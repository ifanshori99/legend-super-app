// Service requests: waiter call, bill request and complaint raised by a table
// guest, plus the zone -> waiter assignment that routes them (PRD v1.7 §3 F10
// "Panggil Waiter & Minta Tagihan", §6 C `service_requests`, ORD-07).
//
// Both tables carry tenant_id NOT NULL, need enforced tenant RLS and outlet RLS
// in the generated migration, and their unique constraints include tenant_id.
// Children point at their parent through (tenant_id, id) composite keys, so a
// request can never reference another tenant's table, zone or session.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  ServiceRequestReason,
  ServiceRequestStatus,
  ServiceRequestType,
} from "@starter/shared/qr-order";
import { outletIdColumn, tenantIdColumn } from "../columns";
import { floorZones, tableSessions, tables } from "./floor";
import { outlets, tenants } from "./platform-org";

/** `service_requests` (T, E): one open ask from one table. */
export const serviceRequests = pgTable(
  "service_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    tableId: uuid("table_id").notNull(),
    /** Snapshot of the table's zone at call time: the routing key. */
    zoneId: uuid("zone_id").notNull(),
    type: varchar("type", { length: 20 }).$type<ServiceRequestType>().notNull(),
    reason: varchar("reason", { length: 20 }).$type<ServiceRequestReason>(),
    message: varchar("message", { length: 500 }),
    status: varchar("status", { length: 20 })
      .$type<ServiceRequestStatus>()
      .notNull()
      .default("pending"),
    /** Zone waiter (or manager) who acknowledged / resolved it. */
    assignedTo: uuid("assigned_to"),
    /** Staff who resolved it; may differ from `assignedTo`. */
    resolvedBy: uuid("resolved_by"),
    resolutionNote: varchar("resolution_note", { length: 200 }),
    /** Guest-supplied key, unique per session, bound to the fingerprint. */
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Set once when the overdue escalation fired (at most once per request). */
    overdueNotifiedAt: timestamp("overdue_notified_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("service_requests_tenant_id_id_key").on(table.tenantId, table.id),
    unique("service_requests_idempotency_key").on(
      table.tenantId,
      table.tableSessionId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "service_requests_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "service_requests_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    foreignKey({
      name: "service_requests_table_fk",
      columns: [table.tenantId, table.tableId],
      foreignColumns: [tables.tenantId, tables.id],
    }),
    foreignKey({
      name: "service_requests_zone_fk",
      columns: [table.tenantId, table.zoneId],
      foreignColumns: [floorZones.tenantId, floorZones.id],
    }),
    // Dedupe: one open request per table and kind (pending or acknowledged).
    uniqueIndex("service_requests_open_dedupe_key")
      .on(table.tenantId, table.tableId, table.type)
      .where(sql`${table.status} IN ('pending', 'acknowledged')`),
    index("service_requests_outlet_inbox_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
      table.id,
    ),
    // The overdue sweep scans only open rows.
    index("service_requests_open_age_idx")
      .on(table.tenantId, table.createdAt)
      .where(sql`${table.status} IN ('pending', 'acknowledged')`),
    check(
      "service_requests_type_check",
      sql`${table.type} IN ('call_waiter', 'request_bill', 'complaint')`,
    ),
    check(
      "service_requests_reason_check",
      sql`${table.reason} IS NULL OR ${table.reason} IN ('add_order', 'utensils', 'complaint', 'other')`,
    ),
    check(
      "service_requests_status_check",
      sql`${table.status} IN ('pending', 'acknowledged', 'resolved', 'cancelled')`,
    ),
    check(
      "service_requests_lifecycle_check",
      sql`(${table.status} <> 'pending' OR ${table.acknowledgedAt} IS NULL)
        AND (${table.status} <> 'acknowledged' OR (${table.acknowledgedAt} IS NOT NULL AND ${table.assignedTo} IS NOT NULL))
        AND ((${table.status} = 'resolved') = (${table.resolvedAt} IS NOT NULL))`,
    ),
  ],
);

/**
 * `zone_waiter_assignments` (T, E): which staff receive calls from a zone.
 * No other table maps waiters to zones (PRD §3 F10 only says "ponsel waiter
 * zona terkait"), so this bead owns the mapping.
 */
export const zoneWaiterAssignments = pgTable(
  "zone_waiter_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    zoneId: uuid("zone_id").notNull(),
    userId: uuid("user_id").notNull(),
    /** Optional free note, e.g. shift label. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("zone_waiter_assignments_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("zone_waiter_assignments_zone_user_key").on(
      table.tenantId,
      table.zoneId,
      table.userId,
    ),
    foreignKey({
      name: "zone_waiter_assignments_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "zone_waiter_assignments_zone_fk",
      columns: [table.tenantId, table.zoneId],
      foreignColumns: [floorZones.tenantId, floorZones.id],
    }),
    index("zone_waiter_assignments_zone_idx").on(
      table.tenantId,
      table.outletId,
      table.zoneId,
    ),
  ],
);
