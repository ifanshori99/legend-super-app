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
  timestamp,
  unique,
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
 * blocks refunds and payouts of the intent. `webhookEventId` is the id of the
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
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    unique("refund_recon_hold_event_key").on(t.tenantId, t.webhookEventId),
    foreignKey({
      name: "refund_recon_hold_intent_fk",
      columns: [t.tenantId, t.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    index("refund_recon_hold_intent_idx").on(t.tenantId, t.paymentIntentId),
    check("refund_recon_hold_amount_check", sql`${t.amountIdr} >= 0`),
  ],
);
