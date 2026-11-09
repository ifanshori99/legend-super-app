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
// - Methods are QRIS and VA (legend-3160, CTO decision 9 Nov). A VA names a
//   bank from the gateway's channel list (`getGuestPaymentOptions`); picking
//   another method or bank opens a new intent, which supersedes the pending
//   one on the same WS-05 link (createIntent: one live code per bill).
// - WS-05 `payment.paid` (appended only by `confirmPayment` after verified
//   evidence, PAY-02) is consumed from the outbox by
//   `deliverOrderPaymentEvent` (order-payment-consumers), which fires the
//   order through `handleQrOrderPaymentPaid`. `deliverQrOrderPaymentEvent` is
//   a thin compatibility delegate to the same handler, kept for tests.
//   Nothing else can fire a pay-first order, so no item reaches the KDS
//   before a verified payment (ORD-02).

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  guestPaymentOptionsSchema,
  type GuestPayment,
  type GuestPaymentMethod,
  type GuestPaymentOptions,
} from "@starter/shared/qr-order";
import { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import { paymentGateway } from "./payment-gateway.ts";
import { resolveRoutingRule } from "./payment-routing.service.ts";
import {
  createIntent,
  createPaymentLink,
  getIntentView,
} from "./payment.service.ts";
import { handleQrOrderPaymentPaid } from "./qr-order-consumers.ts";
import {
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
  const { instructions } = intent;
  // Only QRIS and VA intents are opened for a QR order.
  if (instructions.method !== "qris" && instructions.method !== "va")
    throw new Error("QR order payment has an unsupported method");
  const va = instructions.method === "va" ? instructions : null;
  return guestPaymentSchema.parse({
    id: intent.id,
    target: { kind: "order", orderId },
    method: instructions.method,
    amountIdr: intent.amountIdr,
    status: intent.status,
    qrisPayload: instructions.method === "qris" ? instructions.qrPayload : null,
    redirectUrl: null,
    vaNumber: va?.virtualAccountNumber ?? null,
    bankCode: va?.channelCode ?? null,
    bankName: va?.channelName ?? null,
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
        // legend-zmc2: an inclusive order's subtotal already contains the
        // service charge and tax; the link adds them, so it gets the subtotal
        // without them (same total, payment_links_total_check holds).
        subtotalIdr: order.pricesIncludeTax
          ? order.subtotalIdr - order.serviceChargeIdr - order.taxIdr
          : order.subtotalIdr,
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

/** True when the live intent is the method and bank the guest asks for. */
function sameChoice(
  intent: CustomerPaymentIntent,
  method: GuestPaymentMethod,
  bankCode: string | null,
): boolean {
  if (intent.instructions.method !== method) return false;
  return (
    intent.instructions.method !== "va" ||
    intent.instructions.channelCode === bankCode
  );
}

/**
 * A VA bank must be one the gateway lists right now (PRD §3.13 "Metode DOIT":
 * the list comes from the provider, never from the client).
 */
async function assertVaBank(
  context: ScopedTenantContext,
  bankCode: string,
): Promise<void> {
  const banks = await paymentGateway().channels(context, "va");
  if (!banks.some((bank) => bank.code === bankCode))
    throw new CoreError(
      "VALIDATION_ERROR",
      "Bank virtual account ini tidak tersedia; pilih bank lain.",
    );
}

/**
 * GET /api/table-sessions/:sessionId/payment-options (contract guest.ts).
 * QRIS and VA with the outlet's routing and the gateway's health; VA lists
 * the banks the gateway offers and is off when it offers none.
 */
export async function getGuestPaymentOptions(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  now = new Date(),
): Promise<GuestPaymentOptions> {
  const routed = await withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    const rules = [];
    for (const method of ["qris", "va"] as const) {
      const rule = await resolveRoutingRule(
        tx,
        context,
        session.outletId,
        method,
      );
      rules.push({ method, enabled: rule.enabled });
    }
    return rules;
  });
  const gateway = paymentGateway();
  const gatewayUsable = (await gateway.health(context)).status !== "down";
  const methods = [];
  for (const entry of routed) {
    const banks =
      entry.method === "va" && entry.enabled && gatewayUsable
        ? await gateway.channels(context, "va")
        : [];
    const configured = entry.method === "qris" || banks.length > 0;
    const enabled = entry.enabled && gatewayUsable && configured;
    methods.push({
      method: entry.method,
      enabled,
      unavailableReason: enabled
        ? null
        : !entry.enabled || gatewayUsable
          ? ("routing_disabled" as const)
          : ("gateway_down" as const),
      banks,
    });
  }
  return guestPaymentOptionsSchema.parse({ methods });
}

/**
 * POST /api/table-sessions/:sessionId/payments (contract guest.ts). Only the
 * pay-first `order` target is live, with QRIS or VA: split shares belong to
 * legend-ms3 and the open-bill `bill` target to the bill settlement bead.
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
  const bankCode = parsed.method === "va" ? (parsed.bankCode ?? null) : null;
  if (bankCode !== null) await assertVaBank(context, bankCode);
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
        // One live code per order: a second payer asking for the same
        // method and bank gets the pending intent; another method or bank
        // opens a new one, which supersedes it (createIntent).
        if (order.paymentIntentId !== null) {
          const current = await getIntentView(
            context,
            token,
            order.paymentIntentId,
            now,
          );
          if (
            current.status === "paid" ||
            (current.status === "pending" &&
              sameChoice(current, parsed.method, bankCode))
          )
            return guestPaymentDto(current, order.id);
        }
        // The WS-05 key is unique per tenant; derive it from the order so a
        // guest key can never collide with another session's payment.
        const intent = await createIntent(
          context,
          token,
          {
            method: parsed.method,
            channelCode: bankCode,
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

/**
 * Entry point for WS-05 `payment.paid` of a QR order. Delegates to
 * `handleQrOrderPaymentPaid` (qr-order-consumers.ts), the consumer that
 * `deliverOrderPaymentEvent` routes QR bills to, so there is one decision
 * path: the fire is re-read from the locked rows (link total equals the quote
 * amount due, link fully paid, a `paid` intent, IDR) and a replay or a late
 * payment on a voided order changes nothing here. Runs in the consumption
 * transaction (core-outbox.ts `consumeOutbox`), so the fire commits with the
 * consumed offset. Returns true only when this call fired the order.
 */
export async function deliverQrOrderPaymentEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  _idempotencyKey: string,
  tx: Tx,
  now = new Date(),
): Promise<boolean> {
  return (await handleQrOrderPaymentPaid(context, event, tx, now)) === "fired";
}
