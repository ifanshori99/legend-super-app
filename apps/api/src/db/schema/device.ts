// Device registry (bead legend-165; PRD v1.7 §3 F5 "Registri Perangkat" and
// "Mode Latihan", EDG-03, §6 `devices`). The same tables exist in the cloud
// database and in the edge node's local PostgreSQL (the edge holds a replica,
// cloud wins; edge-device-sync).
//
// Both tables are tenant + outlet owned: the migration must call
// `app.enforce_tenant_rls(...)` and then `app.enforce_outlet_rls(...)` for each
// (device.custom.sql). Unique constraints lead with tenant_id and every
// reference to a device is a composite (tenant_id, outlet_id, id) foreign key.
//
// - devices: one row per enrolled device. A device token (`dv1`) is accepted
//   only while the row is active, so revocation is a status change with
//   timestamp, never a delete, and it is terminal (trigger). `token_issued_at`
//   is the floor for token `issuedAt`: reissue rotates older tokens out.
// - device_training_periods: when a device was in training mode. Sales made
//   in a period are excluded from reports (services/device-training.ts).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { stations } from "./menu.ts";
import { outlets, tenants } from "./platform-org.ts";

export type DeviceType =
  | "pos"
  | "kds"
  | "waiter_phone"
  | "printer"
  | "display"
  | "smart_lock"
  | "panic_button"
  | "edc";
export type DeviceStatus = "active" | "revoked";
/** Barcode scanner state a KDS device reports in its heartbeat. */
export type DeviceScannerStatus = "connected" | "disconnected";

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    type: varchar("type", { length: 20 }).$type<DeviceType>().notNull(),
    stationId: uuid("station_id"),
    label: varchar("label", { length: 255 }).notNull(),
    /** App version the device last reported (heartbeat). */
    version: varchar("version", { length: 255 }).notNull().default("unknown"),
    capabilities: jsonb("capabilities")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    trainingMode: boolean("training_mode").notNull().default(false),
    /**
     * Shared-device mode (legend-f586w): when true, POS/floor/KDS requests from
     * this device need an acting-staff token (middleware/acting-staff.ts).
     * Off by default so unflagged devices keep the old behaviour.
     */
    sharedMode: boolean("shared_mode").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /**
     * Scanner state the device last reported (legend-40nvj). NULL = never
     * reported; a heartbeat without a `scanner` field leaves both columns alone.
     */
    scannerStatus: varchar("scanner_status", {
      length: 20,
    }).$type<DeviceScannerStatus>(),
    /** When the device shell last saw the scanner state change. */
    scannerObservedAt: timestamp("scanner_observed_at", { withTimezone: true }),
    status: varchar("status", { length: 20 })
      .$type<DeviceStatus>()
      .notNull()
      .default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Better Auth user id. */
    revokedBy: text("revoked_by"),
    revokeReason: varchar("revoke_reason", { length: 500 }),
    /** Better Auth user id. */
    enrolledBy: text("enrolled_by"),
    /** Floor for token `issuedAt`; a reissue moves it forward. Never the token. */
    tokenIssuedAt: timestamp("token_issued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("devices_tenant_id_id_key").on(table.tenantId, table.id),
    unique("devices_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "devices_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "devices_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    // Sync watermark (edge replica pull) and outlet listing.
    index("devices_sync_idx").on(
      table.tenantId,
      table.outletId,
      table.updatedAt,
      table.id,
    ),
    check(
      "devices_type_check",
      sql`${table.type} IN ('pos', 'kds', 'waiter_phone', 'printer', 'display', 'smart_lock', 'panic_button', 'edc')`,
    ),
    check(
      "devices_status_check",
      sql`(${table.status} = 'active' AND ${table.revokedAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`,
    ),
    check(
      "devices_scanner_status_check",
      sql`${table.scannerStatus} IS NULL OR ${table.scannerStatus} IN ('connected', 'disconnected')`,
    ),
    check(
      "devices_shared_mode_pos_only",
      sql`NOT ${table.sharedMode} OR ${table.type} = 'pos'`,
    ),
  ],
);

export const deviceTrainingPeriods = pgTable(
  "device_training_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    startedBy: text("started_by"),
    endedBy: text("ended_by"),
  },
  (table) => [
    foreignKey({
      name: "device_training_periods_device_fk",
      columns: [table.tenantId, table.outletId, table.deviceId],
      foreignColumns: [devices.tenantId, devices.outletId, devices.id],
    }),
    // One open period per device at a time.
    uniqueIndex("device_training_periods_open_key")
      .on(table.tenantId, table.deviceId)
      .where(sql`${table.endedAt} IS NULL`),
    index("device_training_periods_device_idx").on(
      table.tenantId,
      table.deviceId,
      table.startedAt,
    ),
    check(
      "device_training_periods_range_check",
      sql`${table.endedAt} IS NULL OR ${table.endedAt} > ${table.startedAt}`,
    ),
  ],
);
