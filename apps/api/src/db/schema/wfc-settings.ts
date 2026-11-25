// WFC business settings and hourly seat quota (brief 1270 card W1, decision 28).
// Tenant RLS, outlet RLS and the append-only guard are installed in
// wfc-seat.custom.sql.
//
// - `wfc_business_settings` (T, E): append-only, one row per approved version.
//   A row is written only after a second person approved it, so `proposed_by`
//   and `approved_by` are both required and differ. Every number is NOT NULL
//   without a default (except the no-show grace): an outlet with no version in
//   force cannot sell (409 WFC_CONFIG_INCOMPLETE). The version of a business
//   date is the one with the latest `effective_from` on or before it, then the
//   highest `version`.
// - `wfc_hourly_quotas` (T, E): seats sellable per outlet-local weekday and
//   hour, one row per cell; a missing cell is 0. The service keeps every cell
//   at or under the active WFC seats.
import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";
import { user } from "./user.ts";

export const wfcBusinessSettings = pgTable(
  "wfc_business_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    version: integer("version").notNull(),
    /** Business date (outlet calendar) from which this version applies. */
    effectiveFrom: date("effective_from").notNull(),
    totalSeats: integer("total_seats").notNull(),
    wfcSeats: integer("wfc_seats").notNull(),
    openHoursPerMonth: integer("open_hours_per_month").notNull(),
    fixedCostIdr: idrColumn("fixed_cost_idr").notNull(),
    targetRevenueIdr: idrColumn("target_revenue_idr").notNull(),
    targetProfitIdr: idrColumn("target_profit_idr").notNull(),
    targetOccupancyBp: integer("target_occupancy_bp").notNull(),
    spendPerPersonIdr: idrColumn("spend_per_person_idr").notNull(),
    cogsBp: integer("cogs_bp").notNull(),
    avgStayMinutes: integer("avg_stay_minutes").notNull(),
    noShowMinutes: integer("no_show_minutes").notNull().default(30),
    reason: varchar("reason", { length: 500 }).notNull(),
    proposedBy: text("proposed_by")
      .notNull()
      .references(() => user.id),
    approvedBy: text("approved_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("wfc_business_settings_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("wfc_business_settings_version_key").on(
      table.tenantId,
      table.outletId,
      table.version,
    ),
    foreignKey({
      name: "wfc_business_settings_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("wfc_business_settings_effective_idx").on(
      table.tenantId,
      table.outletId,
      table.effectiveFrom,
      table.version,
    ),
    check(
      "wfc_business_settings_two_person_check",
      sql`${table.proposedBy} <> ${table.approvedBy}`,
    ),
    check(
      "wfc_business_settings_seats_check",
      sql`${table.wfcSeats} BETWEEN 1 AND ${table.totalSeats}`,
    ),
    check(
      "wfc_business_settings_amount_check",
      sql`${table.fixedCostIdr} > 0 AND ${table.targetRevenueIdr} > 0 AND ${table.targetProfitIdr} >= 0 AND ${table.spendPerPersonIdr} > 0`,
    ),
    check(
      "wfc_business_settings_range_check",
      sql`${table.version} >= 1 AND ${table.openHoursPerMonth} BETWEEN 1 AND 744 AND ${table.targetOccupancyBp} BETWEEN 1 AND 10000 AND ${table.cogsBp} BETWEEN 1 AND 9999 AND ${table.avgStayMinutes} BETWEEN 1 AND 1440 AND ${table.noShowMinutes} BETWEEN 1 AND 240`,
    ),
  ],
);

export const wfcHourlyQuotas = pgTable(
  "wfc_hourly_quotas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** Outlet-local weekday, 0 = Sunday. */
    dayOfWeek: smallint("day_of_week").notNull(),
    hour: smallint("hour").notNull(),
    seats: integer("seats").notNull(),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("wfc_hourly_quotas_cell_key").on(
      table.tenantId,
      table.outletId,
      table.dayOfWeek,
      table.hour,
    ),
    foreignKey({
      name: "wfc_hourly_quotas_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "wfc_hourly_quotas_cell_check",
      sql`${table.dayOfWeek} BETWEEN 0 AND 6 AND ${table.hour} BETWEEN 0 AND 23`,
    ),
    check(
      "wfc_hourly_quotas_seats_check",
      sql`${table.seats} BETWEEN 0 AND 1000`,
    ),
  ],
);
