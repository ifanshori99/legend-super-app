// WS-08 point ledger (legend-111j, docs/design/ws08-member-loyalty.md §M5,
// §M6, §3 "0193", shipped as migration 0203).
//
// Database guarantees (hand SQL in the migration):
// - `point_ledger` is append-only (`point_ledger is append-only (LOY-01)`);
//   legend_app has SELECT and INSERT only.
// - BEFORE INSERT copies the program's `point_value_idr` into the row and
//   computes `liability_idr` (callers never pass them; the Drizzle defaults
//   are placeholders), locking the point value at the first row.
// - AFTER INSERT (SECURITY DEFINER) adds `points` to
//   `customer_profiles.points_balance`; its `>= 0` CHECK aborts an insert
//   that would make the balance negative (LOY-02).
// - Member RLS on `point_ledger.customer_profile_id` and
//   `customer_visits.customer_profile_id`.

import { sql } from "drizzle-orm";
import {
  bigint,
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
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idr } from "@starter/shared/core";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { customerProfiles } from "./crm-member";
import { outlets, tenants } from "./platform-org";
import { orders } from "./qr-order";

const createdAt = timestamp("created_at", { withTimezone: true })
  .defaultNow()
  .notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .notNull();

export const POINT_LEDGER_TYPES = [
  "earn",
  "redeem",
  "expire",
  "reverse",
  "bonus",
  "adjust",
] as const;
export type PointLedgerTypeValue = (typeof POINT_LEDGER_TYPES)[number];

/** Loyalty events held for reconciliation; never ack an uncertain earn as lost. */
export const loyaltyEarnParked = pgTable(
  "loyalty_earn_parked",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    eventId: varchar("event_id", { length: 80 }).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    eventName: varchar("event_name", { length: 80 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    reason: varchar("reason", { length: 40 }).notNull(),
    createdAt,
  },
  (table) => [
    unique("loyalty_earn_parked_tenant_event_key").on(
      table.tenantId,
      table.eventId,
    ),
    index("loyalty_earn_parked_order_idx").on(table.tenantId, table.orderId),
  ],
);

/** `point_ledger` (T): append-only, the balance is its sum (LOY-01..02). */
export const pointLedger = pgTable(
  "point_ledger",
  {
    /** ULID (contract `pointLedgerEntrySchema.id`). */
    id: char("id", { length: 26 }).primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    /** Where it happened; reporting only. */
    outletId: outletIdColumn(() => outlets.id),
    type: varchar("type", { length: 10 })
      .$type<PointLedgerTypeValue>()
      .notNull(),
    points: bigint("points", { mode: "number" }).notNull(),
    sourceType: varchar("source_type", { length: 20 }).notNull(),
    sourceId: text("source_id"),
    reversesEntryId: char("reverses_entry_id", { length: 26 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Set by the BEFORE INSERT trigger from the program row. */
    pointValueIdr: bigint("point_value_idr", { mode: "number" })
      .notNull()
      .default(0),
    /** Set by the BEFORE INSERT trigger: points * point_value_idr. */
    liabilityIdr: bigint("liability_idr", { mode: "number" })
      .notNull()
      .default(0),
    businessDate: businessDate("business_date"),
    reason: varchar("reason", { length: 300 }),
    createdBy: text("created_by"),
    postingSeq: bigint("posting_seq", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    createdAt,
  },
  (table) => [
    unique("point_ledger_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "point_ledger_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    foreignKey({
      name: "point_ledger_reverses_entry_fk",
      columns: [table.tenantId, table.reversesEntryId],
      foreignColumns: [table.tenantId, table.id],
    }),
    uniqueIndex("point_ledger_dedupe_key")
      .on(table.tenantId, table.type, table.sourceType, table.sourceId)
      .where(sql`${table.sourceId} IS NOT NULL`),
    index("point_ledger_profile_seq_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.postingSeq,
    ),
    check(
      "point_ledger_type_check",
      sql`${table.type} IN ('earn', 'redeem', 'expire', 'reverse', 'bonus', 'adjust')`,
    ),
    check(
      "point_ledger_sign_check",
      sql`CASE WHEN ${table.type} IN ('earn', 'bonus') THEN ${table.points} > 0
               WHEN ${table.type} IN ('redeem', 'expire', 'reverse') THEN ${table.points} < 0
               ELSE ${table.points} <> 0 END`,
    ),
    check(
      "point_ledger_source_type_check",
      sql`CASE ${table.type}
            WHEN 'earn' THEN ${table.sourceType} IN ('order', 'table_claim')
            WHEN 'bonus' THEN ${table.sourceType} IN ('mission', 'referral', 'birthday', 'adjustment')
            WHEN 'redeem' THEN ${table.sourceType} IN ('reward_redemption', 'pos_tender')
            WHEN 'expire' THEN ${table.sourceType} = 'expiry'
            WHEN 'reverse' THEN ${table.sourceType} IN ('refund', 'void')
            ELSE ${table.sourceType} = 'adjustment' END`,
    ),
    check(
      "point_ledger_source_id_check",
      sql`${table.type} NOT IN ('earn', 'redeem', 'reverse') OR ${table.sourceId} IS NOT NULL`,
    ),
    check(
      "point_ledger_expires_check",
      sql`CASE WHEN ${table.type} IN ('earn', 'bonus') THEN ${table.expiresAt} IS NOT NULL
               WHEN ${table.type} = 'redeem' THEN ${table.expiresAt} IS NULL
               ELSE true END`,
    ),
    check(
      "point_ledger_adjust_check",
      sql`${table.type} <> 'adjust' OR (
            ${table.reason} IS NOT NULL
            AND (${table.reversesEntryId} IS NULL OR ${table.expiresAt} IS NULL)
            AND (${table.reversesEntryId} IS NOT NULL OR ${table.points} < 0 OR ${table.expiresAt} IS NOT NULL))`,
    ),
    check(
      "point_ledger_liability_check",
      sql`${table.pointValueIdr} > 0 AND ${table.liabilityIdr} = ${table.points} * ${table.pointValueIdr}`,
    ),
  ],
);

export const POINT_EARN_STATES = [
  "booked",
  "reversed",
  "skipped",
  "blocked",
  "capped",
] as const;
export type PointEarnState = (typeof POINT_EARN_STATES)[number];

/** `point_earn_records` (T+O): one per paid order with a member; mutable, written under the profile lock. */
export const pointEarnRecords = pgTable(
  "point_earn_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    channel: varchar("channel", { length: 20 }).notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    state: varchar("state", { length: 20 }).$type<PointEarnState>().notNull(),
    outcomeReason: varchar("outcome_reason", { length: 40 }),
    businessDate: businessDate("business_date").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    eligibleSpendIdr: idrColumn("eligible_spend_idr").notNull().default(idr(0)),
    computedPoints: bigint("computed_points", { mode: "number" })
      .notNull()
      .default(0),
    cappedPoints: bigint("capped_points", { mode: "number" })
      .notNull()
      .default(0),
    bookedPoints: bigint("booked_points", { mode: "number" })
      .notNull()
      .default(0),
    refundedEligibleIdr: idrColumn("refunded_eligible_idr")
      .notNull()
      .default(idr(0)),
    reversedPoints: bigint("reversed_points", { mode: "number" })
      .notNull()
      .default(0),
    reversalShortfallPoints: bigint("reversal_shortfall_points", {
      mode: "number",
    })
      .notNull()
      .default(0),
    earnEntryId: char("earn_entry_id", { length: 26 }),
    /** legend-wa4hp: refund/void ids already applied to this record. */
    appliedReversalIds: text("applied_reversal_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("point_earn_records_tenant_id_id_key").on(table.tenantId, table.id),
    unique("point_earn_records_order_key").on(table.tenantId, table.orderId),
    foreignKey({
      name: "point_earn_records_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "point_earn_records_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    index("point_earn_records_profile_day_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.businessDate,
    ),
    check(
      "point_earn_records_state_check",
      sql`${table.state} IN ('booked', 'reversed', 'skipped', 'blocked', 'capped')`,
    ),
    check(
      "point_earn_records_points_check",
      sql`${table.computedPoints} >= 0 AND ${table.cappedPoints} >= 0 AND ${table.bookedPoints} >= 0
          AND ${table.reversedPoints} >= 0 AND ${table.reversedPoints} <= ${table.bookedPoints}
          AND ${table.reversalShortfallPoints} >= 0
          AND ${table.refundedEligibleIdr} >= 0 AND ${table.refundedEligibleIdr} <= ${table.eligibleSpendIdr}`,
    ),
  ],
);

/** `customer_visits` (T+O): one per paid order of an active member. */
export const customerVisits = pgTable(
  "customer_visits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    businessDate: businessDate("business_date").notNull(),
    visitedAt: timestamp("visited_at", { withTimezone: true }).notNull(),
    /** Eligible spend of the order. */
    spendIdr: idrColumn("spend_idr").notNull(),
    itemCount: integer("item_count").notNull().default(0),
    createdAt,
  },
  (table) => [
    unique("customer_visits_tenant_id_id_key").on(table.tenantId, table.id),
    unique("customer_visits_order_key").on(table.tenantId, table.orderId),
    foreignKey({
      name: "customer_visits_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "customer_visits_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    index("customer_visits_profile_idx").on(
      table.tenantId,
      table.customerProfileId,
      table.visitedAt,
    ),
    check(
      "customer_visits_amounts_check",
      sql`${table.spendIdr} >= 0 AND ${table.itemCount} >= 0`,
    ),
  ],
);

export const LOYALTY_ANOMALY_KINDS = [
  "daily_cap_hit",
  "self_serve_blocked",
  "refund_after_redeem",
  "phone_lookup_attach",
  "phone_lookup_cap_hit",
  "balance_mismatch",
] as const;
export type LoyaltyAnomalyKindValue = (typeof LOYALTY_ANOMALY_KINDS)[number];

/** `loyalty_anomalies` (T only: `outlet_id` is null for `balance_mismatch`). */
export const loyaltyAnomalies = pgTable(
  "loyalty_anomalies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id),
    customerProfileId: uuid("customer_profile_id"),
    orderId: ulidInUuid("order_id"),
    kind: varchar("kind", { length: 30 })
      .$type<LoyaltyAnomalyKindValue>()
      .notNull(),
    /** Staff user behind the event (cashier of a phone lookup). */
    actorUserId: text("actor_user_id"),
    businessDate: businessDate("business_date"),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt,
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    unique("loyalty_anomalies_tenant_id_id_key").on(table.tenantId, table.id),
    index("loyalty_anomalies_kind_idx").on(
      table.tenantId,
      table.kind,
      table.createdAt,
    ),
    index("loyalty_anomalies_actor_day_idx").on(
      table.tenantId,
      table.kind,
      table.actorUserId,
      table.businessDate,
    ),
    check(
      "loyalty_anomalies_kind_check",
      sql`${table.kind} IN ('daily_cap_hit', 'self_serve_blocked', 'refund_after_redeem', 'phone_lookup_attach', 'phone_lookup_cap_hit', 'balance_mismatch')`,
    ),
  ],
);

/**
 * `member_qr_redeem_nonces` (T+O, migration 0490, bead weexf): the nonce of a
 * member QR spent to redeem points at the POS. One row per QR, written in the
 * same transaction as the points debit, so a QR pays once and a failed debit
 * leaves the nonce unspent.
 */
export const memberQrRedeemNonces = pgTable(
  "member_qr_redeem_nonces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    nonce: varchar("nonce", { length: 64 }).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    points: bigint("points", { mode: "number" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("member_qr_redeem_nonces_nonce_key").on(table.tenantId, table.nonce),
    foreignKey({
      name: "member_qr_redeem_nonces_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "member_qr_redeem_nonces_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    check("member_qr_redeem_nonces_points_check", sql`${table.points} > 0`),
  ],
);

/**
 * `member_qr_redeem_mints` (T+O, migration 0512, legend-0ne0z): every redeem
 * QR the member PWA minted. The mint refuses a second token while one for the
 * same bill is still live (unexpired, unspent, minted at the current ledger
 * version). Written under the member's profile lock, so two mints of one bill
 * serialize. The redeem itself still trusts only the signed token and the
 * spent nonce (`member_qr_redeem_nonces`).
 */
export const memberQrRedeemMints = pgTable(
  "member_qr_redeem_mints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    nonce: varchar("nonce", { length: 64 }).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    points: bigint("points", { mode: "number" }).notNull(),
    ledgerVersion: bigint("ledger_version", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    mintedAt: timestamp("minted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("member_qr_redeem_mints_nonce_key").on(table.tenantId, table.nonce),
    index("member_qr_redeem_mints_order_idx").on(
      table.tenantId,
      table.orderId,
      table.expiresAt,
    ),
    foreignKey({
      name: "member_qr_redeem_mints_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "member_qr_redeem_mints_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    check("member_qr_redeem_mints_points_check", sql`${table.points} > 0`),
    check(
      "member_qr_redeem_mints_version_check",
      sql`${table.ledgerVersion} >= 0`,
    ),
  ],
);
