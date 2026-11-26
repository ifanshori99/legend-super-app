// WS-11 saved reports, email schedules and export jobs (kartu F12, bead
// legend-ay6e6; contract packages/shared/src/dashboard/builder.ts and
// exports.ts). Tenant RLS lives in report-delivery.custom.sql.
//
// - saved_reports: one builder query, private to `owner_user_id`.
// - report_schedules: delivery of a saved report by the owner. The schedule
//   never stores an address: recipients are tenant user ids.
// - report_exports: one file job. A scheduled run writes one job per
//   recipient (`schedule_id`, `scheduled_for`), generated under that
//   recipient's own permissions, so nobody downloads what they may not open.
//   The file lives in `file_content` until `expires_at` (7 days), then it is
//   cleared and the job turns `expired`.
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
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenantIdColumn } from "../columns.ts";
import { tenants } from "./platform-org.ts";
import { user } from "./user.ts";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const savedReports = pgTable(
  "saved_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    /** `reportBuilderQuerySchema`, parsed again on every read. */
    query: jsonb("query").notNull(),
    status: varchar("status", { length: 10 }).notNull().default("active"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("saved_reports_tenant_id_id_key").on(table.tenantId, table.id),
    index("saved_reports_owner_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.createdAt,
      table.id,
    ),
    check(
      "saved_reports_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    check(
      "saved_reports_query_check",
      sql`jsonb_typeof(${table.query}) = 'object'`,
    ),
  ],
);

export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    savedReportId: uuid("saved_report_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id),
    frequency: varchar("frequency", { length: 10 }).notNull(),
    /** HH:MM on the wall clock of `time_zone`. */
    timeOfDay: varchar("time_of_day", { length: 5 }).notNull(),
    dayOfWeek: smallint("day_of_week"),
    dayOfMonth: smallint("day_of_month"),
    format: varchar("format", { length: 4 }).notNull(),
    /** Tenant user ids (text), never addresses. */
    recipientUserIds: jsonb("recipient_user_ids").notNull(),
    /** Outlet time zone resolved when the schedule was saved. */
    timeZone: varchar("time_zone", { length: 64 }).notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("report_schedules_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "report_schedules_saved_report_fk",
      columns: [table.tenantId, table.savedReportId],
      foreignColumns: [savedReports.tenantId, savedReports.id],
    }),
    index("report_schedules_due_idx").on(table.tenantId, table.nextRunAt),
    index("report_schedules_owner_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.createdAt,
      table.id,
    ),
    check(
      "report_schedules_frequency_check",
      sql`${table.frequency} IN ('daily', 'weekly', 'monthly')`,
    ),
    check(
      "report_schedules_time_check",
      sql`${table.timeOfDay} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      "report_schedules_days_check",
      sql`(${table.frequency} = 'daily' AND ${table.dayOfWeek} IS NULL AND ${table.dayOfMonth} IS NULL) OR (${table.frequency} = 'weekly' AND ${table.dayOfWeek} BETWEEN 1 AND 7 AND ${table.dayOfMonth} IS NULL) OR (${table.frequency} = 'monthly' AND ${table.dayOfMonth} BETWEEN 1 AND 28 AND ${table.dayOfWeek} IS NULL)`,
    ),
    check(
      "report_schedules_format_check",
      sql`${table.format} IN ('csv', 'xlsx', 'pdf')`,
    ),
    check(
      "report_schedules_recipients_check",
      sql`jsonb_typeof(${table.recipientUserIds}) = 'array' AND jsonb_array_length(${table.recipientUserIds}) BETWEEN 1 AND 20`,
    ),
    check(
      "report_schedules_next_run_check",
      sql`${table.isEnabled} OR ${table.nextRunAt} IS NULL`,
    ),
  ],
);

export const reportExports = pgTable(
  "report_exports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id),
    reportCode: varchar("report_code", { length: 80 }),
    savedReportId: uuid("saved_report_id"),
    scheduleId: uuid("schedule_id"),
    /** The schedule slot this job delivers; set exactly with `schedule_id`. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    format: varchar("format", { length: 4 }).notNull(),
    /** `reportExportQuerySchema`; for a schedule, the rolled period. */
    query: jsonb("query").notNull(),
    containsPersonalData: boolean("contains_personal_data").notNull(),
    approvalRequestId: uuid("approval_request_id"),
    status: varchar("status", { length: 20 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /**
     * Generation claims so far. A job left `generating` by a dead worker goes
     * back to `queued` until the cap, then `failed`.
     */
    attempts: integer("attempts").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Outlets the generated file covers, after the TEN-03 scope check. */
    outletIds: jsonb("outlet_ids"),
    /**
     * Viewer the file was generated under (`full` | `aggregate`). A download
     * needs at least that viewer now, so a `full` file never reaches a caller
     * who may only see aggregates (SH-01).
     */
    viewer: varchar("viewer", { length: 10 }),
    fileContent: bytea("file_content"),
    fileSizeBytes: integer("file_size_bytes"),
    rowCount: integer("row_count"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    errorCode: varchar("error_code", { length: 40 }),
  },
  (table) => [
    unique("report_exports_tenant_id_id_key").on(table.tenantId, table.id),
    unique("report_exports_idempotency_key").on(
      table.tenantId,
      table.requestedBy,
      table.idempotencyKey,
    ),
    unique("report_exports_schedule_slot_key").on(
      table.tenantId,
      table.scheduleId,
      table.scheduledFor,
      table.requestedBy,
    ),
    foreignKey({
      name: "report_exports_saved_report_fk",
      columns: [table.tenantId, table.savedReportId],
      foreignColumns: [savedReports.tenantId, savedReports.id],
    }),
    foreignKey({
      name: "report_exports_schedule_fk",
      columns: [table.tenantId, table.scheduleId],
      foreignColumns: [reportSchedules.tenantId, reportSchedules.id],
    }),
    index("report_exports_requester_idx").on(
      table.tenantId,
      table.requestedBy,
      table.requestedAt,
      table.id,
    ),
    index("report_exports_status_idx").on(table.tenantId, table.status),
    check(
      "report_exports_source_check",
      sql`(${table.reportCode} IS NULL) <> (${table.savedReportId} IS NULL)`,
    ),
    check(
      "report_exports_schedule_check",
      sql`(${table.scheduleId} IS NULL) = (${table.scheduledFor} IS NULL) AND (${table.scheduleId} IS NULL OR (${table.savedReportId} IS NOT NULL AND NOT ${table.containsPersonalData}))`,
    ),
    check(
      "report_exports_format_check",
      sql`${table.format} IN ('csv', 'xlsx', 'pdf')`,
    ),
    check(
      "report_exports_status_check",
      sql`${table.status} IN ('pending_approval', 'queued', 'generating', 'ready', 'failed', 'rejected', 'expired', 'cancelled')`,
    ),
    // DASH-04 at the data layer: a personal-data job past approval names its
    // approval request; an aggregate job never has one.
    check(
      "report_exports_approval_check",
      sql`(${table.containsPersonalData} OR ${table.approvalRequestId} IS NULL) AND (NOT ${table.containsPersonalData} OR ${table.approvalRequestId} IS NOT NULL OR ${table.status} IN ('cancelled', 'expired'))`,
    ),
    check(
      "report_exports_file_check",
      sql`(${table.status} = 'ready') = (${table.fileContent} IS NOT NULL) AND (${table.fileContent} IS NULL OR (${table.fileSizeBytes} IS NOT NULL AND ${table.rowCount} IS NOT NULL AND ${table.expiresAt} IS NOT NULL))`,
    ),
    check(
      "report_exports_viewer_check",
      sql`${table.viewer} IS NULL OR ${table.viewer} IN ('full', 'aggregate')`,
    ),
    check(
      "report_exports_error_check",
      sql`(${table.status} = 'failed') = (${table.errorCode} IS NOT NULL)`,
    ),
  ],
);
