// Wi-Fi quota engine tables (bead legend-kmd3; PRD v1.7 §3 F25 "Wi-Fi Berbasis
// Belanja", §6 K wifi_sessions; FAC-12/FAC-13/FAC-14).
//
// - `wifi_sessions`: one row per guest device session. The quota numbers
//   (`quota_minutes`, `used_minutes`, `speed_tier`) are what the policy row of
//   the zone computed at `quota_updated_at`; the raw controller device id is
//   NOT stored here (personal data, edge-local in `wifi_device_grants`). At
//   most one open session per account + device, and the open sessions of an
//   account never exceed the policy's `max_devices` (service-level check under
//   the account lock).
// - `wifi_spend_entries`: the paid-spend ledger the quota is derived from. One
//   `paid` row per paid order and one `refund` row per refund, written by the
//   outbox consumer; (tenant, kind, source_id) is the replay guard. Practice
//   (training) orders never get a row. The day's spend of an account is the sum
//   of its rows for the business date, never a client-supplied number.
// - No FK to `customer_profiles` (WS-08 owns it and keeps it FORCE RLS); both
//   tables carry tenant + outlet RLS (wifi-quota.custom.sql).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";
import { wifiPolicies } from "./facility.ts";

export const wifiSessions = pgTable(
  "wifi_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    zoneId: uuid("zone_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    /** SHA-256 hex of the portal's device fingerprint; never the raw value. */
    deviceHash: varchar("device_hash", { length: 64 }).notNull(),
    /** Outlet business day the daily allowance belongs to. */
    businessDate: businessDate("business_date").notNull(),
    quotaMinutes: integer("quota_minutes").notNull(),
    usedMinutes: integer("used_minutes").notNull().default(0),
    speedTier: varchar("speed_tier", { length: 8 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Usage is accrued up to here; the next read adds the elapsed minutes. */
    accruedAt: timestamp("accrued_at", { withTimezone: true }).notNull(),
    quotaUpdatedAt: timestamp("quota_updated_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("wifi_sessions_tenant_id_id_key").on(t.tenantId, t.id),
    // One open session per account + device: a reload re-uses it.
    uniqueIndex("wifi_sessions_open_device_key")
      .on(t.tenantId, t.customerProfileId, t.deviceHash)
      .where(sql`${t.endedAt} IS NULL`),
    index("wifi_sessions_account_day_idx").on(
      t.tenantId,
      t.customerProfileId,
      t.businessDate,
    ),
    index("wifi_sessions_outlet_open_idx").on(
      t.tenantId,
      t.outletId,
      t.endedAt,
    ),
    foreignKey({
      name: "wifi_sessions_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "wifi_sessions_policy_fk",
      columns: [t.tenantId, t.policyId],
      foreignColumns: [wifiPolicies.tenantId, wifiPolicies.id],
    }),
    check(
      "wifi_sessions_device_hash_check",
      sql`${t.deviceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "wifi_sessions_speed_tier_check",
      sql`${t.speedTier} IN ('full','base')`,
    ),
    check(
      "wifi_sessions_minutes_check",
      sql`${t.quotaMinutes} BETWEEN 0 AND 1440 AND ${t.usedMinutes} BETWEEN 0 AND 1440`,
    ),
  ],
);

export type WifiSessionRow = typeof wifiSessions.$inferSelect;

export const wifiSpendEntries = pgTable(
  "wifi_spend_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    businessDate: businessDate("business_date").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    kind: varchar("kind", { length: 8 }).notNull(),
    /** The order id for `paid`, the refund id for `refund`: the replay guard. */
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    /** Money actually paid (cash, gateway, EDC) or refunded; never points. */
    amountIdr: idrColumn("amount_idr").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("wifi_spend_entries_source_key").on(t.tenantId, t.kind, t.sourceId),
    index("wifi_spend_entries_account_day_idx").on(
      t.tenantId,
      t.customerProfileId,
      t.businessDate,
    ),
    index("wifi_spend_entries_order_idx").on(t.tenantId, t.orderId),
    foreignKey({
      name: "wifi_spend_entries_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check("wifi_spend_entries_kind_check", sql`${t.kind} IN ('paid','refund')`),
    check("wifi_spend_entries_amount_check", sql`${t.amountIdr} >= 0`),
  ],
);

export type WifiSpendEntryRow = typeof wifiSpendEntries.$inferSelect;
