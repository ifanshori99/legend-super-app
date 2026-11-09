// HRIS shift scheduling (PRD v1.7 §3 Kelompok D 28 "Penjadwalan Shift", §6 H
// `shift_templates`, `shift_assignments`, `shift_swap_requests`; F26, HR-05;
// bead legend-jstx).
//
// Contract: `@starter/shared/hris` (scheduling.ts, endpoints.ts, events.ts).
//
// - `shift_assignments` snapshots concrete segments + break minutes so a later
//   template edit never changes a published roster. `business_date` is the
//   outlet-local day the shift starts on (derived server-side).
// - `shift_swap_requests.compliance_issues` is the HR-05 diff frozen at request
//   time; an approval recomputes it against the live roster.
// - `shift_compliance_policies.outlet_id` is nullable (null = tenant default),
//   so it gets tenant RLS only; every other table carries outlet_id NOT NULL
//   and also gets the outlet RLS backstop (hris-scheduling.custom.sql).
// - `roster_publications` is the publish idempotency ledger per outlet-week.
// - Composite (tenant_id, id) foreign keys keep every reference in one tenant.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  ShiftAssignment,
  ShiftAssignmentSegment,
  ShiftAssignmentSource,
  ShiftAssignmentStatus,
  ShiftComplianceIssue,
  ShiftSwapStatus,
  ShiftTemplateSegment,
} from "@starter/shared/hris";
import type { UserId } from "@starter/shared/core";
import { businessDate, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";
import { employees, positions } from "./hris.ts";
import { stations } from "./menu.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

// ----------------------------------------------------------- shift templates

/** PRD §6 H `shift_templates` (T, O): one segment, or two for a split shift. */
export const shiftTemplates = pgTable(
  "shift_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    segments: jsonb("segments").$type<ShiftTemplateSegment[]>().notNull(),
    breakMinutes: integer("break_minutes").notNull().default(0),
    stationId: uuid("station_id"),
    positionId: uuid("position_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").$type<UserId>().notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("shift_templates_tenant_id_key").on(table.tenantId, table.id),
    // Target of the composite (tenant, outlet) FK from shift_assignments.
    unique("shift_templates_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("shift_templates_tenant_outlet_name_key").on(
      table.tenantId,
      table.outletId,
      table.name,
    ),
    foreignKey({
      name: "shift_templates_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "shift_templates_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "shift_templates_position_fk",
      columns: [table.tenantId, table.positionId],
      foreignColumns: [positions.tenantId, positions.id],
    }),
    check(
      "shift_templates_break_check",
      sql`${table.breakMinutes} >= 0 AND ${table.breakMinutes} <= 240`,
    ),
    check(
      "shift_templates_segments_check",
      sql`jsonb_typeof(${table.segments}) = 'array' AND jsonb_array_length(${table.segments}) BETWEEN 1 AND 2`,
    ),
  ],
);

// -------------------------------------------------------- shift assignments

/** PRD §6 H `shift_assignments` (T, O): source user | ai | mcp. */
export const shiftAssignments = pgTable(
  "shift_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    shiftTemplateId: uuid("shift_template_id"),
    stationId: uuid("station_id"),
    businessDate: businessDate("business_date").notNull(),
    segments: jsonb("segments").$type<ShiftAssignmentSegment[]>().notNull(),
    breakMinutes: integer("break_minutes").notNull().default(0),
    status: varchar("status", { length: 20 })
      .$type<ShiftAssignmentStatus>()
      .notNull()
      .default("draft"),
    source: varchar("source", { length: 10 })
      .$type<ShiftAssignmentSource>()
      .notNull()
      .default("user"),
    publishedBy: text("published_by").$type<UserId>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: text("created_by").$type<UserId>().notNull(),
    createIdempotencyKey: varchar("create_idempotency_key", { length: 100 }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("shift_assignments_tenant_id_key").on(table.tenantId, table.id),
    // Target of the composite (tenant, outlet) FK from shift_swap_requests.
    unique("shift_assignments_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    // A retried create returns the stored row (NULLs stay distinct: copies).
    unique("shift_assignments_tenant_idempotency_key").on(
      table.tenantId,
      table.createIdempotencyKey,
    ),
    // One live row per employee, day and template, whatever the key: stops a
    // create racing a copy from duplicating a shift.
    uniqueIndex("shift_assignments_active_employee_day_template_key")
      .on(
        table.tenantId,
        table.employeeId,
        table.businessDate,
        table.shiftTemplateId,
      )
      .where(
        sql`${table.status} <> 'cancelled' AND ${table.shiftTemplateId} IS NOT NULL`,
      ),
    index("shift_assignments_tenant_outlet_date_idx").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
    ),
    index("shift_assignments_tenant_employee_date_idx").on(
      table.tenantId,
      table.employeeId,
      table.businessDate,
    ),
    foreignKey({
      name: "shift_assignments_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "shift_assignments_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "shift_assignments_template_fk",
      columns: [table.tenantId, table.outletId, table.shiftTemplateId],
      foreignColumns: [
        shiftTemplates.tenantId,
        shiftTemplates.outletId,
        shiftTemplates.id,
      ],
    }),
    foreignKey({
      name: "shift_assignments_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    check(
      "shift_assignments_status_check",
      sql`${table.status} IN ('draft', 'published', 'swapped', 'cancelled')`,
    ),
    check(
      "shift_assignments_source_check",
      sql`${table.source} IN ('user', 'ai', 'mcp')`,
    ),
    check(
      "shift_assignments_break_check",
      sql`${table.breakMinutes} >= 0 AND ${table.breakMinutes} <= 240`,
    ),
    check(
      "shift_assignments_segments_check",
      sql`jsonb_typeof(${table.segments}) = 'array' AND jsonb_array_length(${table.segments}) BETWEEN 1 AND 2`,
    ),
    check(
      "shift_assignments_published_check",
      sql`(${table.publishedBy} IS NULL) = (${table.publishedAt} IS NULL)
        AND (${table.status} = 'draft') = (${table.publishedAt} IS NULL)
        OR ${table.status} = 'cancelled'`,
    ),
  ],
);

// -------------------------------------------------------- roster publications

/**
 * One row per published outlet-week. The idempotency key makes a retried
 * publish return the first result instead of emitting events twice.
 */
export const rosterPublications = pgTable(
  "roster_publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    weekStart: businessDate("week_start").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    complianceIssues: jsonb("compliance_issues")
      .$type<ShiftComplianceIssue[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    assignmentCount: integer("assignment_count").notNull(),
    /** Assignments this publication published, and how they looked then. */
    assignmentIds: uuid("assignment_ids").array().notNull(),
    snapshot: jsonb("snapshot").$type<ShiftAssignment[]>().notNull(),
    publishedBy: text("published_by").$type<UserId>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("roster_publications_tenant_id_key").on(table.tenantId, table.id),
    unique("roster_publications_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("roster_publications_tenant_outlet_week_idx").on(
      table.tenantId,
      table.outletId,
      table.weekStart,
    ),
    foreignKey({
      name: "roster_publications_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "roster_publications_count_check",
      sql`${table.assignmentCount} > 0 AND cardinality(${table.assignmentIds}) = ${table.assignmentCount}`,
    ),
  ],
);

// ------------------------------------------------------------ roster copies

/**
 * Idempotency ledger for "salin minggu": one row per accepted copy request, so
 * a retried key returns the drafts the first call created.
 */
export const rosterCopies = pgTable(
  "roster_copies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    fromWeekStart: businessDate("from_week_start").notNull(),
    toWeekStart: businessDate("to_week_start").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    assignmentIds: uuid("assignment_ids").array().notNull(),
    createdBy: text("created_by").$type<UserId>().notNull(),
    createdAt,
  },
  (table) => [
    unique("roster_copies_tenant_id_key").on(table.tenantId, table.id),
    unique("roster_copies_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("roster_copies_tenant_outlet_week_idx").on(
      table.tenantId,
      table.outletId,
      table.toWeekStart,
    ),
    foreignKey({
      name: "roster_copies_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "roster_copies_count_check",
      sql`cardinality(${table.assignmentIds}) > 0 AND ${table.toWeekStart} <> ${table.fromWeekStart}`,
    ),
  ],
);

// ------------------------------------------------------------- swap requests

/** PRD §6 H `shift_swap_requests` (T, O): swap (to_assignment set) or cover. */
export const shiftSwapRequests = pgTable(
  "shift_swap_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    fromAssignmentId: uuid("from_assignment_id").notNull(),
    toAssignmentId: uuid("to_assignment_id"),
    requestedBy: uuid("requested_by").notNull(),
    toEmployeeId: uuid("to_employee_id").notNull(),
    status: varchar("status", { length: 20 })
      .$type<ShiftSwapStatus>()
      .notNull()
      .default("pending"),
    complianceIssues: jsonb("compliance_issues")
      .$type<ShiftComplianceIssue[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    overrideReason: varchar("override_reason", { length: 500 }),
    approvedBy: text("approved_by").$type<UserId>(),
    requestedByUserId: text("requested_by_user_id").$type<UserId>().notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createIdempotencyKey: varchar("create_idempotency_key", { length: 100 }),
    updatedAt,
  },
  (table) => [
    unique("shift_swap_requests_tenant_id_key").on(table.tenantId, table.id),
    unique("shift_swap_requests_tenant_idempotency_key").on(
      table.tenantId,
      table.createIdempotencyKey,
    ),
    index("shift_swap_requests_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
    ),
    // One open request per surrendered assignment.
    uniqueIndex("shift_swap_requests_open_from_key")
      .on(table.tenantId, table.fromAssignmentId)
      .where(sql`${table.status} = 'pending'`),
    foreignKey({
      name: "shift_swap_requests_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "shift_swap_requests_from_fk",
      columns: [table.tenantId, table.outletId, table.fromAssignmentId],
      foreignColumns: [
        shiftAssignments.tenantId,
        shiftAssignments.outletId,
        shiftAssignments.id,
      ],
    }),
    foreignKey({
      name: "shift_swap_requests_to_fk",
      columns: [table.tenantId, table.outletId, table.toAssignmentId],
      foreignColumns: [
        shiftAssignments.tenantId,
        shiftAssignments.outletId,
        shiftAssignments.id,
      ],
    }),
    foreignKey({
      name: "shift_swap_requests_requester_fk",
      columns: [table.tenantId, table.requestedBy],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "shift_swap_requests_target_fk",
      columns: [table.tenantId, table.toEmployeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "shift_swap_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')`,
    ),
    check(
      "shift_swap_requests_distinct_employee_check",
      sql`${table.requestedBy} <> ${table.toEmployeeId}`,
    ),
    check(
      "shift_swap_requests_decision_check",
      sql`(${table.approvedBy} IS NULL) = (${table.decidedAt} IS NULL)
        OR ${table.status} IN ('cancelled', 'expired')`,
    ),
  ],
);

// ------------------------------------------------------ compliance policies

/**
 * Working-time limits (F26 "aturan yang dapat dikonfigurasi"). `outlet_id`
 * null is the tenant default; an outlet row overrides it for that outlet.
 */
export const shiftCompliancePolicies = pgTable(
  "shift_compliance_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id"),
    maxShiftMinutes: integer("max_shift_minutes").notNull().default(600),
    maxDailyMinutes: integer("max_daily_minutes").notNull().default(720),
    maxWeeklyMinutes: integer("max_weekly_minutes").notNull().default(2_700),
    minRestMinutesBetweenShifts: integer("min_rest_minutes_between_shifts")
      .notNull()
      .default(660),
    maxConsecutiveWorkDays: integer("max_consecutive_work_days")
      .notNull()
      .default(6),
    updatedBy: text("updated_by").$type<UserId>().notNull(),
    updatedAt,
  },
  (table) => [
    unique("shift_compliance_policies_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    uniqueIndex("shift_compliance_policies_tenant_outlet_key")
      .on(table.tenantId, table.outletId)
      .where(sql`${table.outletId} IS NOT NULL`),
    uniqueIndex("shift_compliance_policies_tenant_default_key")
      .on(table.tenantId)
      .where(sql`${table.outletId} IS NULL`),
    foreignKey({
      name: "shift_compliance_policies_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "shift_compliance_policies_limits_check",
      sql`${table.maxShiftMinutes} BETWEEN 60 AND 1440
        AND ${table.maxDailyMinutes} BETWEEN ${table.maxShiftMinutes} AND 2880
        AND ${table.maxWeeklyMinutes} BETWEEN ${table.maxDailyMinutes} AND 10080
        AND ${table.minRestMinutesBetweenShifts} BETWEEN 0 AND 1440
        AND ${table.maxConsecutiveWorkDays} BETWEEN 1 AND 31`,
    ),
  ],
);
