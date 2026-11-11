// Shared payroll lock guard (legend-0c5yg). Attendance corrections and leave
// both change what an employee is paid for a date, so both refuse to touch a
// date inside a closed payroll run.
import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { employees } from "../db/schema/hris.ts";
import { payrollRuns } from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./hris-access.ts";

const DEFAULT_LOCKED_MESSAGE =
  "Periode payroll sudah dikunci; perubahan tidak bisa dilakukan.";

/** Inclusive calendar-day range (YYYY-MM-DD). */
interface DateRange {
  readonly start: string;
  readonly end: string;
}

/**
 * 409 when a closed payroll run (locked, paid or reversed) covers any of the
 * dates. The run has no outlet; with a legal entity on the employee only that
 * entity's runs count, otherwise every run of the tenant does (fail closed).
 */
export async function assertPayrollOpen(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  dates: readonly string[],
  message: string = DEFAULT_LOCKED_MESSAGE,
): Promise<void> {
  if (!(await isPayrollClosed(tx, tenantId, employeeId, dates))) return;
  throw new HttpError(409, "PAYROLL_PERIOD_LOCKED", message);
}

/**
 * Same guard for a whole range (start..end inclusive): refused when any day of
 * it lies in a closed run, so a leave that only partly overlaps is refused as
 * a whole (doubt limits payout).
 */
export async function assertPayrollOpenInRange(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  start: string,
  end: string,
  message: string = DEFAULT_LOCKED_MESSAGE,
): Promise<void> {
  if (!(await isPayrollClosedInRange(tx, tenantId, employeeId, start, end)))
    return;
  throw new HttpError(409, "PAYROLL_PERIOD_LOCKED", message);
}

/** Non-throwing form of assertPayrollOpenInRange (start..end inclusive). */
export function isPayrollClosedInRange(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  start: string,
  end: string,
): Promise<boolean> {
  return closedRunExists(tx, tenantId, employeeId, [{ start, end }]);
}

export async function isPayrollClosed(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  dates: readonly string[],
): Promise<boolean> {
  return closedRunExists(
    tx,
    tenantId,
    employeeId,
    dates.map((date) => ({ start: date, end: date })),
  );
}

async function closedRunExists(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  ranges: readonly DateRange[],
): Promise<boolean> {
  const [employee] = await tx
    .select({ legalEntityId: employees.legalEntityId })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
    .limit(1);
  const filters: SQL[] = [
    eq(payrollRuns.tenantId, tenantId),
    or(
      inArray(payrollRuns.status, ["locked", "paid", "reversed"]),
      isNotNull(payrollRuns.lockedAt),
    )!,
    or(
      ...ranges.map(
        ({ start, end }) =>
          sql`(${payrollRuns.periodStart} <= ${end}::date AND ${payrollRuns.periodEnd} >= ${start}::date)`,
      ),
    )!,
  ];
  if (employee?.legalEntityId)
    filters.push(eq(payrollRuns.legalEntityId, employee.legalEntityId));
  const [closed] = await tx
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(and(...filters))
    .limit(1);
  return closed !== undefined;
}
