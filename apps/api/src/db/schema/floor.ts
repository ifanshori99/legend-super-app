// Floor zones, tables, table sessions and session participants (PRD v1.7
// §6 C "Menu, Meja & Order": floor_zones, tables, table_sessions,
// session_participants; §3 F9 "Denah & Meja", F10 "Scan & Sesi Meja",
// "Keamanan Sesi", "Kontrol Open Bill"; ORD-04, ORD-10).
//
// Every table carries tenant_id NOT NULL, gets enforced RLS in the generated
// migration (`app.enforce_tenant_rls`), and its unique constraints include
// tenant_id. Operational rows also carry outlet_id, and children reference
// their parent through (tenant_id, id) composite keys so a row can never point
// at another tenant's zone, table or session.
//
// Secrets never sit in a DTO: `tables.qr_token_hash` is the SHA-256 lookup
// key, `session_token_hash` the session credential hash, and the sealed
// (AES-256-GCM, lib/secrets.ts) copies exist only so a reprint or a joining
// guest can be handed the same token again. Neither column is exported by the
// schemas in packages/shared/src/qr-order.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idr } from "@starter/shared/core";
import type {
  PaymentMode,
  TableLayout,
  TableSessionClosedReason,
  TableSessionStatus,
  TableStatus,
  TableType,
  ZoneHours,
  ZoneStatus,
} from "@starter/shared/qr-order";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns";
import { outlets, tenants } from "./platform-org";
import { syncTxidColumn } from "./sync-txid";

/** `floor_zones` (T, E): a zone with its pay mode, service charge and hours. */
export const floorZones = pgTable(
  "floor_zones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    /** Snapshot source for every session opened in the zone (PRD "Mode Bayar"). */
    paymentMode: varchar("payment_mode", { length: 20 })
      .$type<PaymentMode>()
      .notNull(),
    /** floor_zones.service_charge_pct once the tax engine reads it (500 = 5%). */
    serviceChargeBp: integer("service_charge_bp").notNull().default(0),
    minimumSpendIdr: idrColumn("minimum_spend_idr").notNull().default(idr(0)),
    /** zoneHoursSchema[] in the wire contract; a zone with no window never opens. */
    hours: jsonb("hours").$type<ZoneHours[]>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<ZoneStatus>()
      .notNull()
      .default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** legend-p4q10: explicit WFC zone marker; revpash and seat occupancy read only these zones. */
    isWfc: boolean("is_wfc").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("floor_zones_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("floor_zones_tenant_outlet_name_key").on(
      table.tenantId,
      table.outletId,
      table.name,
    ),
    unique("floor_zones_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "floor_zones_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("floor_zones_outlet_order_idx").on(
      table.tenantId,
      table.outletId,
      table.sortOrder,
      table.id,
    ),
    check(
      "floor_zones_payment_mode_check",
      sql`${table.paymentMode} IN ('pay_first', 'open_bill')`,
    ),
    check(
      "floor_zones_status_check",
      sql`${table.status} IN ('active', 'inactive')`,
    ),
    check(
      "floor_zones_service_charge_check",
      sql`${table.serviceChargeBp} BETWEEN 0 AND 10000`,
    ),
    check(
      "floor_zones_minimum_spend_check",
      sql`${table.minimumSpendIdr} >= 0`,
    ),
  ],
);

/** `tables` (T, E): a physical table with its signed permanent QR. */
export const tables = pgTable(
  "tables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    zoneId: uuid("zone_id").notNull(),
    /** Table number printed on the plan and the sticker (unique per outlet). */
    code: varchar("code", { length: 20 }).notNull(),
    capacity: smallint("capacity").notNull(),
    type: varchar("type", { length: 20 }).$type<TableType>().notNull(),
    /** SHA-256 hex of the signed token; the lookup key for a guest scan. */
    qrTokenHash: varchar("qr_token_hash", { length: 64 }),
    /** Sealed signed token, so a reprint never rotates the sticker (ORD-04). */
    qrTokenSealed: text("qr_token_sealed"),
    /** Position and shape on the floor plan (tables.layout JSONB). */
    layout: jsonb("layout").$type<TableLayout>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<TableStatus>()
      .notNull()
      .default("available"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("tables_sync_txid_idx").on(table.tenantId, table.syncTxid, table.id),
    unique("tables_tenant_outlet_code_key").on(
      table.tenantId,
      table.outletId,
      table.code,
    ),
    unique("tables_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "tables_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "tables_zone_fk",
      columns: [table.tenantId, table.zoneId],
      foreignColumns: [floorZones.tenantId, floorZones.id],
    }),
    index("tables_outlet_zone_idx").on(
      table.tenantId,
      table.outletId,
      table.zoneId,
      table.code,
    ),
    uniqueIndex("tables_tenant_qr_hash_key")
      .on(table.tenantId, table.qrTokenHash)
      .where(sql`${table.qrTokenHash} IS NOT NULL`),
    check("tables_code_check", sql`${table.code} ~ '^[A-Z0-9-]{1,20}$'`),
    check("tables_capacity_check", sql`${table.capacity} BETWEEN 1 AND 50`),
    check(
      "tables_type_check",
      sql`${table.type} IN ('regular', 'bar', 'sofa', 'private_room')`,
    ),
    check(
      "tables_status_check",
      sql`${table.status} IN ('available', 'occupied', 'reserved', 'dirty', 'inactive')`,
    ),
    check(
      "tables_qr_pair_check",
      sql`(${table.qrTokenHash} IS NULL) = (${table.qrTokenSealed} IS NULL)`,
    ),
  ],
);

/** `table_sessions` (T, E): one diner visit at one table. */
export const tableSessions = pgTable(
  "table_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    tableId: uuid("table_id").notNull(),
    pax: smallint("pax").notNull(),
    /** Snapshot of the zone's mode at open time (contract schema comment). */
    paymentMode: varchar("payment_mode", { length: 20 })
      .$type<PaymentMode>()
      .notNull(),
    status: varchar("status", { length: 20 })
      .$type<TableSessionStatus>()
      .notNull(),
    /** SHA-256 hex of the opaque guest credential; rotates when the session closes. */
    sessionTokenHash: varchar("session_token_hash", { length: 64 }).notNull(),
    /** Sealed credential, so a later guest scan joins with the same token. */
    sessionTokenSealed: text("session_token_sealed").notNull(),
    /** Staff member who confirmed an open-bill session (PRD "Kontrol Open Bill"). */
    confirmedBy: uuid("confirmed_by"),
    /** Reservation that seated the party (WS-08); FK lands with that schema. */
    reservationId: uuid("reservation_id"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * The `last_activity_at` the open-bill idle alert already fired for
     * (legend-cqrw): one alert per idle spell, new activity starts a new one.
     */
    inactivityAlertedActivityAt: timestamp("inactivity_alerted_activity_at", {
      withTimezone: true,
    }),
    billRequestedAt: timestamp("bill_requested_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: varchar("closed_reason", {
      length: 20,
    }).$type<TableSessionClosedReason>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("table_sessions_tenant_id_id_key").on(table.tenantId, table.id),
    unique("table_sessions_token_hash_key").on(
      table.tenantId,
      table.sessionTokenHash,
    ),
    foreignKey({
      name: "table_sessions_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "table_sessions_table_fk",
      columns: [table.tenantId, table.tableId],
      foreignColumns: [tables.tenantId, tables.id],
    }),
    // A table runs one session at a time; a closed or voided row keeps history.
    uniqueIndex("table_sessions_active_table_key")
      .on(table.tenantId, table.tableId)
      .where(sql`${table.status} NOT IN ('closed', 'voided')`),
    index("table_sessions_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.openedAt,
    ),
    check("table_sessions_pax_check", sql`${table.pax} BETWEEN 1 AND 30`),
    check(
      "table_sessions_payment_mode_check",
      sql`${table.paymentMode} IN ('pay_first', 'open_bill')`,
    ),
    check(
      "table_sessions_status_check",
      sql`${table.status} IN ('pending_confirmation', 'open', 'bill_requested', 'closed', 'voided')`,
    ),
    check(
      "table_sessions_closed_reason_check",
      sql`${table.closedReason} IS NULL OR ${table.closedReason} IN ('paid_and_cleaned', 'voided', 'expired')`,
    ),
    // An active session carries no close fields; a closed one carries both.
    check(
      "table_sessions_closed_pair_check",
      sql`(${table.status} IN ('closed', 'voided')) = (${table.closedAt} IS NOT NULL AND ${table.closedReason} IS NOT NULL)`,
    ),
    // A bill_requested session always records when the bill was asked for.
    check(
      "table_sessions_bill_requested_check",
      sql`${table.status} <> 'bill_requested' OR ${table.billRequestedAt} IS NOT NULL`,
    ),
    // PRD "Kontrol Open Bill": only an open-bill session waits for a waiter.
    check(
      "table_sessions_open_bill_confirmation_check",
      sql`${table.status} <> 'pending_confirmation' OR ${table.paymentMode} = 'open_bill'`,
    ),
  ],
);

/** `session_participants` (T, E): guests sharing one table session. */
export const sessionParticipants = pgTable(
  "session_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    /** Opaque device fingerprint; the guest identity for unauthenticated orders. */
    deviceHash: varchar("device_hash", { length: 128 }).notNull(),
    /** Set when the guest is signed in; guests may order without it (ORD-01). */
    userId: uuid("user_id"),
    /** Optional WhatsApp number (E.164) left by a guest without an account (legend-qr3sd). */
    contactWhatsapp: text("contact_whatsapp"),
    /** Optional email left by a guest without an account (legend-qr3sd). */
    contactEmail: text("contact_email"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("session_participants_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    // A device joins a session once; rescanning updates its lastSeenAt.
    unique("session_participants_device_key").on(
      table.tenantId,
      table.tableSessionId,
      table.deviceHash,
    ),
    foreignKey({
      name: "session_participants_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    index("session_participants_session_idx").on(
      table.tenantId,
      table.tableSessionId,
      table.joinedAt,
      table.id,
    ),
  ],
);
