// Salary corrections remain outside immutable employee salary history. The
// approved prospective target is an overlay of one exact history row, so a
// later normal salary row supersedes it without rewriting a frozen period.
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { businessDate, tenantIdColumn } from "../columns.ts";
import { employees } from "./hris.ts";
import {
  employeePayComponents,
  payComponents,
  payrollRuns,
} from "./payroll.ts";
import { legalEntities, tenants } from "./platform-org.ts";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const payrollRapels = pgTable(
  "payroll_rapels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    componentId: uuid("component_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    anchorHistoryRowId: uuid("anchor_history_row_id").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    prospectiveFrom: businessDate("prospective_from").notNull(),
    eligibilityJoinDate: businessDate("eligibility_join_date").notNull(),
    eligibilityEndDate: businessDate("eligibility_end_date"),
    newAmountEncrypted: bytea("new_amount_encrypted").notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    requestedBy: text("requested_by").notNull(),
    approvedByHr: text("approved_by_hr"),
    approvedByHrAt: timestamp("approved_by_hr_at", { withTimezone: true }),
    approvedByFinance: text("approved_by_finance"),
    approvedByFinanceAt: timestamp("approved_by_finance_at", {
      withTimezone: true,
    }),
    payrollRunId: uuid("payroll_run_id"),
    reservedPayslipId: uuid("reserved_payslip_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("payroll_rapels_tenant_id_key").on(table.tenantId, table.id),
    index("payroll_rapels_employee_idx").on(table.tenantId, table.employeeId),
    index("payroll_rapels_run_employee_idx").on(
      table.tenantId,
      table.payrollRunId,
      table.employeeId,
    ),
    uniqueIndex("payroll_rapels_pending_component_key")
      .on(table.tenantId, table.employeeId, table.componentId)
      .where(sql`${table.status} IN ('pending', 'hr_approved')`),
    foreignKey({
      name: "payroll_rapels_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "payroll_rapels_component_fk",
      columns: [table.tenantId, table.componentId],
      foreignColumns: [payComponents.tenantId, payComponents.id],
    }),
    foreignKey({
      name: "payroll_rapels_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "payroll_rapels_anchor_fk",
      columns: [table.tenantId, table.anchorHistoryRowId],
      foreignColumns: [
        employeePayComponents.tenantId,
        employeePayComponents.id,
      ],
    }),
    foreignKey({
      name: "payroll_rapels_target_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    check(
      "payroll_rapels_status_check",
      sql`${table.status} IN ('pending', 'hr_approved', 'approved', 'allocated', 'cancelled')`,
    ),
    check(
      "payroll_rapels_dates_check",
      sql`${table.prospectiveFrom} > ${table.effectiveFrom}`,
    ),
    check("payroll_rapels_key_version_check", sql`${table.piiKeyVersion} >= 1`),
    check(
      "payroll_rapels_approvers_check",
      sql`
      (${table.approvedByHr} IS NULL OR ${table.approvedByHr} <> ${table.requestedBy})
      AND (${table.approvedByFinance} IS NULL OR (${table.approvedByFinance} <> ${table.requestedBy} AND ${table.approvedByFinance} <> ${table.approvedByHr}))
      AND (${table.approvedByHr} IS NULL) = (${table.approvedByHrAt} IS NULL)
      AND (${table.approvedByFinance} IS NULL) = (${table.approvedByFinanceAt} IS NULL)
      AND (${table.status} NOT IN ('hr_approved', 'approved', 'allocated') OR ${table.approvedByHr} IS NOT NULL)
      AND (${table.status} NOT IN ('approved', 'allocated') OR ${table.approvedByFinance} IS NOT NULL)
      AND (${table.status} = 'allocated') = (${table.payrollRunId} IS NOT NULL)
      AND (${table.payrollRunId} IS NULL) = (${table.reservedPayslipId} IS NULL)
    `,
    ),
  ],
);

export const payrollRapelItems = pgTable(
  "payroll_rapel_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    rapelId: uuid("rapel_id").notNull(),
    sourceRunId: uuid("source_run_id").notNull(),
    amountEncrypted: bytea("amount_encrypted").notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("payroll_rapel_items_tenant_id_key").on(table.tenantId, table.id),
    unique("payroll_rapel_items_source_key").on(
      table.tenantId,
      table.rapelId,
      table.sourceRunId,
    ),
    index("payroll_rapel_items_source_idx").on(
      table.tenantId,
      table.sourceRunId,
    ),
    foreignKey({
      name: "payroll_rapel_items_header_fk",
      columns: [table.tenantId, table.rapelId],
      foreignColumns: [payrollRapels.tenantId, payrollRapels.id],
    }),
    foreignKey({
      name: "payroll_rapel_items_source_fk",
      columns: [table.tenantId, table.sourceRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    check(
      "payroll_rapel_items_key_version_check",
      sql`${table.piiKeyVersion} >= 1`,
    ),
  ],
);

/** Insert proof only: ciphertext may later be rekeyed by the existing worker. */
export const payrollRapelFinalizations = pgTable(
  "payroll_rapel_finalizations",
  {
    payslipId: uuid("payslip_id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    payrollRunId: uuid("payroll_run_id").notNull(),
    allocationRevision: integer("allocation_revision").notNull(),
    calculationSha256: varchar("calculation_sha256", { length: 64 }).notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    transactionId: text("transaction_id")
      .notNull()
      .default(sql`txid_current()::text`),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("payroll_rapel_finalizations_tenant_id_key").on(
      table.tenantId,
      table.payslipId,
    ),
    unique("payroll_rapel_finalizations_run_employee_key").on(
      table.tenantId,
      table.payrollRunId,
      table.employeeId,
    ),
    foreignKey({
      name: "payroll_rapel_finalizations_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "payroll_rapel_finalizations_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    check(
      "payroll_rapel_finalizations_revision_check",
      sql`${table.allocationRevision} >= 0`,
    ),
    check(
      "payroll_rapel_finalizations_key_version_check",
      sql`${table.piiKeyVersion} >= 1`,
    ),
    check(
      "payroll_rapel_finalizations_hash_check",
      sql`${table.calculationSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
