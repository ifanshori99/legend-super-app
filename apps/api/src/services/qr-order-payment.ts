// Pay-first payment hand-off and kitchen fire for QR orders (bead legend-e2x;
// PRD v1.7 §3 F10 "Mode Bayar", §4 Alur A steps 5-6; ORD-02).
//
// PRD Alur A: "Pelanggan memilih metode pembayaran; server membuat payment
// intent ... Setelah webhook terverifikasi diterima, pesanan diteruskan ke KDS".
//
// - `createGuestPayment` (contract guest.ts `createGuestPayment`, target
//   `order`) opens one WS-05 payment link per order (lazily, the first time a
//   guest pays) and one live intent for it. The amount is the order total less
//   the applied reservation deposit, computed by the server (PAY-01, ORD-03).
//   Two guests paying the same order serialize on the order row: the second
//   one receives the same live intent instead of a second one.
// - `deliverQrOrderPaymentEvent` consumes WS-05 `payment.paid` (appended only
//   by `confirmPayment` after verified evidence, PAY-02) from the outbox and
//   fires the order to the kitchen. Nothing else can fire a pay-first order,
//   so no item reaches the KDS before a verified payment (ORD-02).

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  CoreError,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import type { CustomerPaymentIntent } from "@starter/shared/payment";
import {
  createGuestPaymentInputSchema,
  guestPaymentSchema,
  type GuestPayment,
} from "@starter/shared/qr-order";
import { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { paymentIntents, paymentLinks } from "../db/schema/index.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import {
  createIntent,
  createPaymentLink,
  getIntentView,
} from "./payment.service.ts";
import {
  fireQrOrder,
  loadQrZoneOfSession,
  lockGuestSessionForPayment,
  qrOrderIdempotent,
  type QrOrderRow,
} from "./qr-order.service.ts";

type CreateGuestPaymentInput = z.output<typeof createGuestPaymentInputSchema>;

/** `payment_links.created_by` is free text; QR guests are not users. */
const LINK_CREATED_BY = "system:qr-order";

function linkSealAad(tenantId: string, orderId: string): string {
  return `qr-order-payment-link:${tenantId}:${orderId}`;
}

function guestPaymentDto(
  intent: CustomerPaymentIntent,
  orderId: string,
): GuestPayment {
  return guestPaymentSchema.parse({
    id: intent.id,
    target: { kind: "order", orderId },
    method: "qris",
    amountIdr: intent.amountIdr,
    status: intent.status,
    qrisPayload:
      intent.instructions.method === "qris"
        ? intent.instructions.qrPayload
        : null,
    redirectUrl: null,
    expiresAt: intent.expiresAt,
    paidAt: intent.status === "paid" ? intent.paidAt : null,
  });
}

async function lockSessionOrder(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  orderId: string,
): Promise<QrOrderRow> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, context.tenant.tenantId),
        eq(orders.id, orderId),
        eq(orders.tableSessionId, sessionId),
      ),
    )
    .for("update");
  if (!order) throw new CoreError("NOT_FOUND", "Pesanan tidak ditemukan.");
  return order;
}

function linkToken(context: ScopedTenantContext, order: QrOrderRow): string {
  if (order.paymentLinkTokenSealed === null)
    throw new Error("Payment link token missing");
  return openSecret(
    order.paymentLinkTokenSealed,
    linkSealAad(context.tenant.tenantId, order.id),
  );
}

/**
 * Step 1: the order's WS-05 bill, opened once. The link is created through
 * `createPaymentLink` (its own transaction) while this transaction holds the
 * order row, so concurrent payers never open two bills for one order.
 */
async function ensurePaymentLink(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  orderId: string,
  now: Date,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    const order = await lockSessionOrder(tx, context, session.id, orderId);
    if (order.status !== "awaiting_payment")
      throw new CoreError(
        "CONFLICT",
        order.status === "voided"
          ? "Pesanan ini sudah dibatalkan."
          : "Pesanan ini tidak menunggu pembayaran.",
      );
    if (order.paymentLinkId !== null) return;
    const { tableCode } = await loadQrZoneOfSession(tx, context, session);
    const payable = order.totalIdr - order.depositAppliedIdr;
    // The deposit is shown as a reduction of the bill: the link's total is
    // what the guest still owes (PAY-01: the amount is the server's).
    const opened = await createPaymentLink(
      context,
      {
        outletId: order.outletId,
        reference: order.number,
        tableLabel: tableCode,
        pax: session.pax,
        subtotalIdr: order.subtotalIdr,
        discountIdr: order.discountIdr + order.depositAppliedIdr,
        serviceChargeIdr: order.serviceChargeIdr,
        taxIdr: order.taxIdr,
        roundingIdr: order.roundingIdr,
        totalIdr: payable,
        returnPath: null,
      },
      LINK_CREATED_BY,
      now,
    );
    await tx
      .update(orders)
      .set({
        paymentLinkId: opened.linkId,
        paymentLinkTokenSealed: sealSecret(
          opened.token,
          linkSealAad(context.tenant.tenantId, order.id),
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(orders.tenantId, context.tenant.tenantId),
          eq(orders.id, order.id),
        ),
      );
  });
}

/**
 * POST /api/table-sessions/:sessionId/payments (contract guest.ts). Only the
 * pay-first `order` target with QRIS is live: split shares belong to
 * legend-ms3, the open-bill `bill` target to the bill settlement bead, and the
 * WS-05 gateway offers no e-wallet intent yet.
 */
export async function createGuestPayment(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  input: CreateGuestPaymentInput,
  now = new Date(),
): Promise<GuestPayment> {
  const parsed = createGuestPaymentInputSchema.parse(input);
  if (parsed.target.kind !== "order")
    throw new CoreError(
      "VALIDATION_ERROR",
      "Pembayaran bagian atau tagihan open bill belum tersedia di sini.",
    );
  if (parsed.method !== "qris")
    throw new CoreError(
      "VALIDATION_ERROR",
      "Metode pembayaran ini belum tersedia; pilih QRIS.",
    );
  const orderId = parsed.target.orderId;
  await ensurePaymentLink(context, credential, sessionId, orderId, now);
  return withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "share",
    );
    const { idempotencyKey, ...request } = parsed;
    return qrOrderIdempotent(
      tx,
      context,
      { sessionId: session.id, outletId: session.outletId },
      idempotencyKey,
      "payment.create",
      request,
      async () => {
        const order = await lockSessionOrder(tx, context, session.id, orderId);
        if (order.status !== "awaiting_payment")
          throw new CoreError(
            "CONFLICT",
            "Pesanan ini tidak menunggu pembayaran.",
          );
        const token = linkToken(context, order);
        // One live code per order: a second payer gets the pending intent.
        if (order.paymentIntentId !== null) {
          const current = await getIntentView(
            context,
            token,
            order.paymentIntentId,
            now,
          );
          if (current.status === "pending" || current.status === "paid")
            return guestPaymentDto(current, order.id);
        }
        // The WS-05 key is unique per tenant; derive it from the order so a
        // guest key can never collide with another session's payment.
        const intent = await createIntent(
          context,
          token,
          {
            method: "qris",
            channelCode: null,
            idempotencyKey: `qro-${createHash("sha256")
              .update(`${order.id}:${idempotencyKey}`)
              .digest("hex")
              .slice(0, 48)}`,
          },
          now,
        );
        await tx
          .update(orders)
          .set({ paymentIntentId: intent.id, updatedAt: now })
          .where(
            and(
              eq(orders.tenantId, context.tenant.tenantId),
              eq(orders.id, order.id),
            ),
          );
        return guestPaymentDto(intent, order.id);
      },
    );
  });
}

/** GET /api/table-sessions/:sessionId/payments/:paymentId (status poll). */
export async function getGuestPayment(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  paymentId: string,
  now = new Date(),
): Promise<GuestPayment> {
  const intentId = uuidSchema.parse(paymentId);
  const found = await withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, context.tenant.tenantId),
          eq(orders.tableSessionId, session.id),
          eq(orders.paymentIntentId, intentId),
        ),
      );
    if (!order || order.paymentLinkTokenSealed === null)
      throw new CoreError("NOT_FOUND", "Pembayaran tidak ditemukan.");
    return { orderId: order.id, token: linkToken(context, order) };
  });
  const intent = await getIntentView(context, found.token, intentId, now);
  return guestPaymentDto(intent, found.orderId);
}

// ---- Kitchen fire on verified payment (ORD-02) --------------------------------------

const paidPayloadSchema = z.looseObject({
  paymentLinkId: uuidSchema,
  intentId: uuidSchema,
});

/**
 * Outbox consumer for WS-05 `payment.paid`. Runs in the consumption
 * transaction (core-outbox.ts `consumeOutbox`), so the fire commits with the
 * consumed offset. Idempotent: an order already sent or voided is left as it
 * is, and a replayed event changes nothing. The decision is re-read from the
 * locked rows, never from the event alone: the link must be fully covered by
 * verified money and a `paid` intent must exist on it.
 */
export async function deliverQrOrderPaymentEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  _idempotencyKey: string,
  tx: Tx,
  now = new Date(),
): Promise<boolean> {
  if (event.name !== "payment.paid") return false;
  const payload = paidPayloadSchema.safeParse(event.payload);
  if (!payload.success) return false;
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.paymentLinkId, payload.data.paymentLinkId),
      ),
    )
    .for("update");
  // Not a QR order's bill, or already fired / voided (late payment is held as
  // unallocated funds by WS-05, PAY-04).
  if (!order || order.status !== "awaiting_payment") return false;
  const [link] = await tx
    .select({ paidIdr: paymentLinks.paidIdr, totalIdr: paymentLinks.totalIdr })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        eq(paymentLinks.id, payload.data.paymentLinkId),
      ),
    );
  if (!link || link.paidIdr < link.totalIdr) return false;
  const [paid] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, payload.data.paymentLinkId),
        inArray(paymentIntents.status, ["paid"]),
      ),
    )
    .limit(1);
  if (!paid) return false;
  await fireQrOrder(tx, context, order, { now, reason: "verified_payment" });
  return true;
}
