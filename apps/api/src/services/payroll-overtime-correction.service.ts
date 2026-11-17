// Overtime correction ("rapel lembur") of frozen periods (bead legend-72nod;
// brief docs/briefs/983-hr-sisa.md "Rancangan Kartu C").
//
// Overtime is priced live from the approved requests of the period, so a run
// that locked keeps what it paid, and a request approved or cancelled later
// leaves a difference. For one employee and one TARGET run T, every SOURCE run
// S of the same legal entity (regular, locked or paid, never reversed, the
// employee has a payslip on it, period ends before T starts) gives:
//
//   paidSet    = requests approved at or before S.lockedAt that are still
//                approved, or were cancelled after S.lockedAt
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
// Held (reported, nothing automatic): an offboarding that is not cancelled, an
// end date before the end of T's period, an approved request without a
// readable formula, a cancelled request whose approval time is unknown, an
// unreadable source payslip, overlapping source periods. In doubt: held.
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
import { payrollOvertimeCorrections } from "../db/schema/payroll-overtime-corrections.ts";
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
  | "overlapping_sources";

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

export type OvertimeCorrectionPlan =
  | { kind: "none" }
  | {
      kind: "held";
      reason: OvertimeCorrectionHeldReason;
      sourceRunIds: PayrollRunId[];
    }
  | {
      kind: "correction";
      /** Sources with a positive outstanding, oldest first. */
      positive: { sourceRunId: PayrollRunId; amountIdr: number }[];
      /** Sources with a negative outstanding, oldest first (before pay cap). */
      negative: {
        sourceRunId: PayrollRunId;
        /** min(|outstanding|, negativeMax). */
        wantedIdr: number;
        outstandingIdr: number;
      }[];
      sources: OvertimeCorrectionSource[];
    };

const notFoundRun = () =>
  new HttpError(404, "PAYROLL_RUN_NOT_FOUND", "Payroll tidak ditemukan.");

type SourceRow = {
  runId: PayrollRunId;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  lockedAt: Date;
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
  for (const row of rows) {
    if (row.status === "approved") {
      out.set(row.id, row.decidedAt ?? undefined);
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
        out.set(row.id, last.decidedAt ?? undefined);
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

  const sourceRows = await tx
    .select({
      runId: payrollRuns.id,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
      lockedAt: payrollRuns.lockedAt,
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
        eq(payslips.employeeId, employeeId),
      ),
    )
    .orderBy(asc(payrollRuns.periodStart), asc(payrollRuns.id));
  if (sourceRows.length === 0) return { kind: "none" };

  const held = (
    reason: OvertimeCorrectionHeldReason,
    ids: PayrollRunId[] = sourceRows.map((row) => row.runId as PayrollRunId),
  ): OvertimeCorrectionPlan => ({ kind: "held", reason, sourceRunIds: ids });

  let sources: SourceRow[];
  try {
    sources = sourceRows.map((row) => {
      if (row.lockedAt === null) throw new Error("not locked");
      return {
        runId: row.runId as PayrollRunId,
        periodStart: row.periodStart as BusinessDate,
        periodEnd: row.periodEnd as BusinessDate,
        lockedAt: row.lockedAt,
        slip: row,
      };
    });
  } catch {
    return held("source_unreadable");
  }

  const earliest = sources[0]!.periodStart;
  const latest = sources.reduce(
    (max, row) => (row.periodEnd > max ? row.periodEnd : max),
    sources[0]!.periodEnd,
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
        eq(payrollOvertimeCorrections.employeeId, employeeId),
        eq(payrollOvertimeCorrections.status, "settled"),
        ne(payrollOvertimeCorrections.targetRunId, targetRunId),
        inArray(
          payrollOvertimeCorrections.sourceRunId,
          sources.map((row) => row.runId),
        ),
      ),
    );

  const planned: OvertimeCorrectionSource[] = [];
  let formulas: Awaited<ReturnType<typeof loadPinnedOvertimeFormulas>> | null =
    null;
  for (const source of sources) {
    const inPeriod = requestRows.filter(
      (row) => row.date >= source.periodStart && row.date <= source.periodEnd,
    );
    const current: RequestRow[] = [];
    const paid: RequestRow[] = [];
    for (const row of inPeriod) {
      const approved = approvedAt.get(row.id);
      if (row.status === "approved") current.push(row);
      if (approved === undefined)
        return held("approval_unclear", [source.runId]);
      if (approved === null || approved.getTime() > source.lockedAt.getTime())
        continue;
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
      try {
        formulas ??= await loadPinnedOvertimeFormulas(
          tx,
          tenantId,
          requestRows.filter(
            (row) =>
              row.status === "approved" ||
              approvedAt.get(row.id) instanceof Date,
          ),
        );
      } catch (error) {
        if (error instanceof HttpError)
          return held("formula_missing", [source.runId]);
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
        priceOvertimeRequests(rows, formulas!, basis.logs, basis.overtimeBaseOn)
          .overtimeIdr as number;
      deltaIdr = price(current) - price(paid);
    }
    let settledIdr = 0;
    let settledNegativeIdr = 0;
    for (const row of ledger)
      if (row.sourceRunId === source.runId) {
        const amount = row.amountIdr as number;
        if (row.direction === "positive") settledIdr += amount;
        else {
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
        return held("source_unreadable", [source.runId]);
      }
    }
    planned.push({
      sourceRunId: source.runId,
      periodStart: source.periodStart,
      periodEnd: source.periodEnd,
      deltaIdr,
      settledIdr,
      outstandingIdr,
      // Never take back more than the source paid, counting what was taken.
      negativeMaxIdr: Math.max(0, paidOvertimeIdr - settledNegativeIdr),
    });
  }

  const open = planned.filter((entry) => entry.outstandingIdr !== 0);
  if (open.length === 0) return { kind: "none" };
  const openIds = open.map((entry) => entry.sourceRunId);

  // Blockers apply only when something would be paid or taken.
  const [employee] = await tx
    .select({ endDate: employees.endDate })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
    .limit(1);
  if (!employee) return held("employee_ended", openIds);
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
  if (offboarding) return held("offboarding", openIds);
  if (employee.endDate !== null && employee.endDate < target.periodEnd)
    return held("employee_ended", openIds);
  for (let i = 1; i < sources.length; i++)
    if (sources[i]!.periodStart <= sources[i - 1]!.periodEnd)
      return held("overlapping_sources", openIds);

  return {
    kind: "correction",
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
  };
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
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-overtime-correction:${tenantId}:${found.legalEntityId}`}, 0))`,
  );
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
    if (plan.kind !== "correction")
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
            eq(payrollOvertimeCorrections.employeeId, slip.employeeId),
            eq(payrollOvertimeCorrections.sourceRunId, sourceId),
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
