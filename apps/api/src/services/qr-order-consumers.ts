// QR order consumers of WS-05 payment events and the unpaid-order sweep
// (bead legend-x4qy; PRD v1.7 §3 F10 "Mode Bayar", §4 Alur A steps 5-6,
// §3.13 "Siklus Pembayaran" and "QRIS Dinamis"; ORD-02).
//
// Routed here by order-payment-consumers.ts `deliverOrderPaymentEvent`, inside
// the outbox consumption transaction, so every change commits with the
// consumed offset. Every handler re-reads the locked order row and the WS-05
// rows; the event only says where to look, never what to do.
//
// payment.paid (ORD-02 pay-first gate): the order fires to the kitchen only
// when (a) it is still `awaiting_payment`, (b) the event's intent is `paid`
// on this order's link, (c) the link total equals what the order quote says
// the guest owes (total less the applied deposit) and (d) the link is fully
// covered by verified money. A replay finds the order `sent` and changes
// nothing. A payment for a voided order (paid after its code expired, which
// the PRD accepts and WS-05 flags `late_payment`) never revives it: the stock
// and promotion were released; the money WS-05 booked on the bill goes back
// through one pending system refund request per intent (`system:qr`,
// qr-order-late-payment.ts; beads legend-b0au, legend-dahl). The same holds
// when the order's table session closed while a code (a VA lives 3 hours)
// was still payable (legend-3160): the order is voided instead of fired and
// the money goes back through the same refund request. A code the guest
// switched away from, paid after the order was already paid, is booked as
// `double_payment` unallocated funds; it gets a system refund request too.
// When both codes settled before either event is consumed, the order is fired
// for the code that covered the bill, proven by WS-05 evidence less its
// unallocated funds, never for the double-paid one (legend-mks0q).
//
// payment.expired / payment.failed (bead note: an expired code or link must
// not strand the order in `awaiting_payment`). PRD silent on the exact rule;
// the decision (`decideUnpaidQrOrder`, safest option):
// - a new QRIS code is offered while the table session is open, the WS-05
//   link is still valid and fewer than MAX_QR_PAYMENT_ATTEMPTS codes were
//   issued (PRD "QRIS Dinamis": the QR refreshes when it expires); a code
//   superseded by the guest's own switch of bank or method is not an attempt;
// - otherwise the order is voided (`voidUnpaidQrOrderTx`: items voided, daily
//   limit and promotion released exactly once), but only after
//   LATE_PAYMENT_GRACE_MS past the last code's expiry for a local timeout,
//   because a payment made at the last second may still settle. A provider-
//   declared expiry voids at once; a failure waits the grace too, because
//   WS-05 still accepts a verified settlement after `failed` (legend-b0au);
// - an order with no open code for UNPAID_ORDER_ABANDON_MS is abandoned and
//   voided by `sweepUnpaidQrOrders` (relay tick), which also covers guests
//   who stop polling (no expiry event is produced then).

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { uuidSchema, z, type ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import {
  billSplits,
  domainEventOutbox,
  paymentIntents,
  paymentLinks,
  tableSessions,
} from "../db/schema/index.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import {
  expireSplitClaimsTx,
  listLiveSplitsTx,
  markSplitPartPaidTx,
  voidLiveSplitsTx,
} from "./bill-split.service.ts";
import type { Tx } from "./menu-internals.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { listSessionDepositSources } from "./reservation-deposit-credit.ts";
import { pendingRefundIdr } from "./pos-order-late-payment.ts";
import { markSplitQrisHoldPaidByIntentTx } from "./pos-qris-hold.ts";
import {
  HOLDS_REFUNDABLE_MONEY,
  requestQrDoublePaymentRefund,
  requestQrLatePaymentRefund,
} from "./qr-order-late-payment.ts";
import { notifyQrOrderChange } from "./qr-order-realtime-signal.ts";
import {
  fireQrOrder,
  voidUnpaidQrOrderTx,
  type QrOrderRow,
} from "./qr-order.service.ts";
import { issueWholeBillClaimTx } from "./table-claim.service.ts";

/** PRD silent: three QRIS codes (about 30 minutes) per unpaid order. */
export const MAX_QR_PAYMENT_ATTEMPTS = 3;
/** PRD §3.13: a payment confirmed after expiry is accepted; wait for it. */
export const LATE_PAYMENT_GRACE_MS = 2 * 60_000;
/** PRD silent: no open code for 15 minutes means the guests walked away. */
export const UNPAID_ORDER_ABANDON_MS = 15 * 60_000;

const paidPayloadSchema = z.looseObject({
  intentId: uuidSchema,
  paymentLinkId: uuidSchema,
  amountIdr: z.number().int().optional(),
  // WS-05 is IDR-only (BIGINT whole rupiah); a currency, if ever sent, must be IDR.
  currency: z.string().optional(),
});
const closedPayloadSchema = z.looseObject({
  intentId: uuidSchema,
  reason: z.string().optional(),
});

export type QrPaymentPaidOutcome =
  | "ignored"
  | "fired"
  | "unchanged"
  | "not_settled"
  | "amount_mismatch"
  | "currency_mismatch"
  | "late_payment_on_voided_order"
  | "late_payment_on_closed_session"
  | "late_payment_refund_committed"
  | "double_payment_refund_requested";

export type QrPaymentClosedOutcome =
  "ignored" | "unchanged" | "voided" | "retry_allowed" | "awaiting_grace";

// ---- Decision (pure) ------------------------------------------------------------

export type UnpaidQrOrderState = {
  readonly sessionActive: boolean;
  /** null: the guests never opened the payment link (never pressed pay). */
  readonly linkExpiresAt: Date | null;
  readonly linkFullyPaid: boolean;
  /** Payment codes (WS-05 intents) issued on the order's link, less the
   * ones superseded by the guest switching bank or method. */
  readonly attempts: number;
  /** A pending code that is not past its expiry plus the late grace. */
  readonly hasOpenIntent: boolean;
  /** End of the last payment window: max(placed at, last code expiry). */
  readonly windowClosedAt: Date;
};

export type UnpaidQrOrderDecision =
  | { readonly action: "keep"; readonly why: QrPaymentClosedOutcome }
  | { readonly action: "void"; readonly reason: string };

/**
 * What to do with an unpaid pay-first order whose payment code closed.
 * `providerFinal`: the gateway itself declared the code expired, so no late
 * payment can follow and the grace is skipped. Never set for a failure: WS-05
 * still accepts a verified settlement after `failed` (legend-b0au).
 */
export function decideUnpaidQrOrder(
  state: UnpaidQrOrderState,
  now: Date,
  providerFinal = false,
): UnpaidQrOrderDecision {
  // Money already covers the bill: payment.paid fires it, never void it.
  if (state.linkFullyPaid) return { action: "keep", why: "unchanged" };
  if (state.hasOpenIntent) return { action: "keep", why: "unchanged" };
  const idleMs = now.getTime() - state.windowClosedAt.getTime();
  const linkValid =
    state.linkExpiresAt === null ||
    state.linkExpiresAt.getTime() > now.getTime();
  const retryPossible =
    state.sessionActive &&
    linkValid &&
    state.attempts < MAX_QR_PAYMENT_ATTEMPTS;
  if (!retryPossible) {
    if (!providerFinal && idleMs < LATE_PAYMENT_GRACE_MS)
      return { action: "keep", why: "awaiting_grace" };
    return {
      action: "void",
      reason: !state.sessionActive
        ? "payment_unpaid_session_closed"
        : !linkValid
          ? "payment_link_expired"
          : "payment_attempts_exhausted",
    };
  }
  if (idleMs >= UNPAID_ORDER_ABANDON_MS)
    return { action: "void", reason: "payment_abandoned" };
  return { action: "keep", why: "retry_allowed" };
}

/** False once the order's table session closed or was voided. */
async function orderSessionActive(
  tx: Tx,
  context: ScopedTenantContext,
  order: QrOrderRow,
): Promise<boolean> {
  const [session] =
    order.tableSessionId === null
      ? []
      : await tx
          .select({ status: tableSessions.status })
          .from(tableSessions)
          .where(
            and(
              eq(tableSessions.tenantId, context.tenant.tenantId),
              eq(tableSessions.id, order.tableSessionId),
            ),
          );
  return (
    session !== undefined &&
    session.status !== "closed" &&
    session.status !== "voided"
  );
}

/**
 * Intents of the link that WS-05 superseded because the guest picked another
 * bank or method (`supersedePending` appends `payment.expired` with reason
 * `superseded`; the intent row keeps no reason). A provider or timeout expiry
 * carries another reason, so it still counts as an attempt.
 */
async function supersededIntentIds(
  tx: Tx,
  context: ScopedTenantContext,
  intentIds: readonly string[],
): Promise<Set<string>> {
  if (intentIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ intentId: domainEventOutbox.aggregateId })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, context.tenant.tenantId),
        inArray(domainEventOutbox.aggregateId, [...intentIds]),
        sql`${domainEventOutbox.event}->>'name' = 'payment.expired'`,
        sql`${domainEventOutbox.event}->'payload'->>'reason' = 'superseded'`,
      ),
    );
  return new Set(rows.map((row) => row.intentId));
}

async function loadUnpaidState(
  tx: Tx,
  context: ScopedTenantContext,
  order: QrOrderRow,
  now: Date,
): Promise<UnpaidQrOrderState> {
  const tenantId = context.tenant.tenantId;
  const sessionActive = await orderSessionActive(tx, context, order);
  if (order.paymentLinkId === null)
    return {
      sessionActive,
      linkExpiresAt: null,
      linkFullyPaid: false,
      attempts: 0,
      hasOpenIntent: false,
      windowClosedAt: order.placedAt,
    };
  const [link] = await tx
    .select({
      paidIdr: paymentLinks.paidIdr,
      totalIdr: paymentLinks.totalIdr,
      expiresAt: paymentLinks.expiresAt,
    })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        eq(paymentLinks.id, order.paymentLinkId),
      ),
    );
  const intents = await tx
    .select({
      id: paymentIntents.id,
      status: paymentIntents.status,
      expiresAt: paymentIntents.expiresAt,
      billSplitId: paymentIntents.billSplitId,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, order.paymentLinkId),
      ),
    );
  const superseded = await supersededIntentIds(
    tx,
    context,
    intents.map((row) => row.id),
  );
  const windowClosedAt = new Date(
    Math.max(
      order.placedAt.getTime(),
      ...intents.map((row) => row.expiresAt.getTime()),
    ),
  );
  // Split bill: codes are counted per part, so a part that already used its
  // attempts never voids a bill whose other parts are paid or still open.
  // Attempts = the most codes any pending part used (superseded, paid and
  // refunded codes do not count).
  const liveSplits = await listLiveSplitsTx(tx, context, order.id);
  const attempts =
    liveSplits.length === 0
      ? intents.filter((row) => !superseded.has(row.id)).length
      : Math.max(
          0,
          ...liveSplits
            .filter((part) => part.status === "pending")
            .map(
              (part) =>
                intents.filter(
                  (row) =>
                    row.billSplitId === part.id &&
                    !superseded.has(row.id) &&
                    !HOLDS_REFUNDABLE_MONEY.includes(row.status) &&
                    row.status !== "refunded",
                ).length,
            ),
        );
  return {
    sessionActive,
    // A missing link row fails closed: treated as expired.
    linkExpiresAt: link ? (link.expiresAt ?? null) : new Date(0),
    linkFullyPaid: link !== undefined && link.paidIdr >= link.totalIdr,
    attempts,
    hasOpenIntent: intents.some(
      (row) =>
        row.status === "pending" &&
        row.expiresAt.getTime() + LATE_PAYMENT_GRACE_MS > now.getTime(),
    ),
    windowClosedAt,
  };
}

async function lockOrderOfLink(
  tx: Tx,
  context: ScopedTenantContext,
  paymentLinkId: string,
): Promise<QrOrderRow | null> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, context.tenant.tenantId),
        eq(orders.paymentLinkId, paymentLinkId),
      ),
    )
    .for("update");
  return order && order.channel === "qr" ? order : null;
}

/**
 * legend-mks0q: what each paid code of the link put toward the bill, from the
 * durable WS-05 rows: the money its provider evidence brought in, less the
 * part booked as unallocated funds (overpayment or double payment, whatever
 * became of it later). WS-05 keeps no per-code allocation column; these two
 * append-only tables, written in the settling transaction, are the allocation
 * record. One statement, so one snapshot: a second payment of a code that
 * commits mid-read can never make its evidence count without its fund (or
 * the reverse) under READ COMMITTED.
 */
async function allocatedIdrByIntent(
  tx: Tx,
  context: ScopedTenantContext,
  paymentLinkId: string,
): Promise<Map<string, number>> {
  const result = await tx.execute<{ id: string; allocated: string }>(sql`
    SELECT i.id,
           (coalesce((SELECT sum(e.amount_idr) FROM payment_evidence e
                       WHERE e.tenant_id = i.tenant_id
                         AND e.payment_intent_id = i.id), 0)
          - coalesce((SELECT sum(f.amount_idr) FROM payment_unallocated_funds f
                       WHERE f.tenant_id = i.tenant_id
                         AND f.payment_intent_id = i.id), 0))::text AS allocated
      FROM payment_intents i
     WHERE i.tenant_id = ${context.tenant.tenantId}
       AND i.payment_link_id = ${paymentLinkId}
       AND i.status IN ('paid', 'partially_refunded', 'refunded')`);
  return new Map(result.rows.map((row) => [row.id, Number(row.allocated)]));
}

/**
 * legend-mks0q: the code that paid the bill, proven by its allocation: the
 * event's own code when it covered what the guest owed, else the one code of
 * the link that did (the link never takes more than its total, so at most one
 * can). A code whose money was all booked as a double payment is never the
 * payer, whichever paid event is consumed first: its receipt backs only its
 * own refund. A bill split over several codes (none covered it alone) keeps
 * the event's code when it put money toward the bill. Null: the event's code
 * put nothing toward the bill and no code covered it alone.
 */
async function payerIntentOf(
  tx: Tx,
  context: ScopedTenantContext,
  input: { paymentLinkId: string; intentId: string; owedIdr: number },
): Promise<string | null> {
  const allocated = await allocatedIdrByIntent(
    tx,
    context,
    input.paymentLinkId,
  );
  const own = allocated.get(input.intentId) ?? 0;
  if (allocated.has(input.intentId) && own >= input.owedIdr)
    return input.intentId;
  for (const [id, amount] of allocated)
    if (amount > 0 && amount >= input.owedIdr) return id;
  return own > 0 ? input.intentId : null;
}

async function voidAndNotify(
  tx: Tx,
  context: ScopedTenantContext,
  order: QrOrderRow,
  reason: string,
  now: Date,
): Promise<void> {
  await voidUnpaidQrOrderTx(
    tx,
    context,
    order.id,
    { reason, actorUserId: null },
    now,
  );
  // Split bill: unpaid parts can no longer be paid, and the paid parts'
  // claim links stop redeeming (the order is gone). The refund per paid
  // intent is filed by `voidUnpaidQrOrderTx` (legend-gjf1).
  await voidLiveSplitsTx(tx, context, order.id, now);
  await expireSplitClaimsTx(tx, context, order.id, now);
  if (order.tableSessionId !== null)
    await notifyQrOrderChange(tx, context, {
      sessionId: order.tableSessionId,
      orderId: order.id,
      status: "voided",
    });
}

// ---- payment.paid ---------------------------------------------------------------

/**
 * Marks every still-pending part of the order whose own code has settled
 * (`paid`) as paid, so `voidLiveSplitsTx` only voids parts nobody paid. Money
 * flow untouched: only the part status and claim token change. Replay safe
 * (`markSplitPartPaidTx` answers "already").
 */
async function reconcileSettledSplitPartsTx(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  now: Date,
): Promise<void> {
  const settled = await tx
    .select({ intentId: paymentIntents.id })
    .from(billSplits)
    .innerJoin(
      paymentIntents,
      and(
        eq(paymentIntents.tenantId, billSplits.tenantId),
        eq(paymentIntents.billSplitId, billSplits.id),
      ),
    )
    .where(
      and(
        eq(billSplits.tenantId, context.tenant.tenantId),
        eq(billSplits.orderId, orderId),
        eq(billSplits.status, "pending"),
        eq(paymentIntents.status, "paid"),
      ),
    )
    .orderBy(asc(paymentIntents.id));
  for (const { intentId } of settled)
    await markSplitPartPaidTx(tx, context, { intentId, now });
}

/** ORD-02: fires a pay-first QR order on verified payment. Replay safe. */
export async function handleQrOrderPaymentPaid(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<QrPaymentPaidOutcome> {
  if (event.name !== "payment.paid") return "ignored";
  if (event.tenantId !== context.tenant.tenantId) return "ignored";
  const payload = paidPayloadSchema.safeParse(event.payload);
  if (!payload.success) return "ignored";
  const { intentId, paymentLinkId, currency } = payload.data;
  const order = await lockOrderOfLink(tx, context, paymentLinkId);
  if (!order) return "ignored";
  // legend-yhia9: the QR was paid, so its hold ends `paid` before any branch
  // below that the 0369 triggers refuse while the hold is active (void, fire).
  await markSplitQrisHoldPaidByIntentTx(
    tx,
    context.tenant.tenantId,
    intentId,
    now,
  );
  if (order.status === "voided") {
    const [late] = await tx
      .select({ status: paymentIntents.status })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
          eq(paymentIntents.paymentLinkId, paymentLinkId),
        ),
      );
    if (!late || !HOLDS_REFUNDABLE_MONEY.includes(late.status))
      return "unchanged";
    // WS-05 booked the money on this voided order's bill; it is never the
    // order's revenue. One system refund request per intent returns it
    // (beads legend-b0au, legend-dahl); a replay finds the first one.
    const refundId = await requestQrLatePaymentRefund(tx, context, {
      order,
      paymentLinkId,
      intentId,
      now,
    });
    // A second code paid on the same bill (the guest switched bank and paid
    // both) was booked as `double_payment` unallocated funds, which the
    // request above cannot reach; it gets its own request.
    const doubleRefundIds = await requestQrDoublePaymentRefund(tx, context, {
      order,
      paymentLinkId,
      intentId,
      now,
    });
    // Identifiers only.
    logger.warn(
      { orderId: order.id, intentId, refundId, doubleRefundIds },
      "QR order: payment settled after the unpaid order was voided; refund requested",
    );
    return "late_payment_on_voided_order";
  }
  if (order.status !== "awaiting_payment") {
    // The order was already paid by another code of the same bill (the
    // guest switched bank and paid both): WS-05 booked this payment as
    // `double_payment` unallocated funds; return it to the guest.
    const refundIds = await requestQrDoublePaymentRefund(tx, context, {
      order,
      paymentLinkId,
      intentId,
      now,
    });
    if (refundIds.length === 0) return "unchanged";
    logger.warn(
      { orderId: order.id, intentId, refundIds },
      "QR order: a second code was paid after the order was paid; refund requested",
    );
    return "double_payment_refund_requested";
  }
  if (currency !== undefined && currency !== "IDR") return "currency_mismatch";
  if (!(await orderSessionActive(tx, context, order))) {
    // The table session closed while the code was still payable (a VA lives
    // 3 hours): never fire to the kitchen for a table that is gone. The order
    // is voided (stock and promotion released) and the money goes back
    // through the late-payment refund request.
    const [late] = await tx
      .select({ status: paymentIntents.status })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
          eq(paymentIntents.paymentLinkId, paymentLinkId),
        ),
      );
    if (!late || !HOLDS_REFUNDABLE_MONEY.includes(late.status))
      return "not_settled";
    await voidAndNotify(
      tx,
      context,
      order,
      "payment_unpaid_session_closed",
      now,
    );
    const refundId = await requestQrLatePaymentRefund(tx, context, {
      order,
      paymentLinkId,
      intentId,
      now,
    });
    const doubleRefundIds = await requestQrDoublePaymentRefund(tx, context, {
      order,
      paymentLinkId,
      intentId,
      now,
    });
    logger.warn(
      { orderId: order.id, intentId, refundId, doubleRefundIds },
      "QR order: payment settled after the table session closed; order voided, refund requested",
    );
    return "late_payment_on_closed_session";
  }
  // Split bill: mark the part this code paid (replay safe; "no_split" for an
  // ordinary payment). The order still fires only when the link is covered.
  await markSplitPartPaidTx(tx, context, { intentId, now });
  const [link] = await tx
    .select({ paidIdr: paymentLinks.paidIdr, totalIdr: paymentLinks.totalIdr })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, context.tenant.tenantId),
        eq(paymentLinks.id, paymentLinkId),
      ),
    );
  if (!link) return "not_settled";
  // The bill the guest paid must be the order quote's amount due (PAY-01,
  // ORD-03): total less the applied reservation deposit, exactly.
  if (link.totalIdr !== order.totalIdr - order.depositAppliedIdr) {
    logger.warn(
      { orderId: order.id, paymentLinkId },
      "QR order: payment link total differs from the order quote",
    );
    return "amount_mismatch";
  }
  if (link.paidIdr < link.totalIdr) return "not_settled";
  const [intent] = await tx
    .select({ status: paymentIntents.status })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, intentId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
      ),
    );
  // A refund that completed before this event moves the intent on to
  // (partially_)refunded; it is still the money that paid the bill, so the
  // refund guard below decides (void, refund the rest), never "not_settled"
  // (the order would stay awaiting_payment for good; legend-9vzvs).
  if (
    !intent ||
    !["paid", "partially_refunded", "refunded"].includes(intent.status)
  )
    return "not_settled";
  // Pin the intent that paid: a superseded code may have settled the bill,
  // and a code paid after another covered it (`double_payment`, nothing
  // allocated) is never the payer, whichever event is consumed first
  // (legend-mks0q). Decided under the order lock from durable WS-05 rows.
  const payerIntentId = await payerIntentOf(tx, context, {
    paymentLinkId,
    intentId,
    owedIdr: link.totalIdr,
  });
  if (payerIntentId === null) {
    // This code put nothing toward the bill and no code covered it alone:
    // the codes that did fire the order with their own events. Its money is
    // a double payment; it goes back.
    const refundIds = await requestQrDoublePaymentRefund(tx, context, {
      order,
      paymentLinkId,
      intentId,
      now,
    });
    return refundIds.length > 0
      ? "double_payment_refund_requested"
      : "unchanged";
  }
  if (payerIntentId !== intentId)
    logger.warn(
      { orderId: order.id, intentId, payerIntentId },
      "QR order: fired for the code that covered the bill, not the event's double-paid code",
    );
  // legend-9vzvs: the sale takes the money of the codes that paid the bill,
  // so the fire is decided under the same intent row locks the refund writers
  // hold (lock order: order row -> intents ascending, as the POS paid
  // consumer). An approved or completed refund (`reserved - pending`) that
  // leaves a code less than the part it put toward the bill means firing
  // would also pay the guest back: void the order and refund what is left
  // (the late-payment request, per code). A refund still `pending` does not
  // block: the sale wins, and its approval then finds the fired sale held and
  // fails `cap_exceeded` (qrSaleInUse).
  // legend-nslvm: a bill split over several codes is checked code by code.
  const allocated = await allocatedIdrByIntent(tx, context, paymentLinkId);
  const contributors = [...allocated]
    .filter(([id, amount]) => amount > 0 || id === payerIntentId)
    .map(([id]) => id);
  const depositSources =
    order.depositAppliedIdr > 0 && order.tableSessionId !== null
      ? await listSessionDepositSources(
          tx,
          context.tenant.tenantId,
          order.tableSessionId,
        )
      : [];
  const at = await lockIntentsForFact(
    tx,
    context.tenant.tenantId,
    [
      payerIntentId,
      ...contributors,
      ...depositSources.map(({ paymentIntentId }) => paymentIntentId),
    ],
    now,
  );
  let committedRefund = false;
  for (const id of contributors) {
    const [code] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, id),
          eq(paymentIntents.paymentLinkId, paymentLinkId),
        ),
      );
    if (!code) return "not_settled";
    const balance = await refundableBalance(tx, code);
    const committed =
      balance.reserved -
      (await pendingRefundIdr(tx, context.tenant.tenantId, code.id));
    // The part this code put toward the bill; one code covering it alone
    // takes the order's amount due.
    const part =
      contributors.length === 1
        ? BigInt(order.totalIdr - order.depositAppliedIdr)
        : BigInt(allocated.get(id) ?? 0);
    if (committed > 0n && committed + part > balance.cap)
      committedRefund = true;
  }
  if (committedRefund) {
    await voidAndNotify(tx, context, order, "refund_committed", at);
    const refundIds: (string | null)[] = [];
    for (const id of contributors)
      refundIds.push(
        await requestQrLatePaymentRefund(tx, context, {
          order,
          paymentLinkId,
          intentId: id,
          now: at,
        }),
      );
    const doubleRefundIds = await requestQrDoublePaymentRefund(tx, context, {
      order,
      paymentLinkId,
      intentId,
      now: at,
    });
    logger.warn(
      {
        orderId: order.id,
        intentId,
        payerIntentId,
        refundIds,
        doubleRefundIds,
      },
      "QR order: a refund already took the payment's money; order voided, remainder refunded",
    );
    return "late_payment_refund_committed";
  }
  await fireQrOrder(tx, context, order, {
    now: at,
    reason: "verified_payment",
    paidIntentId: payerIntentId,
  });
  // Split bill: a part whose code settled before its own event was consumed
  // is still `pending` here; mark it paid (and issue its claim token) before
  // the leftovers are voided, or the guest who paid loses the part and the
  // points claim (its event later stops at the paid-order guard).
  await reconcileSettledSplitPartsTx(tx, context, order.id, at);
  // Split bill: the paid parts covered the bill; a part still pending (a
  // different code settled the whole bill) can no longer be paid.
  const voidedParts = await voidLiveSplitsTx(tx, context, order.id, at);
  if (voidedParts > 0)
    logger.warn(
      { orderId: order.id, intentId, voidedParts },
      "QR order: fired with split parts still pending; leftover parts voided",
    );
  // Guest point claim: an order paid by one payer (no live split part) gets
  // its own claim token; split parts carry theirs (markSplitPartPaidTx).
  await issueWholeBillClaimTx(tx, context, order.id, at);
  // Outbox order across intents is not relied on: when this event's intent
  // also carries `double_payment` funds (another code covered the bill
  // first), they are returned here too; a replay files nothing new.
  const doubleRefundIds = await requestQrDoublePaymentRefund(tx, context, {
    order,
    paymentLinkId,
    intentId,
    now,
  });
  if (doubleRefundIds.length > 0)
    logger.warn(
      { orderId: order.id, intentId, refundIds: doubleRefundIds },
      "QR order: fired by a code whose bill another code already covered; refund requested",
    );
  if (order.tableSessionId !== null)
    await notifyQrOrderChange(tx, context, {
      sessionId: order.tableSessionId,
      orderId: order.id,
      status: "sent",
    });
  return "fired";
}

// ---- payment.expired / payment.failed ------------------------------------------

/** Voids or keeps an unpaid QR order whose payment code closed. Replay safe. */
export async function handleQrOrderPaymentClosed(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<QrPaymentClosedOutcome> {
  if (event.name !== "payment.expired" && event.name !== "payment.failed")
    return "ignored";
  if (event.tenantId !== context.tenant.tenantId) return "ignored";
  const payload = closedPayloadSchema.safeParse(event.payload);
  if (!payload.success) return "ignored";
  // A code replaced by a fresh one for the same bill is not a closed payment.
  if (payload.data.reason === "superseded") return "ignored";
  const [intent] = await tx
    .select({ paymentLinkId: paymentIntents.paymentLinkId })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, payload.data.intentId),
      ),
    );
  if (!intent) return "ignored";
  const order = await lockOrderOfLink(tx, context, intent.paymentLinkId);
  if (!order) return "ignored";
  if (order.status !== "awaiting_payment") return "unchanged";
  // A newer code is the live one; its own events decide.
  if (
    order.paymentIntentId !== null &&
    order.paymentIntentId !== payload.data.intentId
  )
    return "unchanged";
  // A gateway-declared expiry is final. `payment.failed` is not (beads
  // legend-b0au, legend-dahl): WS-05 still accepts a verified settlement after
  // `failed`, so the order waits the late-payment grace like a local timeout
  // instead of being voided while the guest's money may still land.
  const providerFinal =
    event.name === "payment.expired" && payload.data.reason === "gateway";
  const decision = decideUnpaidQrOrder(
    await loadUnpaidState(tx, context, order, now),
    now,
    providerFinal,
  );
  if (decision.action === "keep") return decision.why;
  await voidAndNotify(tx, context, order, decision.reason, now);
  return "voided";
}

// ---- Sweep (relay tick) ---------------------------------------------------------

/**
 * Voids unpaid pay-first QR orders whose payment window closed (abandoned,
 * link expired, attempts exhausted or session closed) — the safety net for
 * guests who stop polling, when no expiry event is ever produced. Each order
 * is decided and voided in its own transaction under its row lock; a second
 * run finds it voided and releases nothing again.
 */
export async function sweepUnpaidQrOrders(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 100,
): Promise<{ voided: number }> {
  const candidates = await withTenant(db, context, (tx) =>
    tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, context.tenant.tenantId),
          eq(orders.channel, "qr"),
          inArray(orders.status, ["awaiting_payment"]),
          lte(orders.placedAt, new Date(now.getTime() - LATE_PAYMENT_GRACE_MS)),
        ),
      )
      .orderBy(asc(orders.placedAt), asc(orders.id))
      .limit(limit),
  );
  let voided = 0;
  for (const candidate of candidates) {
    const done = await withTenant(db, context, async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, context.tenant.tenantId),
            eq(orders.id, candidate.id),
          ),
        )
        .for("update");
      if (!order || order.status !== "awaiting_payment") return false;
      const decision = decideUnpaidQrOrder(
        await loadUnpaidState(tx, context, order, now),
        now,
      );
      if (decision.action === "keep") return false;
      await voidAndNotify(tx, context, order, decision.reason, now);
      return true;
    });
    if (done) voided += 1;
  }
  return { voided };
}
