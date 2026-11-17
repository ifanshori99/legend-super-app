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
import { paymentIntents } from "./payment.ts";

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
  },
  (t) => [
    unique("refund_recon_hold_event_key").on(t.tenantId, t.webhookEventId),
    foreignKey({
      name: "refund_recon_hold_intent_fk",
      columns: [t.tenantId, t.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    // One hold per provider refund of an intent: the provider resending the
    // same refund under a new event id adds none.
    uniqueIndex("refund_recon_hold_provider_refund_key")
      .on(t.tenantId, t.paymentIntentId, t.providerRefundId)
      .where(sql`${t.providerRefundId} IS NOT NULL`),
    index("refund_recon_hold_intent_idx").on(t.tenantId, t.paymentIntentId),
    check("refund_recon_hold_amount_check", sql`${t.amountIdr} >= 0`),
    check(
      "refund_recon_hold_resolution_check",
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('not_this_intent', 'counted_against_intent')`,
    ),
  ],
);
