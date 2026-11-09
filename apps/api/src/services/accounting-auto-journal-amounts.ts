// Auto-journal facts (F19, design docs/design/auto-journals.md sections 3-4).
// Turns one outbox event into the posting-rule input of the auto-journal
// consumer: rule event name, exact amount keys, business-fact idempotency key,
// source id, outlet and the moment the money moved. Payloads are parsed with
// consumer-local, non-strict schemas (emitter additions never break them), and
// only ids, amounts and times are kept: that subset is what
// `auto_journal_parked.payload` stores, so the sweep rebuilds the same fact
// without an outbox replay.
//
// Slice 1 handles order.paid (POS), order.refunded, payment.paid,
// payment.funds_unallocated and payment.refunded. Gateway money is
// receipt-first: payment.paid (one receipt per intent) and
// payment.funds_unallocated (money no payment.paid counts: closed intent,
// second payment) book the receipt into customer_deposit, order.paid moves the
// intent-backed gateway tenders whose receipt is booked out of it and waits
// (AutoJournalReceiptPending) while a receipt can still post. EDC-linked
// intents are skipped (EDC money posts through edc_clearing on the sale); an
// EDC-linked gateway tender fails closed.
//
// Slice 2 adds the reservation DP and the cashier shift: order.paid moves the
// DP applied (paidDepositIdr, checked against the order row) out of
// customer_deposit when the DP receipt is booked, or books it as gateway money
// when the DP was paid before the cutover; reservation.cancelled /
// reservation.no_show book the forfeited DP the same way; cashier_shift.closed
// books the signed drawer difference checked against the shift row.
//
// A payload, row or method that can never post as sent throws
// AutoJournalPayloadInvalid (or a ZodError): the consumer parks it as
// non-retryable AUTO_JOURNAL_PAYLOAD_INVALID instead of failing the outbox
// consumption.

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { AccountingError } from "@starter/shared/accounting";
import type { ScopedTenantContext } from "@starter/shared/core";
import { tenderBucket } from "@starter/shared/pos";
import { depositHoldsFunds } from "@starter/shared/reservation";
import {
  autoJournalParked,
  domainEventOutbox,
  journalEntries,
  paymentIntents,
  paymentRefunds,
  orders,
  paymentUnallocatedFunds,
  posOrderTenders,
  posShifts,
  reservationDepositAllocations,
  reservations,
} from "../db/schema/index.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import { EVENT_DESTINATION } from "./payment-support.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

export const AUTO_JOURNAL_EVENTS = [
  "order.paid",
  "order.refunded",
  "payment.paid",
  "payment.funds_unallocated",
  "payment.refunded",
  "reservation.cancelled",
  "reservation.no_show",
  "cashier_shift.closed",
] as const;
export type AutoJournalEventName = (typeof AUTO_JOURNAL_EVENTS)[number];

export function isAutoJournalEvent(name: string): name is AutoJournalEventName {
  return (AUTO_JOURNAL_EVENTS as readonly string[]).includes(name);
}

/** The event can never post as sent: parked, never retried. */
export class AutoJournalPayloadInvalid extends Error {
  readonly code = "AUTO_JOURNAL_PAYLOAD_INVALID";
}

/**
 * order.paid met a gateway tender whose receipt has not posted yet: parked
 * retryable, the sweep posts the sale once the receipt is booked.
 */
export class AutoJournalReceiptPending extends Error {
  readonly code = "AUTO_JOURNAL_RECEIPT_PENDING";
}

/**
 * A reservation DP whose intents are partly receipt-booked and partly
 * pre-cutover: no single account holds it, finance must decide. Parked, never
 * retried.
 */
export class AutoJournalDepositCutoverMixed extends Error {
  readonly code = "AUTO_JOURNAL_DEPOSIT_CUTOVER_MIXED";
}

const idr = z.number().int().safe();
const id = z.string().min(1).max(64);
const time = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp");

const orderPaidSchema = z.object({
  orderId: id,
  outletId: z.string().uuid(),
  grossSalesIdr: idr,
  discountIdr: idr,
  serviceChargeIdr: idr,
  pbjtIdr: idr,
  roundingIdr: idr,
  paidCashIdr: idr,
  paidGatewayIdr: idr,
  paidEdcIdr: idr,
  paidPointsIdr: idr,
  /** Reservation DP applied (slice 2); absent means no DP applied. */
  paidDepositIdr: idr.nonnegative().default(0),
  paidAt: time,
});

const orderRefundedSchema = z.object({
  refundId: id,
  orderId: id,
  outletId: z.string().uuid(),
  grossSalesIdr: idr,
  discountIdr: idr,
  serviceChargeIdr: idr,
  pbjtIdr: idr,
  refundCashIdr: idr,
  refundGatewayIdr: idr,
  refundEdcIdr: idr,
  refundPointsIdr: idr,
  refundedAt: time,
});

const paymentPaidSchema = z.object({
  intentId: z.string().uuid(),
  receivedIdr: idr,
  paidAt: time.nullable().optional(),
});

const fundsUnallocatedSchema = z.object({
  unallocatedFundId: z.string().uuid(),
  intentId: z.string().uuid(),
  receivedIdr: idr,
  receivedAt: time,
});

const paymentRefundedSchema = z.object({
  refundId: z.string().uuid(),
  paymentIntentId: z.string().uuid(),
  amountIdr: idr,
});

const reservationClosedSchema = z.object({
  reservationId: z.string().uuid(),
  depositForfeitedIdr: idr.nonnegative(),
});

const shiftClosedSchema = z.object({
  shiftId: z.string().uuid(),
  outletId: z.string().uuid(),
  /** countedIdr - expectedIdr: positive = over, negative = short. */
  differenceIdr: idr,
  closedAt: time,
});

const PAYMENT_SCHEMAS = {
  "payment.paid": paymentPaidSchema,
  "payment.funds_unallocated": fundsUnallocatedSchema,
  "payment.refunded": paymentRefundedSchema,
} as const;

/**
 * What the consumer stores and rebuilds from: the event identity plus the
 * picked payload (ids, amounts, times; never personal data).
 */
export type StoredAutoJournalEvent = {
  readonly eventId: string;
  readonly eventName: AutoJournalEventName;
  readonly outletId: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
};

export type AutoJournalFact = {
  readonly ruleEvent: AutoJournalEventName;
  readonly amounts: Record<string, number>;
  readonly sourceId: string;
  readonly outletId: string;
  readonly moneyTime: Date;
};

/**
 * Picks the stored subset of an event; throws a ZodError or
 * AutoJournalPayloadInvalid on a payload it cannot read.
 */
export function storedEventOf(event: {
  id: string;
  name: AutoJournalEventName;
  outletId: string | null;
  occurredAt: string;
  payload: unknown;
}): StoredAutoJournalEvent {
  const base = { eventId: event.id, eventName: event.name };
  const occurredAt = event.occurredAt;
  switch (event.name) {
    case "order.paid": {
      const payload = orderPaidSchema.parse(event.payload);
      return { ...base, outletId: payload.outletId, occurredAt, payload };
    }
    case "order.refunded": {
      const payload = orderRefundedSchema.parse(event.payload);
      return { ...base, outletId: payload.outletId, occurredAt, payload };
    }
    case "payment.paid":
    case "payment.funds_unallocated":
    case "payment.refunded": {
      const payload = PAYMENT_SCHEMAS[event.name].parse(event.payload);
      if (event.outletId === null)
        throw new AutoJournalPayloadInvalid(
          `${event.name} event has no outlet`,
        );
      return { ...base, outletId: event.outletId, occurredAt, payload };
    }
    case "reservation.cancelled":
    case "reservation.no_show": {
      const payload = reservationClosedSchema.parse(event.payload);
      if (event.outletId === null)
        throw new AutoJournalPayloadInvalid(
          `${event.name} event has no outlet`,
        );
      return { ...base, outletId: event.outletId, occurredAt, payload };
    }
    case "cashier_shift.closed": {
      const payload = shiftClosedSchema.parse(event.payload);
      return { ...base, outletId: payload.outletId, occurredAt, payload };
    }
  }
}

const IDEMPOTENCY_KEY_MAX = 100;

function boundedKey(key: string): string {
  if (key.length <= IDEMPOTENCY_KEY_MAX) return key;
  return `aj:${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * Receipt key of a gateway intent: one per intent, so payment.paid replayed
 * under another event id posts once, and order.paid can look it up.
 */
export function receiptKeyOf(intentId: string): string {
  return boundedKey(`aj:receipt:${intentId}`);
}

/** Parking key of an event whose payload cannot be read at all. */
export function invalidEventKeyOf(eventId: string): string {
  return boundedKey(`aj:invalid:${eventId}`);
}

/** Business-fact key (design section 4), sha256 above 100 characters. */
export function autoJournalKeyOf(stored: StoredAutoJournalEvent): string {
  const p = stored.payload;
  switch (stored.eventName) {
    case "order.paid":
      return boundedKey(`aj:sale:${String(p.orderId)}`);
    case "order.refunded":
      return boundedKey(`aj:order-refund:${String(p.refundId)}`);
    case "payment.paid":
      return receiptKeyOf(String(p.intentId));
    case "payment.funds_unallocated":
      return boundedKey(`aj:receipt-fund:${String(p.unallocatedFundId)}`);
    case "payment.refunded":
      return boundedKey(`aj:payout:${String(p.refundId)}`);
    case "reservation.cancelled":
    case "reservation.no_show":
      return boundedKey(`aj:dp-forfeit:${String(p.reservationId)}`);
    case "cashier_shift.closed":
      return boundedKey(`aj:shift:${String(p.shiftId)}`);
  }
}

type ReceiptState = "posted" | "pending" | "none";

/**
 * Receipt state of each intent in `intentIds` (cutover/ordering guard):
 * - "posted": the receipt journal exists, the tender debits customer_deposit;
 * - "pending": payment.paid is still in the outbox (pending, retrying, dead
 *   letter) or its receipt is parked retryable; the sale must wait, or the
 *   gateway money would be counted twice;
 * - "none": the receipt will never post by itself (payment.paid consumed
 *   before the consumer went live or with accounting off, never emitted, or
 *   parked non-retryable), so the tender books the money once, the
 *   pre-deposit way, Dr gateway_clearing.
 * Read order outbox, parked, journals: each later source is written by the
 * same transaction that clears the earlier one (consumption marks the outbox
 * row delivered with the receipt journal or its parked row; the sweep inserts
 * the journal and deletes the parked row), so under read committed a receipt
 * that commits between two reads is seen as pending or posted, never as none.
 * Fails closed on an unknown or EDC-linked intent (EDC money is not gateway
 * money).
 */
async function receiptStatesOf(
  tx: Tx,
  tenantId: TenantId,
  intentIds: readonly string[],
): Promise<Map<string, ReceiptState>> {
  const ids = [...new Set(intentIds)];
  const states = new Map<string, ReceiptState>(
    ids.map((intentId) => [intentId, "none"]),
  );
  if (ids.length === 0) return states;
  const intents = await tx
    .select({
      id: paymentIntents.id,
      edcTransactionId: paymentIntents.edcTransactionId,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.id, ids),
      ),
    );
  if (intents.length !== ids.length)
    throw new AutoJournalPayloadInvalid(
      "Payment intent of a gateway tender not found",
    );
  if (intents.some((intent) => intent.edcTransactionId !== null))
    throw new AutoJournalPayloadInvalid(
      "Gateway tender is linked to an EDC transaction",
    );
  // 1. Outbox first (see the ordering note above).
  const undelivered = await tx
    .select({ intentId: domainEventOutbox.aggregateId })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, "payment"),
        inArray(domainEventOutbox.aggregateId, ids),
        sql`${domainEventOutbox.event}->>'name' = 'payment.paid'`,
        ne(domainEventOutbox.status, "delivered"),
      ),
    );
  for (const row of undelivered) states.set(row.intentId, "pending");
  const intentByKey = new Map(
    ids.map((intentId) => [receiptKeyOf(intentId), intentId]),
  );
  const keys = [...intentByKey.keys()];
  // 2. Then the parked receipts: only a retryable one can still post.
  const parked = await tx
    .select({
      key: autoJournalParked.idempotencyKey,
      retryable: autoJournalParked.retryable,
    })
    .from(autoJournalParked)
    .where(
      and(
        eq(autoJournalParked.tenantId, tenantId),
        inArray(autoJournalParked.idempotencyKey, keys),
      ),
    );
  for (const row of parked) {
    const intentId = intentByKey.get(row.key);
    if (intentId !== undefined && row.retryable)
      states.set(intentId, "pending");
  }
  // 3. Last the receipt journals (they win over pending).
  const posted = await tx
    .select({ key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        inArray(journalEntries.idempotencyKey, keys),
      ),
    );
  const postedIds = new Set<string>();
  for (const row of posted) {
    const intentId = row.key === null ? undefined : intentByKey.get(row.key);
    if (intentId !== undefined) postedIds.add(intentId);
  }
  for (const intentId of postedIds) states.set(intentId, "posted");
  return states;
}

/** DP intents that took money: their receipts decide where the DP sits. */
const DP_INTENT_STATUSES = ["paid", "partially_refunded", "refunded"] as const;

/**
 * Where a DP is booked (the cutover guard of receiptStatesOf, applied to the
 * exact DP intents behind the money: the session's allocation intents for a
 * DP applied, reservations.deposit_payment_id for a forfeit; a second or
 * duplicate intent of the reservation never counts):
 * - "deposit": every receipt posted, the DP sits in customer_deposit;
 * - "gateway": no receipt will ever post (DP paid before the cutover), the DP
 *   was never booked and still sits in gateway_clearing only;
 * - any receipt pending: AutoJournalReceiptPending (retryable);
 * - posted and none mixed: AutoJournalDepositCutoverMixed (not retryable);
 * - an intent missing or that never took money: AutoJournalPayloadInvalid;
 * - an EDC-linked intent fails closed (receiptStatesOf).
 */
export async function depositReceiptOf(
  tx: Tx,
  tenantId: TenantId,
  intentIds: readonly string[],
): Promise<"deposit" | "gateway"> {
  const ids = [...new Set(intentIds)];
  if (ids.length === 0)
    throw new AutoJournalPayloadInvalid("DP has no payment intent");
  const intents = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.id, ids),
        inArray(paymentIntents.status, [...DP_INTENT_STATUSES]),
      ),
    );
  if (intents.length !== ids.length)
    throw new AutoJournalPayloadInvalid(
      "DP payment intent not found or never paid",
    );
  const states = [...(await receiptStatesOf(tx, tenantId, ids)).values()];
  if (states.includes("pending"))
    throw new AutoJournalReceiptPending("DP receipt is not booked yet");
  if (states.every((state) => state === "posted")) return "deposit";
  if (states.every((state) => state === "none")) return "gateway";
  throw new AutoJournalDepositCutoverMixed(
    "DP receipts are partly booked and partly before the cutover",
  );
}

/**
 * Where the DP applied to an order is booked: the order row must carry exactly
 * the DP the event reports, the session's live orders together may not apply
 * more DP than the allocation intents still hold (a DP refunded after seating
 * would otherwise leave customer_deposit twice), and the allocation intents
 * must agree (depositReceiptOf).
 */
/**
 * DP of one table session: its allocation intents, what they still hold
 * (same hold rule as the reservation module's loadHeldDeposit: zero unless
 * the intent is paid / partially_refunded, else its amount minus every
 * non-failed refund reserved against it, unallocated-fund payouts aside)
 * and the DP its orders applied. "live" counts every non-voided order (the
 * sale being posted included); "completed" only sales whose order.paid
 * already debited customer_deposit or will.
 *
 * With `asOf` (a refund being journaled) the hold is read as it stood right
 * after that refund: only completed refunds up to it (completedAt, then id)
 * plus the refund itself, so a later or still pending refund never parks an
 * earlier valid one, and an intent a later refund emptied still counts.
 */
async function sessionDepositOf(
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
  orderScope: "live" | "completed",
  asOf?: { refundId: string; completedAt: Date | null },
): Promise<{ intentIds: string[]; heldIdr: bigint; appliedIdr: bigint }> {
  const allocations = await tx
    .select({ paymentIntentId: reservationDepositAllocations.paymentIntentId })
    .from(reservationDepositAllocations)
    .where(
      and(
        eq(reservationDepositAllocations.tenantId, tenantId),
        eq(reservationDepositAllocations.tableSessionId, tableSessionId),
      ),
    );
  const intentIds = [...new Set(allocations.map((row) => row.paymentIntentId))];
  if (intentIds.length === 0)
    return { intentIds, heldIdr: 0n, appliedIdr: 0n };
  const intents = await tx
    .select({
      id: paymentIntents.id,
      status: paymentIntents.status,
      amountIdr: paymentIntents.amountIdr,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.id, intentIds),
      ),
    );
  const refunds = await tx
    .select({
      intentId: paymentRefunds.paymentIntentId,
      total: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}), 0)::text`,
    })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        inArray(paymentRefunds.paymentIntentId, intentIds),
        isNull(paymentRefunds.unallocatedFundId),
        asOf === undefined
          ? sql`${paymentRefunds.status} <> 'failed'`
          : asOf.completedAt === null
            ? eq(paymentRefunds.id, asOf.refundId)
            : sql`(${paymentRefunds.id} = ${asOf.refundId} OR (
                ${paymentRefunds.status} = 'completed'
                AND ${paymentRefunds.completedAt} IS NOT NULL
                AND (${paymentRefunds.completedAt}, ${paymentRefunds.id})
                    < (${asOf.completedAt.toISOString()}::timestamptz, ${asOf.refundId}::uuid)))`,
      ),
    )
    .groupBy(paymentRefunds.paymentIntentId);
  const refundedBy = new Map(
    refunds.map((row) => [row.intentId, BigInt(row.total)]),
  );
  let heldIdr = 0n;
  for (const intent of intents) {
    // A later refund may since have moved the intent to "refunded".
    const holds =
      depositHoldsFunds(intent.status) ||
      (asOf !== undefined && intent.status === "refunded");
    if (!holds) continue;
    const held = BigInt(intent.amountIdr) - (refundedBy.get(intent.id) ?? 0n);
    if (held > 0n) heldIdr += held;
  }
  const [applied] = await tx
    .select({
      total: sql<string>`coalesce(sum(${orders.depositAppliedIdr}), 0)::text`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.tableSessionId, tableSessionId),
        orderScope === "live"
          ? ne(orders.status, "voided")
          : eq(orders.status, "completed"),
      ),
    );
  return { intentIds, heldIdr, appliedIdr: BigInt(applied?.total ?? "0") };
}

/**
 * legend-e7zj interim guard: a refund of a DP intent whose DP a completed
 * sale already took from customer_deposit would debit it twice. Fail closed
 * until the refund module refuses such a refund.
 */
async function assertRefundLeavesAppliedDeposit(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
  refund: { refundId: string; completedAt: Date | null },
): Promise<void> {
  const sessions = await tx
    .selectDistinct({
      tableSessionId: reservationDepositAllocations.tableSessionId,
    })
    .from(reservationDepositAllocations)
    .where(
      and(
        eq(reservationDepositAllocations.tenantId, tenantId),
        eq(reservationDepositAllocations.paymentIntentId, intentId),
      ),
    );
  for (const { tableSessionId } of sessions) {
    const { heldIdr, appliedIdr } = await sessionDepositOf(
      tx,
      tenantId,
      tableSessionId,
      "completed",
      refund,
    );
    if (appliedIdr > heldIdr)
      throw new AccountingError(
        "POSTING_AMOUNTS_MISMATCH",
        "Refund of a DP that a completed sale already applied",
      );
  }
}

async function orderDepositReceiptOf(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  paidDepositIdr: number,
): Promise<"deposit" | "gateway"> {
  const [order] = await tx
    .select({
      depositAppliedIdr: orders.depositAppliedIdr,
      tableSessionId: orders.tableSessionId,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)));
  if (!order)
    throw new AutoJournalPayloadInvalid("Order of the event not found");
  if (Number(order.depositAppliedIdr) !== paidDepositIdr)
    throw new AccountingError(
      "POSTING_AMOUNTS_MISMATCH",
      "paidDepositIdr does not match the DP applied to the order",
    );
  if (order.tableSessionId === null)
    throw new AutoJournalPayloadInvalid("Order with a DP has no table session");
  const { intentIds, heldIdr, appliedIdr } = await sessionDepositOf(
    tx,
    tenantId,
    order.tableSessionId,
    "live",
  );
  if (intentIds.length === 0)
    throw new AutoJournalPayloadInvalid(
      "Order with a DP has no reservation deposit on its session",
    );
  if (appliedIdr > heldIdr)
    throw new AccountingError(
      "POSTING_AMOUNTS_MISMATCH",
      "DP applied by the session exceeds what its DP intents still hold",
    );
  return depositReceiptOf(tx, tenantId, intentIds);
}

/** EDC-linked intents post through edc_clearing, never as gateway receipts. */
async function intentOf(tx: Tx, tenantId: TenantId, intentId: string) {
  const [intent] = await tx
    .select({
      outletId: paymentIntents.outletId,
      edcTransactionId: paymentIntents.edcTransactionId,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, intentId),
      ),
    );
  if (!intent)
    throw new AutoJournalPayloadInvalid(
      "Payment intent of the event not found",
    );
  return intent;
}

/**
 * Rule input of one stored event, or null when the event books nothing
 * (EDC-linked intent on a payment event, zero receipt, zero forfeit, zero
 * shift difference). Re-reads only rows that are final once
 * the event exists (captured tenders, the intent, the completed refund).
 */
export async function autoJournalFactOf(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
): Promise<AutoJournalFact | null> {
  switch (stored.eventName) {
    case "order.paid": {
      const p = orderPaidSchema.parse(stored.payload);
      const tenders = await tx
        .select({
          method: posOrderTenders.method,
          amountIdr: posOrderTenders.amountIdr,
          paymentIntentId: posOrderTenders.paymentIntentId,
        })
        .from(posOrderTenders)
        .where(
          and(
            eq(posOrderTenders.tenantId, tenantId),
            eq(posOrderTenders.orderId, p.orderId),
            eq(posOrderTenders.status, "captured"),
          ),
        );
      let gatewayIdr = 0;
      const intentTenders: { intentId: string; amountIdr: number }[] = [];
      for (const tender of tenders) {
        let bucket: ReturnType<typeof tenderBucket>;
        try {
          bucket = tenderBucket(tender.method as never);
        } catch {
          throw new AutoJournalPayloadInvalid(
            "Captured tender has an unknown method",
          );
        }
        if (bucket !== "gateway") continue;
        gatewayIdr += tender.amountIdr;
        if (tender.paymentIntentId !== null)
          intentTenders.push({
            intentId: tender.paymentIntentId,
            amountIdr: tender.amountIdr,
          });
      }
      if (gatewayIdr !== p.paidGatewayIdr)
        throw new AccountingError(
          "POSTING_AMOUNTS_MISMATCH",
          "Captured gateway tenders do not match paidGatewayIdr",
        );
      const states = await receiptStatesOf(
        tx,
        tenantId,
        intentTenders.map((tender) => tender.intentId),
      );
      let withReceipt = 0;
      for (const tender of intentTenders) {
        const state = states.get(tender.intentId);
        if (state === "pending")
          throw new AutoJournalReceiptPending(
            "Gateway receipt of a tender is not booked yet",
          );
        if (state === "posted") withReceipt += tender.amountIdr;
      }
      // DP applied: out of customer_deposit when its receipt is booked, else
      // (paid before the cutover) gateway money like a tender without receipt.
      let paidDepositIdr = 0;
      let depositGatewayIdr = 0;
      if (p.paidDepositIdr > 0) {
        const source = await orderDepositReceiptOf(
          tx,
          tenantId,
          p.orderId,
          p.paidDepositIdr,
        );
        if (source === "deposit") paidDepositIdr = p.paidDepositIdr;
        else depositGatewayIdr = p.paidDepositIdr;
      }
      return {
        ruleEvent: "order.paid",
        amounts: {
          paidCashIdr: p.paidCashIdr,
          paidGatewayIntentIdr: withReceipt,
          paidDepositIdr,
          paidGatewayIdr: gatewayIdr - withReceipt + depositGatewayIdr,
          paidEdcIdr: p.paidEdcIdr,
          paidPointsIdr: p.paidPointsIdr,
          discountIdr: p.discountIdr,
          grossSalesIdr: p.grossSalesIdr,
          serviceChargeIdr: p.serviceChargeIdr,
          pbjtIdr: p.pbjtIdr,
          roundingIdr: p.roundingIdr,
        },
        sourceId: p.orderId,
        outletId: p.outletId,
        moneyTime: new Date(p.paidAt),
      };
    }
    case "order.refunded": {
      const p = orderRefundedSchema.parse(stored.payload);
      return {
        ruleEvent: "order.refunded",
        amounts: {
          grossSalesIdr: p.grossSalesIdr,
          serviceChargeIdr: p.serviceChargeIdr,
          pbjtIdr: p.pbjtIdr,
          discountIdr: p.discountIdr,
          refundCashIdr: p.refundCashIdr,
          refundGatewayIdr: p.refundGatewayIdr,
          refundEdcIdr: p.refundEdcIdr,
          refundPointsIdr: p.refundPointsIdr,
        },
        sourceId: p.refundId,
        outletId: p.outletId,
        moneyTime: new Date(p.refundedAt),
      };
    }
    case "payment.paid": {
      const p = paymentPaidSchema.parse(stored.payload);
      if (p.receivedIdr <= 0) return null;
      const intent = await intentOf(tx, tenantId, p.intentId);
      if (intent.edcTransactionId !== null) return null;
      return {
        ruleEvent: "payment.paid",
        amounts: { receivedIdr: p.receivedIdr },
        sourceId: p.intentId,
        outletId: intent.outletId,
        moneyTime: new Date(p.paidAt ?? stored.occurredAt),
      };
    }
    case "payment.funds_unallocated": {
      const p = fundsUnallocatedSchema.parse(stored.payload);
      if (p.receivedIdr <= 0) return null;
      const [fund] = await tx
        .select({
          outletId: paymentUnallocatedFunds.outletId,
          paymentIntentId: paymentUnallocatedFunds.paymentIntentId,
          amountIdr: paymentUnallocatedFunds.amountIdr,
        })
        .from(paymentUnallocatedFunds)
        .where(
          and(
            eq(paymentUnallocatedFunds.tenantId, tenantId),
            eq(paymentUnallocatedFunds.id, p.unallocatedFundId),
          ),
        );
      if (
        !fund ||
        fund.paymentIntentId !== p.intentId ||
        Number(fund.amountIdr) !== p.receivedIdr
      )
        throw new AutoJournalPayloadInvalid(
          "Unallocated fund of the event not found or different",
        );
      const intent = await intentOf(tx, tenantId, p.intentId);
      // Same as payment.refunded: the payout of a fund on an EDC-linked
      // intent books nothing, so its receipt books nothing either.
      if (intent.edcTransactionId !== null) return null;
      return {
        ruleEvent: "payment.funds_unallocated",
        amounts: { receivedIdr: p.receivedIdr },
        sourceId: p.unallocatedFundId,
        outletId: fund.outletId,
        moneyTime: new Date(p.receivedAt),
      };
    }
    case "payment.refunded": {
      const p = paymentRefundedSchema.parse(stored.payload);
      if (p.amountIdr <= 0) return null;
      const intent = await intentOf(tx, tenantId, p.paymentIntentId);
      if (intent.edcTransactionId !== null) return null;
      const [refund] = await tx
        .select({
          outletId: paymentRefunds.outletId,
          completedAt: paymentRefunds.completedAt,
          unallocatedFundId: paymentRefunds.unallocatedFundId,
        })
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.tenantId, tenantId),
            eq(paymentRefunds.id, p.refundId),
          ),
        );
      if (!refund)
        throw new AutoJournalPayloadInvalid(
          "Payment refund of the event not found",
        );
      // A payout of an unallocated fund (duplicate or extra payment) never
      // takes DP.
      if (refund.unallocatedFundId === null)
        await assertRefundLeavesAppliedDeposit(tx, tenantId, p.paymentIntentId, {
          refundId: p.refundId,
          completedAt: refund.completedAt,
        });
      return {
        ruleEvent: "payment.refunded",
        amounts: { amountIdr: p.amountIdr },
        sourceId: p.refundId,
        outletId: refund.outletId,
        moneyTime: refund.completedAt ?? new Date(stored.occurredAt),
      };
    }
    case "reservation.cancelled":
    case "reservation.no_show": {
      const p = reservationClosedSchema.parse(stored.payload);
      if (p.depositForfeitedIdr === 0) return null;
      const [reservation] = await tx
        .select({
          outletId: reservations.outletId,
          status: reservations.status,
          depositForfeitedIdr: reservations.depositForfeitedIdr,
          depositPaymentId: reservations.depositPaymentId,
        })
        .from(reservations)
        .where(
          and(
            eq(reservations.tenantId, tenantId),
            eq(reservations.id, p.reservationId),
          ),
        );
      const closedAs =
        stored.eventName === "reservation.cancelled" ? "cancelled" : "no_show";
      if (
        !reservation ||
        reservation.outletId !== stored.outletId ||
        reservation.status !== closedAs
      )
        throw new AutoJournalPayloadInvalid(
          "Reservation of the event not found, of another outlet or not closed so",
        );
      // The close writes the forfeit to the row in the same transaction as
      // the event, and nothing changes it afterwards.
      if (Number(reservation.depositForfeitedIdr) !== p.depositForfeitedIdr)
        throw new AccountingError(
          "POSTING_AMOUNTS_MISMATCH",
          "depositForfeitedIdr does not match the reservation",
        );
      // Only the DP intent the close split (deposit_payment_id) decides.
      if (reservation.depositPaymentId === null)
        throw new AutoJournalPayloadInvalid(
          "Reservation with a forfeit has no DP payment intent",
        );
      const source = await depositReceiptOf(tx, tenantId, [
        reservation.depositPaymentId,
      ]);
      return {
        ruleEvent: stored.eventName,
        amounts: {
          forfeitedIdr: source === "deposit" ? p.depositForfeitedIdr : 0,
          forfeitedGatewayIdr: source === "gateway" ? p.depositForfeitedIdr : 0,
        },
        sourceId: p.reservationId,
        outletId: stored.outletId,
        moneyTime: new Date(stored.occurredAt),
      };
    }
    case "cashier_shift.closed": {
      const p = shiftClosedSchema.parse(stored.payload);
      if (p.differenceIdr === 0) return null;
      const [shift] = await tx
        .select({
          outletId: posShifts.outletId,
          status: posShifts.status,
          varianceIdr: posShifts.varianceIdr,
        })
        .from(posShifts)
        .where(
          and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, p.shiftId)),
        );
      if (!shift || shift.status !== "closed" || shift.outletId !== p.outletId)
        throw new AutoJournalPayloadInvalid(
          "Shift of the event not found, open or of another outlet",
        );
      if (
        shift.varianceIdr === null ||
        Number(shift.varianceIdr) !== p.differenceIdr
      )
        throw new AccountingError(
          "POSTING_AMOUNTS_MISMATCH",
          "differenceIdr does not match the shift variance",
        );
      return {
        ruleEvent: "cashier_shift.closed",
        amounts: { differenceIdr: p.differenceIdr },
        sourceId: p.shiftId,
        outletId: shift.outletId,
        moneyTime: new Date(p.closedAt),
      };
    }
  }
}
