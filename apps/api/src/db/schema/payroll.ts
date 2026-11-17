// Payroll tables (bead legend-gfcr, PRD v1.7 §3 D.30-31, §6 H, R20, PAYR-02,
// HR-03; contract `@starter/shared/hris/payroll`). The PPh 21 policy versions
// live in payroll-pph21-policy.ts (legend-y4wp).
//
// Every table is tenant-owned: tenant_id NOT NULL, `(tenant_id, id)` unique so
// children reference parents with composite foreign keys (a row can never
// point into another tenant), and tenant RLS (ENABLE + FORCE) from
// payroll.custom.sql, copied into the generated migration. Service charge
// pools are the only outlet-owned rows and also carry outlet RLS.
//
// HR-03: an employee's pay amount (employee_pay_components) and a payslip's
// calculation are sealed with AES-256-GCM (lib/payroll-sealed.ts), bound to
// tenant, table, row and field, so a raw database read never shows a salary
// and a ciphertext copied to another row fails to open. Kasbon, reimbursement
// and service charge amounts are claims and splits, not salary; they stay
// plain so limits and totals can be checked in SQL, and only payroll and
// HR approver roles can read them (service layer).
//
// PAYR-02: a published statutory version never changes (database trigger),
// and a locked run keeps its snapshot and totals (database trigger), so a
// later rate change cannot alter a locked payroll.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import type { EmployeeId } from "@starter/shared/hris";
import type {
  BankTransferFileId,
  EmployeeGroup,
  EmployeeLoanId,
  EmployeePayComponentId,
  PayComponentId,
  PayrollConfigSnapshot,
  PayrollCycle,
  PayrollPolicyId,
  PayrollRunId,
  PayrollRunReversal,
  PayrollRunTotals,
  PayrollTaxExportId,
  PayslipId,
  ReimbursementCategoryId,
  ReimbursementId,
  ReimbursementLimit,
  ServiceChargeAllocationId,
  ServiceChargePoolId,
  ServiceChargeRule,
  StatutoryTableVersionId,
  ThrScheduleId,
} from "@starter/shared/hris/payroll";
import {
  businessDate,
  decimal4Column,
  idrColumn,
  tenantIdColumn,
} from "../columns.ts";
import { employees } from "./hris.ts";
import { legalEntities, outlets, tenants } from "./platform-org.ts";

/** Sealed envelope bytes (version | nonce | tag | ciphertext). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
/** Actor reference without a foreign key: history outlives the account. */
const actor = (name: string) => text(name).$type<UserId>();

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

const STATUTORY_TYPES = [
  "bpjs_kes",
  "jht",
  "jkk",
  "jkm",
  "jp",
  "ptkp",
  "pph21_ter",
  "pph21_annual",
  "overtime",
  "thr",
] as const;
const PAY_COMPONENT_CATEGORIES = [
  "base_salary",
  "fixed_allowance",
  "variable_allowance",
  "meal_allowance",
  "transport_allowance",
  "incentive",
  "overtime",
  "service_charge",
  "thr",
  "bonus",
  "reimbursement",
  "tax_allowance",
  "late_deduction",
  "loan_installment",
  "bpjs_employee",
  "pph21",
  "pph21_receivable",
  "custom_earning",
  "custom_deduction",
] as const;
const DEDUCTION_CATEGORIES = [
  "late_deduction",
  "loan_installment",
  "bpjs_employee",
  "pph21",
  "pph21_receivable",
  "custom_deduction",
] as const;
const JKK_RISK_CLASSES = [
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
] as const;
const RUN_STATUSES = [
  "draft",
  "simulated",
  "hr_approved",
  "approved",
  "locked",
  "paid",
  "reversed",
] as const;
const BANK_FORMATS = ["generic_csv", "bca", "mandiri", "bni", "bjb"] as const;

// ---- Statutory tables (PAYR-02, R20) -------------------------------------

export const statutoryRates = pgTable(
  "statutory_rates",
  {
    id: uuid("id")
      .$type<StatutoryTableVersionId>()
      .defaultRandom()
      .primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    /** 1, 2, 3 ... per tenant and type. */
    version: integer("version").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    status: varchar("status", { length: 10 }).notNull().default("draft"),
    legalBasis: varchar("legal_basis", { length: 200 }).notNull(),
    /** Validated by the type's parameters schema on write and on read. */
    parameters: jsonb("parameters").$type<unknown>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: actor("published_by"),
    createdBy: actor("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("statutory_rates_tenant_id_key").on(table.tenantId, table.id),
    unique("statutory_rates_tenant_type_version_key").on(
      table.tenantId,
      table.type,
      table.version,
    ),
    // One published version per type and effective date: resolution by date
    // is never ambiguous (PAYROLL_STATUTORY_TABLE_AMBIGUOUS stays a guard).
    uniqueIndex("statutory_rates_tenant_type_published_from_key")
      .on(table.tenantId, table.type, table.effectiveFrom)
      .where(sql`${table.status} = 'published'`),
    check(
      "statutory_rates_type_check",
      sql`${table.type} IN (${inList(STATUTORY_TYPES)})`,
    ),
    check(
      "statutory_rates_status_check",
      sql`${table.status} IN ('draft', 'published', 'archived')`,
    ),
    check("statutory_rates_version_check", sql`${table.version} >= 1`),
    check(
      "statutory_rates_published_pair_check",
      sql`(${table.status} = 'published') = (${table.publishedAt} IS NOT NULL)
        AND (${table.status} = 'published') = (${table.publishedBy} IS NOT NULL)`,
    ),
  ],
);

// ---- Policies and THR ----------------------------------------------------

export const payrollPolicies = pgTable(
  "payroll_policies",
  {
    id: uuid("id").$type<PayrollPolicyId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    /** Copy of employee_group.code for the uniqueness key. */
    employeeGroupCode: varchar("employee_group_code", { length: 30 }).notNull(),
    employeeGroup: jsonb("employee_group").$type<EmployeeGroup>().notNull(),
    cycle: jsonb("cycle").$type<PayrollCycle>().notNull(),
    payDateAdjustment: varchar("pay_date_adjustment", { length: 25 }).notNull(),
    jkkRiskClass: varchar("jkk_risk_class", { length: 10 }).notNull(),
    bpjsProgrammes: jsonb("bpjs_programmes").$type<string[]>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("payroll_policies_tenant_id_key").on(table.tenantId, table.id),
    unique("payroll_policies_tenant_entity_group_key").on(
      table.tenantId,
      table.legalEntityId,
      table.employeeGroupCode,
    ),
    foreignKey({
      name: "payroll_policies_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    check(
      "payroll_policies_pay_date_adjustment_check",
      sql`${table.payDateAdjustment} IN ('previous_working_day', 'next_working_day', 'none')`,
    ),
    check(
      "payroll_policies_jkk_risk_class_check",
      sql`${table.jkkRiskClass} IN (${inList(JKK_RISK_CLASSES)})`,
    ),
    check(
      "payroll_policies_group_code_check",
      sql`${table.employeeGroupCode} = ${table.employeeGroup} ->> 'code'`,
    ),
    check(
      "payroll_policies_bpjs_programmes_check",
      sql`jsonb_typeof(${table.bpjsProgrammes}) = 'array'`,
    ),
  ],
);

export const thrSchedules = pgTable(
  "thr_schedules",
  {
    id: uuid("id").$type<ThrScheduleId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    holidayName: varchar("holiday_name", { length: 100 }).notNull(),
    holidayDate: businessDate("holiday_date").notNull(),
    tenureAsOfDate: businessDate("tenure_as_of_date").notNull(),
    payDate: businessDate("pay_date").notNull(),
    /** null = every eligible employee of the legal entity. */
    employeeIds: jsonb("employee_ids").$type<string[] | null>(),
    status: varchar("status", { length: 10 }).notNull().default("scheduled"),
    createdBy: actor("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("thr_schedules_tenant_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "thr_schedules_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    index("thr_schedules_tenant_holiday_idx").on(
      table.tenantId,
      table.holidayDate,
    ),
    check(
      "thr_schedules_status_check",
      sql`${table.status} IN ('scheduled', 'paid', 'cancelled')`,
    ),
    check(
      "thr_schedules_dates_check",
      sql`${table.payDate} <= ${table.holidayDate} AND ${table.tenureAsOfDate} <= ${table.holidayDate}`,
    ),
    check(
      "thr_schedules_employee_ids_check",
      sql`${table.employeeIds} IS NULL OR jsonb_typeof(${table.employeeIds}) = 'array'`,
    ),
  ],
);

// ---- Pay components ------------------------------------------------------

export const payComponents = pgTable(
  "pay_components",
  {
    id: uuid("id").$type<PayComponentId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    category: varchar("category", { length: 30 }).notNull(),
    kind: varchar("kind", { length: 10 }).notNull(),
    recurrence: varchar("recurrence", { length: 10 }).notNull(),
    taxable: boolean("taxable").notNull(),
    taxScheme: varchar("tax_scheme", { length: 10 }).notNull(),
    bpjsBase: boolean("bpjs_base").notNull(),
    overtimeBase: boolean("overtime_base").notNull(),
    thrBase: boolean("thr_base").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    isSystem: boolean("is_system").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("pay_components_tenant_id_key").on(table.tenantId, table.id),
    unique("pay_components_tenant_code_key").on(table.tenantId, table.code),
    check(
      "pay_components_code_check",
      sql`${table.code} ~ '^[A-Z][A-Z0-9_]{1,29}$'`,
    ),
    check(
      "pay_components_category_check",
      sql`${table.category} IN (${inList(PAY_COMPONENT_CATEGORIES)})`,
    ),
    check(
      "pay_components_kind_check",
      sql`${table.kind} = CASE WHEN ${table.category} IN (${inList(DEDUCTION_CATEGORIES)}) THEN 'deduction' ELSE 'earning' END`,
    ),
    check(
      "pay_components_recurrence_check",
      sql`${table.recurrence} IN ('fixed', 'variable')`,
    ),
    check(
      "pay_components_tax_scheme_check",
      sql`${table.taxScheme} IN ('gross', 'gross_up', 'net')`,
    ),
    // Deductions never form a wage base; reimbursement is not income.
    check(
      "pay_components_deduction_flags_check",
      sql`${table.kind} = 'earning' OR NOT (${table.taxable} OR ${table.bpjsBase} OR ${table.overtimeBase} OR ${table.thrBase})`,
    ),
    check(
      "pay_components_reimbursement_taxable_check",
      sql`${table.category} <> 'reimbursement' OR NOT ${table.taxable}`,
    ),
    check(
      "pay_components_display_order_check",
      sql`${table.displayOrder} BETWEEN 0 AND 999`,
    ),
  ],
);

export const employeePayComponents = pgTable(
  "employee_pay_components",
  {
    id: uuid("id").$type<EmployeePayComponentId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    componentId: uuid("component_id").$type<PayComponentId>().notNull(),
    /** HR-03: sealed whole-rupiah amount (lib/payroll-sealed.ts). */
    amountEncrypted: bytea("amount_encrypted").notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    /** Inclusive last day; null = open-ended. The only column a user action updates (the reseal job also moves the sealed amount + key version, 0248). */
    effectiveTo: businessDate("effective_to"),
    createdBy: actor("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("employee_pay_components_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("employee_pay_components_tenant_employee_component_from_key").on(
      table.tenantId,
      table.employeeId,
      table.componentId,
      table.effectiveFrom,
    ),
    // At most one open-ended row per employee and component.
    uniqueIndex("employee_pay_components_open_key")
      .on(table.tenantId, table.employeeId, table.componentId)
      .where(sql`${table.effectiveTo} IS NULL`),
    foreignKey({
      name: "employee_pay_components_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "employee_pay_components_component_fk",
      columns: [table.tenantId, table.componentId],
      foreignColumns: [payComponents.tenantId, payComponents.id],
    }),
    check(
      "employee_pay_components_dates_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check(
      "employee_pay_components_key_version_check",
      sql`${table.piiKeyVersion} >= 1`,
    ),
  ],
);

// ---- Payroll runs, payslips, files (lifecycle: legend-07eg) ---------------

export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid("id").$type<PayrollRunId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    payrollPolicyId: uuid("payroll_policy_id")
      .$type<PayrollPolicyId>()
      .notNull(),
    runType: varchar("run_type", { length: 10 }).notNull(),
    thrScheduleId: uuid("thr_schedule_id").$type<ThrScheduleId>(),
    periodStart: businessDate("period_start").notNull(),
    periodEnd: businessDate("period_end").notNull(),
    payDate: businessDate("pay_date").notNull(),
    status: varchar("status", { length: 12 }).notNull().default("draft"),
    simulationCount: integer("simulation_count").notNull().default(0),
    lastSimulatedAt: timestamp("last_simulated_at", { withTimezone: true }),
    /** Run-level aggregates (no per-employee amount). */
    totals: jsonb("totals").$type<PayrollRunTotals>(),
    /** Statutory versions and policy pinned at simulation (PAYR-02). */
    configSnapshot: jsonb("config_snapshot").$type<PayrollConfigSnapshot>(),
    approvedByHr: actor("approved_by_hr"),
    approvedByHrAt: timestamp("approved_by_hr_at", { withTimezone: true }),
    approvedByFinance: actor("approved_by_finance"),
    approvedByFinanceAt: timestamp("approved_by_finance_at", {
      withTimezone: true,
    }),
    lockedBy: actor("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    paidBy: actor("paid_by"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    reversal: jsonb("reversal").$type<PayrollRunReversal>(),
    createdBy: actor("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("payroll_runs_tenant_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "payroll_runs_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "payroll_runs_policy_fk",
      columns: [table.tenantId, table.payrollPolicyId],
      foreignColumns: [payrollPolicies.tenantId, payrollPolicies.id],
    }),
    foreignKey({
      name: "payroll_runs_thr_schedule_fk",
      columns: [table.tenantId, table.thrScheduleId],
      foreignColumns: [thrSchedules.tenantId, thrSchedules.id],
    }),
    index("payroll_runs_tenant_period_idx").on(
      table.tenantId,
      table.periodStart,
    ),
    // One live regular run per policy and period, and one live run per THR
    // schedule: a period is never paid twice (a reversed run can be redone).
    uniqueIndex("payroll_runs_live_regular_period_key")
      .on(table.tenantId, table.payrollPolicyId, table.periodStart)
      .where(
        sql`${table.runType} = 'regular' AND ${table.status} <> 'reversed'`,
      ),
    uniqueIndex("payroll_runs_live_thr_schedule_key")
      .on(table.tenantId, table.thrScheduleId)
      .where(sql`${table.runType} = 'thr' AND ${table.status} <> 'reversed'`),
    check(
      "payroll_runs_run_type_check",
      sql`${table.runType} IN ('regular', 'thr', 'off_cycle')`,
    ),
    check(
      "payroll_runs_status_check",
      sql`${table.status} IN (${inList(RUN_STATUSES)})`,
    ),
    check(
      "payroll_runs_period_check",
      sql`${table.periodEnd} >= ${table.periodStart}`,
    ),
    check(
      "payroll_runs_thr_schedule_check",
      sql`(${table.runType} = 'thr') = (${table.thrScheduleId} IS NOT NULL)`,
    ),
    check(
      "payroll_runs_simulation_count_check",
      sql`${table.simulationCount} >= 0`,
    ),
    // Maker-checker is enforced by payroll_runs_approvers_guard_trg in
    // payroll.custom.sql (0300/0301/0304): check INSERT and actual identity
    // changes while permitting legacy locked -> paid/reversed transitions.
    // A frozen run went through both approvals and the lock (PAYR-01).
    check(
      "payroll_runs_frozen_check",
      sql`${table.status} NOT IN ('locked', 'paid', 'reversed') OR (${table.configSnapshot} IS NOT NULL AND ${table.totals} IS NOT NULL
        AND ${table.approvedByHr} IS NOT NULL AND ${table.approvedByHrAt} IS NOT NULL
        AND ${table.approvedByFinance} IS NOT NULL AND ${table.approvedByFinanceAt} IS NOT NULL
        AND ${table.lockedBy} IS NOT NULL AND ${table.lockedAt} IS NOT NULL)`,
    ),
    check(
      "payroll_runs_paid_pair_check",
      sql`(${table.status} = 'paid') = (${table.paidAt} IS NOT NULL)
        AND (${table.status} = 'paid') = (${table.paidBy} IS NOT NULL)`,
    ),
    // PAYR-05: a run is reversed only through an approved reversal.
    check(
      "payroll_runs_reversed_check",
      sql`${table.status} <> 'reversed' OR COALESCE(${table.reversal} ->> 'status' = 'approved', false)`,
    ),
  ],
);

export const payslips = pgTable(
  "payslips",
  {
    id: uuid("id").$type<PayslipId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>().notNull(),
    employeeId: uuid("employee_id").notNull(),
    paymentMethod: varchar("payment_method", { length: 15 }).notNull(),
    /** HR-03: sealed PayslipCalculation JSON (lib/payroll-sealed.ts). */
    calculationEncrypted: bytea("calculation_encrypted").notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    /** Storage key of the rendered PDF; null until rendered. */
    pdfObjectKey: varchar("pdf_object_key", { length: 500 }),
    /** The only other column a user action updates (employee opened it with the PIN); the reseal job also moves the sealed calculation + key version (0248). */
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("payslips_tenant_id_key").on(table.tenantId, table.id),
    unique("payslips_tenant_run_employee_key").on(
      table.tenantId,
      table.payrollRunId,
      table.employeeId,
    ),
    index("payslips_tenant_employee_idx").on(table.tenantId, table.employeeId),
    foreignKey({
      name: "payslips_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    foreignKey({
      name: "payslips_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "payslips_payment_method_check",
      sql`${table.paymentMethod} IN ('bank_transfer', 'cash')`,
    ),
    check("payslips_key_version_check", sql`${table.piiKeyVersion} >= 1`),
  ],
);

/**
 * legend-c2yca: the sealed per-employee result of the latest simulation (HR-03
 * key ring, lib/payroll-sealed.ts, table `payroll_run_results`, field
 * `result`). The lock reads these rows, never caller numbers. `payslip_id` is
 * the id the lock inserts (a rapel employee's reserved payslip id). Writable
 * only while the run is draft/simulated (payroll-run-results.custom.sql);
 * afterwards only the reseal job may move the ciphertext + key version.
 */
export const payrollRunResults = pgTable(
  "payroll_run_results",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>().notNull(),
    employeeId: uuid("employee_id").$type<EmployeeId>().notNull(),
    payslipId: uuid("payslip_id").$type<PayslipId>().notNull(),
    simulationNo: integer("simulation_no").notNull(),
    paymentMethod: varchar("payment_method", { length: 20 }).notNull(),
    resultEncrypted: bytea("result_encrypted").notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "payroll_run_results_pkey",
      columns: [table.tenantId, table.payrollRunId, table.employeeId],
    }),
    unique("payroll_run_results_payslip_key").on(
      table.tenantId,
      table.payslipId,
    ),
    foreignKey({
      name: "payroll_run_results_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    foreignKey({
      name: "payroll_run_results_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "payroll_run_results_simulation_no_check",
      sql`${table.simulationNo} >= 1`,
    ),
    check(
      "payroll_run_results_payment_method_check",
      sql`${table.paymentMethod} IN ('bank_transfer', 'cash')`,
    ),
    check(
      "payroll_run_results_key_version_check",
      sql`${table.piiKeyVersion} >= 1`,
    ),
  ],
);

/**
 * legend-xo0xx: the kasbon (loan) installment a payroll run deducts, one row
 * per (run, loan). Written only while the run is draft/simulated, never
 * edited, and deleted only while the run is draft/simulated or when its
 * reversal is approved (the reversal restores each loan by exactly this
 * amount, once). The amount never exceeds the loan's outstanding balance at
 * write time (payroll-loan-deductions.custom.sql).
 */
export const payrollLoanDeductions = pgTable(
  "payroll_loan_deductions",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>().notNull(),
    employeeId: uuid("employee_id").$type<EmployeeId>().notNull(),
    loanId: uuid("loan_id").$type<EmployeeLoanId>().notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "payroll_loan_deductions_pkey",
      columns: [table.tenantId, table.payrollRunId, table.loanId],
    }),
    foreignKey({
      name: "payroll_loan_deductions_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    foreignKey({
      name: "payroll_loan_deductions_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "payroll_loan_deductions_loan_fk",
      columns: [table.tenantId, table.loanId],
      foreignColumns: [employeeLoans.tenantId, employeeLoans.id],
    }),
    check("payroll_loan_deductions_amount_check", sql`${table.amountIdr} > 0`),
  ],
);

/**
 * legend-89cl7: the payee bank details frozen when the run locks, one row per
 * bank_transfer payslip, written in the lock transaction and read by the bank
 * export instead of the employee's current account. Sealed (HR-03 key ring,
 * lib/payroll-sealed.ts, field `bankSnapshot`): JSON of account number, holder
 * and bank name. Only the ciphertext + key version may move, by the reseal job.
 */
export const payslipBankSnapshots = pgTable(
  "payslip_bank_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>().notNull(),
    payslipId: uuid("payslip_id").$type<PayslipId>().notNull(),
    employeeId: uuid("employee_id").notNull(),
    snapshotEncrypted: bytea("snapshot_encrypted").notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    /** BI bank code (3 digits, not secret) copied from the employee at lock;
     * null when the employee has none. Never rewritten (0345). */
    bankCode: text("bank_code"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("payslip_bank_snapshots_tenant_id_key").on(table.tenantId, table.id),
    unique("payslip_bank_snapshots_tenant_payslip_key").on(
      table.tenantId,
      table.payslipId,
    ),
    index("payslip_bank_snapshots_tenant_run_idx").on(
      table.tenantId,
      table.payrollRunId,
    ),
    foreignKey({
      name: "payslip_bank_snapshots_payslip_fk",
      columns: [table.tenantId, table.payslipId],
      foreignColumns: [payslips.tenantId, payslips.id],
    }),
    foreignKey({
      name: "payslip_bank_snapshots_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    foreignKey({
      name: "payslip_bank_snapshots_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "payslip_bank_snapshots_key_version_check",
      sql`${table.piiKeyVersion} >= 1`,
    ),
    check(
      "payslip_bank_snapshots_bank_code_check",
      sql`${table.bankCode} IS NULL OR ${table.bankCode} ~ '^[0-9]{3}$'`,
    ),
  ],
);

/**
 * Month-dependency edges written once at lock (PAYR-05): the later run of a
 * tax month was computed on the earlier locked/paid run. Reversal of the
 * earlier run is refused while a live (locked/paid) dependent exists. Append
 * only (UPDATE/DELETE revoked from the app role).
 */
export const payrollRunMonthPriors = pgTable(
  "payroll_run_month_priors",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** The later run, the one that was locked. */
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>().notNull(),
    /** The earlier locked/paid run it was computed against. */
    priorPayrollRunId: uuid("prior_payroll_run_id")
      .$type<PayrollRunId>()
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "payroll_run_month_priors_pkey",
      columns: [table.tenantId, table.payrollRunId, table.priorPayrollRunId],
    }),
    foreignKey({
      name: "payroll_run_month_priors_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    foreignKey({
      name: "payroll_run_month_priors_prior_fk",
      columns: [table.tenantId, table.priorPayrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    index("payroll_run_month_priors_prior_idx").on(
      table.tenantId,
      table.priorPayrollRunId,
    ),
    check(
      "payroll_run_month_priors_distinct_check",
      sql`${table.payrollRunId} <> ${table.priorPayrollRunId}`,
    ),
  ],
);

export const bankTransferFiles = pgTable(
  "bank_transfer_files",
  {
    id: uuid("id").$type<BankTransferFileId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>().notNull(),
    format: varchar("format", { length: 15 }).notNull(),
    /** Derived from the file rows, never from client input. */
    rowCount: integer("row_count").notNull(),
    totalIdr: idrColumn("total_idr").notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    /** Storage key of the file; the API signs a short-lived URL on read. */
    objectKey: varchar("object_key", { length: 500 }).notNull(),
    createdBy: actor("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("bank_transfer_files_tenant_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "bank_transfer_files_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    check(
      "bank_transfer_files_format_check",
      sql`${table.format} IN (${inList(BANK_FORMATS)})`,
    ),
    check(
      "bank_transfer_files_row_count_check",
      sql`${table.rowCount} BETWEEN 0 AND 100000`,
    ),
    check("bank_transfer_files_total_check", sql`${table.totalIdr} >= 0`),
    check(
      "bank_transfer_files_checksum_check",
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const payrollTaxExports = pgTable(
  "payroll_tax_exports",
  {
    id: uuid("id").$type<PayrollTaxExportId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    /** YYYY-MM for monthly, YYYY for annual. */
    taxPeriod: varchar("tax_period", { length: 7 }).notNull(),
    status: varchar("status", { length: 10 }).notNull().default("pending"),
    /** Storage key when ready; the API signs a short-lived URL on read. */
    objectKey: varchar("object_key", { length: 500 }),
    createdBy: actor("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("payroll_tax_exports_tenant_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "payroll_tax_exports_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    check(
      "payroll_tax_exports_kind_check",
      sql`${table.kind} IN ('monthly_withholding', 'annual_statement')`,
    ),
    check(
      "payroll_tax_exports_period_check",
      sql`(${table.kind} = 'monthly_withholding' AND ${table.taxPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
        OR (${table.kind} = 'annual_statement' AND ${table.taxPeriod} ~ '^[0-9]{4}$')`,
    ),
    check(
      "payroll_tax_exports_status_check",
      sql`${table.status} IN ('pending', 'ready', 'failed')`,
    ),
    check(
      "payroll_tax_exports_ready_check",
      sql`(${table.status} = 'ready') = (${table.objectKey} IS NOT NULL)`,
    ),
  ],
);

// ---- Service charge (PRD §3 D.30 "Distribusi Service Charge") -------------

export const serviceChargePools = pgTable(
  "service_charge_pools",
  {
    id: uuid("id").$type<ServiceChargePoolId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    periodStart: businessDate("period_start").notNull(),
    periodEnd: businessDate("period_end").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    rule: jsonb("rule").$type<ServiceChargeRule>().notNull(),
    status: varchar("status", { length: 12 }).notNull().default("draft"),
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>(),
    approvedBy: actor("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: actor("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("service_charge_pools_tenant_id_key").on(table.tenantId, table.id),
    // One live pool per outlet and period (a cancelled one can be redone).
    uniqueIndex("service_charge_pools_live_period_key")
      .on(table.tenantId, table.outletId, table.periodStart, table.periodEnd)
      .where(sql`${table.status} <> 'cancelled'`),
    foreignKey({
      name: "service_charge_pools_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "service_charge_pools_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    check(
      "service_charge_pools_status_check",
      sql`${table.status} IN ('draft', 'calculated', 'approved', 'distributed', 'cancelled')`,
    ),
    check(
      "service_charge_pools_period_check",
      sql`${table.periodEnd} >= ${table.periodStart}`,
    ),
    check("service_charge_pools_amount_check", sql`${table.amountIdr} >= 0`),
    check(
      "service_charge_pools_approved_pair_check",
      sql`(${table.status} IN ('approved', 'distributed')) = (${table.approvedBy} IS NOT NULL)
        AND (${table.status} IN ('approved', 'distributed')) = (${table.approvedAt} IS NOT NULL)`,
    ),
    check(
      "service_charge_pools_distributed_run_check",
      sql`(${table.status} = 'distributed') = (${table.payrollRunId} IS NOT NULL)`,
    ),
  ],
);

export const serviceChargeAllocations = pgTable(
  "service_charge_allocations",
  {
    id: uuid("id")
      .$type<ServiceChargeAllocationId>()
      .defaultRandom()
      .primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    poolId: uuid("pool_id").$type<ServiceChargePoolId>().notNull(),
    employeeId: uuid("employee_id").notNull(),
    points: decimal4Column("points").notNull(),
    attendanceDays: integer("attendance_days").notNull(),
    weight: bigint("weight", { mode: "number" }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("service_charge_allocations_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("service_charge_allocations_tenant_pool_employee_key").on(
      table.tenantId,
      table.poolId,
      table.employeeId,
    ),
    foreignKey({
      name: "service_charge_allocations_pool_fk",
      columns: [table.tenantId, table.poolId],
      foreignColumns: [serviceChargePools.tenantId, serviceChargePools.id],
    }),
    foreignKey({
      name: "service_charge_allocations_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check("service_charge_allocations_points_check", sql`${table.points} >= 0`),
    check(
      "service_charge_allocations_attendance_check",
      sql`${table.attendanceDays} BETWEEN 0 AND 31`,
    ),
    check("service_charge_allocations_weight_check", sql`${table.weight} >= 0`),
    check(
      "service_charge_allocations_amount_check",
      sql`${table.amountIdr} >= 0`,
    ),
  ],
);

// ---- Kasbon (PRD §3 D.31) -------------------------------------------------

export const employeeLoans = pgTable(
  "employee_loans",
  {
    id: uuid("id").$type<EmployeeLoanId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    principalIdr: idrColumn("principal_idr").notNull(),
    installmentIdr: idrColumn("installment_idr").notNull(),
    installmentCount: integer("installment_count").notNull(),
    outstandingIdr: idrColumn("outstanding_idr").notNull(),
    firstDeductionPeriod: businessDate("first_deduction_period").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: varchar("status", { length: 10 }).notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: actor("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    disbursedAt: timestamp("disbursed_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("employee_loans_tenant_id_key").on(table.tenantId, table.id),
    index("employee_loans_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
    ),
    foreignKey({
      name: "employee_loans_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "employee_loans_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled')`,
    ),
    check(
      "employee_loans_amounts_check",
      sql`${table.principalIdr} > 0 AND ${table.installmentIdr} > 0
        AND ${table.installmentIdr} <= ${table.principalIdr}
        AND ${table.outstandingIdr} >= 0
        AND ${table.outstandingIdr} <= ${table.principalIdr}
        AND ${table.installmentIdr} * ${table.installmentCount} >= ${table.principalIdr}`,
    ),
    check(
      "employee_loans_installment_count_check",
      sql`${table.installmentCount} BETWEEN 1 AND 36`,
    ),
    check(
      "employee_loans_decided_pair_check",
      sql`(${table.status} <> 'pending') = (${table.decidedBy} IS NOT NULL)
        AND (${table.status} <> 'pending') = (${table.decidedAt} IS NOT NULL)`,
    ),
    check(
      "employee_loans_disbursed_check",
      sql`(${table.status} IN ('disbursed', 'settled')) = (${table.disbursedAt} IS NOT NULL)
        AND (${table.status} IN ('disbursed', 'settled') OR ${table.outstandingIdr} = ${table.principalIdr})`,
    ),
    check(
      "employee_loans_settled_check",
      sql`(${table.status} = 'settled') = (${table.settledAt} IS NOT NULL)
        AND (${table.status} <> 'settled' OR ${table.outstandingIdr} = 0)`,
    ),
  ],
);

/**
 * Kasbon limits, one row per tenant (contract `loanPolicySchema`; bead
 * legend-fij0l). No row = no kasbon: the service fails closed.
 */
export const payrollLoanPolicies = pgTable(
  "payroll_loan_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Absolute ceiling per loan; null = only the salary multiple applies. */
    maxPrincipalIdr: idrColumn("max_principal_idr"),
    /** Ceiling as basis points of the monthly base salary; null = none. */
    maxPrincipalOfBaseSalaryBp: integer("max_principal_of_base_salary_bp"),
    /** Ceiling on one employee's total open kasbon (unpaid principal). */
    maxTotalOpenIdr: idrColumn("max_total_open_idr").notNull(),
    maxInstallments: integer("max_installments").notNull(),
    maxDeductionOfNetPayBp: integer("max_deduction_of_net_pay_bp").notNull(),
    singleOpenLoan: boolean("single_open_loan").notNull().default(true),
    updatedBy: actor("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One policy per tenant.
    unique("payroll_loan_policies_tenant_key").on(table.tenantId),
    check(
      "payroll_loan_policies_ceiling_check",
      sql`${table.maxPrincipalIdr} IS NOT NULL OR ${table.maxPrincipalOfBaseSalaryBp} IS NOT NULL`,
    ),
    check(
      "payroll_loan_policies_values_check",
      sql`(${table.maxPrincipalIdr} IS NULL OR ${table.maxPrincipalIdr} > 0)
        AND (${table.maxPrincipalOfBaseSalaryBp} IS NULL OR ${table.maxPrincipalOfBaseSalaryBp} BETWEEN 1 AND 120000)
        AND ${table.maxTotalOpenIdr} > 0
        AND (${table.maxPrincipalIdr} IS NULL OR ${table.maxTotalOpenIdr} >= ${table.maxPrincipalIdr})
        AND ${table.maxInstallments} BETWEEN 1 AND 36
        AND ${table.maxDeductionOfNetPayBp} BETWEEN 0 AND 10000`,
    ),
  ],
);

// ---- Reimbursement (PRD §3 D.31) ------------------------------------------

export const reimbursementCategories = pgTable(
  "reimbursement_categories",
  {
    id: uuid("id")
      .$type<ReimbursementCategoryId>()
      .defaultRandom()
      .primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    receiptRequired: boolean("receipt_required").notNull(),
    limits: jsonb("limits").$type<ReimbursementLimit[]>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("reimbursement_categories_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("reimbursement_categories_tenant_name_key").on(
      table.tenantId,
      table.name,
    ),
    check(
      "reimbursement_categories_limits_check",
      sql`jsonb_typeof(${table.limits}) = 'array' AND jsonb_array_length(${table.limits}) >= 1`,
    ),
  ],
);

export const reimbursements = pgTable(
  "reimbursements",
  {
    id: uuid("id").$type<ReimbursementId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    categoryId: uuid("category_id").$type<ReimbursementCategoryId>().notNull(),
    expenseDate: businessDate("expense_date").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    approvedAmountIdr: idrColumn("approved_amount_idr"),
    description: varchar("description", { length: 500 }).notNull(),
    /** Upload reference of the receipt; the API signs a URL on read. */
    receiptUploadRef: varchar("receipt_upload_ref", { length: 200 }),
    payout: varchar("payout", { length: 10 }).notNull(),
    status: varchar("status", { length: 10 }).notNull().default("submitted"),
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: actor("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("reimbursements_tenant_id_key").on(table.tenantId, table.id),
    index("reimbursements_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
    ),
    index("reimbursements_tenant_status_idx").on(table.tenantId, table.status),
    // A receipt upload backs one claim only (legend-8399r; the service also
    // locks per ref, this is the backstop). Case-insensitive like the service.
    uniqueIndex("reimbursements_receipt_upload_ref_key")
      .on(table.tenantId, sql`lower(${table.receiptUploadRef})`)
      .where(sql`${table.receiptUploadRef} IS NOT NULL`),
    foreignKey({
      name: "reimbursements_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "reimbursements_category_fk",
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [
        reimbursementCategories.tenantId,
        reimbursementCategories.id,
      ],
    }),
    foreignKey({
      name: "reimbursements_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    check(
      "reimbursements_status_check",
      sql`${table.status} IN ('submitted', 'approved', 'rejected', 'cancelled', 'paid')`,
    ),
    check(
      "reimbursements_payout_check",
      sql`${table.payout} IN ('payroll', 'cash')`,
    ),
    check(
      "reimbursements_amount_check",
      sql`${table.amountIdr} > 0 AND (${table.approvedAmountIdr} IS NULL OR (${table.approvedAmountIdr} > 0 AND ${table.approvedAmountIdr} <= ${table.amountIdr}))`,
    ),
    check(
      "reimbursements_decided_pair_check",
      sql`(${table.status} <> 'submitted') = (${table.decidedBy} IS NOT NULL)
        AND (${table.status} <> 'submitted') = (${table.decidedAt} IS NOT NULL)`,
    ),
    check(
      "reimbursements_approved_amount_check",
      sql`(${table.status} IN ('approved', 'paid')) = (${table.approvedAmountIdr} IS NOT NULL)`,
    ),
    check(
      "reimbursements_paid_check",
      sql`(${table.status} = 'paid') = (${table.paidAt} IS NOT NULL)`,
    ),
    check(
      "reimbursements_run_check",
      sql`(${table.payout} = 'payroll' OR ${table.payrollRunId} IS NULL)
        AND (${table.status} <> 'paid' OR ${table.payout} = 'cash' OR ${table.payrollRunId} IS NOT NULL)`,
    ),
  ],
);
