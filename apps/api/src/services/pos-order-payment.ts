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
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  CoreError,
  idr,
  uuidSchema,
  z,
  type OutletId,
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
import { orderNetSubtotalIdr } from "@starter/shared/tax";
import { db } from "../db/index.ts";
import { paymentIntents, paymentLinks } from "../db/schema/index.ts";
import { posOrders, posOrderTenders } from "../db/schema/pos-order.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import {
  cancelPaymentLinkInTx,
  createIntent,
  createPaymentLink,
} from "./payment.service.ts";
import { lockCashierShiftForCash } from "./pos-cash-guard.ts";
import { requestPosLatePaymentRefund } from "./pos-order-late-payment.ts";
import { settlePosEdcStandalone } from "./pos-edc-standalone.ts";
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

const closedPayloadSchema = z.looseObject({
  intentId: uuidSchema,
  reason: z.string().optional(),
});

const paidPayloadSchema = z.looseObject({
  paymentLinkId: uuidSchema,
  intentId: uuidSchema,
  providerRef: z.string().min(1).max(100).nullable().optional(),
});

/**
 * Voids every QRIS tender of the order that still waits for its payment and
 * closes its WS-05 link (bead legend-b0au), inside the caller's transaction:
 * the tender becomes `voided` with `resolvedAt`, the link stops taking money
 * (`cancelPaymentLinkInTx`: link expired, pending intent `expired`, one
 * `payment.expired` event). Idempotent: a tender already resolved is not
 * returned and nothing is cancelled twice. The caller writes its own order
 * event / audit, as before (complete and void order added none for this).
 * `caller` is accepted for symmetry with the callers; the void has no actor
 * column.
 */
export async function voidPendingQrisTenders(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderId: string;
    now: Date;
    caller?: PosCaller | null;
    /** Refuse (409) when the guest already paid a pending QRIS (void order). */
    refuseWhenPaid?: boolean;
  },
): Promise<(typeof posOrderTenders.$inferSelect)[]> {
  const tenantId = context.tenant.tenantId;
  if (input.refuseWhenPaid) {
    const pending = await tx
      .select({ linkId: posOrderTenders.paymentLinkId })
      .from(posOrderTenders)
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.orderId, input.orderId),
          eq(posOrderTenders.status, "authorized"),
          isNotNull(posOrderTenders.paymentLinkId),
        ),
      );
    const linkIds = pending.flatMap((row) =>
      row.linkId === null ? [] : [row.linkId],
    );
    if (linkIds.length > 0) await assertNoPaidQrisIntent(tx, tenantId, linkIds);
  }
  const voided = await tx
    .update(posOrderTenders)
    .set({ status: "voided", resolvedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.orderId, input.orderId),
        eq(posOrderTenders.status, "authorized"),
        isNotNull(posOrderTenders.paymentLinkId),
      ),
    )
    .returning();
  for (const tender of voided)
    if (tender.paymentLinkId)
      await cancelPaymentLinkInTx(tx, context, {
        linkId: tender.paymentLinkId,
        now: input.now,
        reason: "cancelled",
      });
  return voided;
}

/**
 * A QRIS the guest already paid (verified `paid` intent on the link) whose
 * `payment.paid` event the consumer has not booked yet must not be voided:
 * the money is in, so the cashier waits for the confirmation.
 */
async function assertNoPaidQrisIntent(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  linkIds: readonly string[],
): Promise<void> {
  // Lock the links first (link -> intent, the WS-05 confirmation order), so a
  // confirmation cannot commit `paid` between this check and the cancel.
  await tx
    .select({ id: paymentLinks.id })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        inArray(paymentLinks.id, [...linkIds]),
      ),
    )
    .orderBy(asc(paymentLinks.id))
    .for("update");
  const [paid] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.paymentLinkId, [...linkIds]),
        eq(paymentIntents.status, "paid"),
      ),
    )
    .limit(1);
  if (paid)
    throw new CoreError("CONFLICT", "QRIS sudah dibayar; tunggu konfirmasi.");
}

/**
 * POST .../tenders. Serialized on the order row: two cashiers splitting one
 * bill never apply more than what is due; the loser of a stale screen gets
 * PRECONDITION_FAILED (expectedStatus / If-Match).
 */
export async function addPosTender(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
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
      let tenders = await tendersOf(tx, context, order.id);
      // legend-b0au: another method while a QRIS waits closes that QRIS first
      // (its link stops taking money) unless the guest already paid it.
      if (input.method !== "qris") {
        const waiting = tenders.filter(
          (tender) =>
            tender.status === "authorized" && tender.paymentLinkId !== null,
        );
        if (waiting.length > 0) {
          await assertNoPaidQrisIntent(
            tx,
            tenantId,
            waiting.map((tender) => tender.paymentLinkId as string),
          );
          const voided = await voidPendingQrisTenders(tx, context, {
            orderId: order.id,
            now,
            caller,
          });
          for (const tender of voided) {
            await appendOrderEvent(tx, context, {
              order,
              type: "order.tender_voided",
              payload: {
                tenderId: tender.id,
                method: tender.method,
                amountIdr: tender.amountIdr,
                reason: "replaced_by_other_method",
              },
              caller,
              now,
            });
            await auditPos(
              tx,
              context,
              {
                action: "pos_order.tender_voided",
                order,
                caller,
                before: { id: order.id, status: "authorized" },
                after: {
                  id: order.id,
                  method: tender.method,
                  amountIdr: tender.amountIdr,
                  status: "voided",
                },
              },
              now,
            );
          }
          tenders = await tendersOf(tx, context, order.id);
        }
      }
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
          const shift = await lockCashierShiftForCash(tx, context, {
            outletId,
            cashierId: caller.userId,
            deviceId: caller.deviceId,
            mode: "in",
            at: now,
          });
          [inserted] = await tx
            .insert(posOrderTenders)
            .values({
              ...base,
              shiftId: shift.id,
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
              // legend-zmc2: the link adds service and tax to the subtotal.
              subtotalIdr: orderNetSubtotalIdr(order),
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
          // EDC-04: a hand-keyed terminal payment takes the supervisor-approved
          // standalone path; everything else settles through its port.
          const settled =
            input.standalone &&
            (input.method === "edc_card" || input.method === "edc_qris")
              ? await settlePosEdcStandalone(tx, context, {
                  orderId: order.id,
                  orderNumber: order.number,
                  outletId: order.outletId,
                  method: input.method,
                  amountIdr: remaining,
                  terminalId: input.standalone.terminalId,
                  bankRef: input.standalone.bankRef,
                  approvalCode: input.standalone.approvalCode ?? null,
                  overrideId: input.standalone.overrideId,
                  cashierId: caller.userId,
                  at: now,
                })
              : await (
                  input.method === "points"
                    ? posPointsTenderPort()
                    : posEdcTenderPort()
                )(tx, context, {
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
              edcTransactionId:
                "edcTransactionId" in settled
                  ? settled.edcTransactionId
                  : base.edcTransactionId,
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
 * Idempotent and safe on replay: a tender already captured, or a link that is
 * not a POS tender's, changes nothing. A payment that lands on a voided/failed
 * tender or a final order is refunded in full by a system WS-05 refund request
 * (`pos-order-late-payment.ts`, legend-b0au), once per intent.
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
    if (!order) return;
    const orderFinal =
      order.status === "completed" || order.status === "voided";
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
    if (!tender || tender.status === "captured") return;
    // legend-b0au: money arrived for a tender that can no longer take it (it
    // was voided or failed, or the order closed). Refund what the intent holds.
    if (tender.status !== "authorized" || orderFinal) {
      await requestPosLatePaymentRefund(tx, context, {
        order,
        paymentLinkId: payload.data.paymentLinkId,
        intentId: payload.data.intentId,
        now,
      });
      return;
    }
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
    if (tender.amountIdr > remainingIdr(order, tenders)) {
      // legend-b0au: the bill shrank under the open QRIS (e.g. more deposit
      // applied). The tender cannot take the money, so it is voided, its link
      // closed, and what the intent holds is refunded instead of stranded.
      const voided = await voidPendingQrisTenders(tx, context, {
        orderId: order.id,
        now,
      });
      await bumpPos(tx, context, pos, now);
      for (const row of voided) {
        await appendOrderEvent(tx, context, {
          order,
          type: "order.tender_voided",
          payload: {
            tenderId: row.id,
            method: row.method,
            amountIdr: row.amountIdr,
            reason: "bill_below_tender",
          },
          caller: null,
          now,
        });
        await auditPos(
          tx,
          context,
          {
            action: "pos_order.tender_voided",
            order,
            caller: null,
            before: { id: order.id, status: "authorized" },
            after: {
              id: order.id,
              method: row.method,
              amountIdr: row.amountIdr,
              status: "voided",
            },
          },
          now,
        );
      }
      await requestPosLatePaymentRefund(tx, context, {
        order,
        paymentLinkId: payload.data.paymentLinkId,
        intentId: payload.data.intentId,
        now,
      });
      return;
    }
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

/**
 * WS-05 `payment.expired` / `payment.failed` for the intent of a POS QRIS
 * tender (bead legend-b0au). Runs IN the outbox consumption transaction (`tx`)
 * so the change commits with the consumed offset. The lock order matches
 * `handlePosPaymentPaid`: orders row -> pos_orders row -> tender row. The tender
 * is decided from the locked row: only a still `authorized` tender whose
 * `paymentIntentId` is the event's intent becomes `failed`, so the cashier can
 * open a new QRIS; a voided/captured tender or a replay changes nothing.
 * Returns true when the intent's link belongs to a POS tender (handled or
 * ignored as stale), false when it is not a POS bill (the router then ignores
 * the event). Rows of another tenant are never visible (RLS + explicit filter).
 */
export async function handlePosPaymentClosed(
  context: ScopedTenantContext,
  event: DomainEvent,
  tx: Tx,
  now: Date,
): Promise<boolean> {
  if (event.name !== "payment.expired" && event.name !== "payment.failed")
    return false;
  const payload = closedPayloadSchema.safeParse(event.payload);
  if (!payload.success) return false;
  const tenantId = context.tenant.tenantId;
  const [intent] = await tx
    .select({ paymentLinkId: paymentIntents.paymentLinkId })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, payload.data.intentId),
      ),
    );
  if (!intent) return false;
  const [probe] = await tx
    .select({ orderId: posOrderTenders.orderId })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.paymentLinkId, intent.paymentLinkId),
      ),
    );
  if (!probe) return false;
  // Lock order: orders row -> pos_orders row -> tender row.
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, probe.orderId)))
    .for("update");
  if (!order) return true;
  const [pos] = await tx
    .select()
    .from(posOrders)
    .where(
      and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, order.id)),
    )
    .for("update");
  if (!pos) return true;
  const [tender] = await tx
    .select()
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.paymentLinkId, intent.paymentLinkId),
      ),
    )
    .for("update");
  if (
    !tender ||
    tender.status !== "authorized" ||
    tender.paymentIntentId !== payload.data.intentId
  )
    return true;
  // A guest who paid just before the expiry sweep: the webhook may already
  // have moved the intent on to `paid` (WS-05 accepts a late settlement). Its
  // `payment.paid` captures the tender; failing it here would refund the money
  // and make the cashier charge again. Lock order link -> intent, the same as
  // the WS-05 confirmation and `cancelPaymentLinkInTx`.
  await tx
    .select({ id: paymentLinks.id })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        eq(paymentLinks.id, intent.paymentLinkId),
      ),
    )
    .for("update");
  const [current] = await tx
    .select({ status: paymentIntents.status })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, payload.data.intentId),
      ),
    )
    .for("update");
  if (current && current.status !== "expired" && current.status !== "failed")
    return true;
  await tx
    .update(posOrderTenders)
    .set({ status: "failed", resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.id, tender.id),
        eq(posOrderTenders.status, "authorized"),
      ),
    );
  // The link would otherwise keep taking new intents for a tender that is no
  // longer waiting (the cashier opens a fresh QRIS); close it like a void.
  if (tender.paymentLinkId)
    await cancelPaymentLinkInTx(tx, context, {
      linkId: tender.paymentLinkId,
      now,
      reason: "cancelled",
    });
  await bumpPos(tx, context, pos, now);
  await appendOrderEvent(tx, context, {
    order,
    type: "order.tender_failed",
    payload: {
      tenderId: tender.id,
      method: tender.method,
      amountIdr: tender.amountIdr,
      paymentIntentId: tender.paymentIntentId,
      reason: event.name === "payment.expired" ? "expired" : "failed",
    },
    caller: null,
    now,
  });
  await auditPos(
    tx,
    context,
    {
      action: "pos_order.tender_failed",
      order,
      caller: null,
      before: { id: order.id, status: "authorized" },
      after: {
        id: order.id,
        method: tender.method,
        amountIdr: tender.amountIdr,
        status: "failed",
      },
    },
    now,
  );
  return true;
}
