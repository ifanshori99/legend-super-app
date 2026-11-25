// Order pacing state (bead legend-gyc; PRD v1.7 §3 F12 "Order Pacing" and
// "Estimasi Waktu Saji Real-time", KDS-05, KDS-06; contracts `menuLoadSchema`,
// `channelPauseSchema`, `stationPacingSchema` in @starter/shared/kitchen).
//
// - `kitchen_menu_loads`: load points and preparation seconds per menu line.
//   One row per (menu item, variant or no variant) per outlet.
// - `kitchen_channel_pauses`: a menu line paused for chosen channels. The
//   pacing evaluator writes `station_capacity` rows while a station is at
//   capacity and releases them (`released_at`) when it is not; `manual` rows
//   are never touched by the evaluator. Rows are never deleted (audit).
// - `kitchen_pacing_state`: last capacity level per station, so a transition
//   (and its supervisor alert) fires once, not on every read.
//
// (T, O) tables: tenant_id and outlet_id NOT NULL, enforced tenant + outlet
// RLS (kds-pacing.custom.sql), every unique key includes tenant_id.

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
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns";
import { itemVariants, menuItems, stations } from "./menu";
import { outlets, tenants } from "./platform-org";
import { syncTxidColumn } from "./sync-txid";

/** Pause reasons of `channelPauseSchema`. */
export const CHANNEL_PAUSE_REASONS = [
  "station_capacity",
  "long_prep",
  "manual",
] as const;

/** Capacity levels of `capacityLevelSchema`. */
export const PACING_LEVELS = [
  "available",
  "near_capacity",
  "at_capacity",
] as const;

/** `kitchen_menu_loads` (T, O): load points and prep time of one menu line. */
export const kitchenMenuLoads = pgTable(
  "kitchen_menu_loads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    /** Null = the item without a variant (and the default for any variant). */
    variantId: uuid("variant_id"),
    loadPoints: integer("load_points").notNull(),
    prepSeconds: integer("prep_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("kitchen_menu_loads_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("kitchen_menu_loads_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("kitchen_menu_loads_line_key").on(
      table.tenantId,
      table.outletId,
      table.menuItemId,
      sql`COALESCE(${table.variantId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    foreignKey({
      name: "kitchen_menu_loads_menu_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    foreignKey({
      name: "kitchen_menu_loads_variant_fk",
      columns: [table.tenantId, table.variantId],
      foreignColumns: [itemVariants.tenantId, itemVariants.id],
    }),
    foreignKey({
      name: "kitchen_menu_loads_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "kitchen_menu_loads_points_check",
      sql`${table.loadPoints} BETWEEN 1 AND 100`,
    ),
    check(
      "kitchen_menu_loads_prep_check",
      sql`${table.prepSeconds} BETWEEN 1 AND 7200`,
    ),
  ],
);

/** `kitchen_channel_pauses` (T, O): a menu line paused for some channels. */
export const kitchenChannelPauses = pgTable(
  "kitchen_channel_pauses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    variantId: uuid("variant_id"),
    /** Station whose capacity caused an automatic pause; null for manual. */
    stationId: uuid("station_id"),
    /** Non-empty, duplicate-free channel list. */
    channels: jsonb("channels").$type<string[]>().notNull(),
    reason: varchar("reason", { length: 20 }).notNull(),
    /** Null = until released. */
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the evaluator (or a supervisor) lifts the pause. */
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    unique("kitchen_channel_pauses_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    // One live automatic pause per line and station: a re-evaluation updates
    // it instead of stacking a second row.
    uniqueIndex("kitchen_channel_pauses_auto_live_key")
      .on(
        table.tenantId,
        table.outletId,
        table.stationId,
        table.menuItemId,
        sql`COALESCE(${table.variantId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(
        sql`${table.reason} = 'station_capacity' AND ${table.releasedAt} IS NULL`,
      ),
    foreignKey({
      name: "kitchen_channel_pauses_menu_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    foreignKey({
      name: "kitchen_channel_pauses_variant_fk",
      columns: [table.tenantId, table.variantId],
      foreignColumns: [itemVariants.tenantId, itemVariants.id],
    }),
    foreignKey({
      name: "kitchen_channel_pauses_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "kitchen_channel_pauses_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("kitchen_channel_pauses_live_idx").on(
      table.tenantId,
      table.outletId,
      table.releasedAt,
    ),
    check(
      "kitchen_channel_pauses_reason_check",
      sql`${table.reason} IN ('station_capacity', 'long_prep', 'manual')`,
    ),
    check(
      "kitchen_channel_pauses_channels_check",
      sql`jsonb_typeof(${table.channels}) = 'array' AND jsonb_array_length(${table.channels}) > 0`,
    ),
    check(
      "kitchen_channel_pauses_station_reason_check",
      sql`${table.reason} <> 'station_capacity' OR ${table.stationId} IS NOT NULL`,
    ),
  ],
);

/** `kitchen_pacing_state` (T, O): last capacity level of one station. */
export const kitchenPacingState = pgTable(
  "kitchen_pacing_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    stationId: uuid("station_id").notNull(),
    level: varchar("level", { length: 20 }).notNull(),
    usedPoints: integer("used_points").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    /** When `level` last changed (not when it was last re-read). */
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("kitchen_pacing_state_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("kitchen_pacing_state_station_key").on(
      table.tenantId,
      table.outletId,
      table.stationId,
    ),
    foreignKey({
      name: "kitchen_pacing_state_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "kitchen_pacing_state_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "kitchen_pacing_state_level_check",
      sql`${table.level} IN ('available', 'near_capacity', 'at_capacity')`,
    ),
    check("kitchen_pacing_state_points_check", sql`${table.usedPoints} >= 0`),
  ],
);
