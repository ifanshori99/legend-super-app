// HRIS leave, balances, accrual, holidays and overtime (PRD v1.7 §3 Kelompok D
// 29 "Cuti, Izin & Lembur", §6 H `leave_types`, `leave_balances`,
// `leave_requests`, `holidays`, `overtime_requests`; bead legend-hggk).
//
// Contract: `@starter/shared/hris` (leave.ts, payroll/statutory.ts).
//
// - Day counts are `numeric(9,4)` (string, Decimal4 scale 10^4); money is not
//   stored here. Overtime pay is computed from the pinned formula version.
// - `leave_accruals` is the idempotency ledger for grant / carry-over / expiry:
//   a balance is only moved when the ledger insert actually inserted a row.
// - `leave_requests.outlet_id` / `overtime_requests.outlet_id` record the
//   employee's home outlet at request time (approval routing + reach). Tenant
//   RLS on every table (hris-leave.custom.sql); outlet reach is enforced by the
//   service like the other HRIS tables.
// - `overtime_formulas` are versioned ("rumus lembur"); a request pins the
//   formula version it was approved under, published rows never change.
// - Composite (tenant_id, id) foreign keys keep every reference inside one
//   tenant.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  HolidayType,
  LeavePolicy,
  LeaveRequestStatus,
  OvertimeRequestStatus,
} from "@starter/shared/hris";
import type {
  OvertimeDayType,
  OvertimeParameters,
} from "@starter/shared/hris/payroll";
import type { UserId } from "@starter/shared/core";
import { businessDate, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";
import { employees } from "./hris.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** Leave day quantity: Decimal4 as a string, never a float. */
const days = (name: string) => numeric(name, { precision: 9, scale: 4 });

// -------------------------------------------------------------- leave types

/** PRD §6 H `leave_types` (T): code, name, paid, requires_attachment, policy. */
export const leaveTypes = pgTable(
  "leave_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    paid: boolean("paid").notNull(),
    requiresAttachment: boolean("requires_attachment").notNull(),
    policy: jsonb("policy").$type<LeavePolicy>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("leave_types_tenant_id_key").on(table.tenantId, table.id),
    unique("leave_types_tenant_code_key").on(table.tenantId, table.code),
  ],
);

// ----------------------------------------------------------- leave balances

/** PRD §6 H `leave_balances` (T): one row per employee x type x year. */
export const leaveBalances = pgTable(
  "leave_balances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    periodYear: smallint("period_year").notNull(),
    entitledDays: days("entitled_days").notNull().default("0"),
    carriedOverDays: days("carried_over_days").notNull().default("0"),
    usedDays: days("used_days").notNull().default("0"),
    pendingDays: days("pending_days").notNull().default("0"),
    carryOverExpiresOn: businessDate("carry_over_expires_on"),
    updatedAt,
  },
  (table) => [
    unique("leave_balances_tenant_id_key").on(table.tenantId, table.id),
    unique("leave_balances_tenant_employee_type_year_key").on(
      table.tenantId,
      table.employeeId,
      table.leaveTypeId,
      table.periodYear,
    ),
    foreignKey({
      name: "leave_balances_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "leave_balances_leave_type_fk",
      columns: [table.tenantId, table.leaveTypeId],
      foreignColumns: [leaveTypes.tenantId, leaveTypes.id],
    }),
    check(
      "leave_balances_period_year_check",
      sql`${table.periodYear} BETWEEN 2000 AND 2100`,
    ),
    check(
      "leave_balances_nonnegative_check",
      sql`${table.entitledDays} >= 0 AND ${table.carriedOverDays} >= 0 AND ${table.pendingDays} >= 0`,
    ),
  ],
);

// ----------------------------------------------------------- leave accruals

/**
 * Idempotency ledger for accrual, carry-over and carry-over expiry. `period`
 * is `YYYY` or `YYYY-MM`; `days` is signed (expiry is negative).
 */
export const leaveAccruals = pgTable(
  "leave_accruals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    kind: varchar("kind", { length: 20 })
      .$type<"grant" | "carry_over" | "carry_over_expiry">()
      .notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    days: days("days").notNull(),
    createdAt,
    createdBy: text("created_by").$type<UserId>(),
  },
  (table) => [
    unique("leave_accruals_tenant_employee_type_kind_period_key").on(
      table.tenantId,
      table.employeeId,
      table.leaveTypeId,
      table.kind,
      table.period,
    ),
    foreignKey({
      name: "leave_accruals_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "leave_accruals_leave_type_fk",
      columns: [table.tenantId, table.leaveTypeId],
      foreignColumns: [leaveTypes.tenantId, leaveTypes.id],
    }),
    check(
      "leave_accruals_kind_check",
      sql`${table.kind} IN ('grant', 'carry_over', 'carry_over_expiry')`,
    ),
    check(
      "leave_accruals_period_check",
      sql`${table.period} ~ '^[0-9]{4}(-[0-9]{2})?$'`,
    ),
  ],
);

// ----------------------------------------------------------- leave requests

/** PRD §6 H `leave_requests` (T): approved through the approval matrix. */
export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Employee home outlet at request time. */
    outletId: uuid("outlet_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    periodYear: smallint("period_year").notNull(),
    startDate: businessDate("start_date").notNull(),
    endDate: businessDate("end_date").notNull(),
    days: days("days").notNull(),
    reason: text("reason"),
    attachmentKey: varchar("attachment_key", { length: 500 }),
    status: varchar("status", { length: 20 })
      .$type<LeaveRequestStatus>()
      .notNull()
      .default("pending"),
    approvalChainId: uuid("approval_chain_id"),
    requestedBy: text("requested_by").$type<UserId>().notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: text("decided_by").$type<UserId>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createIdempotencyKey: varchar("create_idempotency_key", { length: 100 }),
    updatedAt,
  },
  (table) => [
    unique("leave_requests_tenant_id_key").on(table.tenantId, table.id),
    unique("leave_requests_tenant_idempotency_key").on(
      table.tenantId,
      table.createIdempotencyKey,
    ),
    index("leave_requests_tenant_employee_start_idx").on(
      table.tenantId,
      table.employeeId,
      table.startDate,
    ),
    foreignKey({
      name: "leave_requests_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "leave_requests_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "leave_requests_leave_type_fk",
      columns: [table.tenantId, table.leaveTypeId],
      foreignColumns: [leaveTypes.tenantId, leaveTypes.id],
    }),
    check(
      "leave_requests_date_range_check",
      sql`${table.endDate} >= ${table.startDate}`,
    ),
    check("leave_requests_days_check", sql`${table.days} >= 0`),
    check(
      "leave_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'cancelled')`,
    ),
  ],
);

// ----------------------------------------------------------------- holidays

/** PRD §6 H `holidays` (T): `outlet_id` null = the whole tenant. */
export const holidays = pgTable(
  "holidays",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id"),
    date: businessDate("date").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    type: varchar("type", { length: 20 }).$type<HolidayType>().notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("holidays_tenant_id_key").on(table.tenantId, table.id),
    unique("holidays_tenant_outlet_date_key")
      .on(table.tenantId, table.outletId, table.date)
      .nullsNotDistinct(),
    index("holidays_tenant_date_idx").on(table.tenantId, table.date),
    foreignKey({
      name: "holidays_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "holidays_type_check",
      sql`${table.type} IN ('national', 'collective', 'company')`,
    ),
  ],
);

// -------------------------------------------------------- overtime formulas

/** Versioned overtime formula ("rumus lembur"); published rows are immutable. */
export const overtimeFormulas = pgTable(
  "overtime_formulas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    version: integer("version").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    status: varchar("status", { length: 20 })
      .$type<"draft" | "published" | "archived">()
      .notNull()
      .default("draft"),
    parameters: jsonb("parameters").$type<OvertimeParameters>().notNull(),
    restDayType: varchar("rest_day_type", { length: 30 })
      .$type<"rest_day_6_day_week" | "rest_day_5_day_week">()
      .notNull(),
    legalBasis: varchar("legal_basis", { length: 200 }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by").$type<UserId>(),
    createdAt,
    createdBy: text("created_by").$type<UserId>().notNull(),
  },
  (table) => [
    unique("overtime_formulas_tenant_id_key").on(table.tenantId, table.id),
    unique("overtime_formulas_tenant_version_key").on(
      table.tenantId,
      table.version,
    ),
    check("overtime_formulas_version_check", sql`${table.version} > 0`),
    check(
      "overtime_formulas_status_check",
      sql`${table.status} IN ('draft', 'published', 'archived')`,
    ),
    check(
      "overtime_formulas_rest_day_type_check",
      sql`${table.restDayType} IN ('rest_day_6_day_week', 'rest_day_5_day_week')`,
    ),
  ],
);

// -------------------------------------------------------- overtime requests

/** PRD §6 H `overtime_requests` (T): approved through the approval matrix. */
export const overtimeRequests = pgTable(
  "overtime_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Employee home outlet at request time. */
    outletId: uuid("outlet_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    date: businessDate("date").notNull(),
    minutes: smallint("minutes").notNull(),
    dayType: varchar("day_type", { length: 30 })
      .$type<OvertimeDayType>()
      .notNull(),
    reason: text("reason").notNull(),
    status: varchar("status", { length: 20 })
      .$type<OvertimeRequestStatus>()
      .notNull()
      .default("pending"),
    approvalChainId: uuid("approval_chain_id"),
    /** Formula version pinned at request time. */
    formulaId: uuid("formula_id"),
    requestedBy: text("requested_by").$type<UserId>().notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: text("decided_by").$type<UserId>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createIdempotencyKey: varchar("create_idempotency_key", { length: 100 }),
    updatedAt,
  },
  (table) => [
    unique("overtime_requests_tenant_id_key").on(table.tenantId, table.id),
    unique("overtime_requests_tenant_idempotency_key").on(
      table.tenantId,
      table.createIdempotencyKey,
    ),
    index("overtime_requests_tenant_employee_date_idx").on(
      table.tenantId,
      table.employeeId,
      table.date,
    ),
    foreignKey({
      name: "overtime_requests_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "overtime_requests_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "overtime_requests_formula_fk",
      columns: [table.tenantId, table.formulaId],
      foreignColumns: [overtimeFormulas.tenantId, overtimeFormulas.id],
    }),
    check(
      "overtime_requests_minutes_check",
      sql`${table.minutes} BETWEEN 1 AND 720`,
    ),
    check(
      "overtime_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'cancelled')`,
    ),
  ],
);
