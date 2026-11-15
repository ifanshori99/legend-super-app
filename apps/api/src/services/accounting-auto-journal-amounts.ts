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
// in accounting-auto-journal-void.ts. order_issue.refund_reversal_requested
// (legend-94q2l, a rejected recovery refund) is the same: its fact is rebuilt
// in accounting-auto-journal-recovery-refund.ts.
//
// Slice 3 (legend-9pz9, legend-kej3, legend-fbms): a QR pay-first order (no
// pos_orders row) emits order.paid when it fires. It has no tenders: what
// is left after the DP (total - DP) was paid by the intent pinned on
// orders.payment_intent_id, receipt-first like a POS gateway tender. An
// order.paid with every amount 0 books nothing (null).
//
// legend-msqvi (D-msqvi, PSAK 72): the five points.* events post the loyalty
// journal. The ledger entry id comes from the envelope idempotency key
// (`<event name>:<ledgerEntryId>`, point-ledger.service.ts), and the amount is
// the signed liability_idr of that point_ledger row, never the payload. The
// tenant must have exactly one legal entity; the anchor outlet (oldest outlet
// of that entity) gives the business-day clock and owns a parked row.
//
// A payload, row or method that can never post as sent throws
// AutoJournalPayloadInvalid (or a ZodError): the consumer parks it as
// non-retryable AUTO_JOURNAL_PAYLOAD_INVALID instead of failing the outbox
// consumption.

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AccountingError,
  type PostingAccountRole,
} from "@starter/shared/accounting";
import type { ScopedTenantContext } from "@starter/shared/core";
import { goodsReceiptValueIdr } from "@starter/shared/inventory";
import { tenderBucket } from "@starter/shared/pos";
import {
  edcTransactionSettledPayloadSchema,
  settlementReconciledPayloadSchema,
} from "@starter/shared/payment";
import {
  accountMappings,
  cashMovements,
  domainEventOutbox,
  goodsReceiptLines,
  journalEntries,
  loyaltyPrograms,
  orderIssueCharges,
  orders,
  outlets,
  paymentIntents,
  paymentRefunds,
  paymentUnallocatedFunds,
  pointLedger,
  posDepositRefunds,
  posOrderRefunds,
  posOrders,
  posOrderTenders,
  posShifts,
  reservations,
  tenants,
} from "../db/schema/index.ts";
import {
  assertForfeitWithinIntent,
  assertPayoutWithinReceipt,
  assertSaleWithinReceipt,
  type Bound,
  assertChargeWithinReceipt,
  backingKeyOf,
  backingStateOf,
  backingStatesOf,
  chargeBoundOf,
  DP_INTENT_STATUSES,
  payoutBackingOf,
  saleBoundOf,
  sessionDepositAt,
} from "./accounting-auto-journal-guards.ts";
import {
  AutoJournalSaleMissing,
  AutoJournalSalePending,
} from "./accounting-auto-journal-void.ts";
import { isTrainingOrder } from "./device-training.ts";
import { ROUNDING_MODE, type Tx } from "./inventory-ops.shared.ts";
import { purchasingPostingEnabled } from "./purchasing-posting-gate.ts";
import { EVENT_DESTINATION } from "./payment-support.ts";
import { OrderRevenueMismatch, orderRevenueSplit } from "./order-revenue.ts";
import {
  isSplit,
  orderUuidOf,
  refundComponentsOf,
  refundTaxSplitOf,
  saleTaxSplitOf,
  TAX_SPLIT_VARIANT,
} from "./accounting-auto-journal-tax-split.ts";
import { salePostingAccountsOf } from "./accounting-sale-account-history.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

/** legend-msqvi: points.* events journaled from their point_ledger row. */
export const LOYALTY_AUTO_JOURNAL_EVENTS = [
  "points.earned",
  "points.reversed",
  "points.redeemed",
  "points.adjusted",
  "points.expired",
] as const;
export type LoyaltyAutoJournalEventName =
  (typeof LOYALTY_AUTO_JOURNAL_EVENTS)[number];

export function isLoyaltyAutoJournalEvent(
  name: string,
): name is LoyaltyAutoJournalEventName {
  return (LOYALTY_AUTO_JOURNAL_EVENTS as readonly string[]).includes(name);
}

export const AUTO_JOURNAL_EVENTS = [
  "order.paid",
  "order.refunded",
  "order.voided",
  "order_issue.refund_reversal_requested",
  "order_issue.charge_paid",
  "payment.paid",
  "payment.funds_unallocated",
  "payment.refunded",
  "reservation.cancelled",
  "reservation.no_show",
  "cashier_shift.closed",
  // legend-89pn
  "cash_movement.recorded",
  "settlement.reconciled",
  "edc_transaction.settled",
  "goods_receipt.recorded",
  "purchase_return.recorded",
  "petty_purchase.recorded",
  // legend-msqvi
  ...LOYALTY_AUTO_JOURNAL_EVENTS,
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
 * legend-3r6r: order.paid met a gateway tender whose payment.paid has sat dead-
 * lettered past DEAD_LETTERED_RECEIPT_BOUND_MS. Parked non-retryable (the sweep
 * stops, finance sees the distinct code). It is NOT booked through
 * gateway_clearing: replaying the dead letter would then count the money twice.
 * Replaying and booking the receipt releases the row (requeueReceiptDependents).
 */
export class AutoJournalReceiptDeadLettered extends Error {
  readonly code = "AUTO_JOURNAL_RECEIPT_DEAD_LETTERED";
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

/**
 * legend-msqvi: a points event of a tenant whose outlets belong to more than
 * one legal entity. v1 cannot tell which entity owes the points (follow-up:
 * loyalty_programs.legal_entity_id). Parked, never retried.
 */
export class AutoJournalLoyaltyEntityAmbiguous extends Error {
  readonly code = "LOYALTY_LEGAL_ENTITY_AMBIGUOUS";
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
  /** Tender lines (method + amount), absent on events stored without them. */
  lines: z.array(z.object({ method: z.string(), amountIdr: idr })).default([]),
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

/**
 * order_issue.refund_reversal_requested as the consumer stores it (legend-94q2l):
 * the payment module rejected the refund of a failed order item, so the
 * `aj:order-refund:<orderIssueId>` journal is reversed. The outlet is the
 * event envelope outlet.
 */
export const orderIssueRefundReversalStoredSchema = z.object({
  orderId: id,
  orderIssueId: z.string().uuid(),
  refundId: z.string().uuid(),
  amountIdr: idr.refine((value) => value > 0),
  rejectedAt: time,
});

/**
 * order_issue.charge_paid as the consumer stores it (legend-i83ls): the guest
 * paid the swap-difference charge of an issue. Only ids, amounts and the time
 * are kept; the outlet is the event envelope outlet, the charge row is the
 * source of truth for the split.
 */
export const orderIssueChargePaidStoredSchema = z.object({
  orderId: id,
  orderIssueId: z.string().uuid(),
  chargeId: z.string().uuid(),
  /** Null exactly when the charge was paid in cash at the POS (legend-800h1). */
  paymentIntentId: z.string().uuid().nullable(),
  /** Absent on events stored before the cash variant: qr_link. */
  method: z.enum(["qr_link", "pos_cash"]).optional(),
  cashMovementId: z.string().uuid().nullable().optional(),
  grossSalesIdr: idr.nonnegative(),
  serviceChargeIdr: idr.nonnegative(),
  pbjtIdr: idr.nonnegative(),
  amountIdr: idr.refine((value) => value > 0),
  paidAt: time,
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

// legend-89pn: the amount and type are re-read from the stored cash_movements
// row; the payload only names the movement and must agree with the row.
const cashMovementRecordedSchema = z.object({
  movementId: z.string().uuid(),
  shiftId: z.string().uuid(),
  outletId: z.string().uuid(),
  type: z.enum(["cash_in", "cash_out", "drop"]),
  amountIdr: idr,
  recordedAt: time,
});

// Purchasing (legend-1xbs, legend-v3lh). The payload is the whole fact, there
// is no backing guard: the emitting transaction already split the value.
// supplier_invoice.recorded is NOT journaled here: its journal is posted in the
// invoice's own transaction (purchasing-invoice.service.ts).
// goods_receipt.recorded (legend-29vw) is journaled here, but only while the
// purchasing posting flag is on, and its value is re-read from the receipt
// lines (see goodsReceiptFactOf).
const goodsReceiptRecordedSchema = z.object({
  goodsReceiptId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  supplierId: z.string().uuid(),
  // Not in the emitted payload: taken from the envelope outlet and stored here
  // so the sweep can rebuild the fact without the outbox row.
  outletId: z.string().uuid(),
  receivedValueIdr: idr.nonnegative(),
  receivedAt: time,
});
const purchaseReturnRecordedSchema = z.object({
  purchaseReturnId: z.string().uuid(),
  // The debit note against the supplier's open items needs the supplier. Older
  // events lack it: the consumer then reads it from the purchase_returns row.
  supplierId: z.string().uuid().optional(),
  outletId: z.string().uuid(),
  valueIdr: idr.nonnegative(),
  uninvoicedValueIdr: idr.nonnegative(),
  invoicedValueIdr: idr.nonnegative(),
  // Signed: billed value minus order-price value of the invoiced part. Events
  // recorded before legend-5b7uf lack it and replay as 0.
  returnPriceVarianceIdr: idr.default(0),
  // Signed: lines at receipt cost minus qty x moving average before the
  // return (legend-uloj6). Events recorded before it lack it and replay as 0.
  movingAvgVarianceIdr: idr.default(0),
  ppnIdr: idr.nonnegative(),
  returnedAt: time,
});

const pettyPurchaseRecordedSchema = z.object({
  pettyPurchaseId: z.string().uuid(),
  outletId: z.string().uuid(),
  amountIdr: idr.nonnegative(),
  businessDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => !Number.isNaN(Date.parse(value))),
  paidAt: time,
});

// legend-msqvi: the stored loyalty fact is the ledger entry id only; the rest
// is re-read from the point_ledger row (the authority).
const ledgerEntryIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const loyaltyStoredSchema = z.object({ ledgerEntryId: ledgerEntryIdSchema });

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

/** legend-knfl6: the order link of a sale / refund journal (uuid form). */
function orderLinkOf(orderId: string): { orderId?: string } {
  const uuid = orderUuidOf(orderId);
  return uuid === null ? {} : { orderId: uuid };
}

export type AutoJournalFact = {
  readonly ruleEvent: AutoJournalEventName;
  /** Rule variant (legend-xa9bc: `tax_split` books tax per type). */
  readonly variant?: string;
  /** Refunds use the original sale's immutable role identities. */
  readonly accountOverrides?: Partial<Record<PostingAccountRole, string>>;
  /** legend-knfl6: uuid of the order a sale / refund journal is linked to. */
  readonly orderId?: string;
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
  /**
   * Purchase return with an invoiced part: after its journal posts, the
   * consumer lowers the supplier's payable open items by `amountIdr` in the
   * same transaction (accounting-ap.service applySupplierDebitNoteInTransaction).
   */
  readonly debitNote?: {
    readonly purchaseReturnId: string;
    readonly supplierId: string | null;
    readonly amountIdr: number;
  };
  /**
   * legend-msqvi: outlet of the journal and its lines when it differs from
   * `outletId` (which then only gives the legal entity and the business-day
   * clock); null posts an entity-level journal.
   */
  readonly journalOutletId?: string | null;
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
  /** legend-msqvi: envelope key, carries the point_ledger entry id. */
  idempotencyKey?: string | null;
  /** legend-msqvi: anchor outlet of a points event (loyaltyAnchorOf). */
  loyaltyOutletId?: string | null;
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
    case "order_issue.refund_reversal_requested": {
      const payload = orderIssueRefundReversalStoredSchema.parse(event.payload);
      if (event.outletId === null)
        throw new AutoJournalPayloadInvalid(
          `${event.name} event has no outlet`,
        );
      return { ...base, outletId: event.outletId, occurredAt, payload };
    }
    case "order_issue.charge_paid": {
      const payload = orderIssueChargePaidStoredSchema.parse(event.payload);
      if (event.outletId === null)
        throw new AutoJournalPayloadInvalid(
          `${event.name} event has no outlet`,
        );
      return { ...base, outletId: event.outletId, occurredAt, payload };
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
    case "cash_movement.recorded": {
      const payload = cashMovementRecordedSchema.parse(event.payload);
      assertEnvelopeOutlet(event, payload.outletId);
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
    case "goods_receipt.recorded": {
      if (event.outletId === null)
        throw new AutoJournalPayloadInvalid(
          `${event.name} event has no outlet`,
        );
      const payload = goodsReceiptRecordedSchema.parse({
        ...(typeof event.payload === "object" && event.payload !== null
          ? event.payload
          : {}),
        outletId: event.outletId,
      });
      return { ...base, outletId: payload.outletId, occurredAt, payload };
    }
    case "purchase_return.recorded": {
      const payload = purchaseReturnRecordedSchema.parse(event.payload);
      assertEnvelopeOutlet(event, payload.outletId);
      return { ...base, outletId: payload.outletId, occurredAt, payload };
    }
    case "petty_purchase.recorded": {
      const payload = pettyPurchaseRecordedSchema.parse(event.payload);
      assertEnvelopeOutlet(event, payload.outletId);
      return { ...base, outletId: payload.outletId, occurredAt, payload };
    }
    // legend-msqvi
    case "points.earned":
    case "points.reversed":
    case "points.redeemed":
    case "points.adjusted":
    case "points.expired": {
      const ledgerEntryId = ledgerEntryIdOf(event.name, event.idempotencyKey);
      if (!event.loyaltyOutletId)
        throw new AutoJournalPayloadInvalid(
          `${event.name} has no outlet to post under`,
        );
      return {
        ...base,
        outletId: event.loyaltyOutletId,
        occurredAt,
        payload: { ledgerEntryId },
      };
    }
  }
}

/**
 * legend-msqvi: the point_ledger entry id of a points event, from its
 * envelope key `<event name>:<ledgerEntryId>` (appendPointsEvent).
 */
function ledgerEntryIdOf(
  eventName: string,
  idempotencyKey: string | null | undefined,
): string {
  const separator = idempotencyKey?.indexOf(":") ?? -1;
  const parsed =
    idempotencyKey && separator > 0
      ? idempotencyKey.slice(0, separator) === eventName
        ? ledgerEntryIdSchema.safeParse(idempotencyKey.slice(separator + 1))
        : null
      : null;
  if (!parsed?.success)
    throw new AutoJournalPayloadInvalid(
      `${eventName} idempotency key carries no ledger entry id`,
    );
  return parsed.data;
}

/**
 * legend-msqvi (D-msqvi section 7): where a tenant's loyalty journals post.
 * One legal entity across the tenant's outlets: that entity, anchored on its
 * oldest outlet. More than one: legalEntityId null (ambiguous), anchored on
 * the tenant's oldest outlet so the event can still be parked. No outlet: null.
 */
export async function lockLoyaltyJournalEntity(
  tx: Tx,
  tenantId: TenantId,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loyalty-entity:${tenantId}`}, 0))`,
  );
}

export async function loyaltyAnchorOf(
  tx: Tx,
  tenantId: TenantId,
): Promise<{ outletId: string; legalEntityId: string | null } | null> {
  const [program] = await tx
    .select({ legalEntityId: loyaltyPrograms.legalEntityId })
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.tenantId, tenantId))
    .limit(1);
  if (!program?.legalEntityId) {
    // Every new outlet has a tenant FK. Its KEY SHARE check must wait for
    // this lock, preventing a second entity from appearing during fallback.
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for("update");
  }
  const rows = await tx
    .select({ id: outlets.id, legalEntityId: outlets.legalEntityId })
    .from(outlets)
    .where(eq(outlets.tenantId, tenantId))
    .orderBy(asc(outlets.createdAt), asc(outlets.id))
    .for("share");
  const [oldest] = rows;
  if (!oldest) return null;
  if (program?.legalEntityId) {
    const selected = rows.find(
      (row) => row.legalEntityId === program.legalEntityId,
    );
    return selected
      ? { outletId: selected.id, legalEntityId: selected.legalEntityId }
      : { outletId: oldest.id, legalEntityId: null };
  }
  const entities = new Set(rows.map((row) => row.legalEntityId));
  return {
    outletId: oldest.id,
    legalEntityId: entities.size === 1 ? oldest.legalEntityId : null,
  };
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
    case "order_issue.refund_reversal_requested":
      return boundedKey(`aj:order-refund-reversal:${String(p.orderIssueId)}`);
    case "order_issue.charge_paid":
      return boundedKey(`aj:order-charge:${String(p.chargeId)}`);
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
    case "cash_movement.recorded":
      return boundedKey(`aj:cash-movement:${String(p.movementId)}`);
    case "settlement.reconciled":
      return boundedKey(`aj:settlement:${String(p.settlementId)}`);
    case "edc_transaction.settled":
      return boundedKey(`aj:edc-settlement:${String(p.settlementBatchId)}`);
    case "goods_receipt.recorded":
      return boundedKey(`aj:goods-receipt:${String(p.goodsReceiptId)}`);
    case "purchase_return.recorded":
      return boundedKey(`aj:purchase-return:${String(p.purchaseReturnId)}`);
    case "petty_purchase.recorded":
      return boundedKey(`aj:petty-purchase:${String(p.pettyPurchaseId)}`);
    // legend-msqvi: one ledger row, one journal.
    case "points.earned":
    case "points.reversed":
    case "points.redeemed":
    case "points.adjusted":
    case "points.expired":
      return boundedKey(`aj:loyalty:${String(p.ledgerEntryId)}`);
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
  const pendingIds = ids.filter(
    (intentId) => states.get(intentId) === "pending",
  );
  if (pendingIds.length > 0)
    await assertNotDeadLettered(tx, tenantId, pendingIds);
  return states;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pseudo method of a refund line that may match any gateway tender. */
const ANY_GATEWAY = "*";

type RefundLine = {
  method: string;
  amountIdr: number;
  tenderId?: string;
  paymentIntentId?: string | null;
};

/**
 * legend-2jyr + legend-27mt: how much of an order refund's gateway part credits
 * customer_deposit (owed until a payout clears it) and how much reverses the
 * sale's gateway_clearing. The refund mirrors the SALE tender by tender, like
 * the payout guard (pos-intent-attribution.ts), never "was a payment refund
 * filed": a refund line of a posted-receipt intent is owed whether the payment
 * refund exists yet or not (an admin may file it by hand later).
 * Attribution of the gateway part to intents:
 * - POS refund (pos_order_refunds row = refundId): its lines; a line naming a
 *   tender (legend-186) goes to that tender's intent, a legacy line (method
 *   only) walks the order's tenders of that method in order, after what earlier
 *   refunds of the order took; a tender without an intent goes to clearing.
 *   The deposit-refund part (pos_deposit_refunds) goes to its source intent;
 * - recovery refund (no POS row): the intent of the payment refund filed with
 *   order_issue_id = refundId;
 * - otherwise (payload only): the payload lines as legacy lines.
 * Per intent, receipt "posted" credits customer_deposit, "pending" parks the
 * refund retryable, "none" (money received before the wiring; its payout parks
 * RECEIPT_MISSING) credits gateway_clearing. The deposit part never exceeds
 * `gatewayIdr` (never credit more than was refunded).
 */
async function refundGatewaySplitOf(
  tx: Tx,
  tenantId: TenantId,
  p: {
    orderId: string;
    refundId: string;
    refundGatewayIdr: number;
    lines: readonly { method: string; amountIdr: number }[];
  },
): Promise<{ depositIdr: number; clearingIdr: number }> {
  const gatewayIdr = p.refundGatewayIdr;
  if (gatewayIdr <= 0) return { depositIdr: 0, clearingIdr: 0 };
  const isGateway = (method: string) => {
    try {
      return tenderBucket(method as never) === "gateway";
    } catch {
      return false;
    }
  };
  // Amount attributed per intent id (null: a tender without an intent).
  const byIntent = new Map<string | null, number>();
  const add = (intentId: string | null, amountIdr: number) => {
    if (amountIdr > 0)
      byIntent.set(intentId, (byIntent.get(intentId) ?? 0) + amountIdr);
  };
  const posRefunds = UUID_RE.test(p.refundId)
    ? await tx
        .select({
          id: posOrderRefunds.id,
          lines: posOrderRefunds.lines,
          refundedAt: posOrderRefunds.refundedAt,
          createdAt: posOrderRefunds.createdAt,
        })
        .from(posOrderRefunds)
        .where(
          and(
            eq(posOrderRefunds.tenantId, tenantId),
            eq(posOrderRefunds.orderId, p.orderId),
          ),
        )
    : [];
  const current = posRefunds.find((row) => row.id === p.refundId);
  const recovery =
    !current && UUID_RE.test(p.refundId)
      ? await tx
          .select({ intentId: paymentRefunds.paymentIntentId })
          .from(paymentRefunds)
          .where(
            and(
              eq(paymentRefunds.tenantId, tenantId),
              eq(paymentRefunds.orderIssueId, p.refundId),
            ),
          )
      : [];
  if (recovery[0]) {
    add(recovery[0].intentId, gatewayIdr);
  } else {
    const tenders = (
      await tx
        .select({
          id: posOrderTenders.id,
          method: posOrderTenders.method,
          intentId: posOrderTenders.paymentIntentId,
          amountIdr: posOrderTenders.amountIdr,
        })
        .from(posOrderTenders)
        .where(
          and(
            eq(posOrderTenders.tenantId, tenantId),
            eq(posOrderTenders.orderId, p.orderId),
            eq(posOrderTenders.status, "captured"),
          ),
        )
        .orderBy(posOrderTenders.requestedAt, posOrderTenders.id)
    )
      .filter((tender) => isGateway(tender.method))
      .map((tender) => ({ ...tender, left: Number(tender.amountIdr) }));
    const apply = (lines: readonly RefundLine[], collect: boolean) => {
      for (const line of lines) {
        if (line.method !== ANY_GATEWAY && !isGateway(line.method)) continue;
        let want = Number(line.amountIdr);
        const named = line.tenderId
          ? tenders.find((tender) => tender.id === line.tenderId)
          : undefined;
        const walk = line.tenderId
          ? named
            ? [named]
            : []
          : tenders.filter(
              (tender) =>
                line.method === ANY_GATEWAY || tender.method === line.method,
            );
        for (const tender of walk) {
          const take = Math.min(want, tender.left);
          if (take <= 0) continue;
          tender.left -= take;
          want -= take;
          if (collect) add(tender.intentId, take);
        }
        // A line naming a tender that is gone, or more than the tenders held.
        if (collect && want > 0)
          add(line.tenderId ? (line.paymentIntentId ?? null) : null, want);
      }
    };
    const key = (row: { refundedAt: Date; createdAt: Date; id: string }) =>
      `${row.refundedAt.toISOString()}|${row.createdAt.toISOString()}|${row.id}`;
    const earlier = posRefunds
      .filter((row) => row.id !== p.refundId)
      .filter((row) => !current || key(row) < key(current))
      .sort((a, b) => (key(a) < key(b) ? -1 : 1));
    for (const row of earlier) apply(row.lines, false);
    // A payload without lines (stored before they were kept): its gateway
    // part walks every gateway tender of the order.
    apply(
      current
        ? current.lines
        : p.lines.some((line) => isGateway(line.method))
          ? p.lines
          : [{ method: ANY_GATEWAY, amountIdr: gatewayIdr }],
      true,
    );
    if (current) {
      const deposits = await tx
        .select({
          intentId: posDepositRefunds.paymentIntentId,
          amountIdr: posDepositRefunds.amountIdr,
        })
        .from(posDepositRefunds)
        .where(
          and(
            eq(posDepositRefunds.tenantId, tenantId),
            eq(posDepositRefunds.posRefundId, p.refundId),
          ),
        );
      for (const row of deposits) add(row.intentId, Number(row.amountIdr));
    }
  }
  const intentIds = [...byIntent.keys()].filter(
    (id): id is string => id !== null,
  );
  const states = await receiptStatesOf(tx, tenantId, intentIds);
  let postedIdr = 0;
  for (const [intentId, amountIdr] of byIntent) {
    if (intentId === null) continue;
    const state = states.get(intentId);
    if (state === "pending")
      throw new AutoJournalReceiptPending(
        "Gateway receipt of a refunded intent is not booked yet",
      );
    if (state === "posted") postedIdr += amountIdr;
  }
  const depositIdr = Math.min(postedIdr, gatewayIdr);
  return { depositIdr, clearingIdr: gatewayIdr - depositIdr };
}

/**
 * legend-3r6r: how long a payment.paid may sit dead-lettered before a sale
 * waiting on it stops retrying (3 days: covers a weekend before an operator
 * replays it).
 */
export const DEAD_LETTERED_RECEIPT_BOUND_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Throws AutoJournalReceiptDeadLettered when a pending intent's payment.paid
 * is held back by a dead letter older than the bound (the head of the intent's
 * undelivered events, see below). A live (ready/queued) head, a young dead
 * letter, or a receipt parked retryable (no outbox row) keeps the plain wait.
 */
async function assertNotDeadLettered(
  tx: Tx,
  tenantId: TenantId,
  intentIds: readonly string[],
): Promise<void> {
  const rows = await tx
    .select({
      intentId: domainEventOutbox.aggregateId,
      sequence: domainEventOutbox.sequence,
      name: sql<string>`${domainEventOutbox.event}->>'name'`,
      dispatchState: domainEventOutbox.dispatchState,
      deadLetteredAt: domainEventOutbox.deadLetteredAt,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        ne(domainEventOutbox.status, "delivered"),
        eq(domainEventOutbox.aggregateType, "payment"),
        inArray(domainEventOutbox.aggregateId, [...intentIds]),
      ),
    );
  const cutoff = Date.now() - DEAD_LETTERED_RECEIPT_BOUND_MS;
  for (const intentId of intentIds) {
    const own = rows
      .filter((row) => row.intentId === intentId)
      .sort((a, b) => a.sequence - b.sequence);
    // The relay delivers an aggregate in sequence order: the first undelivered
    // event (payment.paid or an earlier one such as payment.expired) gates
    // payment.paid, so a dead head holds the receipt back for good.
    const head = own[0];
    if (
      head !== undefined &&
      own.some((row) => row.name === "payment.paid") &&
      head.dispatchState === "dead" &&
      head.deadLetteredAt !== null &&
      head.deadLetteredAt.getTime() <= cutoff
    )
      throw new AutoJournalReceiptDeadLettered(
        "Gateway receipt is dead-lettered; replay it or book the sale by hand",
      );
  }
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

type OrderPaid = z.infer<typeof orderPaidSchema>;

/**
 * Gateway amount of a QR sale (an order.paid whose order has no pos_orders
 * row and channel qr), as { gatewayIdr, withReceipt } like the POS tender
 * loop, or null when the order is not a QR order (the tender path applies):
 * - the order is a fired QR pay-first order of the event outlet;
 * - the payload carries exactly the revenue split of the order row, no cash,
 *   EDC or points, and paidGatewayIdr = total - DP;
 * - money left after the DP was paid by the pinned intent: one that took
 *   money through the order's payment link; its receipt state decides (posted:
 *   out of customer_deposit; none: pre-cutover gateway money; pending: wait).
 */
async function qrSaleGatewayOf(
  tx: Tx,
  tenantId: TenantId,
  p: OrderPaid,
): Promise<{ gatewayIdr: number; withReceipt: number } | null> {
  const [order] = await tx
    .select({
      outletId: orders.outletId,
      channel: orders.channel,
      paymentMode: orders.paymentMode,
      firedAt: orders.firedAt,
      subtotalIdr: orders.subtotalIdr,
      discountIdr: orders.discountIdr,
      serviceChargeIdr: orders.serviceChargeIdr,
      taxIdr: orders.taxIdr,
      roundingIdr: orders.roundingIdr,
      totalIdr: orders.totalIdr,
      pricesIncludeTax: orders.pricesIncludeTax,
      depositAppliedIdr: orders.depositAppliedIdr,
      paymentLinkId: orders.paymentLinkId,
      paymentIntentId: orders.paymentIntentId,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, p.orderId)));
  // A facility breakfast order is sold like a QR pay-first one (bead oa0qk).
  if (!order || (order.channel !== "qr" && order.channel !== "facility"))
    return null;
  if (
    order.paymentMode !== "pay_first" ||
    order.firedAt === null ||
    order.outletId !== p.outletId
  )
    throw new AutoJournalPayloadInvalid(
      "QR sale order is not a fired pay-first order of the outlet",
    );
  let split: ReturnType<typeof orderRevenueSplit>;
  try {
    split = orderRevenueSplit({
      subtotalIdr: Number(order.subtotalIdr),
      discountIdr: Number(order.discountIdr),
      serviceChargeIdr: Number(order.serviceChargeIdr),
      taxIdr: Number(order.taxIdr),
      roundingIdr: Number(order.roundingIdr),
      totalIdr: Number(order.totalIdr),
      pricesIncludeTax: order.pricesIncludeTax,
    });
  } catch (error) {
    if (error instanceof OrderRevenueMismatch)
      throw new AutoJournalPayloadInvalid(error.message);
    throw error;
  }
  const gatewayIdr = split.totalIdr - Number(order.depositAppliedIdr);
  if (
    p.grossSalesIdr !== split.grossSalesIdr ||
    p.discountIdr !== split.discountIdr ||
    p.serviceChargeIdr !== split.serviceChargeIdr ||
    p.pbjtIdr !== split.pbjtIdr ||
    p.roundingIdr !== split.roundingIdr ||
    p.paidCashIdr !== 0 ||
    p.paidEdcIdr !== 0 ||
    p.paidPointsIdr !== 0 ||
    p.paidGatewayIdr !== gatewayIdr
  )
    throw new AccountingError(
      "POSTING_AMOUNTS_MISMATCH",
      "QR sale payload does not match the order row",
    );
  if (gatewayIdr === 0) return { gatewayIdr, withReceipt: 0 };
  const intentId = order.paymentIntentId;
  if (intentId === null || order.paymentLinkId === null)
    throw new AutoJournalPayloadInvalid(
      "QR sale with money to pay has no pinned payment intent",
    );
  const [intent] = await tx
    .select({ id: paymentIntents.id, amountIdr: paymentIntents.amountIdr })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, intentId),
        eq(paymentIntents.paymentLinkId, order.paymentLinkId),
        // Took money (a status that never reverts: a later refund keeps it).
        inArray(paymentIntents.status, [...DP_INTENT_STATUSES]),
      ),
    );
  if (!intent)
    throw new AutoJournalPayloadInvalid(
      "Pinned payment intent of the QR sale is not paid on its payment link",
    );
  // legend-gzu54: a bill split over several codes of the link is paid by
  // every code that put money toward it, each for its part.
  const shares = await qrSaleSharesOf(tx, tenantId, {
    paymentLinkId: order.paymentLinkId,
    pinnedIntentId: intentId,
    dueIdr: gatewayIdr,
  });
  if (shares.size === 1) {
    if (Number(intent.amountIdr) < gatewayIdr)
      throw new AutoJournalPayloadInvalid(
        "Pinned payment intent of the QR sale took less than total - DP",
      );
  } else {
    let partsIdr = 0;
    for (const share of shares.values()) partsIdr += share;
    if (partsIdr < gatewayIdr)
      throw new AutoJournalPayloadInvalid(
        "Payment intents of the QR sale took less than total - DP together",
      );
  }
  const states = await receiptStatesOf(tx, tenantId, [...shares.keys()]);
  if ([...states.values()].includes("pending"))
    throw new AutoJournalReceiptPending(
      "Gateway receipt of the QR sale is not booked yet",
    );
  // A refund of an intent final before the sale may have taken it back.
  let withReceipt = 0;
  let saleBound: Bound | null = null;
  for (const [id, share] of shares) {
    if (states.get(id) !== "posted") continue;
    saleBound ??= await saleBoundOf(tx, tenantId, p.orderId);
    await assertSaleWithinReceipt(tx, tenantId, id, saleBound);
    withReceipt += share;
  }
  return { gatewayIdr, withReceipt: Math.min(gatewayIdr, withReceipt) };
}

/**
 * legend-gzu54: what each code of the order's payment link put toward a QR
 * sale of `dueIdr` (total - DP), keyed by intent. A code paying alone (the
 * pinned intent, no other code with money toward the bill) is the whole sale.
 * On a split bill every code that put money toward it (evidence less its
 * unallocated funds, a status that never reverts) backs `min(due, that)`,
 * the pinned one included; same parts as the payout guard (intentBackedAt,
 * legend-05cm9) and allocatedIdrByIntent (qr-order-consumers.ts).
 * qrSaleInUseOfIntent (payment-admin.service.ts) holds the pinned code's whole
 * due instead, which is stricter.
 */
async function qrSaleSharesOf(
  tx: Tx,
  tenantId: TenantId,
  input: { paymentLinkId: string; pinnedIntentId: string; dueIdr: number },
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
     WHERE i.tenant_id = ${tenantId}
       AND i.payment_link_id = ${input.paymentLinkId}
       AND i.status IN (${sql.join(
         DP_INTENT_STATUSES.map((status) => sql`${status}`),
         sql`, `,
       )})`);
  const allocated = new Map(
    result.rows.map((row) => [row.id, Number(row.allocated)]),
  );
  const others = [...allocated].filter(
    ([id, amount]) => id !== input.pinnedIntentId && amount > 0,
  );
  if (others.length === 0)
    return new Map([[input.pinnedIntentId, input.dueIdr]]);
  const shares = new Map<string, number>();
  const own = allocated.get(input.pinnedIntentId) ?? 0;
  shares.set(input.pinnedIntentId, Math.min(input.dueIdr, Math.max(own, 0)));
  for (const [id, amount] of others)
    shares.set(id, Math.min(input.dueIdr, amount));
  return shares;
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
 * legend-i83ls: the revenue of a paid swap-difference charge, booked with the
 * rule of order.paid. The money of the charge is one intent of its own payment
 * link (never the order's), so the fact reads the charge row, not the order:
 * - the charge is `paid` by the intent the event names, with the exact split
 *   and amount of the event (identity gross + service + pbjt), of the outlet;
 * - the sale journal of its order must exist (or still be able to post), like
 *   a refund (order.refunded): the charge revenue follows the sale;
 * - the intent receipt decides the debit as for a QR sale: posted (out of
 *   customer_deposit, within what the receipt still holds at the charge bound),
 *   none (pre-cutover gateway money, gateway_clearing), pending (wait). An
 *   EDC-linked intent fails closed (receiptStatesOf).
 * legend-800h1: a charge paid in cash at the POS (method pos_cash) has no
 * intent. Its money is the charge's own cash_in movement (same tenant and
 * outlet, amount = charge amount), booked straight to cash_on_hand; there is
 * no receipt to wait for or to bound, the sale journal rule is unchanged.
 */
/**
 * legend-89pn: cash in / cash out of an open or closed shift. Restrictive:
 * - the amount and type come from the stored row; a payload that disagrees is
 *   refused (POSTING_AMOUNTS_MISMATCH), never posted;
 * - a drop stays the outlet's cash: nothing to book;
 * - a movement held for approval (needs_approval, whatever its outcome) is
 *   outside the shift's expected cash, so the close difference already
 *   leaves it alone, and it is never booked here;
 * - the cash_in that pays an order issue charge is booked as a sale by
 *   order_issue.charge_paid (chargePaidFactOf): booking it again would count
 *   the cash twice.
 */
async function cashMovementFactOf(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
): Promise<AutoJournalFact | null> {
  const p = cashMovementRecordedSchema.parse(stored.payload);
  const [movement] = await tx
    .select({
      outletId: cashMovements.outletId,
      shiftId: cashMovements.shiftId,
      type: cashMovements.type,
      amountIdr: cashMovements.amountIdr,
      needsApproval: cashMovements.needsApproval,
      recordedAt: cashMovements.recordedAt,
    })
    .from(cashMovements)
    .where(
      and(
        eq(cashMovements.tenantId, tenantId),
        eq(cashMovements.id, p.movementId),
      ),
    );
  if (
    !movement ||
    movement.outletId !== p.outletId ||
    movement.shiftId !== p.shiftId ||
    movement.type !== p.type
  )
    throw new AutoJournalPayloadInvalid(
      "Cash movement of the event not found or not the one recorded",
    );
  const amountIdr = Number(movement.amountIdr);
  if (amountIdr !== p.amountIdr)
    throw new AccountingError(
      "POSTING_AMOUNTS_MISMATCH",
      "amountIdr does not match the cash movement",
    );
  if (movement.type === "drop" || movement.needsApproval) return null;
  const [charge] = await tx
    .select({ id: orderIssueCharges.id })
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        eq(orderIssueCharges.cashMovementId, p.movementId),
      ),
    )
    .limit(1);
  if (charge) return null;
  return {
    ruleEvent: "cash_movement.recorded",
    variant: movement.type,
    amounts: { amountIdr },
    sourceId: p.movementId,
    outletId: movement.outletId,
    moneyTime: movement.recordedAt,
  };
}

async function chargePaidFactOf(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
): Promise<AutoJournalFact> {
  const p = orderIssueChargePaidStoredSchema.parse(stored.payload);
  const [charge] = await tx
    .select({
      outletId: orderIssueCharges.outletId,
      orderId: orderIssueCharges.orderId,
      orderIssueId: orderIssueCharges.orderIssueId,
      status: orderIssueCharges.status,
      paymentIntentId: orderIssueCharges.paymentIntentId,
      cashMovementId: orderIssueCharges.cashMovementId,
      grossSalesIdr: orderIssueCharges.grossSalesIdr,
      serviceChargeIdr: orderIssueCharges.serviceChargeIdr,
      pbjtIdr: orderIssueCharges.pbjtIdr,
      amountIdr: orderIssueCharges.amountIdr,
    })
    .from(orderIssueCharges)
    .where(
      and(
        eq(orderIssueCharges.tenantId, tenantId),
        eq(orderIssueCharges.id, p.chargeId),
      ),
    );
  if (!charge)
    throw new AutoJournalPayloadInvalid("Charge of the event not found");
  const cash = p.method === "pos_cash";
  if (
    cash !== (p.cashMovementId != null) ||
    cash !== (p.paymentIntentId === null)
  )
    throw new AutoJournalPayloadInvalid(
      "Charge event mixes the cash and the payment link variants",
    );
  if (
    charge.status !== "paid" ||
    charge.paymentIntentId !== p.paymentIntentId ||
    (charge.cashMovementId ?? null) !== (p.cashMovementId ?? null) ||
    charge.outletId !== stored.outletId ||
    charge.orderId !== p.orderId ||
    charge.orderIssueId !== p.orderIssueId
  )
    throw new AutoJournalPayloadInvalid(
      "Charge is not paid by the intent of the event",
    );
  if (
    Number(charge.grossSalesIdr) !== p.grossSalesIdr ||
    Number(charge.serviceChargeIdr) !== p.serviceChargeIdr ||
    Number(charge.pbjtIdr) !== p.pbjtIdr ||
    Number(charge.amountIdr) !== p.amountIdr ||
    p.grossSalesIdr + p.serviceChargeIdr + p.pbjtIdr !== p.amountIdr
  )
    throw new AccountingError(
      "POSTING_AMOUNTS_MISMATCH",
      "Charge payload does not match the charge row",
    );
  const saleState = await backingStateOf(tx, tenantId, {
    kind: "sale",
    orderId: p.orderId,
  });
  if (saleState === "pending")
    throw new AutoJournalSalePending("Sale journal is not posted yet");
  if (saleState === "none")
    throw new AutoJournalSaleMissing("Sale journal will never post");
  if (cash) {
    const [movement] = await tx
      .select({
        type: cashMovements.type,
        outletId: cashMovements.outletId,
        amountIdr: cashMovements.amountIdr,
      })
      .from(cashMovements)
      .where(
        and(
          eq(cashMovements.tenantId, tenantId),
          eq(cashMovements.id, p.cashMovementId!),
        ),
      );
    if (
      !movement ||
      movement.type !== "cash_in" ||
      movement.outletId !== stored.outletId ||
      Number(movement.amountIdr) !== p.amountIdr
    )
      throw new AutoJournalPayloadInvalid(
        "Cash movement of the charge is not its cash_in",
      );
    return {
      ruleEvent: "order.paid",
      amounts: {
        paidCashIdr: p.amountIdr,
        paidGatewayIntentIdr: 0,
        paidDepositIdr: 0,
        paidGatewayIdr: 0,
        paidEdcIdr: 0,
        paidPointsIdr: 0,
        discountIdr: 0,
        grossSalesIdr: p.grossSalesIdr,
        serviceChargeIdr: p.serviceChargeIdr,
        pbjtIdr: p.pbjtIdr,
        roundingIdr: 0,
      },
      sourceId: p.chargeId,
      outletId: stored.outletId,
      moneyTime: new Date(p.paidAt),
    };
  }
  // qr_link: paymentIntentId is set (checked above).
  const intentId = p.paymentIntentId!;
  const states = await receiptStatesOf(tx, tenantId, [intentId]);
  const state = states.get(intentId);
  if (state === "pending")
    throw new AutoJournalReceiptPending(
      "Gateway receipt of the charge is not booked yet",
    );
  let withReceipt = 0;
  if (state === "posted") {
    await assertChargeWithinReceipt(
      tx,
      tenantId,
      intentId,
      await chargeBoundOf(tx, tenantId, p.chargeId),
    );
    withReceipt = p.amountIdr;
  }
  return {
    ruleEvent: "order.paid",
    amounts: {
      paidCashIdr: 0,
      paidGatewayIntentIdr: withReceipt,
      paidDepositIdr: 0,
      paidGatewayIdr: p.amountIdr - withReceipt,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      discountIdr: 0,
      grossSalesIdr: p.grossSalesIdr,
      serviceChargeIdr: p.serviceChargeIdr,
      pbjtIdr: p.pbjtIdr,
      roundingIdr: 0,
    },
    sourceId: p.chargeId,
    outletId: stored.outletId,
    moneyTime: new Date(p.paidAt),
  };
}

async function goodsReceiptFactOf(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
): Promise<AutoJournalFact | null> {
  const p = goodsReceiptRecordedSchema.parse(stored.payload);
  if (!purchasingPostingEnabled()) return null;
  const lines = await tx
    .select({
      quantityReceived: goodsReceiptLines.quantityReceived,
      quantityRejected: goodsReceiptLines.quantityRejected,
      unitCostIdr: goodsReceiptLines.unitCostIdr,
    })
    .from(goodsReceiptLines)
    .where(
      and(
        eq(goodsReceiptLines.tenantId, tenantId),
        eq(goodsReceiptLines.goodsReceiptId, p.goodsReceiptId),
      ),
    );
  const valueIdr = goodsReceiptValueIdr(lines, ROUNDING_MODE);
  if (valueIdr !== p.receivedValueIdr)
    throw new AutoJournalPayloadInvalid(
      "goods_receipt receivedValueIdr differs from its receipt lines",
    );
  if (valueIdr === 0) return null;
  return {
    ruleEvent: "goods_receipt.recorded",
    amounts: { receivedValueIdr: valueIdr },
    sourceId: p.goodsReceiptId,
    outletId: p.outletId,
    moneyTime: new Date(p.receivedAt),
  };
}

/**
 * Rule input of one stored event, or null when the event books nothing
 * (EDC-linked intent on a payment event, zero receipt, zero forfeit, zero
 * shift difference, order.paid with every amount 0). Re-reads only rows that
 * are final once the event exists (captured tenders, the intent, the
 * completed refund, a fired order).
 */
export async function autoJournalFactOf(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
): Promise<AutoJournalFact | null> {
  switch (stored.eventName) {
    case "order.paid": {
      const p = orderPaidSchema.parse(stored.payload);
      // legend-fbms: a total-0 order.paid is emitted for recipe deduction; it
      // books nothing unless it carries a revenue pair (a full comp still
      // posts gross sales against the discount).
      if (
        [
          p.grossSalesIdr,
          p.discountIdr,
          p.serviceChargeIdr,
          p.pbjtIdr,
          p.roundingIdr,
          p.paidCashIdr,
          p.paidGatewayIdr,
          p.paidEdcIdr,
          p.paidPointsIdr,
          p.paidDepositIdr,
        ].every((amount) => amount === 0)
      )
        return null;
      const [posOrder] = await tx
        .select({ orderId: posOrders.orderId })
        .from(posOrders)
        .where(
          and(
            eq(posOrders.tenantId, tenantId),
            eq(posOrders.orderId, p.orderId),
          ),
        );
      // QR pay-first sale: no pos_orders row, channel qr, no tenders.
      const qrSale =
        posOrder === undefined ? await qrSaleGatewayOf(tx, tenantId, p) : null;
      const tenders = qrSale
        ? []
        : await tx
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
      let gatewayIdr = qrSale?.gatewayIdr ?? 0;
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
      let withReceipt = qrSale?.withReceipt ?? 0;
      for (const tender of intentTenders) {
        const state = states.get(tender.intentId);
        if (state === "pending")
          throw new AutoJournalReceiptPending(
            "Gateway receipt of a tender is not booked yet",
          );
        if (state === "posted") withReceipt += tender.amountIdr;
      }
      // legend-6bq2: like a QR sale, a POS sale may not use more of an
      // intent than its posted receipt still holds at the sale's bound
      // (earlier sales, forfeits and payouts of that intent counted), so a
      // refund completed before the sale cannot leave customer_deposit twice.
      const postedIntents = [
        ...new Set(
          intentTenders
            .filter((tender) => states.get(tender.intentId) === "posted")
            .map((tender) => tender.intentId),
        ),
      ];
      if (postedIntents.length > 0) {
        const saleBound = await saleBoundOf(tx, tenantId, p.orderId);
        for (const intentId of postedIntents)
          await assertSaleWithinReceipt(tx, tenantId, intentId, saleBound);
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
      // legend-xa9bc: tax per type from the order's snapshots; PBJT-only and
      // pre-cutover orders keep the base rule (all tax in tax_payable_pbjt).
      const tax = await saleTaxSplitOf(tx, tenantId, p.orderId, p.pbjtIdr);
      return {
        ruleEvent: "order.paid",
        ...orderLinkOf(p.orderId),
        ...(isSplit(tax) ? { variant: TAX_SPLIT_VARIANT } : {}),
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
          pbjtIdr: tax.pbjtIdr,
          ...(isSplit(tax)
            ? { ppnIdr: tax.ppnIdr, otherTaxIdr: tax.otherTaxIdr }
            : {}),
          roundingIdr: p.roundingIdr,
        },
        sourceId: p.orderId,
        outletId: p.outletId,
        moneyTime: new Date(p.paidAt),
      };
    }
    case "order.refunded": {
      const p = orderRefundedSchema.parse(stored.payload);
      // legend-ni6o: the refund mirrors the sale journal, so it waits for it
      // like the void does. A parked or missing sale would leave the refund
      // reversing revenue never booked (its gateway part as customer_deposit).
      const saleState = await backingStateOf(tx, tenantId, {
        kind: "sale",
        orderId: p.orderId,
      });
      if (saleState === "pending")
        throw new AutoJournalSalePending("Sale journal is not posted yet");
      if (saleState === "none")
        throw new AutoJournalSaleMissing("Sale journal will never post");
      const components = await refundComponentsOf(
        tx,
        tenantId,
        p.orderId,
        {
          grossSalesIdr: p.grossSalesIdr,
          discountIdr: p.discountIdr,
          serviceChargeIdr: p.serviceChargeIdr,
          pbjtIdr: p.pbjtIdr,
        },
        p.refundCashIdr +
          p.refundGatewayIdr +
          p.refundEdcIdr +
          p.refundPointsIdr,
      );
      if (typeof components === "string")
        throw new AutoJournalPayloadInvalid(components);
      // legend-xa9bc: mirror the per-type split of the sale journal.
      const split = await refundTaxSplitOf(
        tx,
        tenantId,
        p.orderId,
        components.pbjtIdr,
      );
      // legend-knfl6: never refund more tax than the order collected.
      if (typeof split === "string") throw new AutoJournalPayloadInvalid(split);
      const tax = split;
      const saleAccounts = await salePostingAccountsOf(
        tx,
        tenantId,
        `aj:sale:${p.orderId}`,
      );
      if (!saleAccounts || typeof saleAccounts === "string")
        throw new AutoJournalPayloadInvalid(
          typeof saleAccounts === "string"
            ? saleAccounts
            : "Sale posting accounts are missing",
        );
      // Reverse historical income/tax identities, while the payout follows
      // today's funded cash/clearing/liability accounts selected by its tender.
      const accountOverrides: Partial<Record<PostingAccountRole, string>> = {};
      for (const role of [
        "sales_revenue",
        "sales_discount",
        "service_charge",
        "tax_payable_pbjt",
        "tax_payable_ppn",
        "tax_payable_other",
      ] as const) {
        const accountId = saleAccounts.byRole[role];
        if (accountId) accountOverrides[role] = accountId;
      }
      // The payout credits follow today's mapping. One that points at an
      // account the sale's service charge or tax lines use would credit what
      // the refund debits and hide the refunded amount from the cap: refuse.
      const protectedAccounts = new Set(
        (
          [
            "service_charge",
            "tax_payable_pbjt",
            "tax_payable_ppn",
            "tax_payable_other",
          ] as const
        )
          .map((role) => accountOverrides[role])
          .filter((id): id is string => id !== undefined),
      );
      const payoutMappings = await tx
        .select({
          role: accountMappings.role,
          accountId: accountMappings.accountId,
        })
        .from(accountMappings)
        .where(
          and(
            eq(accountMappings.tenantId, tenantId),
            eq(accountMappings.legalEntityId, saleAccounts.legalEntityId),
            inArray(accountMappings.role, [
              "cash_on_hand",
              "customer_deposit",
              "edc_clearing",
              "loyalty_liability",
            ]),
          ),
        );
      if (payoutMappings.some((row) => protectedAccounts.has(row.accountId)))
        throw new AutoJournalPayloadInvalid(
          "A refund payout account is mapped to a sale service charge or tax account",
        );
      const gatewaySplit = await refundGatewaySplitOf(tx, tenantId, p);
      return {
        ruleEvent: "order.refunded",
        accountOverrides,
        ...orderLinkOf(p.orderId),
        ...(isSplit(tax) ? { variant: TAX_SPLIT_VARIANT } : {}),
        amounts: {
          grossSalesIdr: components.grossSalesIdr,
          serviceChargeIdr: components.serviceChargeIdr,
          pbjtIdr: tax.pbjtIdr,
          ...(isSplit(tax)
            ? { ppnIdr: tax.ppnIdr, otherTaxIdr: tax.otherTaxIdr }
            : {}),
          discountIdr: components.discountIdr,
          refundCashIdr: p.refundCashIdr,
          refundGatewayIdr: gatewaySplit.depositIdr,
          refundGatewayClearingIdr: gatewaySplit.clearingIdr,
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
    case "order_issue.refund_reversal_requested":
      throw new Error(
        "order_issue.refund_reversal_requested is handled by recoveryRefundFactOf",
      );
    case "order_issue.charge_paid":
      return chargePaidFactOf(tx, tenantId, stored);
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
          differenceIdr: posShifts.differenceIdr,
        })
        .from(posShifts)
        .where(
          and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, p.shiftId)),
        );
      if (!shift || shift.status !== "closed" || shift.outletId !== p.outletId)
        throw new AutoJournalPayloadInvalid(
          "Shift of the event not found, open or of another outlet",
        );
      // legend-y9bf: the close stores the difference it booked. A shift
      // closed before that (null) keeps the old check against the variance,
      // so a legacy event that added held cash outs stays parked.
      const booked = shift.differenceIdr ?? shift.varianceIdr;
      if (booked === null || Number(booked) !== p.differenceIdr)
        throw new AccountingError(
          "POSTING_AMOUNTS_MISMATCH",
          "differenceIdr does not match the shift difference",
        );
      return {
        ruleEvent: "cashier_shift.closed",
        amounts: { differenceIdr: p.differenceIdr },
        sourceId: p.shiftId,
        outletId: shift.outletId,
        moneyTime: new Date(p.closedAt),
      };
    }
    case "cash_movement.recorded":
      return cashMovementFactOf(tx, tenantId, stored);
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
    // Dr inventory / Cr GRNI at the received value. The value is re-read from
    // the immutable receipt lines: a payload that disagrees is invalid, never
    // posted. Off while the purchasing posting flag is off (ignored, not parked).
    case "goods_receipt.recorded":
      return goodsReceiptFactOf(tx, tenantId, stored);
    // The posting rule reads debitNoteIdr (accounts payable cleared by the
    // return: the billed value plus its PPN), the emitter sends the parts.
    // Nothing returned books nothing (ignored). The journal date is the
    // outlet business date of returnedAt.
    case "purchase_return.recorded": {
      const p = purchaseReturnRecordedSchema.parse(stored.payload);
      // A zero-price line still moves GL inventory to the moving average: only
      // skip when the variance pair is zero too (legend-uloj6).
      if (p.valueIdr === 0 && p.movingAvgVarianceIdr === 0) return null;
      if (p.valueIdr !== p.uninvoicedValueIdr + p.invoicedValueIdr)
        throw new AutoJournalPayloadInvalid(
          "purchase_return valueIdr differs from its uninvoiced and invoiced parts",
        );
      if (p.ppnIdr > 0 && p.invoicedValueIdr === 0)
        throw new AutoJournalPayloadInvalid(
          "purchase_return ppnIdr without an invoiced value",
        );
      if (p.returnPriceVarianceIdr !== 0 && p.invoicedValueIdr === 0)
        throw new AutoJournalPayloadInvalid(
          "purchase_return returnPriceVarianceIdr without an invoiced value",
        );
      // Debit note = billed value + PPN; billed value = order-price value of
      // the invoiced part + the signed price variance (credited to 5105, which
      // reverses what the invoice booked there).
      const debitNoteIdr =
        p.invoicedValueIdr + p.returnPriceVarianceIdr + p.ppnIdr;
      if (debitNoteIdr < 0)
        throw new AutoJournalPayloadInvalid(
          "purchase_return debit note would be negative",
        );
      return {
        ruleEvent: "purchase_return.recorded",
        amounts: {
          uninvoicedValueIdr: p.uninvoicedValueIdr,
          debitNoteIdr,
          valueIdr: p.valueIdr,
          returnPriceVarianceIdr: p.returnPriceVarianceIdr,
          returnMovingAvgVarianceIdr: p.movingAvgVarianceIdr,
          ppnIdr: p.ppnIdr,
        },
        ...(debitNoteIdr > 0
          ? {
              debitNote: {
                purchaseReturnId: p.purchaseReturnId,
                supplierId: p.supplierId ?? null,
                amountIdr: debitNoteIdr,
              },
            }
          : {}),
        sourceId: p.purchaseReturnId,
        outletId: p.outletId,
        moneyTime: new Date(p.returnedAt),
      };
    }
    // Dated by the petty purchase business date as is (entryDate), like a
    // bank settlement: the outlet already decided which day it belongs to.
    case "petty_purchase.recorded": {
      const p = pettyPurchaseRecordedSchema.parse(stored.payload);
      if (p.amountIdr === 0) return null;
      return {
        ruleEvent: "petty_purchase.recorded",
        amounts: { amountIdr: p.amountIdr },
        sourceId: p.pettyPurchaseId,
        outletId: p.outletId,
        moneyTime: new Date(p.paidAt),
        entryDate: p.businessDate,
      };
    }
    case "points.earned":
    case "points.reversed":
    case "points.redeemed":
    case "points.adjusted":
    case "points.expired":
      return loyaltyFactOf(tx, tenantId, stored.eventName, stored.payload);
  }
}

/** legend-msqvi: ledger row types each points event is emitted for. */
const LOYALTY_ROW_TYPES: Record<
  LoyaltyAutoJournalEventName,
  readonly string[]
> = {
  "points.earned": ["earn", "bonus"],
  "points.reversed": ["reverse"],
  "points.redeemed": ["redeem"],
  "points.adjusted": ["adjust"],
  "points.expired": ["expire"],
};

/**
 * legend-msqvi (D-msqvi sections 3-7): the loyalty fact of one point_ledger
 * row. pointsValueIdr keeps the row's sign: earned and adjusted rules credit
 * loyalty_liability, the others debit it, so the amount is liability_idr or
 * its negation and the journal always moves loyalty_liability exactly as the
 * ledger did (a negative manual adjustment flips to Dr liability / Cr
 * deferral). Ignored (null): a redeem row that is not a reward redemption
 * (points tender belongs to order.paid paidPointsIdr), an earn on a training
 * order or the reversal of one, a zero liability.
 */
async function loyaltyFactOf(
  tx: Tx,
  tenantId: TenantId,
  eventName: LoyaltyAutoJournalEventName,
  payload: Record<string, unknown>,
): Promise<AutoJournalFact | null> {
  const { ledgerEntryId } = loyaltyStoredSchema.parse(payload);
  const row = await ledgerRowOf(tx, tenantId, ledgerEntryId);
  if (!row || !LOYALTY_ROW_TYPES[eventName].includes(row.type))
    throw new AutoJournalPayloadInvalid(
      `Ledger entry of ${eventName} not found or of another type`,
    );
  if (eventName === "points.redeemed" && row.sourceType !== "reward_redemption")
    return null;
  let journalOutletId: string | null = null;
  if (eventName === "points.earned") {
    if (
      row.sourceType === "order" &&
      row.sourceId !== null &&
      (await isTrainingOrder(tx, tenantId, row.sourceId))
    )
      return null;
    journalOutletId = row.outletId;
  }
  if (eventName === "points.reversed") {
    const reversed =
      row.reversesEntryId === null
        ? undefined
        : await ledgerRowOf(tx, tenantId, row.reversesEntryId);
    if (!reversed)
      throw new AutoJournalPayloadInvalid(
        "Reversed ledger entry of points.reversed not found",
      );
    if (
      reversed.sourceType === "order" &&
      reversed.sourceId !== null &&
      (await isTrainingOrder(tx, tenantId, reversed.sourceId))
    )
      return null;
    journalOutletId = reversed.outletId;
  }
  const liabilityIdr = Number(row.liabilityIdr);
  if (liabilityIdr === 0) return null;
  const anchor = await loyaltyAnchorOf(tx, tenantId);
  if (!anchor)
    throw new AutoJournalPayloadInvalid("Tenant has no outlet for loyalty");
  if (anchor.legalEntityId === null)
    throw new AutoJournalLoyaltyEntityAmbiguous(
      "Tenant outlets belong to more than one legal entity",
    );
  if (journalOutletId !== null) {
    const [sourceOutlet] = await tx
      .select({ legalEntityId: outlets.legalEntityId })
      .from(outlets)
      .where(
        and(eq(outlets.tenantId, tenantId), eq(outlets.id, journalOutletId)),
      )
      .limit(1);
    if (!sourceOutlet || sourceOutlet.legalEntityId !== anchor.legalEntityId)
      throw new AutoJournalLoyaltyEntityAmbiguous(
        "Loyalty source outlet belongs to a different legal entity",
      );
  }
  const [differentEntity] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.sourceType, "loyalty"),
        ne(journalEntries.legalEntityId, anchor.legalEntityId),
      ),
    )
    .limit(1);
  if (differentEntity)
    throw new AutoJournalLoyaltyEntityAmbiguous(
      "Loyalty liability is already journaled in a different legal entity",
    );
  const raisesLiability =
    eventName === "points.earned" || eventName === "points.adjusted";
  return {
    ruleEvent: eventName,
    amounts: { pointsValueIdr: raisesLiability ? liabilityIdr : -liabilityIdr },
    sourceId: row.id,
    outletId: anchor.outletId,
    journalOutletId,
    moneyTime: row.createdAt,
    // Dated like the sale that earned the points (the earn consumer copies the
    // order business date), so an offline order synced after midnight or
    // month end defers in the same period as its revenue. Rows without one
    // (expire, redeem, manual) fall back to the anchor outlet clock.
    ...(row.businessDate ? { entryDate: row.businessDate } : {}),
  };
}

async function ledgerRowOf(tx: Tx, tenantId: TenantId, ledgerEntryId: string) {
  const [row] = await tx
    .select({
      id: pointLedger.id,
      type: pointLedger.type,
      outletId: pointLedger.outletId,
      sourceType: pointLedger.sourceType,
      sourceId: pointLedger.sourceId,
      reversesEntryId: pointLedger.reversesEntryId,
      liabilityIdr: pointLedger.liabilityIdr,
      createdAt: pointLedger.createdAt,
      businessDate: pointLedger.businessDate,
    })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.tenantId, tenantId),
        eq(pointLedger.id, ledgerEntryId),
      ),
    );
  return row;
}
