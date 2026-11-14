// Edge Print Agent tables (bead legend-46p; PRD v1.7 §3 F5 "Print Agent",
// "Fallback Berlapis", §3 F12 "Fallback Cetak", EDG-05). Same tables in the
// cloud database and in every edge node's local PostgreSQL.
//
// Every table is tenant + outlet owned: the migration calls
// `app.enforce_tenant_rls(...)` and `app.enforce_outlet_rls(...)` for each
// (edge-print.custom.sql). Unique constraints lead with tenant_id; every
// printer reference is a composite (tenant_id, outlet_id, id) foreign key, so
// a job can never point at another tenant's or outlet's printer.
//
// - edge_printers: thermal printers the agent drives (network TCP 9100 or a
//   USB device file), their role, optional station and fallback printer, and
//   the heartbeat status the monitor keeps.
// - edge_print_jobs: the print queue. Content is the raw ESC/POS bytes. A
//   reprint is a new job pointing at the original (reprint_of).
// - edge_print_alerts: supervisor alerts (printer offline/online, KDS down/up,
//   fallback printed, job failed). Evidence stays immutable; acknowledgement
//   and the notification delivery marker can change.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";
import { syncTxidColumn } from "./sync-txid";
import type {
  FailurePhase,
  FallbackReason,
  PaperWidth,
  PrintAlertKind,
  PrintJobKind,
  PrintJobStatus,
  PrinterRole,
  PrinterStatus,
  PrinterTransportKind,
} from "../../edge/print/types.ts";

/** Raw ESC/POS bytes. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

export const edgePrinters = pgTable(
  "edge_printers",
  {
    /** Printer device id (devices registry, legend-165); plain UUID until it lands. */
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).$type<PrinterRole>().notNull(),
    /** stations.id for role "station"; plain UUID (stations is outlet-scoped elsewhere). */
    stationId: uuid("station_id"),
    transport: varchar("transport", { length: 20 })
      .$type<PrinterTransportKind>()
      .notNull(),
    host: varchar("host", { length: 255 }),
    port: integer("port"),
    devicePath: varchar("device_path", { length: 255 }),
    paperWidth: integer("paper_width")
      .$type<PaperWidth>()
      .notNull()
      .default(48),
    fallbackPrinterId: uuid("fallback_printer_id"),
    status: varchar("status", { length: 20 })
      .$type<PrinterStatus>()
      .notNull()
      .default("unknown"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    offlineSince: timestamp("offline_since", { withTimezone: true }),
    /** Edge-owned (legend-fbf4v): the cloud deleted this printer but print jobs still point at it. Never part of the cloud record; cleared when the cloud brings the printer back. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Catalog down-sync version (legend-fbf4v): stamped by `app.set_sync_txid`. */
    syncTxid: syncTxidColumn(),
  },
  (t) => [
    unique("edge_printers_tenant_outlet_id_key").on(
      t.tenantId,
      t.outletId,
      t.id,
    ),
    foreignKey({
      name: "edge_printers_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "edge_printers_fallback_fk",
      columns: [t.tenantId, t.outletId, t.fallbackPrinterId],
      foreignColumns: [t.tenantId, t.outletId, t.id],
    }),
    index("edge_printers_station_idx").on(t.tenantId, t.outletId, t.stationId),
    index("edge_printers_sync_txid_idx").on(
      t.tenantId,
      t.outletId,
      t.syncTxid,
      t.id,
    ),
    check("edge_printers_role_check", sql`${t.role} IN ('receipt', 'station')`),
    check(
      "edge_printers_status_check",
      sql`${t.status} IN ('unknown', 'online', 'offline')`,
    ),
    check("edge_printers_paper_width_check", sql`${t.paperWidth} IN (32, 48)`),
    check(
      "edge_printers_transport_check",
      sql`(${t.transport} = 'network' AND ${t.host} IS NOT NULL AND ${t.port} BETWEEN 1 AND 65535 AND ${t.devicePath} IS NULL)
        OR (${t.transport} = 'usb' AND ${t.devicePath} IS NOT NULL AND ${t.host} IS NULL AND ${t.port} IS NULL)`,
    ),
    /** Only the agent's own targets: Linux USB printer nodes, raw-print ports 9100-9102. */
    check(
      "edge_printers_device_path_check",
      sql`${t.devicePath} IS NULL OR ${t.devicePath} ~ '^/dev/(usb/lp|lp)[0-9]+$'`,
    ),
    check(
      "edge_printers_port_check",
      sql`${t.port} IS NULL OR ${t.port} BETWEEN 9100 AND 9102`,
    ),
    /** Private LAN IPv4 literal only (10/8, 172.16/12, 192.168/16): no loopback, link-local, hostname. CASE keeps the inet cast behind the strict dotted-quad regex. */
    check(
      "edge_printers_host_check",
      sql`${t.host} IS NULL OR (CASE WHEN ${t.host} ~ '^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$' THEN ${t.host}::inet << '10.0.0.0/8'::inet OR ${t.host}::inet << '172.16.0.0/12'::inet OR ${t.host}::inet << '192.168.0.0/16'::inet ELSE false END)`,
    ),
    check(
      "edge_printers_station_role_check",
      sql`${t.role} = 'station' OR ${t.stationId} IS NULL`,
    ),
    check(
      "edge_printers_not_own_fallback_check",
      sql`${t.fallbackPrinterId} IS NULL OR ${t.fallbackPrinterId} <> ${t.id}`,
    ),
  ],
);

/**
 * Deletion marker of a cloud printer (legend-fbf4v). The cloud CRUD deletes the
 * `edge_printers` row for good, so the catalog `printers` stream would never
 * learn of it: the AFTER DELETE trigger `edge_printers_tombstone` writes one
 * row here instead, and the stream serves it as a record with `deletedAt`.
 * Append-only; the edge apply never writes it (the trigger skips edge applies).
 */
export const edgePrinterTombstones = pgTable(
  "edge_printer_tombstones",
  {
    /** The deleted printer's id; a printer id is never reused. */
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncTxid: syncTxidColumn(),
  },
  (t) => [
    foreignKey({
      name: "edge_printer_tombstones_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("edge_printer_tombstones_sync_txid_idx").on(
      t.tenantId,
      t.outletId,
      t.syncTxid,
      t.id,
    ),
  ],
);

export const edgePrintJobs = pgTable(
  "edge_print_jobs",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    printerId: uuid("printer_id").notNull(),
    kind: varchar("kind", { length: 20 }).$type<PrintJobKind>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<PrintJobStatus>()
      .notNull()
      .default("queued"),
    content: bytea("content").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: varchar("last_error", { length: 500 }),
    /** Set while status is failed (write: bytes may be partly printed; stale: claim swept). */
    failurePhase: varchar("failure_phase", {
      length: 20,
    }).$type<FailurePhase>(),
    reprintOf: ulidInUuid("reprint_of"),
    printedFallback: boolean("printed_fallback").notNull().default(false),
    fallbackReason: varchar("fallback_reason", {
      length: 20,
    }).$type<FallbackReason>(),
    originalPrinterId: uuid("original_printer_id"),
    sourceRef: varchar("source_ref", { length: 255 }),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("edge_print_jobs_tenant_outlet_id_key").on(
      t.tenantId,
      t.outletId,
      t.id,
    ),
    unique("edge_print_jobs_tenant_outlet_idempotency_key").on(
      t.tenantId,
      t.outletId,
      t.idempotencyKey,
    ),
    foreignKey({
      name: "edge_print_jobs_printer_fk",
      columns: [t.tenantId, t.outletId, t.printerId],
      foreignColumns: [
        edgePrinters.tenantId,
        edgePrinters.outletId,
        edgePrinters.id,
      ],
    }),
    foreignKey({
      name: "edge_print_jobs_original_printer_fk",
      columns: [t.tenantId, t.outletId, t.originalPrinterId],
      foreignColumns: [
        edgePrinters.tenantId,
        edgePrinters.outletId,
        edgePrinters.id,
      ],
    }),
    foreignKey({
      name: "edge_print_jobs_reprint_of_fk",
      columns: [t.tenantId, t.outletId, t.reprintOf],
      foreignColumns: [t.tenantId, t.outletId, t.id],
    }),
    /** Queue order per printer: oldest queued first (created_at, id). */
    index("edge_print_jobs_queue_idx").on(
      t.tenantId,
      t.outletId,
      t.printerId,
      t.status,
      t.createdAt,
      t.id,
    ),
    /** Listing newest first (cursor on created_at, id). */
    index("edge_print_jobs_list_idx").on(
      t.tenantId,
      t.outletId,
      t.createdAt,
      t.id,
    ),
    check(
      "edge_print_jobs_kind_check",
      sql`${t.kind} IN ('receipt', 'station_ticket', 'shift_report')`,
    ),
    check(
      "edge_print_jobs_status_check",
      sql`${t.status} IN ('queued', 'printing', 'printed', 'failed')`,
    ),
    check(
      "edge_print_jobs_fallback_check",
      sql`(${t.printedFallback} AND ${t.fallbackReason} IS NOT NULL AND ${t.fallbackReason} IN ('kds_down', 'printer_offline'))
        OR (NOT ${t.printedFallback} AND ${t.fallbackReason} IS NULL)`,
    ),
    check(
      "edge_print_jobs_failure_phase_check",
      sql`${t.failurePhase} IN ('write', 'stale', 'other')`,
    ),
    check(
      "edge_print_jobs_failure_phase_status_check",
      sql`(${t.status} = 'failed') = (${t.failurePhase} IS NOT NULL)`,
    ),
    check("edge_print_jobs_attempts_check", sql`${t.attempts} >= 0`),
    check(
      "edge_print_jobs_printed_at_check",
      sql`(${t.status} = 'printed') = (${t.printedAt} IS NOT NULL)`,
    ),
  ],
);

export const edgePrintAlerts = pgTable(
  "edge_print_alerts",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    kind: varchar("kind", { length: 30 }).$type<PrintAlertKind>().notNull(),
    /** Printer id, station id (KDS) or job id (as UUID), depending on kind. */
    subjectId: uuid("subject_id").notNull(),
    stationId: uuid("station_id"),
    detail: jsonb("detail")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Queue insertion committed; null means the print agent must retry notification. */
    notificationEnqueuedAt: timestamp("notification_enqueued_at", {
      withTimezone: true,
    }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: uuid("acknowledged_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("edge_print_alerts_tenant_outlet_id_key").on(
      t.tenantId,
      t.outletId,
      t.id,
    ),
    foreignKey({
      name: "edge_print_alerts_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("edge_print_alerts_recent_idx").on(
      t.tenantId,
      t.outletId,
      t.occurredAt,
    ),
    index("edge_print_alerts_pending_notification_idx")
      .on(t.tenantId, t.outletId, t.occurredAt, t.id)
      .where(sql`${t.notificationEnqueuedAt} IS NULL`),
    check(
      "edge_print_alerts_kind_check",
      sql`${t.kind} IN ('printer_offline', 'printer_online', 'kds_down', 'kds_up', 'fallback_printed', 'job_failed')`,
    ),
    check(
      "edge_print_alerts_ack_check",
      sql`(${t.acknowledgedAt} IS NULL) = (${t.acknowledgedBy} IS NULL)`,
    ),
  ],
);
