// Payroll run LOCK step (beads legend-b9y4y; PRD PAYR-01..PAYR-05; design
// docs/briefs/sub-payroll-run-lock-design.md §3). Trusted in-transaction writer,
// same boundary style as `finalizePayrollRapelRunInTransaction`: the caller owns
// the transaction (`withTenant`) and supplies the approved per-employee results.
// No create/simulate run service exists yet, so this step re-proves those
// results under the month lock before it writes anything:
//
//  1. permission, input shape (409 PAYROLL_RUN_RESULT_STALE on a bad plan);
//  2. LOCK ORDER: month advisory lock first, then the `payroll_runs` row
//     `FOR UPDATE`, then plain reads, then inserts. The reversal follows the
//     same order. Never take the month lock after a run row lock;
//  3. status `approved -> locked` through the shared reducer (two distinct
//     approvers, totals, snapshot);
//  4. refusal of side effects this step does not perform (loans,
//     reimbursements, service charge, rapel): refusing never pays anyone more;
//  5. the plan equals the approved totals, the PPh 21 recomputed on the pinned
//     tables and the month basis equals every stored tax (409
//     PAYROLL_PPH21_MONTH_STALE when an earlier run of the month changed);
//  6. only then the writes: status, payslips, month-dependency edges, payee
//     bank snapshot, `payroll.locked` outbox event and audit. A throw anywhere
//     rolls all of it back with the caller's transaction.
//
// OPEN Q-a (design §3.2 step 8): the tables are the ones pinned at simulation
// (`configSnapshot.statutoryVersions`), not the ones in force at lock: what was
// approved is what locks. The PPh 21 policy keeps its approved-ref check.
// OPEN Q-c (step 10): the PPh 21 refund line is the earning with component
// code `PPH21_REFUND` (category `custom_earning`; `components.ts` has no
// `pph21_refund` category); like `tax_allowance` it is not an engine earning.
// OPEN Q-d (step 16): the event actor is `{ type: "user", id: actor }`.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import {
  createUlid,
  isoDateTimeSchema,
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
  payslipCalculationSchema,
  payslipIdSchema,
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
import {
  payrollRunMonthPriors,
  payrollRuns,
  payslips,
  statutoryRates,
} from "../db/schema/payroll.ts";
import {
  payrollRapelFinalizations,
  payrollRapels,
} from "../db/schema/payroll-rapel.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { recordAudit } from "./core-audit.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import { snapshotPayeeBankForLock } from "./payroll-bank-snapshot.service.ts";
import { emitPayrollEvent } from "./payroll-events.ts";
import {
  loadMonthPriorRunIds,
  lockPayrollRunMonth,
  lockPayrollRunTax,
  type PayrollMonthBasis,
  type PayrollRunTaxEmployee,
} from "./payroll-run-pph21.service.ts";
import type { Tx } from "./permission-resolver.ts";

export type PayrollRunLockEmployee = {
  /** Approved simulation result (full payslip body, tax included). */
  calculation: PayslipCalculation;
  /** Engine input of that simulation; employeeId comes from `calculation`. */
  taxInput: Omit<PayrollRunTaxEmployee, "employeeId">;
  /** Month basis the simulation computed against; null when lastTaxPeriod. */
  approvedMonthBasis: PayrollMonthBasis | null;
};

export type PayrollRunLockInput = {
  payrollRunId: PayrollRunId;
  employees: readonly PayrollRunLockEmployee[];
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

const lockUnsupported = () =>
  new HttpError(
    409,
    "PAYROLL_RUN_LOCK_UNSUPPORTED",
    "Payroll ini memuat pinjaman, reimbursement, service charge, atau rapel yang belum didukung langkah kunci. Penguncian ditahan.",
  );

/** Maps a stored `payroll_runs` row to the contract run (dates as ISO strings). */
function toRun(row: typeof payrollRuns.$inferSelect): PayrollRun {
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

  const parsedPlan = input.employees.map((entry) => {
    const calculation = payslipCalculationSchema.safeParse(entry.calculation);
    if (!calculation.success) throw resultStale();
    return { ...entry, calculation: calculation.data };
  });
  if (
    parsedPlan.length === 0 ||
    new Set(parsedPlan.map((entry) => entry.calculation.employeeId)).size !==
      parsedPlan.length
  )
    throw resultStale();
  const plan = [...parsedPlan].sort((a, b) =>
    a.calculation.employeeId.localeCompare(b.calculation.employeeId),
  );

  // LOCK 1: the month advisory lock. LOCK 2: the run row. Never the reverse.
  const month = await lockPayrollRunMonth(tx, tenantId, runId);
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
  if (
    row.legalEntityId !== month.legalEntityId ||
    row.payDate !== month.payDate
  )
    throw new HttpError(
      409,
      "PAYROLL_PPH21_RUN_MISMATCH",
      "Tanggal bayar atau badan hukum payroll tidak sesuai dengan data payroll yang tersimpan.",
    );

  const run = toRun(row);
  const at = isoDateTimeSchema.parse(now.toISOString());
  // Throws PAYROLL_RUN_INVALID_TRANSITION unless `approved`, and
  // PAYROLL_RUN_NOT_APPROVED without two distinct approvers, totals, snapshot.
  applyPayrollRunCommand(run, { action: "lock", actorId: actor, at });
  const totals = payrollRunTotalsSchema.parse(run.totals);
  const configSnapshot = payrollConfigSnapshotSchema.parse(run.configSnapshot);

  // Side effects this step does not perform: refuse, never pay more.
  if (
    totals.loanRepaymentIdr > 0 ||
    totals.reimbursementIdr > 0 ||
    totals.serviceChargeIdr > 0
  )
    throw lockUnsupported();
  const [allocated] = await tx
    .select({ id: payrollRapels.id })
    .from(payrollRapels)
    .where(
      and(
        eq(payrollRapels.tenantId, tenantId),
        eq(payrollRapels.payrollRunId, runId),
        eq(payrollRapels.status, "allocated"),
      ),
    )
    .limit(1);
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
  if (allocated || finalized) throw lockUnsupported();

  // The plan is what was approved.
  const calculations = plan.map((entry) => entry.calculation);
  if (
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

  const tables = await loadPinnedPph21Tables(tx, tenantId, {
    payDate: run.payDate,
    configSnapshot,
  });
  const approvedBasis = new Map<string, PayrollMonthBasis>();
  for (const entry of plan)
    if (entry.approvedMonthBasis !== null)
      approvedBasis.set(entry.calculation.employeeId, entry.approvedMonthBasis);
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
        ...entry.taxInput,
        employeeId: entry.calculation.employeeId,
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
    const computed = taxByEmployee.get(entry.calculation.employeeId);
    if (
      computed === undefined ||
      !isDeepStrictEqual(
        payslipTaxSchema.parse(computed),
        entry.calculation.tax,
      )
    )
      throw resultStale();
    const expected = entry.taxInput.earnings
      .map((earning) => `${earning.amountIdr}:${earning.taxable}`)
      .sort();
    if (!isDeepStrictEqual(expected, engineEarningKeys(entry.calculation)))
      throw resultStale();
  }

  // Last-tax-period employees carry no month basis, so the stale check above
  // cannot see a second run of the month (e.g. December regular + THR): both
  // would lock blind and the annual withholding would double or go missing.
  // Fail closed: a payslip of theirs in another locked/paid run of this legal
  // entity and month refuses the lock.
  const lastPeriodIds = plan
    .filter((entry) => entry.taxInput.lastTaxPeriod)
    .map((entry) => entry.calculation.employeeId);
  if (
    (
      await loadMonthPriorRunIds(
        tx,
        tenantId,
        { runId, legalEntityId: month.legalEntityId, month: month.month },
        lastPeriodIds,
      )
    ).length > 0
  )
    throw new HttpError(
      409,
      "PAYROLL_PPH21_MONTH_STALE",
      "Payroll kedua pada masa pajak terakhir karyawan di bulan ini belum didukung. Selesaikan payroll yang sudah terkunci pada bulan ini terlebih dahulu.",
    );

  const monthPriorRunIds = await loadMonthPriorRunIds(
    tx,
    tenantId,
    { runId, legalEntityId: month.legalEntityId, month: month.month },
    plan.map((entry) => entry.calculation.employeeId),
  );

  // All checks done: the writes.
  const updated = await tx
    .update(payrollRuns)
    .set({ status: "locked", lockedBy: actor, lockedAt: now, updatedAt: now })
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

  const slips = plan.map((entry) => {
    const payslipId = payslipIdSchema.parse(randomUUID());
    return {
      payslipId,
      employeeId: entry.calculation.employeeId,
      paymentMethod: entry.calculation.paymentMethod,
      netIdr: entry.calculation.netIdr,
      sealed: sealPayrollValue(
        JSON.stringify(entry.calculation),
        {
          tenantId,
          table: "payslips",
          rowId: payslipId,
          field: "calculation",
        },
        PAYROLL_SEAL_KEY_VERSION,
      ),
    };
  });
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
      lockedAt: at,
    },
    now,
  });
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
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
      createdAt: now.toISOString(),
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
