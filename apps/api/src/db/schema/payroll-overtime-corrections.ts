// Overtime correction ledger (bead legend-72nod; brief
// docs/briefs/983-hr-sisa.md "Rancangan Kartu C").
//
// Overtime of a frozen (locked or paid) period is paid from the requests
// approved when that run locked. A request approved, or cancelled, later
// leaves a difference. A later run settles the difference on its own payslip
// (an earning `LEMBUR_KOREKSI` when positive, a deduction
// `LEMBUR_KOREKSI_POTONGAN` when negative) and records here how much of which
// source run it settled, so the same hours are never paid, or taken back,
// twice. Outstanding of (employee, source run) = difference now - signed sum
// of the settled rows.
//
// One row per (target run, employee, source run), written by the target run's
// lock step only (the same transaction that locks the run), never edited
// except `settled -> reversed` when the target run's approved reversal gives
// the amount back (payroll-overtime-corrections.custom.sql). The app role has
// no DELETE. Tenant RLS (ENABLE + FORCE) and the guard trigger are installed
// in the same migration.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { EmployeeId } from "@starter/shared/hris";
import type { PayrollRunId } from "@starter/shared/hris/payroll";
import { idrColumn, tenantIdColumn } from "../columns.ts";
import { employees } from "./hris.ts";
import { payrollRuns } from "./payroll.ts";
import { tenants } from "./platform-org.ts";

export const OVERTIME_CORRECTION_DIRECTIONS = ["positive", "negative"] as const;
export type OvertimeCorrectionDirection =
  (typeof OVERTIME_CORRECTION_DIRECTIONS)[number];

export const OVERTIME_CORRECTION_STATUSES = ["settled", "reversed"] as const;
export type OvertimeCorrectionStatus =
  (typeof OVERTIME_CORRECTION_STATUSES)[number];

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

export const payrollOvertimeCorrections = pgTable(
  "payroll_overtime_corrections",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** The run whose payslip carries the correction line. */
    targetRunId: uuid("target_run_id").$type<PayrollRunId>().notNull(),
    employeeId: uuid("employee_id").$type<EmployeeId>().notNull(),
    /** The frozen run whose overtime this corrects. */
    sourceRunId: uuid("source_run_id").$type<PayrollRunId>().notNull(),
    direction: varchar("direction", { length: 8 })
      .$type<OvertimeCorrectionDirection>()
      .notNull(),
    /** Whole rupiah, always positive; `direction` gives the sign. */
    amountIdr: idrColumn("amount_idr").notNull(),
    status: varchar("status", { length: 10 })
      .$type<OvertimeCorrectionStatus>()
      .notNull()
      .default("settled"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: "payroll_overtime_corrections_pkey",
      columns: [
        table.tenantId,
        table.targetRunId,
        table.employeeId,
        table.sourceRunId,
      ],
    }),
    foreignKey({
      name: "payroll_overtime_corrections_target_fk",
      columns: [table.tenantId, table.targetRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    foreignKey({
      name: "payroll_overtime_corrections_source_fk",
      columns: [table.tenantId, table.sourceRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    foreignKey({
      name: "payroll_overtime_corrections_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    index("payroll_overtime_corrections_source_idx").on(
      table.tenantId,
      table.employeeId,
      table.sourceRunId,
    ),
    check(
      "payroll_overtime_corrections_amount_check",
      sql`${table.amountIdr} > 0`,
    ),
    check(
      "payroll_overtime_corrections_direction_check",
      sql`${table.direction} IN (${inList(OVERTIME_CORRECTION_DIRECTIONS)})`,
    ),
    check(
      "payroll_overtime_corrections_status_check",
      sql`${table.status} IN (${inList(OVERTIME_CORRECTION_STATUSES)})`,
    ),
    check(
      "payroll_overtime_corrections_runs_check",
      sql`${table.sourceRunId} <> ${table.targetRunId}`,
    ),
    check(
      "payroll_overtime_corrections_reversed_check",
      sql`(${table.status} = 'reversed') = (${table.reversedAt} IS NOT NULL)`,
    ),
  ],
);
