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
//   fallback printed, job failed). Append-only except acknowledgement.
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
import type {
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
