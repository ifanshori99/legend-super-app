// WS-08 member foundation (legend-111j, docs/design/ws08-member-loyalty.md
// §3 "0193", shipped as migration 0203): the loyalty program per tenant, the
// member profile per (tenant, user) and the published consent policy versions.
//
// Database guarantees (hand SQL in the migration, not expressible here):
// - `customer_profiles.points_balance` is written only by the SECURITY
//   DEFINER balance trigger on `point_ledger`; legend_app has a per-column
//   UPDATE grant without that column, and a trigger rejects a profile
//   inserted with a nonzero balance.
// - `loyalty_programs.point_value_idr` cannot change once
//   `point_value_locked_at` is set (first ledger row), and the lock cannot be
//   cleared.
// - Member RLS (`member_self`, GUC `app.customer_profile_id`) on
//   `customer_profiles.id`.
// - `member_profile_user_index` is kept by a SECURITY DEFINER trigger and read
//   only through `app.member_profiles_of_user(text)` (cross-tenant lookup for
//   the identity merge, 290b); legend_app has no privilege on it.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idr } from "@starter/shared/core";
import type { ReferralRules } from "@starter/shared/crm";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns";
import { outlets, tenants } from "./platform-org";

const createdAt = timestamp("created_at", { withTimezone: true })
  .defaultNow()
  .notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull();

export const MEMBERSHIP_STATUSES = [
  "pending_verification",
  "active",
  "suspended",
  "closed",
] as const;
export type MembershipStatusValue = (typeof MEMBERSHIP_STATUSES)[number];

/** `loyalty_programs` (T): one program per tenant, created inactive (§8). */
export const loyaltyPrograms = pgTable(
  "loyalty_programs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 120 }).notNull().default("Poin Member"),
    earnSpendIdr: idrColumn("earn_spend_idr").notNull().default(idr(10_000)),
    earnPoints: integer("earn_points").notNull().default(1),
    expiryMonths: integer("expiry_months").notNull().default(12),
    rollingMonths: integer("rolling_months").notNull().default(12),
    pointValueIdr: idrColumn("point_value_idr").notNull().default(idr(100)),
    /** Null = no daily cap. Default 500 (founder Q69). */
    dailyPointCapPerCustomer: bigint("daily_point_cap_per_customer", {
      mode: "number",
    }).default(500),
    phoneLookupDailyCapPerCashier: integer("phone_lookup_daily_cap_per_cashier")
      .notNull()
      .default(20),
    employeeSelfServeBan: boolean("employee_self_serve_ban")
      .notNull()
      .default(true),
    /** Contract `referralRulesSchema`; written by 290e (legend-3zd1). */
    referral: jsonb("referral")
      .$type<ReferralRules>()
      .notNull()
      .default(
        sql`'{"enabled":false,"referrerPoints":100,"refereePoints":50,"qualifyingEvent":"first_paid_order","minFirstOrderIdr":0,"maxReferralsPerCustomerPerMonth":10}'::jsonb`,
      ),
    isActive: boolean("is_active").notNull().default(false),
    /** Set by the ledger trigger at the first ledger row; never cleared. */
    pointValueLockedAt: timestamp("point_value_locked_at", {
      withTimezone: true,
    }),
    createdAt,
    updatedAt,
    updatedBy: text("updated_by"),
  },
  (table) => [
    unique("loyalty_programs_tenant_key").on(table.tenantId),
    unique("loyalty_programs_tenant_id_id_key").on(table.tenantId, table.id),
    check(
      "loyalty_programs_earn_check",
      sql`${table.earnSpendIdr} > 0 AND ${table.earnPoints} > 0`,
    ),
    check(
      "loyalty_programs_months_check",
      sql`${table.expiryMonths} BETWEEN 1 AND 60 AND ${table.rollingMonths} BETWEEN 1 AND 60`,
    ),
    check(
      "loyalty_programs_point_value_check",
      sql`${table.pointValueIdr} > 0`,
    ),
    check(
      "loyalty_programs_daily_cap_check",
      sql`${table.dailyPointCapPerCustomer} IS NULL OR ${table.dailyPointCapPerCustomer} > 0`,
    ),
    check(
      "loyalty_programs_phone_lookup_cap_check",
      sql`${table.phoneLookupDailyCapPerCashier} > 0`,
    ),
  ],
);

/** `customer_profiles` (T): a member of a tenant, one per (tenant, user). */
export const customerProfiles = pgTable(
  "customer_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Better Auth user id; null only on a profile closed by a merge. */
    userId: text("user_id"),
    whatsappHash: varchar("whatsapp_hash", { length: 64 }),
    name: varchar("name", { length: 120 }).notNull(),
    birthMonthDay: varchar("birth_month_day", { length: 5 }),
    /** Written only by the point ledger balance trigger. */
    pointsBalance: bigint("points_balance", { mode: "number" })
      .notNull()
      .default(0),
    lifetimeSpendIdr: idrColumn("lifetime_spend_idr").notNull().default(idr(0)),
    visitsCount: integer("visits_count").notNull().default(0),
    firstVisitAt: timestamp("first_visit_at", { withTimezone: true }),
    lastVisitAt: timestamp("last_visit_at", { withTimezone: true }),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    referralCode: varchar("referral_code", { length: 20 }),
    membershipStatus: varchar("membership_status", { length: 30 })
      .$type<MembershipStatusValue>()
      .notNull(),
    whatsappVerifiedAt: timestamp("whatsapp_verified_at", {
      withTimezone: true,
    }),
    homeOutletId: outletIdColumn(() => outlets.id, "home_outlet_id"),
    mergedIntoProfileId: uuid("merged_into_profile_id"),
    /**
     * Current loyalty tier (legend-3zd1). Composite FK to `loyalty_tiers` is in
     * crm-tiers.custom.sql, not here, to avoid a circular import.
     */
    tierId: uuid("tier_id"),
    tierEvaluatedAt: timestamp("tier_evaluated_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("customer_profiles_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("customer_profiles_tenant_user_key")
      .on(table.tenantId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("customer_profiles_tenant_whatsapp_key")
      .on(table.tenantId, table.whatsappHash)
      .where(
        sql`${table.whatsappHash} IS NOT NULL AND ${table.membershipStatus} <> 'closed'`,
      ),
    unique("customer_profiles_tenant_referral_code_key").on(
      table.tenantId,
      table.referralCode,
    ),
    check(
      "customer_profiles_points_balance_check",
      sql`${table.pointsBalance} >= 0`,
    ),
    check(
      "customer_profiles_counters_check",
      sql`${table.lifetimeSpendIdr} >= 0 AND ${table.visitsCount} >= 0`,
    ),
    check(
      "customer_profiles_status_check",
      sql`${table.membershipStatus} IN ('pending_verification', 'active', 'suspended', 'closed')`,
    ),
    check(
      "customer_profiles_active_verified_check",
      sql`${table.membershipStatus} <> 'active' OR ${table.whatsappVerifiedAt} IS NOT NULL`,
    ),
    check(
      "customer_profiles_birth_month_day_check",
      sql`${table.birthMonthDay} IS NULL OR ${table.birthMonthDay} ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'`,
    ),
    check(
      "customer_profiles_referral_code_check",
      sql`${table.referralCode} IS NULL OR ${table.referralCode} ~ '^[A-Z0-9]{4,20}$'`,
    ),
  ],
);

/**
 * `member_profile_user_index`: id-only copy of (user, tenant, profile,
 * status), RLS enabled but not forced and no policy (pattern 0126
 * `delivery_store_index`). Read only via `app.member_profiles_of_user`.
 */
export const memberProfileUserIndex = pgTable(
  "member_profile_user_index",
  {
    profileId: uuid("profile_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    status: varchar("status", { length: 30 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId] }),
    index("member_profile_user_index_user_idx").on(table.userId),
  ],
);

/** `consent_policy_versions` (T): the published text versions per purpose. */
export const consentPolicyVersions = pgTable(
  "consent_policy_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    purpose: varchar("purpose", { length: 20 }).notNull(),
    version: varchar("version", { length: 20 }).notNull(),
    textHash: varchar("text_hash", { length: 64 }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    unique("consent_policy_versions_key").on(
      table.tenantId,
      table.purpose,
      table.version,
    ),
    check(
      "consent_policy_versions_purpose_check",
      sql`${table.purpose} IN ('loyalty', 'marketing', 'ai')`,
    ),
  ],
);
