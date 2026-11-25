// Kitchen capacity per station per window (bead legend-w4nq4; PRD v1.7 §6
// `kitchen_capacity_rules`, F12, KDS-05; contract @starter/shared/kitchen
// `capacityRuleSchema`).
//
// One row = one capacity window of one station, applied in the scheduled
// hours. Several rows per station cover per-hour pacing. Kitchen config
// replaces a station's whole list in one transaction (never a partial edit).
//
// (T) rules: tenant_id and outlet_id NOT NULL (enforced tenant + outlet RLS in
// kds-capacity.custom.sql), the unique constraint includes tenant_id, and the
// parents are referenced through composite keys. `stations` is unique on
// (tenant_id, id) only, like every other KDS table, so the service asserts
// that the station belongs to the path outlet. The value rules of the contract
// are repeated as CHECKs so a writer that skips the API cannot store a window
// the pacing code would divide by.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns";
import { stations } from "./menu";
import { outlets, tenants } from "./platform-org";
import { syncTxidColumn } from "./sync-txid";

export type CapacityScheduleRow = {
  daysOfWeek: number[];
  start: string;
  end: string;
};

/** `kitchen_capacity_rules` (T, O): one capacity window of one station. */
export const kitchenCapacityRules = pgTable(
  "kitchen_capacity_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    stationId: uuid("station_id").notNull(),
    windowMinutes: integer("window_minutes").notNull(),
    capacityPoints: integer("capacity_points").notNull(),
    /** Level (basis points of capacity) that counts as near capacity. */
    nearCapacityBp: integer("near_capacity_bp").notNull(),
    schedule: jsonb("schedule").$type<CapacityScheduleRow[]>().notNull(),
    /** Ordered, duplicate-free channel list. */
    channelPriority: jsonb("channel_priority").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("kitchen_capacity_rules_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("kitchen_capacity_rules_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "kitchen_capacity_rules_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "kitchen_capacity_rules_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("kitchen_capacity_rules_outlet_station_idx").on(
      table.tenantId,
      table.outletId,
      table.stationId,
      table.windowMinutes,
    ),
    check(
      "kitchen_capacity_rules_window_check",
      sql`${table.windowMinutes} BETWEEN 5 AND 60 AND ${table.windowMinutes} % 5 = 0`,
    ),
    check(
      "kitchen_capacity_rules_points_check",
      sql`${table.capacityPoints} > 0`,
    ),
    check(
      "kitchen_capacity_rules_near_bp_check",
      sql`${table.nearCapacityBp} > 0`,
    ),
  ],
);
