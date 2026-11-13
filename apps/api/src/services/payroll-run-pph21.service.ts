// PPh 21 step of a payroll run (beads legend-iwgb, legend-oo3q, legend-y4wp;
// PRD v1.7 §3 D.30 "PPh 21", PAYR-02, PAYR-03). The payroll run tables do not
// exist yet (legend-gfcr, legend-07eg), so this service takes the run facts it
// needs (status, pay date, config snapshot) as arguments and answers the tax of
// every payslip; the run service that follows stores the results and the
// policy ref.
//
// The policy comes from the tenant's versions: before lock the version in
// force on the pay date, from lock on exactly the one the snapshot pinned
// (`pph21PolicyForRun`, shared). The statutory tables are resolved by the
// caller (`statutoryVersionsForRun`) and passed in. Each payslip goes through
// `computePayslipTax`, the same step the mock payslip builder uses.
//
// An employee's year-to-date history is passed as the earlier payslips
// (`priorPeriods`), never as raw sums: `buildPph21Prior` fills every field the
// last period needs from the stored taxes, the gross-up tax allowance and the
// scheme mix included (bead legend-s5c1). Pass only the payslips of the
// current period of service: after the latest annual recalculation of the
// year (a rehire in the same year starts a new one), with `monthsWorked` of
// that period. The run service locks through `lockPayrollRunTax` inside its
// lock transaction, which pins the policy ref from the same computation.
//
// TER on the month's total (bead legend-ihjan): when several runs of one legal
// entity pay an employee in the same tax month (pay date month: a regular run,
// then THR or off-cycle), the later run looks the TER rate up on the month's
// total X, earlier locked/paid payslips included, and owes the tax of that
// total minus what those payslips already owe, floored at 0 (the engine,
// pph21.ts `monthPrior`; December keeps the annual rule). `monthScope` (the run
// id) and the caller's transaction are required: the legal entity and pay date
// come from the stored run (the caller's pay date must agree, else 409
// PAYROLL_PPH21_RUN_MISMATCH), then computing, simulating and locking take one
// transaction-scoped advisory lock per tenant + legal entity + tax month, so
// two runs never compute against the same earlier total. Each payslip answers
// the `monthBasis` it was computed against; the simulation stores it and the
// lock (`lockPayrollRunTax`, `approvedMonthBasis`) refuses with 409
// PAYROLL_PPH21_MONTH_STALE when an earlier run was locked, reversed or
// changed since: re-simulate. Approved runs have no payslips yet, so they
// count only once locked (the stale check covers the gap).

import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type {
  BusinessDate,
  ScopedTenantContext,
  TenantId,
} from "@starter/shared/core";
import {
  PayrollError,
  buildPph21Prior,
  computePayslipTax,
  isSamePph21PolicyRef,
  payslipCalculationSchema,
  pph21PolicyForRun,
  type PayrollConfigSnapshot,
  type PayrollRunId,
  type PayrollRunStatus,
  type PayslipTax,
  type PayslipTaxInput,
  type Pph21PolicyParameters,
  type Pph21PolicyRef,
  type Pph21PriorPeriod,
  type Pph21Tables,
} from "@starter/shared/hris/payroll";
import { payrollRuns, payslips } from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { loadPph21PolicyVersionsForRun } from "./payroll-pph21-policy.service.ts";
import type { Tx } from "./permission-resolver.ts";

export type PayrollRunTaxRun = {
  status: PayrollRunStatus;
  payDate: BusinessDate;
  configSnapshot: Pick<PayrollConfigSnapshot, "pph21Policy"> | null;
};

export type PayrollRunTaxEmployee = Omit<
  PayslipTaxInput,
  "tables" | "policy" | "prior" | "monthPrior"
> & {
  employeeId: string;
  /**
   * Earlier payslips of the current period of service in this tax year
   * (after the latest annual recalculation; none: []).
   */
  priorPeriods: readonly Pph21PriorPeriod[];
};

/**
 * The run whose tax month is totalled across runs (see the header). Only the
 * id: the legal entity and pay date are read from the stored run, never taken
 * from the caller.
 */
export type PayrollRunMonthScope = {
  runId: PayrollRunId;
};

export type PayrollRunTaxInput = {
  run: PayrollRunTaxRun;
  tables: Pph21Tables;
  employees: readonly PayrollRunTaxEmployee[];
  /** TER months are totalled over the earlier locked/paid runs of the legal entity. */
  monthScope: PayrollRunMonthScope;
};

/** What an employee's tax was computed against: the earlier payslips of the month. */
export type PayrollMonthBasis = {
  priorGrossIdr: number;
  priorTaxIdr: number;
  /**
   * Employee-funded part of `priorTaxIdr`: withheld minus the tax allowance
   * plus the receivable of each earlier payslip (review R1: the rate step-up
   * on the earlier gross follows this share).
   */
  priorEmployeeTaxIdr: number;
};

export type PayrollRunTax = {
  /** What the snapshot holds (or would hold at lock): null = default policy. */
  pph21Policy: Pph21PolicyRef | null;
  parameters: Pph21PolicyParameters;
  payslips: {
    employeeId: string;
    tax: PayslipTax;
    /** Absent: no month total applies (the employee is in the last tax period). */
    monthBasis?: PayrollMonthBasis;
  }[];
};

const MONTH_LOCK_NAMESPACE = "payroll-pph21-month";
/** Runs whose payslips exist and count toward the month's tax. */
const MONTH_PRIOR_STATUSES = ["locked", "paid"] as const;

const monthPriorInvalid = () =>
  new HttpError(
    422,
    "PAYROLL_PPH21_MONTH_PRIOR_INVALID",
    "Slip gaji run lain pada bulan pajak ini tidak bisa dibaca atau bukan PPh 21 TER, total bulanan tidak bisa dihitung.",
  );

/** First day of the month after `YYYY-MM`. */
function nextMonthStart(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return number === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(number + 1).padStart(2, "0")}-01`;
}

/**
 * The serialization lock of computing, simulating and locking runs of one
 * legal entity in one tax month: `pg_advisory_xact_lock` on
 * `payroll-pph21-month:<tenant>:<legal entity>:<YYYY-MM>`, held to the end of
 * the caller's transaction.
 */
async function lockPayrollTaxMonth(
  tx: Tx,
  tenantId: string,
  legalEntityId: string,
  month: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${MONTH_LOCK_NAMESPACE}:${tenantId}:${legalEntityId}:${month}`}, 0))`,
  );
}

/**
 * Per employee: gross X, PPh 21 and its employee-funded part (withheld -
 * tax allowance + receivable) of the payslips of the other locked/paid runs
 * of the legal entity whose pay date falls in the month. Every employee asked
 * for has an entry (0 / 0 / 0 when none). An unreadable payslip, one that is
 * not TER, or one whose employee-funded tax is below 0 or above its PPh 21,
 * refuses the whole computation (fail closed).
 */
async function loadMonthBasis(
  tx: Tx,
  tenantId: TenantId,
  run: { runId: PayrollRunId; legalEntityId: string },
  month: string,
  employeeIds: readonly string[],
): Promise<Map<string, PayrollMonthBasis>> {
  const basis = new Map<string, PayrollMonthBasis>(
    employeeIds.map((id) => [
      id,
      { priorGrossIdr: 0, priorTaxIdr: 0, priorEmployeeTaxIdr: 0 },
    ]),
  );
  if (employeeIds.length === 0) return basis;
  const rows = await tx
    .select({
      id: payslips.id,
      tenantId: payslips.tenantId,
      employeeId: payslips.employeeId,
      calculationEncrypted: payslips.calculationEncrypted,
      piiKeyVersion: payslips.piiKeyVersion,
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
        eq(payrollRuns.legalEntityId, run.legalEntityId),
        ne(payrollRuns.id, run.runId),
        inArray(payrollRuns.status, [...MONTH_PRIOR_STATUSES]),
        gte(payrollRuns.payDate, `${month}-01`),
        lt(payrollRuns.payDate, nextMonthStart(month)),
        inArray(payslips.employeeId, [...employeeIds]),
      ),
    );
  for (const row of rows) {
    let calc;
    try {
      calc = payslipCalculationSchema.parse(
        JSON.parse(
          openPayrollValue(
            row.calculationEncrypted,
            {
              tenantId: row.tenantId,
              table: "payslips",
              rowId: row.id,
              field: "calculation",
            },
            row.piiKeyVersion,
          ),
        ),
      );
    } catch {
      // Never echo the decrypt or parse error: it may carry payroll values.
      throw monthPriorInvalid();
    }
    const entry = basis.get(row.employeeId);
    const employeeTax =
      calc.tax.pph21WithheldIdr -
      calc.tax.taxAllowanceIdr +
      (calc.tax.pph21ReceivableIdr ?? 0);
    if (
      !entry ||
      calc.employeeId !== row.employeeId ||
      calc.tax.method !== "ter" ||
      calc.tax.taxableGrossIdr < 0 ||
      calc.tax.pph21Idr < 0 ||
      employeeTax < 0 ||
      employeeTax > calc.tax.pph21Idr
    )
      throw monthPriorInvalid();
    entry.priorGrossIdr += calc.tax.taxableGrossIdr;
    entry.priorTaxIdr += calc.tax.pph21Idr;
    entry.priorEmployeeTaxIdr += employeeTax;
  }
  return basis;
}

/** Legal entity and pay date of the stored run (404 when it is not the tenant's). */
async function loadStoredRun(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<{ legalEntityId: string; payDate: string }> {
  const [row] = await tx
    .select({
      legalEntityId: payrollRuns.legalEntityId,
      payDate: payrollRuns.payDate,
    })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .limit(1);
  if (!row)
    throw new HttpError(
      404,
      "PAYROLL_RUN_NOT_FOUND",
      "Payroll tidak ditemukan.",
    );
  return row;
}

/**
 * Takes the month lock and reads the month basis of every employee that is
 * not in the last tax period (annual rule unchanged: no basis). The legal
 * entity and pay date come from the stored run; the caller's pay date must
 * match. The run is read again under the lock, so a pay date edited while
 * waiting for the lock is refused instead of locking the wrong month.
 */
async function monthBasisForInput(
  context: ScopedTenantContext,
  input: PayrollRunTaxInput,
  tx: Tx,
): Promise<Map<string, PayrollMonthBasis>> {
  const { runId } = input.monthScope;
  const { tenantId } = context.tenant;
  const mismatch = () =>
    new HttpError(
      409,
      "PAYROLL_PPH21_RUN_MISMATCH",
      "Tanggal bayar atau badan hukum payroll tidak sesuai dengan data payroll yang tersimpan.",
    );
  const first = await loadStoredRun(tx, tenantId, runId);
  if (first.payDate !== input.run.payDate) throw mismatch();
  const month = first.payDate.slice(0, 7);
  await lockPayrollTaxMonth(tx, tenantId, first.legalEntityId, month);
  const stored = await loadStoredRun(tx, tenantId, runId);
  if (
    stored.payDate !== first.payDate ||
    stored.legalEntityId !== first.legalEntityId
  )
    throw mismatch();
  return loadMonthBasis(
    tx,
    tenantId,
    { runId, legalEntityId: stored.legalEntityId },
    month,
    input.employees.filter((e) => !e.lastTaxPeriod).map((e) => e.employeeId),
  );
}

function taxOfPayslips(
  input: PayrollRunTaxInput,
  parameters: Pph21PolicyParameters,
  ref: Pph21PolicyRef | null,
  monthBasis: ReadonlyMap<string, PayrollMonthBasis>,
): PayrollRunTax {
  return {
    pph21Policy: ref,
    parameters,
    payslips: input.employees.map(
      ({ employeeId, priorPeriods, ...employee }) => {
        const basis = monthBasis.get(employeeId) ?? null;
        return {
          employeeId,
          ...(basis === null ? {} : { monthBasis: basis }),
          tax: computePayslipTax({
            ...employee,
            ...(basis === null
              ? {}
              : {
                  monthPrior: {
                    taxableGrossIdr: basis.priorGrossIdr,
                    pph21Idr: basis.priorTaxIdr,
                    pph21EmployeeIdr: basis.priorEmployeeTaxIdr,
                  },
                }),
            prior: buildPph21Prior(priorPeriods),
            tables: input.tables,
            policy: parameters,
          }).tax,
        };
      },
    ),
  };
}

/**
 * PPh 21 of every payslip of a run. A locked (or later) run is computed with
 * the policy version its snapshot pinned, however many versions were
 * published since; a changed or missing pinned version is
 * PAYROLL_SNAPSHOT_MISMATCH. `tx` is the caller's transaction: it holds the
 * month lock until it ends.
 */
export async function calculatePayrollRunTax(
  context: ScopedTenantContext,
  input: PayrollRunTaxInput,
  tx: Tx,
): Promise<PayrollRunTax> {
  const versions = await loadPph21PolicyVersionsForRun(context, tx);
  const { parameters, ref } = pph21PolicyForRun(input.run, versions);
  const monthBasis = await monthBasisForInput(context, input, tx);
  return taxOfPayslips(input, parameters, ref, monthBasis);
}

/**
 * The lock step: PPh 21 of every payslip AND the ref to store in
 * `configSnapshot.pph21Policy`, from ONE read of the policy versions inside
 * the lock transaction `tx`. `approved` is the ref the run showed when it was
 * approved (null = default policy); when the version in force now differs in
 * id, number, effective date or parameters (a newer version was published
 * between approval and lock) the lock is refused with
 * PAYROLL_SNAPSHOT_MISMATCH, so the pinned policy always is the one the
 * stored payslips were computed with.
 *
 * The month lock is taken first and the month basis is read again inside the
 * lock transaction; any employee whose basis differs from `approvedMonthBasis`
 * (what the simulation stored, per employee) or is missing there is 409
 * PAYROLL_PPH21_MONTH_STALE: an earlier run of the month changed since the
 * simulation, so re-simulate before locking.
 */
export async function lockPayrollRunTax(
  context: ScopedTenantContext,
  input: PayrollRunTaxInput,
  approved: Pph21PolicyRef | null,
  tx: Tx,
  approvedMonthBasis: ReadonlyMap<string, PayrollMonthBasis>,
): Promise<PayrollRunTax> {
  const versions = await loadPph21PolicyVersionsForRun(context, tx);
  const { parameters, ref } = pph21PolicyForRun(input.run, versions);
  if (!isSamePph21PolicyRef(ref, approved))
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  const monthBasis = await monthBasisForInput(context, input, tx);
  const stale = [...monthBasis].some(([employeeId, fresh]) => {
    const was = approvedMonthBasis.get(employeeId);
    return (
      was === undefined ||
      was.priorGrossIdr !== fresh.priorGrossIdr ||
      was.priorTaxIdr !== fresh.priorTaxIdr ||
      was.priorEmployeeTaxIdr !== fresh.priorEmployeeTaxIdr
    );
  });
  if (stale)
    throw new HttpError(
      409,
      "PAYROLL_PPH21_MONTH_STALE",
      "Payroll lain pada bulan pajak ini berubah sejak simulasi. Simulasikan ulang sebelum mengunci.",
    );
  return taxOfPayslips(input, parameters, ref, monthBasis);
}

/**
 * The ref to store in `configSnapshot.pph21Policy` when the run locks: the
 * version in force on the pay date, null when the tenant has none (default
 * policy). Prefer `lockPayrollRunTax`, which pins from the same computation
 * as the payslips. With `options.tx` the read joins the lock transaction;
 * with `options.approved` (the ref the run was approved with, null = default)
 * a different version in force is PAYROLL_SNAPSHOT_MISMATCH.
 */
export async function capturePph21PolicyForLock(
  context: ScopedTenantContext,
  payDate: BusinessDate,
  options: { tx?: Tx; approved?: Pph21PolicyRef | null } = {},
): Promise<Pph21PolicyRef | null> {
  const versions = await loadPph21PolicyVersionsForRun(context, options.tx);
  const { ref } = pph21PolicyForRun(
    { status: "approved", payDate, configSnapshot: null },
    versions,
  );
  if (
    options.approved !== undefined &&
    !isSamePph21PolicyRef(ref, options.approved)
  )
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  return ref;
}
