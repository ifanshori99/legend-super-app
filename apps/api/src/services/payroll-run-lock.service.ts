// Payroll run LOCK step (beads legend-b9y4y, legend-c2yca, legend-q5dx4,
// legend-ele0u; PRD PAYR-01..PAYR-05; designs
// docs/briefs/sub-payroll-run-lock-design.md §3 and
// docs/briefs/sub-payroll-followups-design.md §2). Trusted in-transaction
// writer: the caller owns the transaction (`withTenant`) and passes only the
// run id. What locks is what the server simulated and stored in
// `payroll_run_results` (simulation_no = run.simulation_count); this step
// re-proves those results under the locks before it writes anything:
//
//  1. permission;
//  2. LOCK ORDER (followups design §0.4): month advisory lock, then the rapel
//     component locks with employees/outlets FOR SHARE, then the
//     `payroll_runs` row `FOR UPDATE`, then the prior runs FOR SHARE (tax-year
//     priors), then plain reads, then writes. The reversal follows the same
//     order. Never take the month lock after a run row lock;
//  3. status `approved -> locked` through the shared reducer (two distinct
//     approvers, totals, snapshot);
//  4. refusal of side effects this step does not perform (reimbursements,
//     service charge): refusing never pays anyone more. Kasbon is performed
//     here (legend-8tfvr): the LOAN lines must equal the rows simulate
//     recorded, then each loan is lowered by its row, once, in the same
//     transaction as the guarded `approved -> locked` UPDATE (loans lock in id
//     order after the run row and the priors; migration 0443 proves the
//     ledger at commit). Rapel is locked here (receipt + full slip in the same
//     transaction);
//  5. the stored results equal the approved totals (409
//     PAYROLL_RUN_RESULT_STALE), the tax-year priors are the ones simulated
//     (409 PAYROLL_PPH21_MONTH_STALE), and the PPh 21 recomputed on the pinned
//     tables equals every stored tax;
//  6. only then the writes: status, rapel receipts, payslips, month and year
//     dependency edges, payee bank snapshot, `payroll.locked` outbox event and
//     audit. A throw anywhere rolls all of it back with the caller's
//     transaction.
//
// OPEN Q-a (design §3.2 step 8): the tables are the ones pinned at simulation
// (`configSnapshot.statutoryVersions`), not the ones in force at lock: what was
// approved is what locks. The PPh 21 policy keeps its approved-ref check.
// OPEN Q-c (step 10): the PPh 21 refund line is the earning with component
// code `PPH21_REFUND` (category `custom_earning`; `components.ts` has no
// `pph21_refund` category); like `tax_allowance` it is not an engine earning.
// OPEN Q-d (step 16): the event actor is `{ type: "user", id: actor }`.
// Rapel slips are sealed as v1 envelopes (a full calculation cannot carry the
// v2 gross metadata); migration 0329 lets the rapel insert guard accept a v1
// slip that has its same-transaction finalization receipt.

import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, max, ne } from "drizzle-orm";
import {
  createUlid,
  isoDateTimeSchema,
  type BusinessDate,
  type Idr,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { EmployeeId } from "@starter/shared/hris";
import {
  PayrollError,
  applyPayrollRunCommand,
  payrollConfigSnapshotSchema,
  payrollLocked,
  payrollRunIdSchema,
  payrollRunSchema,
  payrollRunTotalsSchema,
  payslipTaxSchema,
  statutoryTableVersionSchema,
  statutoryVersionsForRun,
  sumPayrollRunTotals,
  type PayrollConfigSnapshot,
  type PayrollRun,
  type PayrollRunId,
  type PayslipCalculation,
  type PayslipId,
  type PayslipPaymentMethod,
  type Pph21Tables,
  type StatutoryTableVersion,
} from "@starter/shared/hris/payroll";
import { employees } from "../db/schema/hris.ts";
import {
  payrollRunMonthPriors,
  payrollRunResults,
  payrollRuns,
  payslips,
  statutoryRates,
} from "../db/schema/payroll.ts";
import { payrollRapelFinalizations } from "../db/schema/payroll-rapel.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  openPayrollValue,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { recordAudit } from "./core-audit.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import { snapshotPayeeBankForLock } from "./payroll-bank-snapshot.service.ts";
import { emitPayrollEvent } from "./payroll-events.ts";
import {
  lockOvertimeCorrectionScope,
  syncOvertimeCorrectionLedgerInTransaction,
} from "./payroll-overtime-correction.service.ts";
import { syncPph21ReceivableOpenItemsInTransaction } from "./payroll-pph21-receivable-open-items.service.ts";
import {
  expectedReceivableCollection,
  loadMonthPriorRunIds,
  loadPph21ReceivableBalances,
  loadTaxYearPriors,
  lockPayrollRunMonth,
  lockPph21ReceivableScope,
  lockPayrollRunTax,
  type PayrollMonthBasis,
} from "./payroll-run-pph21.service.ts";
import {
  assertAllAllocationsCovered,
  assertRapelResultMatches,
  assertRunUnchanged,
  insertRapelReceipt,
  loadRunRapelAllocations,
  lockRapelInputsForRun,
} from "./payroll-run-rapel-lock.ts";
import { assertNoOverlappingRegularPayslips } from "./payroll-run-overlap.ts";
import {
  applyLockLoanDeductions,
  lockLoansForRunLock,
} from "./payroll-run-loans.ts";
import {
  storedRunResultSchema,
  type StoredRunResult,
} from "./payroll-run-simulate.service.ts";
import type { Tx } from "./permission-resolver.ts";

/** Only the run: the results come from the stored simulation, never the caller. */
export type PayrollRunLockInput = {
  payrollRunId: PayrollRunId;
};

export type PayrollRunLockResult = {
  payrollRunId: PayrollRunId;
  payslips: {
    payslipId: PayslipId;
    employeeId: EmployeeId;
    paymentMethod: PayslipPaymentMethod;
    netIdr: Idr;
  }[];
  bankSnapshotCount: number;
  monthPriorRunIds: PayrollRunId[];
};

const PINNED_TABLE_TYPES = ["ptkp", "pph21_ter", "pph21_annual"] as const;

const resultStale = () =>
  new HttpError(
    409,
    "PAYROLL_RUN_RESULT_STALE",
    "Hasil perhitungan payroll tidak sama dengan yang disetujui. Simulasikan ulang sebelum mengunci.",
  );

const resultUnreadable = () =>
  new HttpError(
    422,
    "PAYROLL_RUN_RESULT_UNREADABLE",
    "Hasil simulasi payroll tidak bisa dibaca. Simulasikan ulang sebelum mengunci.",
  );

const monthStale = () =>
  new HttpError(
    409,
    "PAYROLL_PPH21_MONTH_STALE",
    "Payroll lain pada tahun pajak ini berubah sejak simulasi. Simulasikan ulang sebelum mengunci.",
  );

const lockUnsupported = () =>
  new HttpError(
    409,
    "PAYROLL_RUN_LOCK_UNSUPPORTED",
    "Payroll ini memuat reimbursement atau service charge yang belum didukung langkah kunci. Penguncian ditahan.",
  );

/** Maps a stored `payroll_runs` row to the contract run (dates as ISO strings). */
export function toRun(row: typeof payrollRuns.$inferSelect): PayrollRun {
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  const parsed = payrollRunSchema.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    payrollPolicyId: row.payrollPolicyId,
    runType: row.runType,
    thrScheduleId: row.thrScheduleId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    payDate: row.payDate,
    status: row.status,
    simulationCount: row.simulationCount,
    lastSimulatedAt: iso(row.lastSimulatedAt),
    totals: row.totals,
    configSnapshot: row.configSnapshot,
    approvedByHr: row.approvedByHr,
    approvedByHrAt: iso(row.approvedByHrAt),
    approvedByFinance: row.approvedByFinance,
    approvedByFinanceAt: iso(row.approvedByFinanceAt),
    lockedBy: row.lockedBy,
    lockedAt: iso(row.lockedAt),
    paidBy: row.paidBy,
    paidAt: iso(row.paidAt),
    reversal: row.reversal,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  // Never echo the parse error: it may carry payroll values.
  if (!parsed.success) throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  return parsed.data;
}

/**
 * The PTKP, TER and annual tables the run pinned at simulation, read by id and
 * checked against the snapshot refs (`statutoryVersionsForRun`): a missing,
 * unpublished or changed version is PAYROLL_SNAPSHOT_MISMATCH.
 */
async function loadPinnedPph21Tables(
  tx: Tx,
  tenantId: TenantId,
  run: Pick<PayrollRun, "payDate"> & {
    configSnapshot: PayrollConfigSnapshot;
  },
): Promise<Pph21Tables> {
  const versionIds = run.configSnapshot.statutoryVersions
    .filter((ref) =>
      (PINNED_TABLE_TYPES as readonly string[]).includes(ref.type),
    )
    .map((ref) => ref.versionId);
  const rows =
    versionIds.length === 0
      ? []
      : await tx
          .select()
          .from(statutoryRates)
          .where(
            and(
              eq(statutoryRates.tenantId, tenantId),
              inArray(statutoryRates.id, versionIds),
            ),
          );
  const versions: StatutoryTableVersion[] = [];
  for (const row of rows) {
    const parsed = statutoryTableVersionSchema.safeParse({
      id: row.id,
      tenantId: row.tenantId,
      type: row.type,
      version: row.version,
      effectiveFrom: row.effectiveFrom,
      status: row.status,
      legalBasis: row.legalBasis,
      parameters: row.parameters,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      publishedBy: row.publishedBy,
      createdAt: row.createdAt.toISOString(),
    });
    // An unreadable row counts as missing: the pinned lookup then refuses.
    if (parsed.success) versions.push(parsed.data);
  }
  const pinned = statutoryVersionsForRun(
    {
      status: "locked",
      payDate: run.payDate,
      configSnapshot: run.configSnapshot,
    },
    versions,
    PINNED_TABLE_TYPES,
  );
  const ptkp = pinned.get("ptkp");
  const ter = pinned.get("pph21_ter");
  const annual = pinned.get("pph21_annual");
  if (
    ptkp?.type !== "ptkp" ||
    ter?.type !== "pph21_ter" ||
    annual?.type !== "pph21_annual"
  )
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  return {
    ptkp: ptkp.parameters,
    ter: ter.parameters,
    annual: annual.parameters,
  };
}

/** `(amountIdr, taxable)` of the earning lines the tax engine sees, sorted. */
function engineEarningKeys(calculation: PayslipCalculation): string[] {
  return calculation.lines
    .filter(
      (line) =>
        line.kind === "earning" &&
        line.category !== "tax_allowance" &&
        line.componentCode !== "PPH21_REFUND",
    )
    .map((line) => `${line.amountIdr}:${line.taxable}`)
    .sort();
}

type LockEntry = {
  employeeId: EmployeeId;
  payslipId: PayslipId;
  stored: StoredRunResult;
  calculation: PayslipCalculation;
};

/**
 * The stored results of the run's latest simulation, sorted by employee. A
 * row that cannot be opened or parsed, or whose body does not match its row
 * (employee, payment method), is 422 PAYROLL_RUN_RESULT_UNREADABLE.
 */
async function loadStoredResults(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
  simulationNo: number,
): Promise<LockEntry[]> {
  const rows = await tx
    .select()
    .from(payrollRunResults)
    .where(
      and(
        eq(payrollRunResults.tenantId, tenantId),
        eq(payrollRunResults.payrollRunId, runId),
        eq(payrollRunResults.simulationNo, simulationNo),
      ),
    )
    .orderBy(asc(payrollRunResults.employeeId));
  return rows.map((row) => {
    let stored: StoredRunResult;
    try {
      stored = storedRunResultSchema.parse(
        JSON.parse(
          openPayrollValue(
            row.resultEncrypted,
            {
              tenantId: row.tenantId,
              table: "payroll_run_results",
              rowId: row.payslipId,
              field: "result",
            },
            row.piiKeyVersion,
          ),
        ),
      );
    } catch {
      // Never echo the decrypt or parse error: it may carry payroll values.
      throw resultUnreadable();
    }
    if (
      stored.calculation.employeeId !== row.employeeId ||
      stored.calculation.paymentMethod !== row.paymentMethod
    )
      throw resultUnreadable();
    return {
      employeeId: row.employeeId,
      payslipId: row.payslipId,
      stored,
      calculation: stored.calculation,
    };
  });
}

/** The run as its contract DTO (the lock route answers with it). */
export async function loadPayrollRunDto(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<PayrollRun> {
  const [row] = await tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .limit(1);
  if (!row)
    throw new HttpError(
      404,
      "PAYROLL_RUN_NOT_FOUND",
      "Payroll tidak ditemukan.",
    );
  return toRun(row);
}

/**
 * Locks an approved payroll run inside the caller's tenant transaction (see
 * the header). Every check precedes the first write.
 */
export async function lockPayrollRunInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  input: PayrollRunLockInput,
  now = new Date(),
): Promise<PayrollRunLockResult> {
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.lock",
  );
  const tenantId = context.tenant.tenantId;
  const runId = payrollRunIdSchema.parse(input.payrollRunId);

  // LOCK 1: the month advisory lock. LOCK 1b/1c: pph21 receivable, overtime
  // correction scope. LOCK 2: rapel components, employees and outlets. LOCK 3:
  // the run row. Never the reverse.
  const month = await lockPayrollRunMonth(tx, tenantId, runId);
  // LOCK 1b: the receivable of this legal entity (after the month lock, before
  // any run row lock): one receivable is collected by one locked run.
  await lockPph21ReceivableScope(tx, tenantId, month.legalEntityId);
  // LOCK 1c: the overtime correction scope of this legal entity (legend-pxzhy).
  // Taken before any run row lock, so it never waits behind the row of a source
  // run; the later ledger sync takes it again (re-entrant in this transaction).
  await lockOvertimeCorrectionScope(tx, tenantId, month.legalEntityId);
  await lockRapelInputsForRun(tx, context, {
    runId,
    legalEntityId: month.legalEntityId,
    payDate: month.payDate,
  });
  const [row] = await tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .limit(1)
    .for("update");
  if (!row)
    throw new HttpError(
      404,
      "PAYROLL_RUN_NOT_FOUND",
      "Payroll tidak ditemukan.",
    );
  assertRunUnchanged(row, month);

  const run = toRun(row);
  const at = isoDateTimeSchema.parse(now.toISOString());
  // Throws PAYROLL_RUN_INVALID_TRANSITION unless `approved`, and
  // PAYROLL_RUN_NOT_APPROVED without two distinct approvers, totals, snapshot.
  applyPayrollRunCommand(run, { action: "lock", actorId: actor, at });
  const totals = payrollRunTotalsSchema.parse(run.totals);
  const configSnapshot = payrollConfigSnapshotSchema.parse(run.configSnapshot);

  // Side effects this step does not perform: refuse, never pay more.
  if (totals.reimbursementIdr > 0 || totals.serviceChargeIdr > 0)
    throw lockUnsupported();
  // A run the rapel finalizer already wrote slips for cannot lock again.
  const [finalized] = await tx
    .select({ payslipId: payrollRapelFinalizations.payslipId })
    .from(payrollRapelFinalizations)
    .where(
      and(
        eq(payrollRapelFinalizations.tenantId, tenantId),
        eq(payrollRapelFinalizations.payrollRunId, runId),
      ),
    )
    .limit(1);
  if (finalized) throw resultStale();

  // The stored results are what was approved.
  const plan = await loadStoredResults(
    tx,
    tenantId,
    runId,
    run.simulationCount,
  );
  const calculations = plan.map((entry) => entry.calculation);
  if (
    plan.length === 0 ||
    calculations.some(
      (calculation) =>
        calculation.periodStart !== run.periodStart ||
        calculation.periodEnd !== run.periodEnd ||
        calculation.payDate !== run.payDate,
    ) ||
    calculations.length !== totals.employeeCount ||
    !isDeepStrictEqual(sumPayrollRunTotals(calculations), totals)
  )
    throw resultStale();

  // Nobody is paid twice for the same days: under the month and entity locks,
  // before any write (bead legend-1213).
  await assertNoOverlappingRegularPayslips(
    tx,
    tenantId,
    run,
    plan.map((entry) => entry.employeeId),
  );

  // Tax-year priors under the month lock (prior runs FOR SHARE). A changed
  // set since the simulation is stale; a later-month annual slip is 409
  // PAYROLL_PPH21_LATER_PERIOD_LOCKED inside `loadTaxYearPriors`.
  const joined = await tx
    .select({
      id: employees.id,
      joinDate: employees.joinDate,
      endDate: employees.endDate,
    })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, tenantId),
        inArray(
          employees.id,
          plan.map((entry) => entry.employeeId),
        ),
      ),
    );
  const joinDates = new Map(
    joined.map((employee) => [employee.id, employee.joinDate as BusinessDate]),
  );
  // The join/end dates stored at simulation must still match the live row: a
  // changed date moves the proration and the last-tax-period decision.
  const liveDates = new Map(
    joined.map((employee) => [employee.id, employee.endDate ?? null]),
  );
  for (const entry of plan) {
    if (
      joinDates.get(entry.employeeId) !== entry.stored.joinDate ||
      liveDates.get(entry.employeeId) !== (entry.stored.endDate ?? null)
    )
      throw resultStale();
  }
  const priors = await loadTaxYearPriors(
    tx,
    tenantId,
    runId,
    plan.map((entry) => {
      const joinDate = joinDates.get(entry.employeeId);
      if (joinDate === undefined) throw resultStale();
      return {
        employeeId: entry.employeeId,
        joinDate,
        lastTaxPeriod: entry.stored.taxInput.lastTaxPeriod,
      };
    }),
  );
  const priorOf = (entry: LockEntry) => {
    const prior = priors.get(entry.employeeId);
    if (prior === undefined) throw monthStale();
    return prior;
  };
  for (const entry of plan) {
    const fresh = [...priorOf(entry).payslipIds].sort();
    const simulated = [...entry.stored.priorPayslipIds].sort();
    if (!isDeepStrictEqual(fresh, simulated)) throw monthStale();
    // An annual slip of an earlier month locked after this run was simulated
    // (TER on top would under-withhold the year): simulate again, which
    // leaves the leaver out and reports them (legend-1220).
    if (priorOf(entry).annualEarlier) throw monthStale();
  }

  // The receivable collected on each stored payslip must be the one the
  // balance open NOW allows (earlier locked/paid runs of this legal entity,
  // under the receivable lock). Another run that collected it first, a
  // reversed run, or an entity change makes the stored collection stale.
  const balancesNow = await loadPph21ReceivableBalances(
    tx,
    {
      tenantId,
      legalEntityId: month.legalEntityId,
      runId,
      payDate: run.payDate,
      employeeIds: plan.map((entry) => entry.employeeId),
    },
    resultStale,
  );
  for (const entry of plan) {
    const { expectedIdr, storedIdr } = expectedReceivableCollection(
      entry.calculation,
      balancesNow.open.get(entry.employeeId) ?? 0,
    );
    if (expectedIdr !== storedIdr) throw resultStale();
    // The balance carried on the payslip (legend-2fk79) is what later runs
    // trust: it must be the whole balance open now, minus this collection,
    // plus what this payslip raises. A payslip simulated before the field
    // existed carries none and is not checked.
    const carried = entry.calculation.pph21ReceivableOpenAfterIdr;
    if (
      carried !== undefined &&
      carried !==
        (balancesNow.total.get(entry.employeeId) ?? 0) -
          storedIdr +
          (entry.calculation.tax.pph21ReceivableIdr ?? 0)
    )
      throw resultStale();
  }

  const tables = await loadPinnedPph21Tables(tx, tenantId, {
    payDate: run.payDate,
    configSnapshot,
  });
  const approvedBasis = new Map<string, PayrollMonthBasis>();
  for (const entry of plan)
    if (entry.stored.monthBasis !== null)
      approvedBasis.set(entry.employeeId, entry.stored.monthBasis);
  const tax = await lockPayrollRunTax(
    context,
    {
      run: {
        status: "approved",
        payDate: run.payDate,
        configSnapshot,
      },
      tables,
      employees: plan.map((entry) => ({
        ...entry.stored.taxInput,
        employeeId: entry.employeeId,
        priorPeriods: priorOf(entry).periods,
        lastPeriodEarlier: priorOf(entry).lastPeriodEarlier,
      })),
      monthScope: { runId },
    },
    configSnapshot.pph21Policy ?? null,
    tx,
    approvedBasis,
  );
  const taxByEmployee = new Map(
    tax.payslips.map((entry) => [entry.employeeId, entry.tax]),
  );
  for (const entry of plan) {
    const computed = taxByEmployee.get(entry.employeeId);
    if (
      computed === undefined ||
      !isDeepStrictEqual(
        payslipTaxSchema.parse(computed),
        entry.calculation.tax,
      )
    )
      throw resultStale();
    const expected = entry.stored.taxInput.earnings
      .map((earning) => `${earning.amountIdr}:${earning.taxable}`)
      .sort();
    if (!isDeepStrictEqual(expected, engineEarningKeys(entry.calculation)))
      throw resultStale();
  }

  // Rapel: every allocation has a result, and each result matches the live
  // allocations (reserved payslip id, revision, RAPEL lines).
  const allocations = await loadRunRapelAllocations(tx, context, runId);
  assertAllAllocationsCovered(
    allocations,
    new Set(plan.map((entry) => entry.employeeId)),
  );
  for (const entry of plan)
    assertRapelResultMatches(allocations.get(entry.employeeId), {
      payslipId: entry.payslipId,
      rapelAllocationRevision: entry.stored.rapelAllocationRevision,
      calculation: entry.calculation,
    });

  // Edges: same-month priors of every employee, plus the year priors of the
  // last-tax-period employees (their annual tax folds those runs in).
  const edgeIds = new Set<PayrollRunId>(
    await loadMonthPriorRunIds(
      tx,
      tenantId,
      { runId, legalEntityId: month.legalEntityId, month: month.month },
      plan.map((entry) => entry.employeeId),
    ),
  );
  for (const entry of plan)
    if (entry.stored.taxInput.lastTaxPeriod)
      for (const priorRunId of priorOf(entry).runIds) edgeIds.add(priorRunId);
  const monthPriorRunIds = [...edgeIds].sort();

  // The lock time is the order the latest-balance fast path trusts (legend-2fk79).
  // Taken now, after the receivable lock: it sorts strictly after every run of
  // this legal entity locked before, whatever the clock says. The same value
  // goes to the run, the event and the audit row.
  const [latestLock] = await tx
    .select({ at: max(payrollRuns.lockedAt) })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.legalEntityId, month.legalEntityId),
        ne(payrollRuns.id, runId),
      ),
    );
  const lockedAt =
    latestLock?.at != null && latestLock.at.getTime() >= now.getTime()
      ? new Date(latestLock.at.getTime() + 1)
      : now;

  // Kasbon: the LOAN lines equal the recorded rows and every loan still owes
  // them (locks the loans FOR UPDATE in id order, after the run and priors).
  const loanDeductions = await lockLoansForRunLock(
    tx,
    tenantId,
    run,
    plan,
    configSnapshot.loanMaxDeductionOfNetPayBp,
  );

  // All checks done: the writes. Order: status, loans, receipts, payslips.
  const updated = await tx
    .update(payrollRuns)
    .set({ status: "locked", lockedBy: actor, lockedAt, updatedAt: now })
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.id, runId),
        eq(payrollRuns.status, "approved"),
      ),
    )
    .returning({ id: payrollRuns.id });
  if (updated.length !== 1)
    throw new PayrollError("PAYROLL_RUN_INVALID_TRANSITION");
  // The rows are frozen now (0460): lower each loan by its row, once.
  await applyLockLoanDeductions(tx, tenantId, loanDeductions, lockedAt);

  const slips = plan.map((entry) => ({
    payslipId: entry.payslipId,
    employeeId: entry.employeeId,
    paymentMethod: entry.calculation.paymentMethod,
    netIdr: entry.calculation.netIdr,
    sealed: sealPayrollValue(
      JSON.stringify(entry.calculation),
      {
        tenantId,
        table: "payslips",
        rowId: entry.payslipId,
        field: "calculation",
      },
      PAYROLL_SEAL_KEY_VERSION,
    ),
  }));
  for (const slip of slips) {
    const allocation = allocations.get(slip.employeeId);
    if (allocation)
      await insertRapelReceipt(tx, tenantId, {
        payslipId: slip.payslipId,
        employeeId: slip.employeeId,
        runId,
        revision: allocation.revision,
        sealed: slip.sealed,
        keyVersion: PAYROLL_SEAL_KEY_VERSION,
        actorId: actor,
        now,
      });
  }
  await tx.insert(payslips).values(
    slips.map((slip) => ({
      tenantId,
      id: slip.payslipId,
      employeeId: slip.employeeId,
      payrollRunId: runId,
      paymentMethod: slip.paymentMethod,
      calculationEncrypted: slip.sealed,
      piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
      createdAt: now,
    })),
  );
  if (monthPriorRunIds.length > 0)
    await tx.insert(payrollRunMonthPriors).values(
      monthPriorRunIds.map((priorPayrollRunId) => ({
        tenantId,
        payrollRunId: runId,
        priorPayrollRunId,
        createdAt: now,
      })),
    );
  // legend-itph: the receivable raised or collected by these payslips becomes
  // (or settles) the employee open item, under the receivable lock held above.
  await syncPph21ReceivableOpenItemsInTransaction(tx, context, runId);
  // legend-72nod: the overtime correction lines become ledger rows; a line above
  // the outstanding amount (another draft locked first) refuses with 409.
  await syncOvertimeCorrectionLedgerInTransaction(tx, context, runId);
  const bankSnapshotCount = await snapshotPayeeBankForLock(
    tx,
    tenantId,
    runId,
    slips
      .filter(
        (slip) => slip.paymentMethod === "bank_transfer" && slip.netIdr > 0,
      )
      .map((slip) => ({
        payslipId: slip.payslipId,
        employeeId: slip.employeeId,
      })),
  );
  await emitPayrollEvent(tx, context, payrollLocked, {
    aggregateId: runId,
    actor: { type: "user", id: actor },
    payload: {
      payrollRunId: runId,
      legalEntityId: run.legalEntityId,
      runType: run.runType,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      payDate: run.payDate,
      totals,
      lockedBy: actor,
      lockedAt: isoDateTimeSchema.parse(lockedAt.toISOString()),
    },
    now: lockedAt,
  });
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(lockedAt.getTime()),
      tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "payroll.run.locked",
      objectType: "payroll_run",
      objectId: runId,
      reason: null,
      maskedChanges: {
        before: null,
        after: { employeeCount: slips.length, bankSnapshotCount },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: lockedAt.toISOString(),
    },
    ["employeeCount", "bankSnapshotCount"],
  );

  return {
    payrollRunId: runId,
    payslips: slips.map((slip) => ({
      payslipId: slip.payslipId,
      employeeId: slip.employeeId,
      paymentMethod: slip.paymentMethod,
      netIdr: slip.netIdr,
    })),
    bankSnapshotCount,
    monthPriorRunIds,
  };
}
