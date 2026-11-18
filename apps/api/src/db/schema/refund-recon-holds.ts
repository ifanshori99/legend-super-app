// legend-9s33i (1025 C): a signed provider `refund.succeeded` whose reference
// names another intent than the one owning the payment id used to be dropped
// without a trace. The hold records it, blocks the refund and payout of the
// intent that owns the payment id until finance matches the refund, and is
// never turned into a refund or a stamp by the system.
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idrColumn, tenantIdColumn } from "../columns.ts";
import { tenants } from "./platform-org.ts";
import { paymentIntents, paymentProviderRefunds } from "./payment.ts";

/**
 * One row per stored webhook event (unique with the tenant), so a replay, a
 * worker retry and a concurrent delivery add none. `resolvedAt` NULL = open =
 * blocks refunds and payouts of the intent. A provider refund id is held once
 * per intent (partial unique index). `webhookEventId` is the id of the
 * stored `gateway_webhook_events` row (no foreign key: that table has no
 * `(tenant_id, id)` key and the hold must outlive nothing it depends on).
 */
export const refundReconHolds = pgTable(
  "refund_recon_holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    webhookEventId: uuid("webhook_event_id").notNull(),
    providerRefundId: varchar("provider_refund_id", { length: 100 }),
    // legend-yn1of (1035): the kind of `provider_refund_id`, same values as
    // `payment_provider_refunds.refund_id_kind`; set exactly when the id is.
    providerRefundIdKind: varchar("provider_refund_id_kind", { length: 20 }),
    amountIdr: idrColumn("amount_idr").notNull(),
    reason: varchar("reason", { length: 200 }).notNull(),
    flaggedAt: timestamp("flagged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The provider payment id the refund names (the transaction its money
    // came from). Counting a hold records the refund against it.
    providerPaymentRef: varchar("provider_payment_ref", { length: 100 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // legend-vp4ta: who closed the hold, what they decided and why.
    resolvedBy: uuid("resolved_by"),
    resolution: text("resolution"),
    resolutionNote: text("resolution_note"),
    // 1055 G1: what finance said a counted hold is when the transaction has a
    // refund counted from a hold without a refund id (a `synthetic_hold` fact)
    // that may be the same money. `same_as_counted`: it is that refund (no new
    // fact; it matches one such fact). `separate`: another refund (booked).
    resolutionIdentity: varchar("resolution_identity", { length: 20 }),
    // 1063 F3 (legend-flj83): the refund counted from a hold without a refund
    // id (a `synthetic_hold` fact of `payment_provider_refunds`) a
    // `same_as_counted` hold was matched to. One fact is matched by one hold
    // only (unique index), so it can never be the base of a second difference.
    matchedFactId: uuid("matched_fact_id"),
  },
  (t) => [
    unique("refund_recon_hold_event_key").on(t.tenantId, t.webhookEventId),
    foreignKey({
      name: "refund_recon_hold_intent_fk",
      columns: [t.tenantId, t.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    // One hold per provider refund of an intent and provider transaction: the
    // provider resending the same refund under a new event id adds none. 1055
    // AV-P2: the transaction is part of it (no payment id counts as one value,
    // like NULLS NOT DISTINCT), so a closed hold of the id on one transaction
    // never stops the hold of a conflicting report on another.
    uniqueIndex("refund_recon_hold_provider_refund_key")
      .on(
        t.tenantId,
        t.paymentIntentId,
        t.providerRefundIdKind,
        t.providerRefundId,
        sql`coalesce(${t.providerPaymentRef}, '')`,
      )
      .where(sql`${t.providerRefundId} IS NOT NULL`),
    index("refund_recon_hold_intent_idx").on(t.tenantId, t.paymentIntentId),
    foreignKey({
      name: "refund_recon_hold_matched_fact_fk",
      columns: [t.matchedFactId],
      foreignColumns: [paymentProviderRefunds.id],
    }),
    uniqueIndex("refund_recon_hold_matched_fact_key")
      .on(t.tenantId, t.matchedFactId)
      .where(sql`${t.matchedFactId} IS NOT NULL`),
    check("refund_recon_hold_amount_check", sql`${t.amountIdr} >= 0`),
    check(
      "refund_recon_hold_resolution_check",
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('not_this_intent', 'counted_against_intent')`,
    ),
    check(
      "refund_recon_hold_resolution_identity_check",
      sql`${t.resolutionIdentity} IS NULL OR ${t.resolutionIdentity} IN ('same_as_counted', 'separate')`,
    ),
    check(
      "refund_recon_hold_provider_refund_id_kind_check",
      sql`(${t.providerRefundId} IS NULL) = (${t.providerRefundIdKind} IS NULL) AND (${t.providerRefundIdKind} IS NULL OR ${t.providerRefundIdKind} IN ('provider', 'synthetic_full', 'synthetic_hold'))`,
    ),
  ],
);
