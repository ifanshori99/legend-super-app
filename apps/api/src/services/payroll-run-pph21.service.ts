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
// (`priorPeriods`, plus `lastPeriodEarlier` for the annual payslips of an
// earlier run in the same last tax period), never as raw sums:
// `buildPph21PriorWithLastPeriod` fills every field the
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
  buildPph21PriorWithLastPeriod,
  computePayslipTax,
  isSamePph21PolicyRef,
  payslipCalculationSchema,
  planPph21ReceivableCollection,
  pph21PolicyForRun,
  pph21ReceivableBalance,
  type PayrollConfigSnapshot,
  type PayrollRunId,
  type PayrollRunStatus,
  type PayslipCalculation,
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
  /**
   * Earlier annual-recalculation payslips of the SAME last tax period (a
   * second run in December; none: []). Folded into the prior so the year's
   * tax is the annual tax of all income (`buildPph21PriorWithLastPeriod`).
   */
  lastPeriodEarlier: readonly Pph21PriorPeriod[];
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

const runMismatch = () =>
  new HttpError(
    409,
    "PAYROLL_PPH21_RUN_MISMATCH",
    "Tanggal bayar atau badan hukum payroll tidak sesuai dengan data payroll yang tersimpan.",
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

/** What `loadTaxYearPriors` finds for one employee. */
export type TaxYearPriors = {
  /** TER payslips of the current period of service, for `priorPeriods`. */
  periods: Pph21PriorPeriod[];
  /** Annual payslips of the run's own tax month, for `lastPeriodEarlier`. */
  lastPeriodEarlier: Pph21PriorPeriod[];
  /**
   * An annual payslip of an EARLIER month of the year exists (the employee's
   * last tax period already passed). Never skipped silently: the caller
   * leaves the employee out of the run or refuses (legend-1220).
   */
  annualEarlier: boolean;
  /** Every payslip read (sorted): lets the lock detect a changed set. */
  payslipIds: string[];
  /** The runs those payslips belong to (sorted, unique). */
  runIds: PayrollRunId[];
};

/**
 * The earlier payslips of the tax year per employee: those of the same legal
 * entity, in locked/paid runs paid from 1 January to the end of the run's pay
 * month, from the month the employee joined on (the current period of
 * service). The legal entity and pay date are read from the stored run, never
 * taken from the caller. TER payslips go to `periods`, annual-recalculation
 * payslips of the run's own month to `lastPeriodEarlier`. An annual payslip of
 * an earlier month is 422 PAYROLL_PPH21_MONTH_PRIOR_INVALID for an employee in
 * the last tax period (and flagged `annualEarlier` for the others); one that cannot be read
 * is the same 422 (fail closed). A locked/paid run of a LATER month of the tax
 * year that holds an annual-recalculation payslip of any of the employees is
 * 409 PAYROLL_PPH21_LATER_PERIOD_LOCKED: its annual tax already counts income
 * this run would add before it. The caller holds the month lock; the prior and
 * later runs are locked `FOR SHARE` (ordered by id) so none is reversed while
 * the result is used.
 */
export async function loadTaxYearPriors(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
  employees: readonly {
    employeeId: string;
    joinDate: BusinessDate;
    lastTaxPeriod: boolean;
  }[],
): Promise<Map<string, TaxYearPriors>> {
  const priors = new Map<string, TaxYearPriors>(
    employees.map((e) => [
      e.employeeId,
      {
        periods: [],
        lastPeriodEarlier: [],
        annualEarlier: false,
        payslipIds: [],
        runIds: [],
      },
    ]),
  );
  if (employees.length === 0) return priors;
  const run = await loadStoredRun(tx, tenantId, runId);
  const month = run.payDate.slice(0, 7);
  const year = run.payDate.slice(0, 4);
  const employeeIds = employees.map((e) => e.employeeId);
  const runFilter = (from: string, until: string) =>
    and(
      eq(payrollRuns.tenantId, tenantId),
      eq(payrollRuns.legalEntityId, run.legalEntityId),
      ne(payrollRuns.id, runId),
      inArray(payrollRuns.status, [...MONTH_PRIOR_STATUSES]),
      gte(payrollRuns.payDate, from),
      lt(payrollRuns.payDate, until),
    );
  const earlierFilter = runFilter(`${year}-01-01`, nextMonthStart(month));
  const laterFilter = runFilter(
    nextMonthStart(month),
    `${Number(year) + 1}-01-01`,
  );
  await tx
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.legalEntityId, run.legalEntityId),
        ne(payrollRuns.id, runId),
        inArray(payrollRuns.status, [...MONTH_PRIOR_STATUSES]),
        gte(payrollRuns.payDate, `${year}-01-01`),
        lt(payrollRuns.payDate, `${Number(year) + 1}-01-01`),
      ),
    )
    .orderBy(payrollRuns.id)
    .for("share");
  const readSlips = (filter: ReturnType<typeof runFilter>) =>
    tx
      .select({
        id: payslips.id,
        tenantId: payslips.tenantId,
        employeeId: payslips.employeeId,
        runId: payslips.payrollRunId,
        runPayDate: payrollRuns.payDate,
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
          filter,
          eq(payslips.tenantId, tenantId),
          inArray(payslips.employeeId, employeeIds),
        ),
      )
      .orderBy(payslips.id);
  const readCalculation = (row: {
    id: string;
    tenantId: string;
    employeeId: string;
    calculationEncrypted: Buffer;
    piiKeyVersion: number;
  }) => {
    try {
      const calc = payslipCalculationSchema.parse(
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
      if (calc.employeeId !== row.employeeId) throw monthPriorInvalid();
      return calc;
    } catch {
      // Never echo the decrypt or parse error: it may carry payroll values.
      throw monthPriorInvalid();
    }
  };
  const lastPeriod = new Map(
    employees.map((e) => [e.employeeId, e.lastTaxPeriod]),
  );
  // Out of order: a later month of the year already holds an annual slip, or
  // any slip of an employee whose last tax period this is (its income would
  // be missing from the annual tax; legend-1220).
  for (const row of await readSlips(laterFilter)) {
    if (lastPeriod.get(row.employeeId) === true)
      throw new HttpError(
        409,
        "PAYROLL_PPH21_LATER_PERIOD_LOCKED",
        `Karyawan ${row.employeeId} punya THR bulan berikutnya yang sudah dikunci. Lakukan reversal THR itu dulu sebelum run masa pajak terakhir ini dikunci.`,
      );
    if (readCalculation(row).tax.method === "annual_recalculation")
      throw new HttpError(
        409,
        "PAYROLL_PPH21_LATER_PERIOD_LOCKED",
        "Payroll bulan pajak yang lebih akhir pada tahun ini sudah dikunci dengan perhitungan tahunan. Payroll bulan ini tidak bisa dikunci lagi.",
      );
  }
  const joinMonthStart = new Map(
    employees.map((e) => [e.employeeId, `${e.joinDate.slice(0, 7)}-01`]),
  );
  for (const row of await readSlips(earlierFilter)) {
    const entry = priors.get(row.employeeId);
    const from = joinMonthStart.get(row.employeeId);
    if (!entry || from === undefined || row.runPayDate < from) continue;
    const calc = readCalculation(row);
    const period: Pph21PriorPeriod = {
      tax: calc.tax,
      employeeDeductibleIdr: calc.bpjs
        .filter((b) => b.type === "jht" || b.type === "jp")
        .reduce((sum, b) => sum + b.employeeIdr, 0),
    };
    if (calc.tax.method === "ter") entry.periods.push(period);
    else if (row.runPayDate.slice(0, 7) === month)
      entry.lastPeriodEarlier.push(period);
    else if (lastPeriod.get(row.employeeId) === true) throw monthPriorInvalid();
    else {
      entry.annualEarlier = true;
      continue;
    }
    entry.payslipIds.push(row.id);
    if (!entry.runIds.includes(row.runId)) entry.runIds.push(row.runId);
  }
  for (const entry of priors.values()) entry.runIds.sort();
  return priors;
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
 * Takes the advisory year lock, then the month lock, of the stored run and re-reads the run under
 * it, so a legal entity or pay date edited while waiting for the lock is
 * refused (409 PAYROLL_PPH21_RUN_MISMATCH) instead of locking the wrong month.
 * The lock is re-entrant inside one transaction. `month` is `YYYY-MM`.
 */
export async function lockPayrollRunMonth(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<{ legalEntityId: string; payDate: BusinessDate; month: string }> {
  const first = await loadStoredRun(tx, tenantId, runId);
  const month = first.payDate.slice(0, 7);
  // Year lock first (always before the month lock, so locks never invert):
  // runs of different months of one year serialize, so a December lock sees
  // the earlier months' payslips of the year.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-pph21-year:${tenantId}:${first.legalEntityId}:${month.slice(0, 4)}`}, 0))`,
  );
  await lockPayrollTaxMonth(tx, tenantId, first.legalEntityId, month);
  const stored = await loadStoredRun(tx, tenantId, runId);
  if (
    stored.payDate !== first.payDate ||
    stored.legalEntityId !== first.legalEntityId
  )
    throw runMismatch();
  return {
    legalEntityId: stored.legalEntityId,
    payDate: stored.payDate as BusinessDate,
    month,
  };
}

/**
 * The other locked/paid runs of the same legal entity and tax month that hold
 * a payslip of any of `employeeIds` (sorted, unique). The caller holds the
 * month lock. These are the runs a later run's month basis depends on; the
 * set also covers last-tax-period employees (doubt limits reversal).
 */
export async function loadMonthPriorRunIds(
  tx: Tx,
  tenantId: TenantId,
  run: { runId: PayrollRunId; legalEntityId: string; month: string },
  employeeIds: readonly string[],
): Promise<PayrollRunId[]> {
  if (employeeIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ id: payrollRuns.id })
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
        gte(payrollRuns.payDate, `${run.month}-01`),
        lt(payrollRuns.payDate, nextMonthStart(run.month)),
        inArray(payslips.employeeId, [...employeeIds]),
      ),
    );
  return rows.map((row) => row.id).sort();
}

/**
 * Takes the month lock and reads the month basis of every employee that is
 * not in the last tax period (annual rule unchanged: no basis). The legal
 * entity and pay date come from the stored run; the caller's pay date must
 * match.
 */
async function monthBasisForInput(
  context: ScopedTenantContext,
  input: PayrollRunTaxInput,
  tx: Tx,
): Promise<Map<string, PayrollMonthBasis>> {
  const { runId } = input.monthScope;
  const { tenantId } = context.tenant;
  const stored = await lockPayrollRunMonth(tx, tenantId, runId);
  if (stored.payDate !== input.run.payDate) throw runMismatch();
  return loadMonthBasis(
    tx,
    tenantId,
    { runId, legalEntityId: stored.legalEntityId },
    stored.month,
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
      ({ employeeId, priorPeriods, lastPeriodEarlier, ...employee }) => {
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
            prior: buildPph21PriorWithLastPeriod(
              priorPeriods,
              lastPeriodEarlier,
            ),
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

/**
 * The serialization lock of the open PPh 21 receivable of one legal entity:
 * `pg_advisory_xact_lock` on `payroll-pph21-receivable:<tenant>:<legal
 * entity>`, held to the end of the caller's transaction. Lock order: after the
 * month lock (`lockPayrollRunMonth`), before any `payroll_runs` row lock. Every
 * writer that raises or collects a receivable (lock, reversal) takes it so a
 * receivable is collected once.
 */
export async function lockPph21ReceivableScope(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-pph21-receivable:${tenantId}:${legalEntityId}`}, 0))`,
  );
}

/**
 * Open PPh 21 receivable per employee (raised minus collected over the
 * payslips of the OTHER locked/paid runs of the same legal entity); employees
 * with none are absent. Another legal entity's receivable is never collected
 * here. A run never collects backwards: only a receivable raised by a run with
 * `pay_date <= payDate` counts, so open = min(raisedAll - collectedAll,
 * max(0, raisedEligible - collectedAll)) (collections of ANY date are
 * subtracted, so nothing is collected twice).
 *
 * `open` is what a run paying on `payDate` may collect; `total` is the whole
 * balance whatever the pay date (the carry a new payslip writes in
 * `pph21ReceivableOpenAfterIdr`). Employees with a zero balance are absent from
 * both.
 *
 * Fast path (legend-2fk79): when every earlier payslip of the employee is paid
 * on or before `payDate` (nothing is held back, open = total) and the payslip
 * of the run locked last carries `pph21ReceivableOpenAfterIdr`, that field is
 * the balance and only that one payslip is opened. Anything else (an older
 * payslip without the field, a payslip paid after `payDate`, a tie on the lock
 * time) reads the full history as before. Calls `invalid()` and throws its
 * error on an unreadable payslip, a payslip of another employee or an
 * inconsistent balance (fail closed). Never echoes a value.
 */
export async function loadPph21ReceivableBalances(
  tx: Tx,
  input: {
    tenantId: TenantId;
    legalEntityId: string;
    runId: PayrollRunId;
    payDate: BusinessDate;
    employeeIds: readonly string[];
  },
  invalid: () => Error,
): Promise<{ open: Map<string, number>; total: Map<string, number> }> {
  const { tenantId } = input;
  const open = new Map<string, number>();
  const total = new Map<string, number>();
  if (input.employeeIds.length === 0) return { open, total };
  const rows = await tx
    .select({
      id: payslips.id,
      tenantId: payslips.tenantId,
      employeeId: payslips.employeeId,
      calculationEncrypted: payslips.calculationEncrypted,
      piiKeyVersion: payslips.piiKeyVersion,
      runPayDate: payrollRuns.payDate,
      runLockedAt: payrollRuns.lockedAt,
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
        eq(payrollRuns.legalEntityId, input.legalEntityId),
        ne(payrollRuns.id, input.runId),
        inArray(payrollRuns.status, ["locked", "paid"]),
        inArray(payslips.employeeId, [...input.employeeIds]),
      ),
    );
  type Row = (typeof rows)[number];
  const readCalc = (row: Row): PayslipCalculation => {
    let calc: PayslipCalculation;
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
      throw invalid();
    }
    if (calc.employeeId !== row.employeeId) throw invalid();
    return calc;
  };
  const rowsByEmployee = new Map<string, Row[]>();
  for (const row of rows)
    rowsByEmployee.set(row.employeeId, [
      ...(rowsByEmployee.get(row.employeeId) ?? []),
      row,
    ]);
  for (const [employeeId, employeeRows] of rowsByEmployee) {
    // Fast path: the payslip of the run locked last, alone, when nothing is
    // held back by the pay date rule.
    const lockedLast = employeeRows.reduce<Row | null>((best, row) => {
      if (row.runLockedAt === null) return best;
      return best === null ||
        (best.runLockedAt !== null && row.runLockedAt > best.runLockedAt)
        ? row
        : best;
    }, null);
    const uniqueLast =
      lockedLast !== null &&
      employeeRows.every(
        (row) =>
          row === lockedLast ||
          (row.runLockedAt !== null &&
            row.runLockedAt < lockedLast.runLockedAt!),
      );
    if (
      lockedLast !== null &&
      uniqueLast &&
      employeeRows.every((row) => row.runPayDate <= input.payDate)
    ) {
      const carried = readCalc(lockedLast).pph21ReceivableOpenAfterIdr;
      if (carried !== undefined) {
        if (carried > 0) {
          open.set(employeeId, carried);
          total.set(employeeId, carried);
        }
        continue;
      }
    }
    const slips = employeeRows.map((row) => ({
      calc: readCalc(row),
      eligible: row.runPayDate <= input.payDate,
    }));
    let fullOpen: number;
    try {
      // Integrity over ALL slips stays fail closed.
      fullOpen = pph21ReceivableBalance(slips.map((slip) => slip.calc));
    } catch {
      throw invalid();
    }
    let raisedEligible = 0;
    let collectedAll = 0;
    for (const { calc, eligible } of slips) {
      if (eligible) raisedEligible += calc.tax.pph21ReceivableIdr ?? 0;
      for (const line of calc.lines)
        if (line.category === "pph21_receivable")
          collectedAll += line.amountIdr;
    }
    const collectable = Math.min(
      fullOpen,
      Math.max(0, raisedEligible - collectedAll),
    );
    if (collectable > 0) open.set(employeeId, collectable);
    if (fullOpen > 0) total.set(employeeId, fullOpen);
  }
  return { open, total };
}

/** The open receivable a run paying on `payDate` may collect, per employee. */
export async function loadOpenPph21Receivables(
  tx: Tx,
  input: Parameters<typeof loadPph21ReceivableBalances>[1],
  invalid: () => Error,
): Promise<Map<string, number>> {
  return (await loadPph21ReceivableBalances(tx, input, invalid)).open;
}

/**
 * The receivable collection a composed payslip must carry: the same rule as
 * `composePayslipCalculation` (min(open, max(0, room)), room = gross minus the
 * deductions other than `pph21_receivable`). Used by the lock to re-prove the
 * stored collection against the balance open now.
 */
export function expectedReceivableCollection(
  calculation: Pick<PayslipCalculation, "grossIdr" | "deductionsIdr" | "lines">,
  openIdr: number,
): { expectedIdr: number; storedIdr: number } {
  const storedIdr = calculation.lines
    .filter((line) => line.category === "pph21_receivable")
    .reduce((total, line) => total + line.amountIdr, 0);
  const roomIdr =
    calculation.grossIdr - (calculation.deductionsIdr - storedIdr);
  return {
    expectedIdr: planPph21ReceivableCollection({ openIdr, roomIdr })
      .collectedIdr,
    storedIdr,
  };
}
