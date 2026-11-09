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
// intent-backed gateway tenders whose receipt is booked out of it. EDC-linked
// intents are skipped (EDC money posts through edc_clearing on the sale); an
// EDC-linked gateway tender fails closed.
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
  autoJournalParked,
  journalEntries,
  paymentIntents,
  paymentRefunds,
  paymentUnallocatedFunds,
  posOrderTenders,
} from "../db/schema/index.ts";
import type { Tx } from "./inventory-ops.shared.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

export const AUTO_JOURNAL_EVENTS = [
  "order.paid",
  "order.refunded",
  "payment.paid",
  "payment.funds_unallocated",
  "payment.refunded",
] as const;
export type AutoJournalEventName = (typeof AUTO_JOURNAL_EVENTS)[number];

export function isAutoJournalEvent(name: string): name is AutoJournalEventName {
  return (AUTO_JOURNAL_EVENTS as readonly string[]).includes(name);
}

/** The event can never post as sent: parked, never retried. */
export class AutoJournalPayloadInvalid extends Error {
  readonly code = "AUTO_JOURNAL_PAYLOAD_INVALID";
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
  /** Slice 2 adds it to order.paid; absent means no DP applied. */
  paidDepositIdr: idr.default(0),
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
  }
}

/**
 * Intent ids among `intentIds` whose gateway receipt is booked or waiting
 * (journal or parked row under the receipt key). Cutover/ordering guard: an
 * intent paid before the auto-journal consumer went live, or whose
 * payment.paid booked nothing (accounting off then, payload invalid), never
 * credited customer_deposit, so its tender must not debit it either; it posts
 * the pre-deposit way, Dr gateway_clearing. Fails closed on an unknown or
 * EDC-linked intent (EDC money is not gateway money).
 */
async function receiptBookedIntents(
  tx: Tx,
  tenantId: TenantId,
  intentIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(intentIds)];
  if (ids.length === 0) return new Set();
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
  const intentByKey = new Map(
    ids.map((intentId) => [receiptKeyOf(intentId), intentId]),
  );
  const keys = [...intentByKey.keys()];
  const posted = await tx
    .select({ key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        inArray(journalEntries.idempotencyKey, keys),
      ),
    );
  const parked = await tx
    .select({ key: autoJournalParked.idempotencyKey })
    .from(autoJournalParked)
    .where(
      and(
        eq(autoJournalParked.tenantId, tenantId),
        inArray(autoJournalParked.idempotencyKey, keys),
      ),
    );
  const booked = new Set<string>();
  for (const row of [...posted, ...parked]) {
    const intentId = row.key === null ? undefined : intentByKey.get(row.key);
    if (intentId !== undefined) booked.add(intentId);
  }
  return booked;
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
 * (EDC-linked intent on a payment event, zero receipt). Re-reads only rows that are final once
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
      const booked = await receiptBookedIntents(
        tx,
        tenantId,
        intentTenders.map((tender) => tender.intentId),
      );
      let withReceipt = 0;
      for (const tender of intentTenders)
        if (booked.has(tender.intentId)) withReceipt += tender.amountIdr;
      return {
        ruleEvent: "order.paid",
        amounts: {
          paidCashIdr: p.paidCashIdr,
          paidGatewayIntentIdr: withReceipt,
          paidDepositIdr: p.paidDepositIdr,
          paidGatewayIdr: gatewayIdr - withReceipt,
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
      return {
        ruleEvent: "payment.refunded",
        amounts: { amountIdr: p.amountIdr },
        sourceId: p.refundId,
        outletId: refund.outletId,
        moneyTime: refund.completedAt ?? new Date(stored.occurredAt),
      };
    }
  }
}
