// WFC min-spend windows (PRD v1.7 §3 F39 "Wi-Fi Berbasis Belanja", FAC-14;
// bead legend-bz9h). One row per (table session, one-hour window): the
// monitor's memory of what was spent and how often the guest was nudged. The
// row never moves money and never gates a session (rule M6).
//
// `min_spend_idr` is a snapshot of `wifi_policies.min_spend_per_hour_idr` when
// the window opened, so a later policy edit does not rewrite a past window.
// `table_session_id` uses the (tenant, id) composite FK; the zone lives in
// WS-03's `floor_zones` (composite FK as `wfc_seats`). RLS lives in
// wfc-spend.custom.sql (appended to the migration).
//
// Outlet of zone and session: `floor_zones` and `table_sessions` only have
// unique(tenant_id, id), no unique(tenant_id, outlet_id, id), so the FKs cannot
// include `outlet_id` without altering the floor schema (out of scope, legend-
// bz9h round 2 item 5). The monitor service (wfc-min-spend.service.ts) must
// load the zone and the session by (tenant, outlet, id) before it writes a
// window, so a window never points at another outlet's zone or session.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idr } from "@starter/shared/core";
import {
  maxNudgesPerWindow,
  type WfcSpendWindowStatus,
} from "@starter/shared/wfc";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { floorZones, tableSessions } from "./floor.ts";
import { outlets, tenants } from "./platform-org.ts";

export const wfcSpendWindows = pgTable(
  "wfc_spend_windows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    zoneId: uuid("zone_id").notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    /** Customer profile (WS-08) of the signed-in guest, when known; no FK. */
    customerProfileId: uuid("customer_profile_id"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    minSpendIdr: idrColumn("min_spend_idr").notNull(),
    /** Paid spend of the window, refunds subtracted, never negative (M7). */
    spentIdr: idrColumn("spent_idr").notNull().default(idr(0)),
    status: varchar("status", { length: 10 })
      .$type<WfcSpendWindowStatus>()
      .notNull()
      .default("ok"),
    nudgeCount: integer("nudge_count").notNull().default(0),
    lastNudgedAt: timestamp("last_nudged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("wfc_spend_windows_tenant_id_id_key").on(table.tenantId, table.id),
    // One window per session and start: re-running the monitor updates it.
    unique("wfc_spend_windows_session_window_key").on(
      table.tenantId,
      table.tableSessionId,
      table.windowStart,
    ),
    foreignKey({
      name: "wfc_spend_windows_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "wfc_spend_windows_zone_fk",
      columns: [table.tenantId, table.zoneId],
      foreignColumns: [floorZones.tenantId, floorZones.id],
    }),
    foreignKey({
      name: "wfc_spend_windows_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    index("wfc_spend_windows_zone_idx").on(
      table.tenantId,
      table.zoneId,
      table.windowStart,
    ),
    check(
      "wfc_spend_windows_status_check",
      sql`${table.status} IN ('ok', 'below', 'nudged')`,
    ),
    check(
      "wfc_spend_windows_amount_check",
      sql`${table.minSpendIdr} > 0 AND ${table.spentIdr} >= 0`,
    ),
    check(
      "wfc_spend_windows_range_check",
      sql`${table.windowEnd} > ${table.windowStart}`,
    ),
    // M6: never more than `maxNudgesPerWindow` (2) nudges, and a nudge has a time.
    check(
      "wfc_spend_windows_nudge_check",
      sql.raw(
        `"nudge_count" BETWEEN 0 AND ${maxNudgesPerWindow} AND (("nudge_count" = 0) = ("last_nudged_at" IS NULL))`,
      ),
    ),
  ],
);

export type WfcSpendWindowRow = typeof wfcSpendWindows.$inferSelect;
