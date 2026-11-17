// Overtime correction ("rapel lembur") of frozen periods (bead legend-72nod;
// brief docs/briefs/983-hr-sisa.md "Rancangan Kartu C").
//
// Overtime is priced live from the approved requests of the period, so a run
// that locked keeps what it paid, and a request approved or cancelled later
// leaves a difference. For one employee and one TARGET run T, every SOURCE run
// S of the same legal entity (regular, locked or paid, never reversed, the
// employee has a payslip on it, period ends before T starts) gives:
//
//   paidSet    = requests approved (`updatedAt`, the time the status became
//                approved) at or before S.lockedAt that are still approved,
//                or were cancelled after S.lockedAt
//   currentSet = requests approved now
//   delta      = f(currentSet) - f(paidSet)
//
// f is `priceOvertimeRequests` (the gross engine's own pricing) over the
// attendance and salary basis of S's period read now, for both sides, so a
// salary change never shows up as a correction.
//
// Anti double payment: outstanding = delta - signed sum of the SETTLED ledger
// rows (`payroll_overtime_corrections`) of (employee, S), not counting T's own
// rows. The ledger row is written only by the lock of T
// (`syncOvertimeCorrectionLedgerInTransaction`, same transaction as the lock,
// like the PPh 21 receivable open items) and turned `reversed` when T's
// reversal is approved. The lock recomputes the outstanding under a lock and
// refuses (409) a payslip line above it, so two draft runs carrying the same
// correction cannot both lock.
//
//   positive outstanding -> earning line LEMBUR_KOREKSI (taxable), `sourceId`
//                           = S, amount = outstanding;
//   negative outstanding -> deduction line LEMBUR_KOREKSI_POTONGAN, `sourceId`
//                           = S, in instalments: min(outstanding, LEMBUR of
//                           S not yet deducted, pay left); the rest stays
//                           outstanding for a later run, never dropped.
//
// The payslip of S was priced at its last simulation, not at its lock, so a
// request of S's period approved or cancelled between `lastSimulatedAt` and
// `lockedAt` (widened by OVERTIME_CORRECTION_CLOCK_SKEW_MS on both sides)
// cannot be placed in paidSet: that source is held.
//
// Sources are only runs locked at or after the tenant's activation
// (`payroll_overtime_correction_activations`, migration 0558; no row = all):
// older history was settled by the old process and is never corrected.
//
// Held is PER SOURCE (the other sources of the employee are still processed)
// and reported (`plan.held`, written to the audit of simulate). Held (nothing
// automatic): an offboarding that is not cancelled, an
// end date before the end of T's period, an approved request without a
// readable formula, a cancelled request whose approval time is unknown (for a
// chain request only the audit row of the settle tells it), a
// request changed between the last simulation and the lock of S, an unreadable
// source payslip, overlapping source periods, a deduction above what S paid
// plus what was paid back to the employee by corrections. In doubt: held.
//
// `planOvertimeCorrection` writes nothing (simulate and lock use it).

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  idr,
  type BusinessDate,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { EmployeeId } from "@starter/shared/hris";
import {
  OVERTIME_DAY_TYPES,
  payslipCalculationSchema,
  type PayComponentCategory,
  type PayrollRunId,
} from "@starter/shared/hris/payroll";
import { employees } from "../db/schema/hris.ts";
import { hrisOffboardings } from "../db/schema/hris-lifecycle.ts";
import { overtimeRequests } from "../db/schema/hris-leave.ts";
import {
  payrollOvertimeCorrectionActivations,
  payrollOvertimeCorrections,
} from "../db/schema/payroll-overtime-corrections.ts";
import { auditLogs } from "../db/schema/core-audit.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { payrollRuns, payslips } from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { loadPinnedOvertimeFormulas } from "./hris-overtime.service.ts";
import {
  loadOvertimeBasisInTransaction,
  OVERTIME_CODE,
  priceOvertimeRequests,
  type PricedOvertimeRequest,
} from "./payroll-components.service.ts";
import type { Tx } from "./permission-resolver.ts";

/**
 * Clock skew allowed between app instances. A request stamp and the simulate
 * or lock stamp of a run can come from different instances, so a request
 * inside [lastSimulatedAt - skew, lockedAt + skew] cannot be placed before or
 * after the payslip with certainty: the source is held (`approval_unclear`).
 * Wider than any real skew, narrow enough to hold almost nothing.
 */
export const OVERTIME_CORRECTION_CLOCK_SKEW_MS = 5_000;

/** Payslip line codes of the correction (line identity for simulate and lock). */
export const OVERTIME_CORRECTION_POSITIVE_CODE = "LEMBUR_KOREKSI";
export const OVERTIME_CORRECTION_NEGATIVE_CODE = "LEMBUR_KOREKSI_POTONGAN";

/** Shape of the two payslip lines; `sourceId` is the source run id. */
export const OVERTIME_CORRECTION_LINES = {
  positive: {
    componentCode: OVERTIME_CORRECTION_POSITIVE_CODE,
    name: "Koreksi Lembur",
    category: "overtime" as PayComponentCategory,
    kind: "earning" as const,
    taxable: true,
  },
  negative: {
    componentCode: OVERTIME_CORRECTION_NEGATIVE_CODE,
    name: "Potongan Koreksi Lembur",
    category: "custom_deduction" as PayComponentCategory,
    kind: "deduction" as const,
    taxable: false,
  },
} as const;

export type OvertimeCorrectionHeldReason =
  | "offboarding"
  | "employee_ended"
  | "formula_missing"
  | "approval_unclear"
  | "source_unreadable"
  | "overlapping_sources"
  | "deduction_exceeds_paid";

export type OvertimeCorrectionSource = {
  sourceRunId: PayrollRunId;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** f(currentSet) - f(paidSet), signed. */
  deltaIdr: number;
  /** Signed sum of the settled ledger rows (T's own rows excluded). */
  settledIdr: number;
  /** delta - settled, signed: > 0 is owed to the employee, < 0 to the outlet. */
  outstandingIdr: number;
  /** Most the employee may still owe through POTONGAN for this source. */
  negativeMaxIdr: number;
};

/** One source held back for one employee; nothing is paid or taken for it. */
export type OvertimeCorrectionHold = {
  sourceRunId: PayrollRunId;
  reason: OvertimeCorrectionHeldReason;
  /**
   * Signed outstanding of the source when it was known (offboarding, ended
   * employee: what stays unpaid or untaken), null when the source itself could
   * not be priced.
   */
  outstandingIdr: number | null;
};

/**
 * Held is per SOURCE: an ambiguous or blocked source never stops the others.
 * `kind` is "correction" when some source gives a line, else "none"; `held`
 * lists every source held back (reported by simulate and its audit row).
 */
export type OvertimeCorrectionPlan = {
  kind: "none" | "correction";
  /** Sources with a positive outstanding, oldest first. */
  positive: { sourceRunId: PayrollRunId; amountIdr: number }[];
  /** Sources with a negative outstanding, oldest first (before pay cap). */
  negative: {
    sourceRunId: PayrollRunId;
    /** min(|outstanding|, negativeMax). */
    wantedIdr: number;
    outstandingIdr: number;
  }[];
  /** The sources that are not held (lock accepts a line only for these). */
  sources: OvertimeCorrectionSource[];
  held: OvertimeCorrectionHold[];
};

const notFoundRun = () =>
  new HttpError(404, "PAYROLL_RUN_NOT_FOUND", "Payroll tidak ditemukan.");

type SourceRow = {
  runId: PayrollRunId;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  lockedAt: Date;
  /** The simulation that priced the payslip; a request changed after it is not in the slip. */
  simulatedAt: Date | null;
  /** The sealed payslip; opened only when a deduction needs its LEMBUR. */
  slip: Parameters<typeof paidOvertimeOf>[0];
};

type RequestRow = {
  id: string;
  date: string;
  minutes: number;
  dayType: PricedOvertimeRequest["dayType"];
  formulaId: string | null;
  status: string;
  decidedAt: Date | null;
  updatedAt: Date;
  requestedAt: Date;
  approvalChainId: string | null;
};

/** LEMBUR paid on a payslip (sealed calculation); throws when unreadable. */
function paidOvertimeOf(row: {
  id: string;
  tenantId: TenantId;
  employeeId: string;
  calculationEncrypted: Buffer;
  piiKeyVersion: number;
}): number {
  const calc = readCalculation(row);
  let total = 0;
  for (const line of calc.lines)
    if (line.componentCode === OVERTIME_CODE && line.kind === "earning")
      total += line.amountIdr;
  return total;
}

function readCalculation(row: {
  id: string;
  tenantId: TenantId;
  employeeId: string;
  calculationEncrypted: Buffer;
  piiKeyVersion: number;
}) {
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
    if (calc.employeeId !== row.employeeId) throw new Error("employee");
    return calc;
  } catch {
    // Never echo the decrypt or parse error: it may carry payroll values.
    throw new HttpError(
      409,
      "PAYROLL_OVERTIME_CORRECTION_UNREADABLE",
      "Slip gaji tidak dapat dibaca. Koreksi lembur tidak diproses.",
    );
  }
}

/**
 * Approval time of a request that was approved at some point, or null when
 * it never was (cancelled while pending) or cannot be told (`undefined`).
 */
async function approvedAtOf(
  tx: Tx,
  tenantId: TenantId,
  rows: readonly RequestRow[],
): Promise<Map<string, Date | null | undefined>> {
  const out = new Map<string, Date | null | undefined>();
  const chainIds = [
    ...new Set(
      rows
        .filter((r) => r.status === "cancelled" && r.approvalChainId !== null)
        .map((r) => r.approvalChainId as string),
    ),
  ];
  const chains = new Map<
    string,
    {
      status: string;
      level: number;
      requiredLevels: number;
      decidedAt: Date | null;
    }
  >();
  if (chainIds.length > 0) {
    const levels = await tx
      .select({
        chainId: approvalRequests.chainId,
        status: approvalRequests.status,
        level: approvalRequests.level,
        requiredLevels: approvalRequests.requiredLevels,
        decidedAt: approvalRequests.decidedAt,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, tenantId),
          inArray(approvalRequests.chainId, chainIds),
        ),
      )
      .orderBy(asc(approvalRequests.level));
    for (const level of levels) chains.set(level.chainId, level);
  }
  // `hris.overtime_request.approved` is written in the settle transaction with
  // `createdAt` = the settle time (the same `now` as the request's update).
  const settledAt = new Map<string, Date>();
  const settledIds = rows
    .filter((r) => {
      if (r.status !== "cancelled" || r.approvalChainId === null) return false;
      const last = chains.get(r.approvalChainId);
      return (
        last !== undefined &&
        last.status === "approved" &&
        last.level >= last.requiredLevels
      );
    })
    .map((r) => r.id);
  if (settledIds.length > 0) {
    const audits = await tx
      .select({ event: auditLogs.event })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          sql`${auditLogs.event} ->> 'action' = 'hris.overtime_request.approved'`,
          sql`${auditLogs.event} ->> 'objectId' IN (${sql.join(
            settledIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      );
    for (const audit of audits) {
      const at = new Date(audit.event.createdAt);
      if (Number.isNaN(at.getTime())) continue;
      const id = audit.event.objectId as string;
      const known = settledAt.get(id);
      // Several rows (cannot happen): the latest keeps the hold the longest.
      if (known === undefined || at.getTime() > known.getTime())
        settledAt.set(id, at);
    }
  }
  for (const row of rows) {
    if (row.status === "approved") {
      // `updatedAt` is when the status became approved; the approver's
      // `decidedAt` can be earlier (a late settle).
      out.set(row.id, row.updatedAt);
    } else if (row.approvalChainId === null) {
      // Approved on filing (below every tier of the matrix). The cancel
      // overwrites `decidedAt` with the cancel time (= `updatedAt`); a
      // `decidedAt` before it is an approval that happened after filing.
      out.set(
        row.id,
        row.decidedAt !== null &&
          row.decidedAt.getTime() < row.updatedAt.getTime()
          ? row.decidedAt
          : row.requestedAt,
      );
    } else {
      const last = chains.get(row.approvalChainId);
      if (!last) out.set(row.id, undefined);
      else if (last.status === "approved" && last.level >= last.requiredLevels)
        // The approver's `decidedAt` is when the chain was decided, not when
        // the request became approved (the settle can come much later, and the
        // cancel erases the request's own time). Only the audit row written at
        // the settle tells; without it the time is unknown (held).
        out.set(row.id, settledAt.get(row.id));
      else if (last.status === "pending") out.set(row.id, undefined);
      else out.set(row.id, null);
    }
  }
  return out;
}

/**
 * Read-only plan of the overtime correction of (employee, target run). See the
 * header. Another tenant's run is 404. Callers: simulate (lines), lock (check).
 */
export async function planOvertimeCorrection(
  tx: Tx,
  scope: ScopedTenantContext,
  input: { employeeId: string; targetRunId: PayrollRunId },
): Promise<OvertimeCorrectionPlan> {
  const tenantId = scope.tenant.tenantId;
  const { employeeId, targetRunId } = input;
  const none = (): OvertimeCorrectionPlan => ({
    kind: "none",
    positive: [],
    negative: [],
    sources: [],
    held: [],
  });
  const [target] = await tx
    .select({
      legalEntityId: payrollRuns.legalEntityId,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
    })
    .from(payrollRuns)
    .where(
      and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, targetRunId)),
    )
    .limit(1);
  if (!target) throw notFoundRun();

  // Only runs locked at or after the tenant's activation are sources (R1).
  const [activation] = await tx
    .select({ activatedAt: payrollOvertimeCorrectionActivations.activatedAt })
    .from(payrollOvertimeCorrectionActivations)
    .where(eq(payrollOvertimeCorrectionActivations.tenantId, tenantId))
    .limit(1);

  const sourceRows = await tx
    .select({
      runId: payrollRuns.id,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
      lockedAt: payrollRuns.lockedAt,
      simulatedAt: payrollRuns.lastSimulatedAt,
      id: payslips.id,
      tenantId: payslips.tenantId,
      employeeId: payslips.employeeId,
      calculationEncrypted: payslips.calculationEncrypted,
      piiKeyVersion: payslips.piiKeyVersion,
    })
    .from(payrollRuns)
    .innerJoin(
      payslips,
      and(
        eq(payslips.tenantId, payrollRuns.tenantId),
        eq(payslips.payrollRunId, payrollRuns.id),
      ),
    )
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.legalEntityId, target.legalEntityId),
        eq(payrollRuns.runType, "regular"),
        inArray(payrollRuns.status, ["locked", "paid"]),
        ne(payrollRuns.id, targetRunId),
        sql`${payrollRuns.periodEnd} < ${target.periodStart}`,
        activation
          ? sql`${payrollRuns.lockedAt} >= ${activation.activatedAt}`
          : undefined,
        eq(payslips.employeeId, employeeId),
      ),
    )
    .orderBy(asc(payrollRuns.periodStart), asc(payrollRuns.id));
  if (sourceRows.length === 0) return none();

  const held = new Map<string, OvertimeCorrectionHold>();
  const hold = (
    sourceRunId: PayrollRunId,
    reason: OvertimeCorrectionHeldReason,
    outstandingIdr: number | null = null,
  ) => {
    if (!held.has(sourceRunId))
      held.set(sourceRunId, { sourceRunId, reason, outstandingIdr });
  };

  const sources: SourceRow[] = [];
  for (const row of sourceRows) {
    if (row.lockedAt === null)
      hold(row.runId as PayrollRunId, "source_unreadable");
    else
      sources.push({
        runId: row.runId as PayrollRunId,
        periodStart: row.periodStart as BusinessDate,
        periodEnd: row.periodEnd as BusinessDate,
        lockedAt: row.lockedAt,
        simulatedAt: row.simulatedAt,
        slip: row,
      });
  }
  // Overlapping periods price the same request twice: both are held.
  for (let i = 1; i < sources.length; i++)
    if (sources[i]!.periodStart <= sources[i - 1]!.periodEnd) {
      hold(sources[i - 1]!.runId, "overlapping_sources");
      hold(sources[i]!.runId, "overlapping_sources");
    }
  const live = sources.filter((source) => !held.has(source.runId));
  const finish = (
    planned: OvertimeCorrectionSource[],
  ): OvertimeCorrectionPlan => {
    const open = planned.filter((entry) => entry.outstandingIdr !== 0);
    return {
      kind: open.length === 0 ? "none" : "correction",
      positive: open
        .filter((entry) => entry.outstandingIdr > 0)
        .map((entry) => ({
          sourceRunId: entry.sourceRunId,
          amountIdr: entry.outstandingIdr,
        })),
      negative: open
        .filter((entry) => entry.outstandingIdr < 0)
        .map((entry) => ({
          sourceRunId: entry.sourceRunId,
          wantedIdr: Math.min(-entry.outstandingIdr, entry.negativeMaxIdr),
          outstandingIdr: -entry.outstandingIdr,
        }))
        .filter((entry) => entry.wantedIdr > 0),
      sources: planned,
      held: [...held.values()],
    };
  };
  if (live.length === 0) return finish([]);

  const earliest = live[0]!.periodStart;
  const latest = live.reduce(
    (max, row) => (row.periodEnd > max ? row.periodEnd : max),
    live[0]!.periodEnd,
  );
  const requestRows = (
    await tx
      .select({
        id: overtimeRequests.id,
        date: overtimeRequests.date,
        minutes: overtimeRequests.minutes,
        dayType: overtimeRequests.dayType,
        formulaId: overtimeRequests.formulaId,
        status: overtimeRequests.status,
        decidedAt: overtimeRequests.decidedAt,
        updatedAt: overtimeRequests.updatedAt,
        requestedAt: overtimeRequests.requestedAt,
        approvalChainId: overtimeRequests.approvalChainId,
      })
      .from(overtimeRequests)
      .where(
        and(
          eq(overtimeRequests.tenantId, tenantId),
          eq(overtimeRequests.employeeId, employeeId),
          inArray(overtimeRequests.status, ["approved", "cancelled"]),
          sql`${overtimeRequests.date} >= ${earliest}`,
          sql`${overtimeRequests.date} <= ${latest}`,
          sql`${overtimeRequests.minutes} BETWEEN 1 AND 720`,
          inArray(overtimeRequests.dayType, [...OVERTIME_DAY_TYPES]),
        ),
      )
  ).map((row) => row as RequestRow);

  const approvedAt = await approvedAtOf(tx, tenantId, requestRows);
  const ledger = await tx
    .select({
      sourceRunId: payrollOvertimeCorrections.sourceRunId,
      direction: payrollOvertimeCorrections.direction,
      amountIdr: payrollOvertimeCorrections.amountIdr,
    })
    .from(payrollOvertimeCorrections)
    .where(
      and(
        eq(payrollOvertimeCorrections.tenantId, tenantId),
        eq(payrollOvertimeCorrections.employeeId, employeeId as EmployeeId),
        eq(payrollOvertimeCorrections.status, "settled"),
        ne(payrollOvertimeCorrections.targetRunId, targetRunId),
        inArray(
          payrollOvertimeCorrections.sourceRunId,
          live.map((row) => row.runId),
        ),
      ),
    );

  const planned: OvertimeCorrectionSource[] = [];
  // One source at a time: whatever is unclear holds that source only.
  sourceLoop: for (const source of live) {
    const inPeriod = requestRows.filter(
      (row) => row.date >= source.periodStart && row.date <= source.periodEnd,
    );
    const current: RequestRow[] = [];
    const paid: RequestRow[] = [];
    for (const row of inPeriod) {
      const approved = approvedAt.get(row.id);
      if (row.status === "approved") current.push(row);
      if (approved === undefined) {
        hold(source.runId, "approval_unclear");
        continue sourceLoop;
      }
      if (approved === null) continue;
      // Changed after the slip was priced but before the lock: neither paid
      // nor unpaid can be told.
      if (source.simulatedAt === null) {
        hold(source.runId, "source_unreadable");
        continue sourceLoop;
      }
      const simulatedMs = source.simulatedAt.getTime();
      const lockedMs = source.lockedAt.getTime();
      for (const time of [approved, row.decidedAt, row.updatedAt])
        if (
          time !== null &&
          time.getTime() >= simulatedMs - OVERTIME_CORRECTION_CLOCK_SKEW_MS &&
          time.getTime() <= lockedMs + OVERTIME_CORRECTION_CLOCK_SKEW_MS
        ) {
          hold(source.runId, "approval_unclear");
          continue sourceLoop;
        }
      if (approved.getTime() > lockedMs) continue;
      if (
        row.status === "approved" ||
        row.updatedAt.getTime() > source.lockedAt.getTime()
      )
        paid.push(row);
    }
    const sameSet =
      current.length === paid.length &&
      current.every((row) => paid.some((other) => other.id === row.id));
    let deltaIdr = 0;
    if (!sameSet) {
      let formulas: Awaited<ReturnType<typeof loadPinnedOvertimeFormulas>>;
      try {
        formulas = await loadPinnedOvertimeFormulas(
          tx,
          tenantId,
          inPeriod.filter(
            (row) =>
              row.status === "approved" ||
              approvedAt.get(row.id) instanceof Date,
          ),
        );
      } catch (error) {
        if (error instanceof HttpError) {
          hold(source.runId, "formula_missing");
          continue sourceLoop;
        }
        throw error;
      }
      const basis = await loadOvertimeBasisInTransaction(
        tx,
        scope,
        employeeId,
        source.periodStart,
        source.periodEnd,
      );
      const price = (rows: readonly RequestRow[]) =>
        priceOvertimeRequests(rows, formulas, basis.logs, basis.overtimeBaseOn)
          .overtimeIdr as number;
      deltaIdr = price(current) - price(paid);
    }
    let settledIdr = 0;
    let settledPositiveIdr = 0;
    let settledNegativeIdr = 0;
    for (const row of ledger)
      if (row.sourceRunId === source.runId) {
        const amount = row.amountIdr as number;
        if (row.direction === "positive") {
          settledIdr += amount;
          settledPositiveIdr += amount;
        } else {
          settledIdr -= amount;
          settledNegativeIdr += amount;
        }
      }
    const outstandingIdr = deltaIdr - settledIdr;
    // Only a deduction reads the sealed payslip (never opens one otherwise).
    let paidOvertimeIdr = 0;
    if (outstandingIdr < 0) {
      try {
        paidOvertimeIdr = paidOvertimeOf(source.slip);
      } catch {
        hold(source.runId, "source_unreadable");
        continue sourceLoop;
      }
    }
    // Never take back more than the employee got for these hours: LEMBUR of
    // S plus the positive corrections paid, minus what was already taken.
    const negativeMaxIdr = Math.max(
      0,
      paidOvertimeIdr + settledPositiveIdr - settledNegativeIdr,
    );
    // What cannot be taken back is held, never dropped.
    if (-outstandingIdr > negativeMaxIdr) {
      hold(source.runId, "deduction_exceeds_paid", outstandingIdr);
      continue;
    }
    planned.push({
      sourceRunId: source.runId,
      periodStart: source.periodStart,
      periodEnd: source.periodEnd,
      deltaIdr,
      settledIdr,
      outstandingIdr,
      negativeMaxIdr,
    });
  }

  // Blockers of the employee apply only when something would be paid or taken.
  const open = planned.filter((entry) => entry.outstandingIdr !== 0);
  if (open.length === 0) return finish(planned);
  const [employee] = await tx
    .select({ endDate: employees.endDate })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
    .limit(1);
  let blocker: OvertimeCorrectionHeldReason | null = null;
  if (!employee) blocker = "employee_ended";
  else {
    const [offboarding] = await tx
      .select({ id: hrisOffboardings.id })
      .from(hrisOffboardings)
      .where(
        and(
          eq(hrisOffboardings.tenantId, tenantId),
          eq(hrisOffboardings.employeeId, employeeId),
          ne(hrisOffboardings.status, "cancelled"),
        ),
      )
      .limit(1);
    if (offboarding) blocker = "offboarding";
    else if (employee.endDate !== null && employee.endDate < target.periodEnd)
      blocker = "employee_ended";
  }
  if (blocker !== null) {
    // The sources with something open are held and reported with the amount
    // that stays outstanding; a source with nothing open is unaffected.
    for (const entry of open)
      hold(entry.sourceRunId, blocker, entry.outstandingIdr);
    return finish(planned.filter((entry) => entry.outstandingIdr === 0));
  }
  return finish(planned);
}

/**
 * Instalments of the negative correction on one payslip, oldest source first,
 * limited by the pay left (`roomIdr`, same cap as the PPh 21 receivable
 * collection). The rest stays outstanding; nothing is dropped.
 */
export function planOvertimeCorrectionDeduction(
  plan: OvertimeCorrectionPlan,
  roomIdr: number,
): { sourceRunId: PayrollRunId; amountIdr: number }[] {
  if (plan.kind !== "correction") return [];
  let room = Math.max(0, roomIdr);
  const out: { sourceRunId: PayrollRunId; amountIdr: number }[] = [];
  for (const entry of plan.negative) {
    const take = Math.min(entry.wantedIdr, room);
    if (take <= 0) continue;
    room -= take;
    out.push({ sourceRunId: entry.sourceRunId, amountIdr: take });
  }
  return out;
}

const refused = (message: string) =>
  new HttpError(409, "PAYROLL_OVERTIME_CORRECTION_CONFLICT", message);

/**
 * Writes the ledger rows of `payrollRunId` from its payslip lines (lock) or
 * turns them `reversed` (approved reversal). Idempotent. A run that is not
 * locked, paid or reversed changes nothing. Under the legal entity lock the
 * outstanding is computed again; a line above it, a held employee, or a line
 * the plan does not know refuses with 409 and rolls the caller back.
 */
export async function syncOvertimeCorrectionLedgerInTransaction(
  tx: Tx,
  scope: ScopedTenantContext,
  payrollRunId: PayrollRunId,
): Promise<void> {
  const tenantId = scope.tenant.tenantId;
  const readRun = async () => {
    const [row] = await tx
      .select({
        legalEntityId: payrollRuns.legalEntityId,
        status: payrollRuns.status,
      })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.tenantId, tenantId),
          eq(payrollRuns.id, payrollRunId),
        ),
      )
      .limit(1);
    if (!row) throw notFoundRun();
    return row;
  };
  const synced = ["locked", "paid", "reversed"];
  const found = await readRun();
  if (!synced.includes(found.status)) return;
  await lockOvertimeCorrectionScope(tx, tenantId, found.legalEntityId);
  const run = await readRun();
  if (!synced.includes(run.status)) return;

  if (run.status === "reversed") {
    await tx
      .update(payrollOvertimeCorrections)
      .set({ status: "reversed", reversedAt: new Date() })
      .where(
        and(
          eq(payrollOvertimeCorrections.tenantId, tenantId),
          eq(payrollOvertimeCorrections.targetRunId, payrollRunId),
          eq(payrollOvertimeCorrections.status, "settled"),
        ),
      );
    return;
  }

  const slips = await tx
    .select({
      id: payslips.id,
      tenantId: payslips.tenantId,
      employeeId: payslips.employeeId,
      calculationEncrypted: payslips.calculationEncrypted,
      piiKeyVersion: payslips.piiKeyVersion,
    })
    .from(payslips)
    .where(
      and(
        eq(payslips.tenantId, tenantId),
        eq(payslips.payrollRunId, payrollRunId),
      ),
    )
    .orderBy(asc(payslips.employeeId), asc(payslips.id));
  for (const slip of slips) {
    const taken = new Map<string, { positive: number; negative: number }>();
    for (const line of readCalculation(slip).lines) {
      const positive = line.componentCode === OVERTIME_CORRECTION_POSITIVE_CODE;
      const negative = line.componentCode === OVERTIME_CORRECTION_NEGATIVE_CODE;
      if (!positive && !negative) continue;
      if (line.sourceId === null || line.amountIdr <= 0)
        throw refused("Baris koreksi lembur tidak valid.");
      const entry = taken.get(line.sourceId) ?? { positive: 0, negative: 0 };
      if (positive) entry.positive += line.amountIdr;
      else entry.negative += line.amountIdr;
      taken.set(line.sourceId, entry);
    }
    if (taken.size === 0) continue;
    const plan = await planOvertimeCorrection(tx, scope, {
      employeeId: slip.employeeId,
      targetRunId: payrollRunId,
    });
    if (plan.sources.length === 0)
      throw refused("Koreksi lembur karyawan ditahan atau sudah tidak ada.");
    for (const [sourceId, amounts] of taken) {
      const source = plan.sources.find((s) => s.sourceRunId === sourceId);
      if (!source) throw refused("Sumber koreksi lembur tidak dikenal.");
      if (amounts.positive > 0 && amounts.negative > 0)
        throw refused("Koreksi lembur satu sumber memiliki dua arah.");
      const direction = amounts.positive > 0 ? "positive" : "negative";
      const amount = amounts.positive + amounts.negative;
      const limit =
        direction === "positive"
          ? source.outstandingIdr
          : Math.min(-source.outstandingIdr, source.negativeMaxIdr);
      if (amount > limit)
        throw refused("Koreksi lembur melebihi sisa yang belum dibayarkan.");
      await tx
        .insert(payrollOvertimeCorrections)
        .values({
          tenantId,
          targetRunId: payrollRunId,
          employeeId: slip.employeeId as EmployeeId,
          sourceRunId: sourceId as PayrollRunId,
          direction,
          amountIdr: idr(amount),
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(payrollOvertimeCorrections)
        .where(
          and(
            eq(payrollOvertimeCorrections.tenantId, tenantId),
            eq(payrollOvertimeCorrections.targetRunId, payrollRunId),
            eq(
              payrollOvertimeCorrections.employeeId,
              slip.employeeId as EmployeeId,
            ),
            eq(
              payrollOvertimeCorrections.sourceRunId,
              sourceId as PayrollRunId,
            ),
          ),
        )
        .limit(1);
      if (
        !row ||
        row.status !== "settled" ||
        row.direction !== direction ||
        row.amountIdr !== amount
      )
        throw refused("Catatan koreksi lembur tidak cocok dengan slip gaji.");
    }
  }
}

/**
 * The per legal entity lock of the overtime correction (transaction scoped,
 * re-entrant). LOCK ORDER: take it BEFORE any payroll run row lock. The lock of
 * a target run holds it while the guard trigger of the ledger waits for a
 * share lock on the source row, so a reversal of that source must never hold
 * the row first and then wait here (deadlock).
 */
export async function lockOvertimeCorrectionScope(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-overtime-correction:${tenantId}:${legalEntityId}`}, 0))`,
  );
}

/**
 * Refuses (409) the reversal of a run that is the SOURCE of a settled overtime
 * correction: reversed, it would drop out of the plan and the same overtime
 * would be paid or taken a second time. The target run is reversed first. Takes
 * the same entity lock as the ledger sync, so a lock of the target cannot slip
 * in between. The DB trigger of migration 0557 is the second line.
 */
export async function assertNoSettledOvertimeCorrectionFromRun(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  runId: PayrollRunId,
): Promise<void> {
  await lockOvertimeCorrectionScope(tx, tenantId, legalEntityId);
  const [row] = await tx
    .select({ targetRunId: payrollOvertimeCorrections.targetRunId })
    .from(payrollOvertimeCorrections)
    .where(
      and(
        eq(payrollOvertimeCorrections.tenantId, tenantId),
        eq(payrollOvertimeCorrections.sourceRunId, runId),
        eq(payrollOvertimeCorrections.status, "settled"),
      ),
    )
    .limit(1);
  if (row)
    throw new HttpError(
      409,
      "PAYROLL_RUN_REVERSAL_BLOCKED",
      "Payroll ini menjadi sumber koreksi lembur yang sudah dibayarkan atau dipotong di payroll lain. Batalkan payroll yang memuat koreksi itu dulu.",
    );
}
