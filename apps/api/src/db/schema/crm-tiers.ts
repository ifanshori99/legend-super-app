// WS-08 loyalty tiers, tier history and referrals (legend-3zd1,
// docs/design/ws08-member-loyalty.md §M6, §3 "0197", shipped as migration
// 0210).
//
// Database guarantees (hand SQL in crm-tiers.custom.sql):
// - Tenant RLS on all three tables; member RLS only on `referrals` (a member
//   reads the referrals they gave or received). Tier ladders and tier history
//   carry no member RLS.
// - `customer_tier_history` is append-only (trigger plus REVOKE); no DELETE or
//   TRUNCATE for legend_app on `loyalty_tiers` and `referrals`.
// - `customer_profiles.tier_id` gets its composite FK to `loyalty_tiers` in the
//   hand SQL (FORCE RLS lift, pattern 2), so this file needs no circular
//   import with crm-member.ts.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ReferralStatus, TierBenefits } from "@starter/shared/crm";
import { idrColumn, tenantIdColumn, ulidInUuid } from "../columns";
import { customerProfiles } from "./crm-member";
import { tenants } from "./platform-org";
import { orders } from "./qr-order";

const createdAt = timestamp("created_at", { withTimezone: true })
  .defaultNow()
  .notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull();

export const TIER_HISTORY_REASONS = ["evaluation", "manual"] as const;
export type TierHistoryReasonValue = (typeof TIER_HISTORY_REASONS)[number];

/** `loyalty_tiers` (T): the tier ladder per tenant. Never deleted. */
export const loyaltyTiers = pgTable(
  "loyalty_tiers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 60 }).notNull(),
    /** Higher rank wins when several tiers qualify. */
    rank: integer("rank").notNull(),
    thresholdSpendIdr: idrColumn("threshold_spend_idr").notNull(),
    thresholdVisits: integer("threshold_visits").notNull(),
    benefits: jsonb("benefits").$type<TierBenefits>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("loyalty_tiers_tenant_rank_key").on(table.tenantId, table.rank),
    unique("loyalty_tiers_tenant_id_id_key").on(table.tenantId, table.id),
    check("loyalty_tiers_rank_check", sql`${table.rank} > 0`),
    check(
      "loyalty_tiers_threshold_check",
      sql`${table.thresholdSpendIdr} >= 0 AND ${table.thresholdVisits} >= 0`,
    ),
  ],
);

/** `customer_tier_history` (T): append-only record of every tier change. */
export const customerTierHistory = pgTable(
  "customer_tier_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    /** Null = had no tier. */
    fromTierId: uuid("from_tier_id"),
    /** Null = lost the tier. */
    toTierId: uuid("to_tier_id"),
    reason: varchar("reason", { length: 12 })
      .$type<TierHistoryReasonValue>()
      .notNull(),
    rollingSpendIdr: idrColumn("rolling_spend_idr").notNull(),
    rollingVisits: integer("rolling_visits").notNull(),
    createdAt,
  },
  (table) => [
    foreignKey({
      name: "customer_tier_history_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    foreignKey({
      name: "customer_tier_history_from_tier_fk",
      columns: [table.tenantId, table.fromTierId],
      foreignColumns: [loyaltyTiers.tenantId, loyaltyTiers.id],
    }),
    foreignKey({
      name: "customer_tier_history_to_tier_fk",
      columns: [table.tenantId, table.toTierId],
      foreignColumns: [loyaltyTiers.tenantId, loyaltyTiers.id],
    }),
    index("customer_tier_history_profile_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.createdAt,
    ),
    check(
      "customer_tier_history_reason_check",
      sql`${table.reason} IN ('evaluation', 'manual')`,
    ),
    check(
      "customer_tier_history_stats_check",
      sql`${table.rollingSpendIdr} >= 0 AND ${table.rollingVisits} >= 0`,
    ),
  ],
);

/** `referrals` (T, member RLS for referrer and referee): one per referee. */
export const referrals = pgTable(
  "referrals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    referrerProfileId: uuid("referrer_profile_id").notNull(),
    refereeProfileId: uuid("referee_profile_id").notNull(),
    code: varchar("code", { length: 20 }).notNull(),
    status: varchar("status", { length: 12 })
      .$type<ReferralStatus>()
      .notNull()
      .default("pending"),
    /** The referee's first paid order (ULID); set once qualified. */
    firstOrderId: ulidInUuid("first_order_id"),
    /** Program copy at signup, so a later program edit never changes it. */
    referrerPoints: integer("referrer_points").notNull(),
    refereePoints: integer("referee_points").notNull(),
    createdAt,
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    unique("referrals_tenant_id_id_key").on(table.tenantId, table.id),
    unique("referrals_tenant_referee_key").on(
      table.tenantId,
      table.refereeProfileId,
    ),
    foreignKey({
      name: "referrals_referrer_fk",
      columns: [table.tenantId, table.referrerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    foreignKey({
      name: "referrals_referee_fk",
      columns: [table.tenantId, table.refereeProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    foreignKey({
      name: "referrals_first_order_fk",
      columns: [table.tenantId, table.firstOrderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    index("referrals_referrer_status_idx").on(
      table.tenantId,
      table.referrerProfileId,
      table.status,
    ),
    check(
      "referrals_not_self_check",
      sql`${table.referrerProfileId} <> ${table.refereeProfileId}`,
    ),
    check(
      "referrals_status_check",
      sql`${table.status} IN ('pending', 'qualified', 'rewarded', 'expired')`,
    ),
    check("referrals_code_check", sql`${table.code} ~ '^[A-Z0-9]{4,20}$'`),
    check(
      "referrals_points_check",
      sql`${table.referrerPoints} >= 0 AND ${table.refereePoints} >= 0`,
    ),
    check(
      "referrals_first_order_check",
      sql`(${table.status} IN ('qualified', 'rewarded')) = (${table.firstOrderId} IS NOT NULL)`,
    ),
    check(
      "referrals_qualified_at_check",
      sql`(${table.status} IN ('qualified', 'rewarded')) = (${table.qualifiedAt} IS NOT NULL)`,
    ),
    check(
      "referrals_rewarded_at_check",
      sql`(${table.status} = 'rewarded') = (${table.rewardedAt} IS NOT NULL)`,
    ),
  ],
);
