// PTKP status history (bead 1223, SO 1221 A P2-1; PMK 168/2023).
//
// The PTKP of a tax year is the employee's status on 1 January of that year,
// or on the join date when he starts during the year. A change in the middle of
// the year (marriage, a child) applies from the next tax year. Payroll
// simulate and the A1 read the status from here, never `employees.ptkp_status`
// directly (services/payroll-ptkp-tax-year.ts).
//
// Written by the trigger on `employees` only (hris-ptkp-history.custom.sql):
// an INSERT records the status from the join date, a change of status records
// it from the Jakarta date of the change (never before the join date). Two
// changes on one day keep the last. Tenant RLS, no DELETE or TRUNCATE for the
// app role.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { EmployeeId, PtkpStatus } from "@starter/shared/hris";
import { businessDate, tenantIdColumn } from "../columns.ts";
import { employees } from "./hris.ts";
import { tenants } from "./platform-org.ts";

export const employeePtkpHistory = pgTable(
  "employee_ptkp_history",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").$type<EmployeeId>().notNull(),
    /** First day the status is in force. */
    effectiveFrom: businessDate("effective_from").notNull(),
    ptkpStatus: varchar("ptkp_status", { length: 10 })
      .$type<PtkpStatus>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "employee_ptkp_history_pkey",
      columns: [table.tenantId, table.employeeId, table.effectiveFrom],
    }),
    foreignKey({
      name: "employee_ptkp_history_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }).onDelete("cascade"),
    check(
      "employee_ptkp_history_status_check",
      sql`${table.ptkpStatus} IN ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3', 'K/I/0', 'K/I/1', 'K/I/2', 'K/I/3')`,
    ),
  ],
);
