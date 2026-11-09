// Auto-journal facts (F19, design docs/design/auto-journals.md sections 3-4).
// Turns one outbox event into the posting-rule input of the auto-journal
// consumer: rule event name, exact amount keys, business-fact idempotency key,
// source id, outlet and the moment the money moved. Payloads are parsed with
// consumer-local, non-strict schemas (emitter additions never break them), and
// only ids, amounts and times are kept: that subset is what
// `auto_journal_parked.payload` stores, so the sweep rebuilds the same fact
// without an outbox replay.
//
// Slice 1 handles order.paid (POS), order.refunded, payment.paid and
// payment.refunded. Gateway money is receipt-first: payment.paid books the
// receipt into customer_deposit, order.paid moves the intent-backed gateway
// tenders out of it. EDC-linked intents are skipped (EDC money posts through
// edc_clearing on the sale).

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AccountingError } from "@starter/shared/accounting";
import type { ScopedTenantContext } from "@starter/shared/core";
import { tenderBucket } from "@starter/shared/pos";
import {
  paymentIntents,
  paymentRefunds,
  posOrderTenders,
} from "../db/schema/index.ts";
import type { Tx } from "./inventory-ops.shared.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

export const AUTO_JOURNAL_EVENTS = [
  "order.paid",
  "order.refunded",
  "payment.paid",
  "payment.refunded",
] as const;
export type AutoJournalEventName = (typeof AUTO_JOURNAL_EVENTS)[number];

export function isAutoJournalEvent(name: string): name is AutoJournalEventName {
  return (AUTO_JOURNAL_EVENTS as readonly string[]).includes(name);
}

const idr = z.number().int().safe();
const id = z.string().min(1).max(64);
const time = z.string().min(1).max(64);

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

const paymentRefundedSchema = z.object({
  refundId: z.string().uuid(),
  paymentIntentId: z.string().uuid(),
  amountIdr: idr,
});

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

/** Picks the stored subset of an event; throws on a payload it cannot read. */
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
    case "payment.refunded": {
      const payload = (
        event.name === "payment.paid" ? paymentPaidSchema : paymentRefundedSchema
      ).parse(event.payload);
      if (event.outletId === null)
        throw new Error(`${event.name} event has no outlet`);
      return { ...base, outletId: event.outletId, occurredAt, payload };
    }
  }
}

const IDEMPOTENCY_KEY_MAX = 100;

/** Business-fact key (design section 4), sha256 above 100 characters. */
export function autoJournalKeyOf(stored: StoredAutoJournalEvent): string {
  const p = stored.payload;
  const key =
    stored.eventName === "order.paid"
      ? `aj:sale:${String(p.orderId)}`
      : stored.eventName === "order.refunded"
        ? `aj:order-refund:${String(p.refundId)}`
        : stored.eventName === "payment.paid"
          ? `aj:receipt:${stored.eventId}`
          : `aj:payout:${String(p.refundId)}`;
  if (key.length <= IDEMPOTENCY_KEY_MAX) return key;
  return `aj:${createHash("sha256").update(key).digest("hex")}`;
}

/** EDC-linked intents post through edc_clearing, never as gateway receipts. */
async function intentOf(
  tx: Tx,
  tenantId: TenantId,
  intentId: string,
) {
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
  if (!intent) throw new Error("Payment intent of the event not found");
  return intent;
}

/**
 * Rule input of one stored event, or null when the event books nothing
 * (EDC-linked intent, zero receipt). Re-reads only rows that are final once
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
      let withIntent = 0;
      let withoutIntent = 0;
      for (const tender of tenders) {
        if (tenderBucket(tender.method as never) !== "gateway") continue;
        if (tender.paymentIntentId === null) withoutIntent += tender.amountIdr;
        else withIntent += tender.amountIdr;
      }
      if (withIntent + withoutIntent !== p.paidGatewayIdr)
        throw new AccountingError(
          "POSTING_AMOUNTS_MISMATCH",
          "Captured gateway tenders do not match paidGatewayIdr",
        );
      return {
        ruleEvent: "order.paid",
        amounts: {
          paidCashIdr: p.paidCashIdr,
          paidGatewayIntentIdr: withIntent,
          paidDepositIdr: p.paidDepositIdr,
          paidGatewayIdr: withoutIntent,
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
      if (!refund) throw new Error("Payment refund of the event not found");
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
