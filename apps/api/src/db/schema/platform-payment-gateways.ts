// `platform_payment_gateways` (global, sub-302 D7): which payment gateways the
// platform offers, which one new tenants get, and the per-gateway webhook
// time window and secret grace period. Not tenant data (no tenant column, no
// RLS), not per package. Secrets never live here: credentials stay sealed in
// `tenant_integrations`.
// `platform_payment_gateway_changes` is its append-only change history: one
// row per Super Admin update, non-secret columns only. Tenant audit logs
// cannot hold it because a platform change belongs to no tenant.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const platformPaymentGateways = pgTable(
  "platform_payment_gateways",
  {
    provider: varchar("provider", { length: 20 }).primaryKey(),
    displayName: varchar("display_name", { length: 60 }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    /** Webhook signature timestamp window, past side (default 25 h). */
    webhookTolerancePastSec: integer("webhook_tolerance_past_sec")
      .notNull()
      .default(90000),
    /** Webhook signature timestamp window, future side (default 5 min). */
    webhookToleranceFutureSec: integer("webhook_tolerance_future_sec")
      .notNull()
      .default(300),
    /** How long the previous webhook secret still verifies after rotation. */
    secretGraceHours: integer("secret_grace_hours").notNull().default(72),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "platform_payment_gateways_provider_check",
      sql`${table.provider} IN ('doit', 'duitku')`,
    ),
    check(
      "platform_payment_gateways_default_enabled_check",
      sql`NOT ${table.isDefault} OR ${table.enabled}`,
    ),
    uniqueIndex("platform_payment_gateways_one_default")
      .on(table.isDefault)
      .where(sql`${table.isDefault}`),
  ],
);

export const platformPaymentGatewayChanges = pgTable(
  "platform_payment_gateway_changes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 20 }).notNull(),
    actorUserId: text("actor_user_id").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    /** Non-secret columns of the row before the update. */
    before: jsonb("before").$type<Record<string, unknown>>().notNull(),
    after: jsonb("after").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("platform_payment_gateway_changes_provider_idx").on(
      table.provider,
      table.createdAt,
    ),
  ],
);
