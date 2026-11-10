// WS-08 rewards, redemptions and missions (legend-m4p5,
// docs/design/ws08-member-loyalty.md §M5, §3 "0195", shipped as migration
// 0207).
//
// Database guarantees (hand SQL in crm-rewards.custom.sql):
// - Tenant RLS on all four tables; member RLS (`member_self`) on
//   `reward_redemptions`, `mission_progress` and `vouchers`.
// - No DELETE or TRUNCATE for legend_app on these tables.
// - `reward_redemptions_status_guard` only allows pending -> fulfilled |
//   cancelled | expired and freezes reward, profile, points, code and key.
// - `vouchers.customer_profile_id` gets its composite FK to
//   `customer_profiles` in the hand SQL (FORCE RLS lift, pattern 2).

import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  MissionPeriod,
  MissionReward,
  MissionRule,
  MissionType,
  RewardType,
} from "@starter/shared/crm";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { customerProfiles } from "./crm-member";
import { pointLedger } from "./crm-ledger";
import { vouchers } from "./crm-promo";
import { menuItems } from "./menu";
import { outlets, tenants } from "./platform-org";
import { orders } from "./qr-order";

const createdAt = timestamp("created_at", { withTimezone: true })
  .defaultNow()
  .notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull();

export const REWARD_REDEMPTION_STATUSES = [
  "pending",
  "fulfilled",
  "cancelled",
  "expired",
] as const;
export type RewardRedemptionStatusValue =
  (typeof REWARD_REDEMPTION_STATUSES)[number];

/** `rewards` (T): the redeemable catalog. */
export const rewards = pgTable(
  "rewards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    type: varchar("type", { length: 20 }).$type<RewardType>().notNull(),
    pointsCost: integer("points_cost").notNull(),
    /** Null = unlimited. */
    stock: integer("stock"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    /** free_item / item_upgrade: the item handed over. Null for a voucher. */
    menuItemId: uuid("menu_item_id"),
    /** voucher: the value. Null for an item reward. */
    voucherValueIdr: idrColumn("voucher_value_idr"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Null = no per-member limit. */
    perCustomerLimit: integer("per_customer_limit"),
    redemptionValidDays: integer("redemption_valid_days").notNull().default(30),
    createdBy: text("created_by"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("rewards_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "rewards_menu_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    index("rewards_tenant_active_idx").on(
      table.tenantId,
      table.isActive,
      table.sortOrder,
    ),
    check(
      "rewards_type_check",
      sql`${table.type} IN ('free_item', 'item_upgrade', 'voucher')`,
    ),
    check("rewards_points_cost_check", sql`${table.pointsCost} > 0`),
    check(
      "rewards_stock_check",
      sql`${table.stock} IS NULL OR ${table.stock} >= 0`,
    ),
    check(
      "rewards_per_customer_limit_check",
      sql`${table.perCustomerLimit} IS NULL OR ${table.perCustomerLimit} > 0`,
    ),
    check(
      "rewards_redemption_valid_days_check",
      sql`${table.redemptionValidDays} BETWEEN 1 AND 365`,
    ),
    check(
      "rewards_validity_check",
      sql`${table.validUntil} IS NULL OR ${table.validUntil} > ${table.validFrom}`,
    ),
    check(
      "rewards_type_shape_check",
      sql`CASE WHEN ${table.type} = 'voucher'
               THEN ${table.voucherValueIdr} IS NOT NULL AND ${table.voucherValueIdr} > 0 AND ${table.menuItemId} IS NULL
               ELSE ${table.menuItemId} IS NOT NULL AND ${table.voucherValueIdr} IS NULL END`,
    ),
  ],
);

/** `reward_redemptions` (T, member RLS): one per redeem; status moves once. */
export const rewardRedemptions = pgTable(
  "reward_redemptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    rewardId: uuid("reward_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    /** The POS order the redemption was used on (set on fulfil). */
    orderId: ulidInUuid("order_id"),
    pointsSpent: integer("points_spent").notNull(),
    status: varchar("status", { length: 12 })
      .$type<RewardRedemptionStatusValue>()
      .notNull()
      .default("pending"),
    redemptionCode: varchar("redemption_code", { length: 32 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** The `redeem` row of `point_ledger` (ULID). */
    ledgerEntryId: char("ledger_entry_id", { length: 26 }),
    /** Voucher reward: the voucher whose code is the redemption code. */
    voucherId: uuid("voucher_id"),
    fulfilledOutletId: outletIdColumn(() => outlets.id),
    fulfilledBy: text("fulfilled_by"),
    /** The `adjust` row that gave the points back (cancel / expiry, ULID). */
    restoreEntryId: char("restore_entry_id", { length: 26 }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("reward_redemptions_tenant_id_id_key").on(table.tenantId, table.id),
    unique("reward_redemptions_idempotency_key").on(
      table.tenantId,
      table.customerProfileId,
      table.idempotencyKey,
    ),
    unique("reward_redemptions_code_key").on(
      table.tenantId,
      table.redemptionCode,
    ),
    foreignKey({
      name: "reward_redemptions_reward_fk",
      columns: [table.tenantId, table.rewardId],
      foreignColumns: [rewards.tenantId, rewards.id],
    }),
    foreignKey({
      name: "reward_redemptions_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    foreignKey({
      name: "reward_redemptions_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "reward_redemptions_ledger_entry_fk",
      columns: [table.tenantId, table.ledgerEntryId],
      foreignColumns: [pointLedger.tenantId, pointLedger.id],
    }),
    foreignKey({
      name: "reward_redemptions_restore_entry_fk",
      columns: [table.tenantId, table.restoreEntryId],
      foreignColumns: [pointLedger.tenantId, pointLedger.id],
    }),
    foreignKey({
      name: "reward_redemptions_voucher_fk",
      columns: [table.tenantId, table.voucherId],
      foreignColumns: [vouchers.tenantId, vouchers.id],
    }),
    index("reward_redemptions_status_expiry_idx").on(
      table.tenantId,
      table.status,
      table.expiresAt,
    ),
    index("reward_redemptions_profile_reward_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.rewardId,
    ),
    check("reward_redemptions_points_check", sql`${table.pointsSpent} > 0`),
    check(
      "reward_redemptions_status_check",
      sql`${table.status} IN ('pending', 'fulfilled', 'cancelled', 'expired')`,
    ),
    check(
      "reward_redemptions_fulfilled_check",
      sql`(${table.status} = 'fulfilled') = (${table.fulfilledAt} IS NOT NULL)`,
    ),
    check(
      "reward_redemptions_cancelled_check",
      sql`(${table.status} = 'cancelled') = (${table.cancelledAt} IS NOT NULL)`,
    ),
  ],
);

/** `missions` (T): mission and stamp card definitions. */
export const missions = pgTable(
  "missions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    type: varchar("type", { length: 20 }).$type<MissionType>().notNull(),
    rule: jsonb("rule").$type<MissionRule>().notNull(),
    reward: jsonb("reward").$type<MissionReward>().notNull(),
    period: jsonb("period").$type<MissionPeriod>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("missions_tenant_id_id_key").on(table.tenantId, table.id),
    index("missions_tenant_active_idx").on(table.tenantId, table.isActive),
    check(
      "missions_type_check",
      sql`${table.type} IN ('visit_count', 'try_new_item', 'weekday_visit', 'stamp_card')`,
    ),
    check(
      "missions_window_check",
      sql`${table.startsAt} IS NULL OR ${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`,
    ),
  ],
);

/** `mission_progress` (T, member RLS): one row per mission, member and period. */
export const missionProgress = pgTable(
  "mission_progress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    missionId: uuid("mission_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    periodKey: varchar("period_key", { length: 32 }).notNull(),
    progress: integer("progress").notNull().default(0),
    target: integer("target").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    rewardIssuedAt: timestamp("reward_issued_at", { withTimezone: true }),
    voucherId: uuid("voucher_id"),
    voucherCode: varchar("voucher_code", { length: 32 }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("mission_progress_tenant_id_id_key").on(table.tenantId, table.id),
    unique("mission_progress_period_key").on(
      table.tenantId,
      table.missionId,
      table.customerProfileId,
      table.periodKey,
    ),
    foreignKey({
      name: "mission_progress_mission_fk",
      columns: [table.tenantId, table.missionId],
      foreignColumns: [missions.tenantId, missions.id],
    }),
    foreignKey({
      name: "mission_progress_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    foreignKey({
      name: "mission_progress_voucher_fk",
      columns: [table.tenantId, table.voucherId],
      foreignColumns: [vouchers.tenantId, vouchers.id],
    }),
    index("mission_progress_profile_idx").on(
      table.tenantId,
      table.customerProfileId,
    ),
    check(
      "mission_progress_counts_check",
      sql`${table.progress} >= 0 AND ${table.target} > 0`,
    ),
  ],
);
