// VA staff release (legend-5wn1e). A virtual account code that the provider has
// not answered final for (provider_final_at null) keeps the bill locked, since
// local time is no proof the code is dead (legend-tqkbb). A supervisor may
// release such a code 30 minutes after it lapsed (founder Q93, same rule as the
// QRIS release). The row is both the audit of the release and the durable queue
// that keeps asking the provider until it answers for good. One row per intent,
// never deleted. While the row exists the code no longer blocks the bill, and
// money that still arrives on it is parked as unallocated funds, never applied.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns";
import { paymentIntents } from "./payment";
import { outlets, tenants } from "./platform-org";
import { orders } from "./qr-order";

export const PAYMENT_VA_RELEASE_STATUSES = ["open", "resolved"] as const;
export type PaymentVaReleaseStatus =
  (typeof PAYMENT_VA_RELEASE_STATUSES)[number];

export const PAYMENT_VA_RELEASE_RESOLUTIONS = [
  "paid_recorded",
  "provider_expired",
  "provider_failed",
] as const;
export type PaymentVaReleaseResolution =
  (typeof PAYMENT_VA_RELEASE_RESOLUTIONS)[number];

export const paymentVaReleases = pgTable(
  "payment_va_releases",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    id: ulidInUuid("id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    /** The supervisor's reason, trimmed, 3..300 characters. */
    reason: text("reason").notNull(),
    releasedBy: text("released_by").notNull(),
    approvedBy: text("approved_by").notNull(),
    overrideId: ulidInUuid("override_id").notNull(),
    status: text("status").$type<PaymentVaReleaseStatus>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** The provider's last answer: pending / paid / expired / failed /
     * unreachable / paid_without_amount / no_provider_ref. */
    lastProviderStatus: text("last_provider_status"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution").$type<PaymentVaReleaseResolution>(),
  },
  (table) => [
    primaryKey({
      name: "payment_va_releases_pkey",
      columns: [table.tenantId, table.id],
    }),
    unique("payment_va_releases_intent_key").on(
      table.tenantId,
      table.paymentIntentId,
    ),
    unique("payment_va_releases_override_key").on(
      table.tenantId,
      table.overrideId,
    ),
    foreignKey({
      name: "payment_va_releases_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "payment_va_releases_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    foreignKey({
      name: "payment_va_releases_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    index("payment_va_releases_due_idx")
      .on(table.status, table.nextCheckAt)
      .where(sql`${table.status} = 'open'`),
    check(
      "payment_va_releases_status_check",
      sql`${table.status} IN ('open', 'resolved')`,
    ),
    check("payment_va_releases_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "payment_va_releases_reason_check",
      sql`char_length(${table.reason}) BETWEEN 3 AND 300 AND ${table.reason} = btrim(${table.reason})`,
    ),
    check(
      "payment_va_releases_resolved_check",
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} IS NOT NULL AND ${table.resolution} IS NOT NULL)`,
    ),
    check(
      "payment_va_releases_resolution_check",
      sql`${table.resolution} IS NULL OR ${table.resolution} IN ('paid_recorded', 'provider_expired', 'provider_failed')`,
    ),
  ],
);
