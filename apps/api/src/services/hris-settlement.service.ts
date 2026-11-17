// Final settlement summary of an offboarding (PRD v1.7 F24 "perhitungan hak
// akhir"; bead legend-ovxw; docs/DECISIONS.md "WS-10 lifecycle" §4).
//
// A summary of data that is already recorded, never a calculation and never a
// payment: the last payroll run that paid the employee and the unpaid days
// after it, outstanding kasbon, approved reimbursements not paid yet, and
// leave balances in days. Prorated salary, THR, BPJS, leave cash-out and the
// net payout wait for the payroll engine (legend-j2l2) and are listed in
// `pendingPayrollEngine` instead of being estimated here. Completing the
// offboarding freezes the summary in `hris_offboardings.settlement_snapshot`.

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  decimal4,
  formatDecimal4,
  idr,
  parseDecimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  employeeIdSchema,
  finalSettlementSummarySchema,
  outstandingLoans,
  unpaidReimbursements,
  type FinalSettlementSummary,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { leaveBalances, leaveTypes } from "../db/schema/hris-leave.ts";
import { hrisOffboardings } from "../db/schema/hris-lifecycle.ts";
import {
  employeeLoans,
  payrollLoanDeductions,
  payrollRuns,
  payslips,
  reimbursements,
} from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { loadHrisAccess, type Tx } from "./hris-access.ts";
import { RESERVING_STATUSES } from "./payroll-run-loans.ts";

type OffboardingRow = typeof hrisOffboardings.$inferSelect;
type EmployeeRow = typeof employees.$inferSelect;

/** Everything the payroll engine (legend-j2l2) still has to compute. */
const PENDING_PAYROLL_ENGINE = [
  "prorated_salary",
  "thr",
  "bpjs",
  "leave_cash_out",
  "net_payout",
] as const;

/** Runs whose payslips were really paid out (or are locked for payment). */
const PAID_RUN_STATUSES = ["locked", "paid"] as const;

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function inclusiveDays(from: string, to: string): number {
  if (from > to) return 0;
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        DAY_MS,
    ) + 1
  );
}

/** Builds the summary from the live rows, inside the caller's transaction. */
export async function computeFinalSettlementInTx(
  tx: Tx,
  context: ScopedTenantContext,
  offboarding: OffboardingRow,
  employee: EmployeeRow,
  now: Date,
): Promise<FinalSettlementSummary> {
  const tenantId = context.tenant.tenantId;
  const lastWorkingDate = offboarding.lastWorkingDate;

  const [lastRun] = await tx
    .select({
      id: payrollRuns.id,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
      status: payrollRuns.status,
    })
    .from(payslips)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payslips.tenantId),
        eq(payrollRuns.id, payslips.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payslips.tenantId, tenantId),
        eq(payslips.employeeId, employee.id),
        eq(payrollRuns.runType, "regular"),
        inArray(payrollRuns.status, [...PAID_RUN_STATUSES]),
      ),
    )
    .orderBy(desc(payrollRuns.periodEnd), desc(payrollRuns.id))
    .limit(1);
  const unpaidFrom = lastRun
    ? addDays(lastRun.periodEnd, 1)
    : employee.joinDate;
  const unpaidCalendarDays = inclusiveDays(unpaidFrom, lastWorkingDate);

  // Installments reserved by a run that is not locked yet (same statuses as
  // payroll-run-loans.ts): not owed twice, so subtracted from the balance.
  // Loans and reservations are read in ONE statement so both see the same
  // snapshot.
  const reservedDeductions = tx
    .select({
      loanId: payrollLoanDeductions.loanId,
      reserved: sql<string>`SUM(${payrollLoanDeductions.amountIdr})`.as(
        "reserved",
      ),
    })
    .from(payrollLoanDeductions)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payrollLoanDeductions.tenantId),
        eq(payrollRuns.id, payrollLoanDeductions.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payrollLoanDeductions.tenantId, tenantId),
        eq(
          payrollLoanDeductions.employeeId,
          employeeIdSchema.parse(employee.id),
        ),
        inArray(payrollRuns.status, [...RESERVING_STATUSES]),
      ),
    )
    .groupBy(payrollLoanDeductions.loanId)
    .as("reserved_deductions");
  const loans = await tx
    .select({
      id: employeeLoans.id,
      status: employeeLoans.status,
      outstandingIdr: employeeLoans.outstandingIdr,
      reserved: sql<string>`COALESCE(${reservedDeductions.reserved}, 0)`,
    })
    .from(employeeLoans)
    .leftJoin(
      reservedDeductions,
      eq(reservedDeductions.loanId, employeeLoans.id),
    )
    .where(
      and(
        eq(employeeLoans.tenantId, tenantId),
        eq(employeeLoans.employeeId, employee.id),
      ),
    )
    .orderBy(asc(employeeLoans.id));
  const loansAfterPending = loans.map(({ reserved, ...loan }) => ({
    ...loan,
    outstandingIdr: idr(
      Math.max(0, Number(loan.outstandingIdr) - Number(reserved)),
    ),
  }));
  // Only a disbursed loan can still be deducted, and never above what is left
  // of it: min(reserved installment, outstanding) per loan.
  const pendingLoans = loans
    .filter((loan) => loan.status === "disbursed")
    .map((loan) => ({
      id: loan.id,
      amountIdr: Math.min(Number(loan.reserved), Number(loan.outstandingIdr)),
    }))
    .filter((loan) => loan.amountIdr > 0);
  const claims = await tx
    .select({
      status: reimbursements.status,
      amountIdr: reimbursements.amountIdr,
      approvedAmountIdr: reimbursements.approvedAmountIdr,
    })
    .from(reimbursements)
    .where(
      and(
        eq(reimbursements.tenantId, tenantId),
        eq(reimbursements.employeeId, employee.id),
        ne(reimbursements.status, "paid"),
      ),
    );

  const exitYear = Number(lastWorkingDate.slice(0, 4));
  const balances = await tx
    .select({
      leaveTypeId: leaveBalances.leaveTypeId,
      name: leaveTypes.name,
      periodYear: leaveBalances.periodYear,
      entitledDays: leaveBalances.entitledDays,
      carriedOverDays: leaveBalances.carriedOverDays,
      usedDays: leaveBalances.usedDays,
      pendingDays: leaveBalances.pendingDays,
    })
    .from(leaveBalances)
    .innerJoin(
      leaveTypes,
      and(
        eq(leaveTypes.tenantId, leaveBalances.tenantId),
        eq(leaveTypes.id, leaveBalances.leaveTypeId),
      ),
    )
    .where(
      and(
        eq(leaveBalances.tenantId, tenantId),
        eq(leaveBalances.employeeId, employee.id),
        eq(leaveBalances.periodYear, exitYear),
      ),
    )
    .orderBy(asc(leaveTypes.name), asc(leaveBalances.leaveTypeId));

  return finalSettlementSummarySchema.parse({
    offboardingId: offboarding.id,
    employeeId: employee.id,
    exitType: offboarding.exitType,
    joinDate: employee.joinDate,
    lastWorkingDate,
    runningSalary: {
      lastPayrollRun: lastRun ?? null,
      unpaidFrom: unpaidCalendarDays > 0 ? unpaidFrom : null,
      unpaidTo: lastWorkingDate,
      unpaidCalendarDays,
    },
    outstandingLoans: outstandingLoans(
      loansAfterPending as Parameters<typeof outstandingLoans>[0],
    ),
    pendingPayrollDeductions: {
      count: pendingLoans.length,
      amountIdr: pendingLoans.reduce((sum, loan) => sum + loan.amountIdr, 0),
      loanIds: pendingLoans.map((loan) => loan.id),
    },
    unpaidReimbursements: unpaidReimbursements(
      claims as Parameters<typeof unpaidReimbursements>[0],
    ),
    leave: balances.map((row) => {
      const remaining =
        parseDecimal4(decimal4(row.entitledDays)) +
        parseDecimal4(decimal4(row.carriedOverDays)) -
        parseDecimal4(decimal4(row.usedDays)) -
        parseDecimal4(decimal4(row.pendingDays));
      return {
        leaveTypeId: row.leaveTypeId,
        name: row.name,
        periodYear: row.periodYear,
        entitledDays: decimal4(row.entitledDays),
        carriedOverDays: decimal4(row.carriedOverDays),
        usedDays: decimal4(row.usedDays),
        pendingDays: decimal4(row.pendingDays),
        remainingDays: formatDecimal4(remaining > 0n ? remaining : 0n),
      };
    }),
    pendingPayrollEngine: [...PENDING_PAYROLL_ENGINE],
    computedAt: now.toISOString(),
    frozen: false,
  });
}

/**
 * GET /api/hris/offboardings/:offboardingId/settlement. HR manager or payroll
 * viewer of the employee's home outlet; anyone else gets 404. A completed
 * offboarding answers its frozen snapshot.
 */
export async function getFinalSettlement(
  context: ScopedTenantContext,
  actorUserId: string,
  offboardingId: string,
  now = new Date(),
): Promise<FinalSettlementSummary> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const [found] = await tx
      .select({ offboarding: hrisOffboardings, employee: employees })
      .from(hrisOffboardings)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, hrisOffboardings.tenantId),
          eq(employees.id, hrisOffboardings.employeeId),
        ),
      )
      .where(
        and(
          eq(hrisOffboardings.tenantId, context.tenant.tenantId),
          eq(hrisOffboardings.id, offboardingId),
        ),
      )
      .limit(1);
    const viewer = found ? access.viewerFor(found.employee) : null;
    if (
      !found ||
      found.offboarding.status === "cancelled" ||
      viewer === null ||
      (viewer.kind !== "hr" && viewer.kind !== "payroll")
    )
      throw new HttpError(404, "NOT_FOUND", "Offboarding tidak ditemukan.");
    if (
      found.offboarding.status === "completed" &&
      found.offboarding.settlementSnapshot
    )
      return finalSettlementSummarySchema.parse({
        ...found.offboarding.settlementSnapshot,
        frozen: true,
      });
    return computeFinalSettlementInTx(
      tx,
      context,
      found.offboarding,
      found.employee,
      now,
    );
  });
}
