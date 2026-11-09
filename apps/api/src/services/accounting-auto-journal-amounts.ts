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
// Slice 4 adds the bank settlements: settlement.reconciled (gateway) and
// edc_transaction.settled (EDC) post Dr bank net, Dr gateway_fee_expense fee,
// Cr clearing gross, dated settledOn (AutoJournalFact.entryDate). The payload
// is the whole fact; there is no backing guard (see autoJournalFactOf).
//
// legend-9pz9 (design section 10): a payout, a forfeit and a sale are judged
// at their own moment (accounting-auto-journal-guards.ts), never against
// current state, so the verdict does not depend on event delivery order.
// order.voided is only stored and keyed here; the consumer rebuilds its fact
// in accounting-auto-journal-void.ts.
//
// A payload, row or method that can never post as sent throws
// AutoJournalPayloadInvalid (or a ZodError): the consumer parks it as
// non-retryable AUTO_JOURNAL_PAYLOAD_INVALID instead of failing the outbox
// consumption.

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { AccountingError } from "@starter/shared/accounting";
import type { ScopedTenantContext } from "@starter/shared/core";
import { tenderBucket } from "@starter/shared/pos";
import {
  edcTransactionSettledPayloadSchema,
  settlementReconciledPayloadSchema,
} from "@starter/shared/payment";
import {
  orders,
  paymentIntents,
  paymentRefunds,
  paymentUnallocatedFunds,
  posOrderTenders,
  posShifts,
  reservations,
} from "../db/schema/index.ts";
import {
  assertForfeitWithinIntent,
  assertPayoutWithinReceipt,
  backingKeyOf,
  backingStateOf,
  backingStatesOf,
  DP_INTENT_STATUSES,
  payoutBackingOf,
  saleBoundOf,
  sessionDepositAt,
} from "./accounting-auto-journal-guards.ts";
import type { Tx } from "./inventory-ops.shared.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

export const AUTO_JOURNAL_EVENTS = [
  "order.paid",
  "order.refunded",
  "order.voided",
  "payment.paid",
  "payment.funds_unallocated",
  "payment.refunded",
  "reservation.cancelled",
  "reservation.no_show",
  "cashier_shift.closed",
  "settlement.reconciled",
  "edc_transaction.settled",
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
 * payment.refunded paid out of a receipt that will never post (payment.paid
 * consumed before the consumer went live, never emitted, or parked non-
 * retryable): parked, never retried.
 */
export class AutoJournalReceiptMissing extends Error {
  readonly code = "AUTO_JOURNAL_RECEIPT_MISSING";
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

/**
 * order.voided as the consumer stores it. Only a void of a completed sale
 * (voidedFinalOrder) is journaled; an open-order void books nothing.
 */
export const orderVoidedStoredSchema = z.object({
  orderId: id,
  outletId: z.string().uuid(),
  voidId: id.nullable(),
  amountIdr: idr,
  voidedFinalOrder: z.boolean(),
  voidedAt: time,
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
  /**
   * Business date of the journal when the fact is a date, not an instant
   * (bank settlement date). The consumer uses it as is, instead of deriving a
   * date from `moneyTime` (timezone and business-day cutoff would shift it).
   */
  readonly entryDate?: string;
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
    case "order.voided": {
      const payload = orderVoidedStoredSchema.parse(event.payload);
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
    case "settlement.reconciled": {
      const payload = settlementReconciledPayloadSchema.parse(event.payload);
      assertEnvelopeOutlet(event, payload.outletId);
      return { ...base, outletId: payload.outletId, occurredAt, payload };
    }
    case "edc_transaction.settled": {
      const payload = edcTransactionSettledPayloadSchema.parse(event.payload);
      assertEnvelopeOutlet(event, payload.outletId);
      return { ...base, outletId: payload.outletId, occurredAt, payload };
    }
  }
}

/** An envelope outlet, when set, must be the payload outlet. */
function assertEnvelopeOutlet(
  event: { name: string; outletId: string | null },
  payloadOutletId: string,
): void {
  if (event.outletId !== null && event.outletId !== payloadOutletId)
    throw new AutoJournalPayloadInvalid(
      `${event.name} envelope outlet differs from the payload outlet`,
    );
}

const IDEMPOTENCY_KEY_MAX = 100;

export function boundedKey(key: string): string {
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
    case "order.voided":
      return boundedKey(`aj:sale-void:${String(p.orderId)}`);
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
    case "settlement.reconciled":
      return boundedKey(`aj:settlement:${String(p.settlementId)}`);
    case "edc_transaction.settled":
      return boundedKey(`aj:edc-settlement:${String(p.settlementBatchId)}`);
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
 * Read order and ordering note: backingStatesOf. Fails closed on an unknown or EDC-linked intent (EDC money is not gateway
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
  const backingStates = await backingStatesOf(
    tx,
    tenantId,
    ids.map((intentId) => ({ kind: "intent", intentId })),
  );
  for (const intentId of ids)
    states.set(
      intentId,
      backingStates.get(backingKeyOf({ kind: "intent", intentId })) ?? "none",
    );
  return states;
}

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
 * the DP the event reports, the session's sales completed by this sale
 * (bound S, this one included) together may not apply more DP than the
 * allocation intents still held right before it (a DP refunded or forfeited
 * before the sale would otherwise leave customer_deposit twice), and the
 * allocation intents must agree (depositReceiptOf). Facts after S never count.
 */
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
  const sale = await saleBoundOf(tx, tenantId, orderId);
  const { intentIds, heldIdr, appliedIdr } = await sessionDepositAt(
    tx,
    tenantId,
    order.tableSessionId,
    sale,
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
    case "order.voided":
      throw new Error("order.voided is handled by voidFactOf");
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
          status: paymentRefunds.status,
          completedAt: paymentRefunds.completedAt,
          amountIdr: paymentRefunds.amountIdr,
          paymentIntentId: paymentRefunds.paymentIntentId,
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
      // The refund is judged at its own completion: it must be final and be
      // the one the event reports.
      if (
        refund.status !== "completed" ||
        refund.completedAt === null ||
        Number(refund.amountIdr) !== p.amountIdr ||
        refund.paymentIntentId !== p.paymentIntentId
      )
        throw new AutoJournalPayloadInvalid(
          "Payment refund is not completed or differs from the event",
        );
      // The payout leaves the receipt that holds its money: the fund's own
      // receipt, else the intent's (an intent refund, or a fund the intent's
      // payment.paid already counts).
      const backing = await payoutBackingOf(tx, tenantId, {
        intentId: p.paymentIntentId,
        unallocatedFundId: refund.unallocatedFundId,
      });
      const backingState = await backingStateOf(tx, tenantId, backing);
      if (backingState === "pending")
        throw new AutoJournalReceiptPending(
          "Receipt behind a payout is not booked yet",
        );
      if (backingState === "none")
        throw new AutoJournalReceiptMissing(
          "Receipt behind a payout will never be booked",
        );
      await assertPayoutWithinReceipt(tx, tenantId, backing, {
        refundId: p.refundId,
        completedAt: refund.completedAt,
        intentId: p.paymentIntentId,
        unallocatedFundId: refund.unallocatedFundId,
      });
      return {
        ruleEvent: "payment.refunded",
        amounts: { amountIdr: p.amountIdr },
        sourceId: p.refundId,
        outletId: refund.outletId,
        moneyTime: refund.completedAt,
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
          closedAt: reservations.closedAt,
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
      // The forfeit and the refunds that were final before it may not take
      // more than the DP intent took (a later refund parks itself instead).
      if (reservation.closedAt === null)
        throw new AutoJournalPayloadInvalid(
          "Closed reservation has no close time",
        );
      await assertForfeitWithinIntent(
        tx,
        tenantId,
        reservation.depositPaymentId,
        p.depositForfeitedIdr,
        p.reservationId,
      );
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
    // No backing guard (design section 10): the bank statement is the fact,
    // finance reconciles the clearing account, so an over-settlement is a
    // reconciliation case, not a park. A zero fee posts Dr bank / Cr clearing
    // only (buildJournalLinesFromRule skips a zero amount). The journal is
    // dated settledOn exactly: entryDate, not a date derived from an instant.
    case "settlement.reconciled": {
      const p = settlementReconciledPayloadSchema.parse(stored.payload);
      return {
        ruleEvent: "settlement.reconciled",
        amounts: {
          grossIdr: p.grossIdr,
          feeIdr: p.feeIdr,
          netSettledIdr: p.netSettledIdr,
        },
        sourceId: p.settlementId,
        outletId: p.outletId,
        moneyTime: new Date(`${p.settledOn}T00:00:00.000Z`),
        entryDate: p.settledOn,
      };
    }
    case "edc_transaction.settled": {
      const p = edcTransactionSettledPayloadSchema.parse(stored.payload);
      return {
        ruleEvent: "edc_transaction.settled",
        amounts: {
          grossIdr: p.grossIdr,
          feeIdr: p.feeIdr,
          netSettledIdr: p.netSettledIdr,
        },
        sourceId: p.settlementBatchId,
        outletId: p.outletId,
        moneyTime: new Date(`${p.settledOn}T00:00:00.000Z`),
        entryDate: p.settledOn,
      };
    }
  }
}
