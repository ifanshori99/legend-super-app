// POS payment panel: tenders and the WS-05 hand-off (bead legend-kk7; PRD
// v1.7 §3 F8 "Pembayaran", §3.13 "Siklus Pembayaran"; PAY-01/PAY-02;
// contract @starter/shared/pos `addPosTender`, calculations.ts).
//
// - The body never carries an applied amount (TEN-02 money rule): cash sends
//   what the customer handed over and the server applies min(received,
//   remaining) and computes change (`planCashTender`); every other method
//   settles the remaining balance.
// - Cash is captured at once. QRIS opens a WS-05 payment link + intent for the
//   remaining balance and stays `authorized` until the verified `payment.paid`
//   (PAY-02) arrives: `handlePosPaymentPaid` captures it, idempotently. The
//   link is stored on the tender row, never on `orders.payment_link_id`, so
//   the QR consumer (qr-order-payment.ts) never mistakes a POS bill for a QR
//   pay-first order.
// - EDC and points settle through ports (legend-m0k, loyalty); VA, e-wallet
//   and online card need a bank/channel the contract body does not carry and
//   are refused for now.

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  CoreError,
  idr,
  uuidSchema,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  addPosTender as addTenderEndpoint,
  assertPosOrderSettleable,
  planCashTender,
  posTenderResultSchema,
  PosError,
  type PosTenderResult,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { paymentIntents, paymentLinks } from "../db/schema/index.ts";
import { posOrders, posOrderTenders } from "../db/schema/pos-order.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { sealSecret } from "../lib/secrets.ts";
import { createIntent, createPaymentLink } from "./payment.service.ts";
import { posEdcTenderPort, posPointsTenderPort } from "./pos-order-ports.ts";
import { freshDetail, mutatePosOrder } from "./pos-order.service.ts";
import {
  appendOrderEvent,
  assertExpectedStatus,
  assertMutable,
  auditPos,
  bumpPos,
  remainingIdr,
  tenderDto,
  tendersOf,
  type PosCaller,
} from "./pos-order-support.ts";

type AddTenderInput = z.output<typeof addTenderEndpoint.body>;

/** The envelope a WS-05 outbox consumer hands over (`payment.paid`). */
export type DomainEvent = EventEnvelope;

function linkSealAad(tenantId: string, tenderId: string): string {
  return `pos-order-payment-link:${tenantId}:${tenderId}`;
}

const paidPayloadSchema = z.looseObject({
  paymentLinkId: uuidSchema,
  intentId: uuidSchema,
  providerRef: z.string().min(1).max(100).nullable().optional(),
});

/**
 * POST .../tenders. Serialized on the order row: two cashiers splitting one
 * bill never apply more than what is due; the loser of a stale screen gets
 * PRECONDITION_FAILED (expectedStatus / If-Match).
 */
export async function addPosTender(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: string,
  orderId: string,
  input: AddTenderInput,
  now = new Date(),
): Promise<PosTenderResult> {
  const { idempotencyKey, ...request } = input;
  return mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.tender",
      request,
    },
    async (tx, locked) => {
      const { order, pos } = locked;
      const tenantId = context.tenant.tenantId;
      assertExpectedStatus(order, input.expectedStatus);
      assertMutable(order);
      assertPosOrderSettleable({ status: order.status });
      const tenders = await tendersOf(tx, context, order.id);
      const remaining = remainingIdr(order, tenders);
      if (remaining <= 0)
        throw new PosError("ORDER_NOT_PAYABLE", "Tagihan ini sudah lunas.");
      if (input.method !== "points" && input.pointsUsed != null)
        throw new PosError("CASH_TENDER_MISMATCH");
      const base = {
        tenantId,
        outletId: order.outletId,
        orderId: order.id,
        method: input.method,
        reference: input.reference ?? null,
        edcTransactionId: input.edcTransactionId ?? null,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      let inserted: typeof posOrderTenders.$inferSelect | undefined;
      switch (input.method) {
        case "cash": {
          if (input.receivedIdr === undefined)
            throw new PosError("CASH_TENDER_MISMATCH");
          const plan = planCashTender(idr(remaining), idr(input.receivedIdr));
          [inserted] = await tx
            .insert(posOrderTenders)
            .values({
              ...base,
              provider: "manual",
              amountIdr: plan.amountIdr,
              receivedIdr: plan.receivedIdr,
              changeIdr: plan.changeIdr,
              status: "captured",
              resolvedAt: now,
              capturedBy: caller.userId,
            })
            .returning();
          break;
        }
        case "qris": {
          if (
            tenders.some(
              (tender) =>
                tender.status === "authorized" && tender.paymentLinkId !== null,
            )
          )
            throw new CoreError(
              "CONFLICT",
              "Masih ada QRIS yang menunggu pembayaran untuk pesanan ini.",
            );
          // WS-05 bill for exactly the remaining balance (PAY-01: the amount
          // is the server's). The already covered part shows as a reduction.
          const covered = order.totalIdr - remaining;
          const opened = await createPaymentLink(
            context,
            {
              outletId: order.outletId,
              reference: order.number,
              tableLabel: null,
              pax: null,
              subtotalIdr: order.subtotalIdr,
              discountIdr: idr(order.discountIdr + covered),
              serviceChargeIdr: order.serviceChargeIdr,
              taxIdr: order.taxIdr,
              roundingIdr: order.roundingIdr,
              totalIdr: idr(remaining),
              returnPath: null,
            },
            caller.userId,
            now,
          );
          const intent = await createIntent(
            context,
            opened.token,
            {
              method: "qris",
              channelCode: null,
              idempotencyKey: `pos-${createHash("sha256")
                .update(`${order.id}:${idempotencyKey}`)
                .digest("hex")
                .slice(0, 48)}`,
            },
            now,
          );
          const tenderId = randomUUID();
          [inserted] = await tx
            .insert(posOrderTenders)
            .values({
              ...base,
              id: tenderId,
              provider: "doit",
              paymentLinkId: opened.linkId,
              paymentLinkTokenSealed: sealSecret(
                opened.token,
                linkSealAad(tenantId, tenderId),
              ),
              paymentIntentId: intent.id,
              amountIdr: idr(remaining),
              status: "authorized",
              resolvedAt: null,
            })
            .returning();
          break;
        }
        case "edc_card":
        case "edc_qris":
        case "points": {
          if (input.method === "points" && input.pointsUsed == null)
            throw new CoreError(
              "VALIDATION_ERROR",
              "Pembayaran poin mencantumkan jumlah poin.",
            );
          const port =
            input.method === "points"
              ? posPointsTenderPort()
              : posEdcTenderPort();
          const settled = await port(tx, context, {
            orderId: order.id,
            outletId: order.outletId,
            method: input.method,
            amountIdr: remaining,
            reference: input.reference ?? null,
            edcTransactionId: input.edcTransactionId ?? null,
            pointsUsed: input.pointsUsed ?? null,
            cashierId: caller.userId,
            at: now,
          });
          [inserted] = await tx
            .insert(posOrderTenders)
            .values({
              ...base,
              provider: input.method === "points" ? "manual" : "edc",
              reference: settled.reference ?? base.reference,
              pointsUsed:
                input.method === "points" ? (input.pointsUsed ?? null) : null,
              amountIdr: idr(remaining),
              status: "captured",
              resolvedAt: now,
              capturedBy: caller.userId,
              approvedBy: settled.approvedBy,
            })
            .returning();
          break;
        }
        default:
          throw new CoreError(
            "VALIDATION_ERROR",
            "Metode ini belum tersedia di POS; gunakan tunai, QRIS atau EDC.",
          );
      }
      if (!inserted) throw new Error("Tender insert returned no row");
      await bumpPos(tx, context, pos, now);
      await appendOrderEvent(tx, context, {
        order,
        type: "order.tender_added",
        payload: {
          tenderId: inserted.id,
          method: inserted.method,
          amountIdr: inserted.amountIdr,
          status: inserted.status,
        },
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.tender_added",
          order,
          caller,
          before: null,
          after: {
            id: order.id,
            method: inserted.method,
            amountIdr: inserted.amountIdr,
            status: inserted.status,
          },
        },
        now,
      );
      const detail = await freshDetail(tx, context, outletId, orderId);
      const after = await tendersOf(tx, context, order.id);
      const current = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)));
      const fresh = current[0] ?? order;
      return posTenderResultSchema.parse({
        order: detail,
        tender: tenderDto(inserted),
        remainingIdr: remainingIdr(fresh, after),
      });
    },
  );
}

/**
 * Outbox consumer entry for WS-05 `payment.paid` (wired by legend-x4qy).
 * Captures the POS QRIS tender whose payment link the event names, once the
 * link is fully covered by verified money and a `paid` intent exists on it
 * (decision re-read from the locked rows, never from the event alone).
 * Idempotent and safe on replay: a tender already captured/voided, an order
 * already final, or a link that is not a POS tender's changes nothing (a late
 * payment stays WS-05 unallocated funds, PAY-04).
 */
export async function handlePosPaymentPaid(
  context: ScopedTenantContext,
  event: DomainEvent,
): Promise<void> {
  if (event.name !== "payment.paid") return;
  const payload = paidPayloadSchema.safeParse(event.payload);
  if (!payload.success) return;
  const now = new Date();
  await withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [probe] = await tx
      .select({ orderId: posOrderTenders.orderId })
      .from(posOrderTenders)
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.paymentLinkId, payload.data.paymentLinkId),
        ),
      );
    if (!probe) return;
    // Lock order: orders row -> pos_orders row -> tender row.
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, probe.orderId)))
      .for("update");
    if (!order || order.status === "completed" || order.status === "voided")
      return;
    const [pos] = await tx
      .select()
      .from(posOrders)
      .where(
        and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, order.id)),
      )
      .for("update");
    if (!pos) return;
    const [tender] = await tx
      .select()
      .from(posOrderTenders)
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.paymentLinkId, payload.data.paymentLinkId),
        ),
      )
      .for("update");
    if (!tender || tender.status !== "authorized") return;
    const [link] = await tx
      .select({
        paidIdr: paymentLinks.paidIdr,
        totalIdr: paymentLinks.totalIdr,
      })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, tenantId),
          eq(paymentLinks.id, payload.data.paymentLinkId),
        ),
      );
    if (!link || link.paidIdr < link.totalIdr) return;
    const [paid] = await tx
      .select({
        id: paymentIntents.id,
        providerRef: paymentIntents.providerRef,
      })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.paymentLinkId, payload.data.paymentLinkId),
          inArray(paymentIntents.status, ["paid"]),
        ),
      )
      .limit(1);
    if (!paid) return;
    // A tender may never take the order above its total (contract refine).
    const tenders = await tendersOf(tx, context, order.id);
    if (tender.amountIdr > remainingIdr(order, tenders)) return;
    await tx
      .update(posOrderTenders)
      .set({
        status: "captured",
        resolvedAt: now,
        paymentIntentId: paid.id,
        reference:
          (paid.providerRef ?? tender.reference)?.slice(0, 100) ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.id, tender.id),
          eq(posOrderTenders.status, "authorized"),
        ),
      );
    await bumpPos(tx, context, pos, now);
    await appendOrderEvent(tx, context, {
      order,
      type: "order.tender_captured",
      payload: {
        tenderId: tender.id,
        method: tender.method,
        amountIdr: tender.amountIdr,
        paymentIntentId: paid.id,
      },
      caller: null,
      now,
    });
    await auditPos(
      tx,
      context,
      {
        action: "pos_order.tender_captured",
        order,
        caller: null,
        before: { id: order.id, status: "authorized" },
        after: {
          id: order.id,
          method: tender.method,
          amountIdr: tender.amountIdr,
          status: "captured",
        },
      },
      now,
    );
  });
}
