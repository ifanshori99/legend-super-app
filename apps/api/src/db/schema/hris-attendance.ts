// HRIS attendance (PRD v1.7 §3 Kelompok D 27 "Absensi", §6 H `attendance_logs`;
// F25, HR-02; bead legend-wh71).
//
// Contract: `@starter/shared/hris` (attendance.ts, endpoints.ts, events.ts).
//
// - `attendance_policies.outlet_id` is nullable (null = tenant default, an
//   outlet row overrides it), so it gets tenant RLS only. `attendance_devices`
//   belongs to the employee, not an outlet: tenant RLS only. Every other table
//   carries outlet_id NOT NULL and also gets the outlet RLS backstop
//   (hris-attendance.custom.sql).
// - `attendance_logs.id` is a ULID stored as uuid (PRD §6 H): an edge node
//   records offline and syncs later. `occurred_at` is server time for online
//   submissions; only an offline (edge) event keeps the client time.
//   Raw coordinates are never stored, only `geo_distance_m`.
// - `photo_key` points at a private selfie; the purge job nulls it and stamps
//   `photo_purged_at` once the payroll period is closed and retention passed.
// - A rejected attempt is kept (validity = rejected) so HR can see it; it never
//   counts toward worked hours.
// - `attendance_qr_secrets` holds the per-outlet HMAC seed behind the 30 s
//   rotating QR; the token itself is never stored.
// - Composite (tenant_id, id) foreign keys keep every reference in one tenant.
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
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  AttendanceCorrectionStatus,
  AttendanceStoredFlagReason,
  AttendanceMethod,
  AttendancePolicy,
  AttendanceType,
  AttendanceValidity,
} from "@starter/shared/hris";
import type { UserId } from "@starter/shared/core";
import { businessDate, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";
import { employees } from "./hris.ts";
import { shiftAssignments } from "./hris-scheduling.ts";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const SHA256_FORMAT = "'^[a-f0-9]{64}$'";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** F25 supervisor sampling of flagged selfies (jsonb `attendance_policies.sampling`). */
export type AttendanceSamplingConfig = {
  /** Share of valid logs drawn into the review queue, 0..1. */
  rate: number;
  /** Flagged logs always enter the queue. */
  flaggedAlways: boolean;
  minPerSupervisorPerWeek: number;
};

export type AttendanceDeviceStatus = "active" | "revoked";
export type AttendanceReviewStatus =
  "none" | "pending" | "accepted" | "rejected";

// ---------------------------------------------------------------- policies

/** F25 "sesuai kebijakan": tenant default row plus optional per-outlet override. */
export const attendancePolicies = pgTable(
  "attendance_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id"),
    policy: jsonb("policy").$type<AttendancePolicy>().notNull(),
    sampling: jsonb("sampling").$type<AttendanceSamplingConfig>().notNull(),
    updatedBy: text("updated_by").$type<UserId>().notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("attendance_policies_tenant_id_key").on(table.tenantId, table.id),
    unique("attendance_policies_tenant_outlet_key")
      .on(table.tenantId, table.outletId)
      .nullsNotDistinct(),
    foreignKey({
      name: "attendance_policies_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "attendance_policies_policy_check",
      sql`jsonb_typeof(${table.policy}) = 'object'`,
    ),
    check(
      "attendance_policies_sampling_check",
      sql`jsonb_typeof(${table.sampling}) = 'object'
        AND (${table.sampling}->>'rate')::numeric BETWEEN 0 AND 1
        AND jsonb_typeof(${table.sampling}->'flaggedAlways') = 'boolean'
        AND (${table.sampling}->>'minPerSupervisorPerWeek')::numeric >= 0`,
    ),
  ],
);

// ----------------------------------------------------------------- devices

/** F25 "pengikatan perangkat": at most one active device per employee. */
export const attendanceDevices = pgTable(
  "attendance_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    deviceIdHash: varchar("device_id_hash", { length: 64 }).notNull(),
    label: varchar("label", { length: 100 }).notNull(),
    status: varchar("status", { length: 10 })
      .$type<AttendanceDeviceStatus>()
      .notNull()
      .default("active"),
    boundAt: timestamp("bound_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").$type<UserId>(),
  },
  (table) => [
    unique("attendance_devices_tenant_id_key").on(table.tenantId, table.id),
    unique("attendance_devices_tenant_employee_hash_key").on(
      table.tenantId,
      table.employeeId,
      table.deviceIdHash,
    ),
    uniqueIndex("attendance_devices_active_employee_key")
      .on(table.tenantId, table.employeeId)
      .where(sql`${table.status} = 'active'`),
    foreignKey({
      name: "attendance_devices_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "attendance_devices_hash_check",
      sql.raw(`"device_id_hash" ~ ${SHA256_FORMAT}`),
    ),
    check(
      "attendance_devices_status_check",
      sql`${table.status} IN ('active', 'revoked')`,
    ),
    check(
      "attendance_devices_revoked_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)
        AND (${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`,
    ),
  ],
);

// ------------------------------------------------------------- corrections

/**
 * PRD F25 "Koreksi Absensi" (T, O): decided through the approval matrix
 * (sourceModule `hris_attendance`); `approval_chain_id` is the chain the
 * consumer settles by.
 */
export const attendanceCorrections = pgTable(
  "attendance_corrections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    /** Null when the log is missing entirely. */
    attendanceLogId: ulidInUuid("attendance_log_id"),
    requestedType: varchar("requested_type", { length: 20 })
      .$type<AttendanceType>()
      .notNull(),
    requestedOccurredAt: timestamp("requested_occurred_at", {
      withTimezone: true,
    }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<AttendanceCorrectionStatus>()
      .notNull()
      .default("pending"),
    approvalChainId: uuid("approval_chain_id"),
    requestedBy: text("requested_by").$type<UserId>().notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: text("decided_by").$type<UserId>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The `manual_correction` log an approval created. */
    resultingLogId: ulidInUuid("resulting_log_id"),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    updatedAt,
  },
  (table): PgTableExtraConfigValue[] => [
    unique("attendance_corrections_tenant_id_key").on(table.tenantId, table.id),
    unique("attendance_corrections_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("attendance_corrections_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
      table.requestedOccurredAt,
    ),
    index("attendance_corrections_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
    ),
    index("attendance_corrections_chain_idx").on(
      table.tenantId,
      table.approvalChainId,
    ),
    foreignKey({
      name: "attendance_corrections_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "attendance_corrections_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "attendance_corrections_log_fk",
      columns: [table.tenantId, table.attendanceLogId],
      foreignColumns: [attendanceLogs.tenantId, attendanceLogs.id],
    }),
    foreignKey({
      name: "attendance_corrections_resulting_log_fk",
      columns: [table.tenantId, table.resultingLogId],
      foreignColumns: [attendanceLogs.tenantId, attendanceLogs.id],
    }),
    check(
      "attendance_corrections_type_check",
      sql`${table.requestedType} IN ('in', 'out', 'break_start', 'break_end')`,
    ),
    check(
      "attendance_corrections_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected')`,
    ),
    check(
      "attendance_corrections_decision_check",
      sql`(${table.decidedBy} IS NULL) = (${table.decidedAt} IS NULL)
        AND (${table.status} = 'pending') = (${table.decidedAt} IS NULL)`,
    ),
    check(
      "attendance_corrections_result_check",
      sql`${table.resultingLogId} IS NULL OR ${table.status} = 'approved'`,
    ),
  ],
);

// -------------------------------------------------------------------- logs

/** PRD §6 H `attendance_logs` (T, O): ULID id, immutable apart from review fields. */
export const attendanceLogs = pgTable(
  "attendance_logs",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    type: varchar("type", { length: 20 }).$type<AttendanceType>().notNull(),
    method: varchar("method", { length: 20 })
      .$type<AttendanceMethod>()
      .notNull(),
    /** Server receive time online; client time only when `offline` is true. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Server-computed metres to the outlet geofence point; no raw coordinates. */
    geoDistanceM: integer("geo_distance_m"),
    deviceIdHash: varchar("device_id_hash", { length: 64 }),
    /** Private selfie object key; null after the retention purge. */
    photoKey: text("photo_key"),
    photoPurgedAt: timestamp("photo_purged_at", { withTimezone: true }),
    validity: varchar("validity", { length: 10 })
      .$type<AttendanceValidity>()
      .notNull(),
    flagReasons: jsonb("flag_reasons")
      .$type<AttendanceStoredFlagReason[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    shiftAssignmentId: uuid("shift_assignment_id"),
    /** Outlet-local calendar day (core `localDateOf`). */
    businessDate: businessDate("business_date").notNull(),
    lateMinutes: integer("late_minutes"),
    earlyLeaveMinutes: integer("early_leave_minutes"),
    overtimeMinutes: integer("overtime_minutes"),
    offline: boolean("offline").notNull().default(false),
    clientEventId: varchar("client_event_id", { length: 100 }).notNull(),
    correctionId: uuid("correction_id"),
    reviewStatus: varchar("review_status", { length: 10 })
      .$type<AttendanceReviewStatus>()
      .notNull()
      .default("none"),
    reviewedBy: text("reviewed_by").$type<UserId>(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("attendance_logs_tenant_id_key").on(table.tenantId, table.id),
    // A retried submission returns the stored row.
    unique("attendance_logs_tenant_client_event_key").on(
      table.tenantId,
      table.clientEventId,
    ),
    index("attendance_logs_tenant_employee_date_idx").on(
      table.tenantId,
      table.employeeId,
      table.businessDate,
    ),
    index("attendance_logs_tenant_outlet_occurred_idx").on(
      table.tenantId,
      table.outletId,
      table.occurredAt,
    ),
    // Purge job: only rows that still hold a selfie.
    index("attendance_logs_photo_purge_idx")
      .on(table.tenantId, table.businessDate)
      .where(sql`${table.photoKey} IS NOT NULL`),
    foreignKey({
      name: "attendance_logs_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "attendance_logs_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "attendance_logs_shift_assignment_fk",
      columns: [table.tenantId, table.shiftAssignmentId],
      foreignColumns: [shiftAssignments.tenantId, shiftAssignments.id],
    }),
    foreignKey({
      name: "attendance_logs_correction_fk",
      columns: [table.tenantId, table.correctionId],
      foreignColumns: [
        attendanceCorrections.tenantId,
        attendanceCorrections.id,
      ],
    }),
    check(
      "attendance_logs_type_check",
      sql`${table.type} IN ('in', 'out', 'break_start', 'break_end')`,
    ),
    check(
      "attendance_logs_method_check",
      sql`${table.method} IN ('selfie_geo', 'rotating_qr', 'manual_correction', 'outlet_device')`,
    ),
    check(
      "attendance_logs_validity_check",
      sql`${table.validity} IN ('valid', 'flagged', 'rejected')`,
    ),
    check(
      "attendance_logs_review_status_check",
      sql`${table.reviewStatus} IN ('none', 'pending', 'accepted', 'rejected')`,
    ),
    check(
      "attendance_logs_review_check",
      sql`(${table.reviewedBy} IS NULL) = (${table.reviewedAt} IS NULL)
        AND (${table.reviewStatus} IN ('accepted', 'rejected')) = (${table.reviewedAt} IS NOT NULL)`,
    ),
    check(
      "attendance_logs_flag_reasons_check",
      sql`jsonb_typeof(${table.flagReasons}) = 'array'`,
    ),
    check(
      "attendance_logs_device_hash_check",
      sql.raw(
        `"device_id_hash" IS NULL OR "device_id_hash" ~ ${SHA256_FORMAT}`,
      ),
    ),
    check(
      "attendance_logs_measure_check",
      sql`(${table.geoDistanceM} IS NULL OR ${table.geoDistanceM} >= 0)
        AND (${table.lateMinutes} IS NULL OR ${table.lateMinutes} >= 0)
        AND (${table.earlyLeaveMinutes} IS NULL OR ${table.earlyLeaveMinutes} >= 0)
        AND (${table.overtimeMinutes} IS NULL OR ${table.overtimeMinutes} >= 0)`,
    ),
    check(
      "attendance_logs_photo_check",
      sql`${table.photoPurgedAt} IS NULL OR ${table.photoKey} IS NULL`,
    ),
  ],
);

// ------------------------------------------------------------- QR secrets

/** Per-outlet seed of the 30 s rotating QR token (HMAC-SHA256, manual rotation). */
export const attendanceQrSecrets = pgTable(
  "attendance_qr_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    seed: bytea("seed").notNull(),
    createdAt,
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (table) => [
    unique("attendance_qr_secrets_tenant_id_key").on(table.tenantId, table.id),
    unique("attendance_qr_secrets_tenant_outlet_key").on(
      table.tenantId,
      table.outletId,
    ),
    foreignKey({
      name: "attendance_qr_secrets_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "attendance_qr_secrets_seed_check",
      sql`octet_length(${table.seed}) >= 32`,
    ),
  ],
);

// -------------------------------------------------------------- duty meals

/** F25 duty meal ("makan dinas") per employee shift; stock cut is a separate consumer. */
export const attendanceDutyMeals = pgTable(
  "attendance_duty_meals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    shiftAssignmentId: uuid("shift_assignment_id"),
    businessDate: businessDate("business_date").notNull(),
    mealCount: integer("meal_count").notNull().default(1),
    recordedBy: text("recorded_by").$type<UserId>().notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
  },
  (table) => [
    unique("attendance_duty_meals_tenant_id_key").on(table.tenantId, table.id),
    unique("attendance_duty_meals_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    // One record per employee, day and shift (NULL shift counts as one slot).
    unique("attendance_duty_meals_employee_day_shift_key")
      .on(
        table.tenantId,
        table.employeeId,
        table.businessDate,
        table.shiftAssignmentId,
      )
      .nullsNotDistinct(),
    index("attendance_duty_meals_tenant_outlet_date_idx").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
    ),
    foreignKey({
      name: "attendance_duty_meals_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "attendance_duty_meals_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "attendance_duty_meals_shift_assignment_fk",
      columns: [table.tenantId, table.shiftAssignmentId],
      foreignColumns: [shiftAssignments.tenantId, shiftAssignments.id],
    }),
    check("attendance_duty_meals_count_check", sql`${table.mealCount} >= 1`),
  ],
);
