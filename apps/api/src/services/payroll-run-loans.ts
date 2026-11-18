// Kasbon (loan) deductions of a payroll run (bead legend-8tfvr; design
// docs/briefs/955-loan-design.md). Trusted in-transaction helpers: the caller
// owns the tenant transaction and the lock order below.
//
// The simulate step PLANS the installments and writes one
// `payroll_loan_deductions` row per loan (a reservation: `employee_loans`
// stays as it is, PAYR-01). The lock step LOWERS each loan's outstanding
// balance by exactly its row, once, in the transaction of the guarded
// `approved -> locked` UPDATE. An approved reversal restores the balance
// (`payroll-run-reversal.service.ts`). Migration 0443 proves at commit that
// principal - outstanding = the rows of locked or paid runs.
//
// LOCK ORDER (design §2): never lock a `payroll_runs` row after an
// `employee_loans` row; loans lock in `id` order. Both callers take the loans
// only after the run row and the tax-year priors (run FOR SHARE) are held.
// ONE DEDUCTION PER LOAN PER MONTH (CTO rule): per loan and calendar month of
// `period_end`, a loan that already has a `payroll_loan_deductions` row in
// ANOTHER regular run (draft, simulated, hr_approved, approved, locked or
// paid; never reversed, never thr) is not deducted again. Simulation drops
// such a loan from the plan (the run is not rejected); lock treats a clash as
// 409 resultStale. Month = `date_trunc('month', period_end)` of both runs.
// COMPLETED OFFBOARDING: an employee whose offboarding is completed is not
// deducted (the frozen settlement snapshot owns the balance; see below).
// Money rules: a row is never above min(installment, outstanding - what other
// live runs reserve, room); `planLoanDeductions` owns the room. Anything that
// does not match at lock is 409 PAYROLL_RUN_RESULT_STALE, never a guess.

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  idr,
  isoDateTimeSchema,
  type Idr,
  type TenantId,
} from "@starter/shared/core";
import type { EmployeeId } from "@starter/shared/hris";
import {
  PayrollError,
  type EmployeeLoanId,
  type PayrollRunId,
  type PayslipCalculation,
} from "@starter/shared/hris/payroll";
import { hrisOffboardings } from "../db/schema/hris-lifecycle.ts";
import {
  employeeLoans,
  payrollLoanDeductions,
  payrollRuns,
} from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import type { PlannableLoan } from "./payroll-run-compose.ts";
import type { Tx } from "./permission-resolver.ts";

/** Runs whose rows still reserve part of a loan's outstanding balance. */
export const RESERVING_STATUSES = [
  "draft",
  "simulated",
  "hr_approved",
  "approved",
] as const;

/** Run statuses whose loan rows count as "this month's deduction is taken". */
const MONTH_BLOCKING_STATUSES = [
  ...RESERVING_STATUSES,
  "locked",
  "paid",
] as const;

/**
 * Loan ids (of `loanIds`) that already have a row in another regular run
 * whose period end falls in the same calendar month as `periodEnd`.
 */
async function loanIdsDeductedInMonth(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
  periodEnd: string,
  loanIds: readonly EmployeeLoanId[],
): Promise<Set<string>> {
  if (loanIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ loanId: payrollLoanDeductions.loanId })
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
        inArray(payrollLoanDeductions.loanId, [...loanIds]),
        sql`${payrollLoanDeductions.payrollRunId} <> ${runId}`,
        eq(payrollRuns.runType, "regular"),
        inArray(payrollRuns.status, [...MONTH_BLOCKING_STATUSES]),
        sql`date_trunc('month', ${payrollRuns.periodEnd}::date) = date_trunc('month', ${periodEnd}::date)`,
      ),
    );
  return new Set(rows.map((row) => row.loanId));
}

const resultStale = () =>
  new HttpError(
    409,
    "PAYROLL_RUN_RESULT_STALE",
    "Hasil perhitungan payroll tidak sama dengan yang disetujui. Simulasikan ulang sebelum mengunci.",
  );

/** One row of `payroll_loan_deductions` (employee, loan, amount). */
export type RunLoanDeduction = {
  employeeId: EmployeeId;
  loanId: EmployeeLoanId;
  amountIdr: Idr;
};

/**
 * Locks the loans the run may deduct from (FOR UPDATE, id order) and answers
 * them per employee. A loan qualifies when it is disbursed, has a balance and
 * its first deduction period is on or before the run's period end. Its
 * `outstandingIdr` is lowered by what OTHER live runs already reserve, so two
 * runs never plan more than the loan owes; a loan with nothing left is
 * dropped, and so is a loan another regular run of the same calendar month
 * already deducts (one deduction per loan per month; see header). Call after
 * `loadTaxYearPriors` (design §2).
 */
export async function lockLoansForRunSimulation(
  tx: Tx,
  tenantId: TenantId,
  input: {
    runId: PayrollRunId;
    employeeIds: readonly string[];
    periodEnd: string;
  },
): Promise<Map<string, PlannableLoan[]>> {
  const byEmployee = new Map<string, PlannableLoan[]>();
  if (input.employeeIds.length === 0) return byEmployee;
  const loans = await tx
    .select({
      id: employeeLoans.id,
      employeeId: employeeLoans.employeeId,
      installmentIdr: employeeLoans.installmentIdr,
      outstandingIdr: employeeLoans.outstandingIdr,
      disbursedAt: employeeLoans.disbursedAt,
    })
    .from(employeeLoans)
    .where(
      and(
        eq(employeeLoans.tenantId, tenantId),
        inArray(employeeLoans.employeeId, [...input.employeeIds]),
        eq(employeeLoans.status, "disbursed"),
        sql`${employeeLoans.outstandingIdr} > 0`,
        lte(employeeLoans.firstDeductionPeriod, input.periodEnd),
      ),
    )
    .orderBy(asc(employeeLoans.id))
    .for("update");
  if (loans.length === 0) return byEmployee;

  // A completed offboarding froze the final-settlement snapshot with the loan
  // balance at that moment; a later deduction would lower the real balance
  // below the snapshot and HR would collect the same money twice. Such an
  // employee is not deducted: the snapshot stays the only source (the rule
  // that limits payment). Read after the loans are locked, so a completion
  // that ran first is seen (completion locks the same loans, id order).
  const completedOffboarding = new Set(
    (
      await tx
        .select({ employeeId: hrisOffboardings.employeeId })
        .from(hrisOffboardings)
        .where(
          and(
            eq(hrisOffboardings.tenantId, tenantId),
            inArray(hrisOffboardings.employeeId, [
              ...new Set(loans.map((loan) => loan.employeeId)),
            ]),
            eq(hrisOffboardings.status, "completed"),
          ),
        )
    ).map((row) => row.employeeId),
  );

  const takenThisMonth = await loanIdsDeductedInMonth(
    tx,
    tenantId,
    input.runId,
    input.periodEnd,
    loans.map((loan) => loan.id),
  );

  const reservedRows = await tx
    .select({
      loanId: payrollLoanDeductions.loanId,
      reserved: sql<string>`SUM(${payrollLoanDeductions.amountIdr})`,
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
        inArray(
          payrollLoanDeductions.loanId,
          loans.map((loan) => loan.id),
        ),
        sql`${payrollLoanDeductions.payrollRunId} <> ${input.runId}`,
        inArray(payrollRuns.status, [...RESERVING_STATUSES]),
      ),
    )
    .groupBy(payrollLoanDeductions.loanId);
  const reserved = new Map(
    reservedRows.map((row) => [row.loanId, Number(row.reserved)]),
  );

  for (const loan of loans) {
    const free = Number(loan.outstandingIdr) - (reserved.get(loan.id) ?? 0);
    if (free <= 0 || loan.disbursedAt === null) continue;
    if (takenThisMonth.has(loan.id)) continue;
    if (completedOffboarding.has(loan.employeeId)) continue;
    const list = byEmployee.get(loan.employeeId) ?? [];
    list.push({
      id: loan.id,
      employeeId: loan.employeeId as EmployeeId,
      status: "disbursed",
      installmentIdr: loan.installmentIdr,
      outstandingIdr: idr(free),
      disbursedAt: isoDateTimeSchema.parse(loan.disbursedAt.toISOString()),
    });
    byEmployee.set(loan.employeeId, list);
  }
  return byEmployee;
}

/**
 * Replaces the run's reservation: deletes its rows, then inserts the new
 * ones. Call after the run UPDATE (status `simulated`), when the 0460 guard
 * accepts both and checks each amount under the loan lock.
 */
export async function replaceRunLoanDeductions(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
  rows: readonly RunLoanDeduction[],
): Promise<void> {
  await tx
    .delete(payrollLoanDeductions)
    .where(
      and(
        eq(payrollLoanDeductions.tenantId, tenantId),
        eq(payrollLoanDeductions.payrollRunId, runId),
      ),
    );
  if (rows.length === 0) return;
  await tx.insert(payrollLoanDeductions).values(
    [...rows]
      .sort((a, b) => (a.loanId < b.loanId ? -1 : 1))
      .map((row) => ({
        tenantId,
        payrollRunId: runId,
        employeeId: row.employeeId,
        loanId: row.loanId,
        amountIdr: row.amountIdr,
      })),
  );
}

/** The loan lines of a calculation as rows; null when a line is malformed. */
function loanLinesOf(
  employeeId: EmployeeId,
  calculation: PayslipCalculation,
): RunLoanDeduction[] | null {
  const rows: RunLoanDeduction[] = [];
  for (const line of calculation.lines) {
    if (line.category !== "loan_installment") continue;
    if (
      line.componentCode !== "LOAN" ||
      line.kind !== "deduction" ||
      line.sourceId === null
    )
      return null;
    rows.push({
      employeeId,
      loanId: line.sourceId as EmployeeLoanId,
      amountIdr: line.amountIdr,
    });
  }
  return rows;
}

const keyOf = (row: RunLoanDeduction) =>
  `${row.employeeId}|${row.loanId}|${row.amountIdr}`;

/**
 * Lock-time proof of the run's loan deductions (design §3 step 3, items a-d).
 * Every check is 409 PAYROLL_RUN_RESULT_STALE and precedes the first write:
 * the stored LOAN lines equal the recorded rows exactly, each slip's loans
 * stay within the policy share of its pay before loans, and every loan is
 * still the employee's, disbursed, and owes at least its amount. Locks the
 * loans FOR UPDATE in id order and answers the rows sorted by loan id for
 * `applyLockLoanDeductions`. Call after `lockedAt` is computed and before the
 * status UPDATE.
 */
export async function lockLoansForRunLock(
  tx: Tx,
  tenantId: TenantId,
  run: { id: PayrollRunId },
  plan: readonly { employeeId: EmployeeId; calculation: PayslipCalculation }[],
  loanMaxDeductionOfNetPayBp: number,
): Promise<RunLoanDeduction[]> {
  // a. Every loan line is well formed; one line per loan in the whole run.
  const lines: RunLoanDeduction[] = [];
  for (const entry of plan) {
    const entryLines = loanLinesOf(entry.employeeId, entry.calculation);
    if (entryLines === null) throw resultStale();
    // c. Loans of a slip take at most the policy share of its pay before them.
    const loanTotal = entryLines.reduce((sum, row) => sum + row.amountIdr, 0);
    const room =
      ((BigInt(entry.calculation.netIdr) + BigInt(loanTotal)) *
        BigInt(loanMaxDeductionOfNetPayBp)) /
      10_000n;
    if (BigInt(loanTotal) > room) throw resultStale();
    lines.push(...entryLines);
  }
  if (new Set(lines.map((row) => row.loanId)).size !== lines.length)
    throw resultStale();

  // b. The recorded rows are the lines, as a set of (employee, loan, amount).
  const stored = await tx
    .select({
      employeeId: payrollLoanDeductions.employeeId,
      loanId: payrollLoanDeductions.loanId,
      amountIdr: payrollLoanDeductions.amountIdr,
    })
    .from(payrollLoanDeductions)
    .where(
      and(
        eq(payrollLoanDeductions.tenantId, tenantId),
        eq(payrollLoanDeductions.payrollRunId, run.id),
      ),
    )
    .orderBy(asc(payrollLoanDeductions.loanId));
  const rows: RunLoanDeduction[] = stored.map((row) => ({
    employeeId: row.employeeId,
    loanId: row.loanId,
    amountIdr: idr(Number(row.amountIdr)),
  }));
  const lineKeys = lines.map(keyOf).sort();
  const rowKeys = rows.map(keyOf).sort();
  if (
    lineKeys.length !== rowKeys.length ||
    lineKeys.some((key, i) => key !== rowKeys[i])
  )
    throw resultStale();
  if (rows.length === 0) return [];

  // d. Lock the loans (id order) and re-check each against its row.
  const loanIds = rows.map((row) => row.loanId);
  const loans = await tx
    .select({
      id: employeeLoans.id,
      employeeId: employeeLoans.employeeId,
      status: employeeLoans.status,
      installmentIdr: employeeLoans.installmentIdr,
      outstandingIdr: employeeLoans.outstandingIdr,
    })
    .from(employeeLoans)
    .where(
      and(
        eq(employeeLoans.tenantId, tenantId),
        inArray(employeeLoans.id, loanIds),
      ),
    )
    .orderBy(asc(employeeLoans.id))
    .for("update");
  const loanById = new Map(loans.map((loan) => [loan.id, loan]));
  // One deduction per loan per calendar month: a clash with another regular
  // run of the run's period-end month means the plan is stale.
  const [runRow] = await tx
    .select({ periodEnd: payrollRuns.periodEnd })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, run.id)))
    .limit(1);
  if (runRow === undefined) throw resultStale();
  const takenThisMonth = await loanIdsDeductedInMonth(
    tx,
    tenantId,
    run.id,
    runRow.periodEnd,
    loanIds,
  );
  for (const row of rows) {
    if (takenThisMonth.has(row.loanId)) throw resultStale();
    const loan = loanById.get(row.loanId);
    if (
      loan === undefined ||
      loan.employeeId !== row.employeeId ||
      loan.status !== "disbursed" ||
      row.amountIdr > loan.outstandingIdr ||
      row.amountIdr > loan.installmentIdr
    )
      throw resultStale();
  }
  return rows;
}

/**
 * Lowers each loan by its row, once, in loan id order. The UPDATE only
 * matches a disbursed loan that still owes the amount, and settles it when
 * the balance reaches zero. One row each, else
 * PAYROLL_RUN_INVALID_TRANSITION. Call right after the guarded
 * `approved -> locked` UPDATE (the rows are frozen by then).
 */
export async function applyLockLoanDeductions(
  tx: Tx,
  tenantId: TenantId,
  rows: readonly RunLoanDeduction[],
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  for (const row of [...rows].sort((a, b) => (a.loanId < b.loanId ? -1 : 1))) {
    const amount = String(row.amountIdr);
    const updated = await tx
      .update(employeeLoans)
      .set({
        outstandingIdr: sql`${employeeLoans.outstandingIdr} - ${amount}::bigint`,
        status: sql`CASE WHEN ${employeeLoans.outstandingIdr} = ${amount}::bigint THEN 'settled' ELSE 'disbursed' END`,
        settledAt: sql`CASE WHEN ${employeeLoans.outstandingIdr} = ${amount}::bigint THEN ${nowIso}::timestamptz ELSE NULL END`,
        updatedAt: now,
      })
      .where(
        and(
          eq(employeeLoans.tenantId, tenantId),
          eq(employeeLoans.id, row.loanId),
          eq(employeeLoans.status, "disbursed"),
          sql`${employeeLoans.outstandingIdr} >= ${amount}::bigint`,
        ),
      )
      .returning({ id: employeeLoans.id });
    if (updated.length !== 1)
      throw new PayrollError("PAYROLL_RUN_INVALID_TRANSITION");
  }
}
