// Payroll run reversal (PRD v1.7 §3 D.30, PAYR-05; beads legend-b9y4y,
// legend-yod9z; design docs/briefs/sub-payroll-run-lock-design.md §4). Trusted
// in-transaction writers: the caller wraps `withTenant`, a throw rolls back
// everything. Only a `locked` run can be reversed; a `paid` run never is.
//
// Lock order, same as the lock step: the tax-month advisory lock first, then
// the `payroll_runs` row `FOR UPDATE`, then plain reads, then writes. A request
// only touches its own run row (no month lock), so it never inverts the order.
//
// An approved reversal is refused while a live (locked or paid) run of the
// same tax month was computed on this run (`payroll_run_month_priors`, written
// at lock): reverse the later run first. The database trigger
// `payroll_runs_reversal_dependency_trg` enforces the same rule. Runs whose
// side effects the lock step does not perform (loans, reimbursements, service
// charge, rapel) are not reversed here either: refusing never pays anyone more.

import { and, eq, inArray } from "drizzle-orm";
import {
  createUlid,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  applyPayrollRunCommand,
  payrollReversed,
  payrollRunSchema,
  type PayrollRun,
  type PayrollRunId,
} from "@starter/shared/hris/payroll";
import {
  payrollRapelFinalizations,
  payrollRapels,
} from "../db/schema/payroll-rapel.ts";
import { payrollRunMonthPriors, payrollRuns } from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import type { Tx } from "./hris-access.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import { emitPayrollEvent } from "./payroll-events.ts";
import { lockPayrollRunMonth } from "./payroll-run-pph21.service.ts";

type RunRow = typeof payrollRuns.$inferSelect;

const AUDIT_FIELDS = ["status", "reversalStatus"] as const;

/** Row to the shared run shape (ISO strings); also re-validates the row. */
function toPayrollRun(row: RunRow): PayrollRun {
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  return payrollRunSchema.parse({
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
}

async function lockRunRow(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<RunRow> {
  const [row] = await tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .for("update");
  if (!row)
    throw new HttpError(
      404,
      "PAYROLL_RUN_NOT_FOUND",
      "Payroll tidak ditemukan.",
    );
  return row;
}

/** Totals that carry side effects the lock step does not perform. */
function hasUnsupportedTotals(run: PayrollRun): boolean {
  const totals = run.totals;
  return (
    totals !== null &&
    (totals.loanRepaymentIdr > 0 ||
      totals.reimbursementIdr > 0 ||
      totals.serviceChargeIdr > 0)
  );
}

async function assertNoRapelSideEffects(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<void> {
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
  if (finalized || allocated) throw unsupported();
}

function unsupported(): HttpError {
  return new HttpError(
    409,
    "PAYROLL_RUN_LOCK_UNSUPPORTED",
    "Payroll ini memuat kasbon, reimbursement, service charge, atau rapel yang belum bisa dibatalkan lewat langkah ini.",
  );
}

/** Live (locked or paid) later runs computed on `runId`; caller holds locks. */
async function loadLiveDependentRunIds(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<PayrollRunId[]> {
  const rows = await tx
    .select({ id: payrollRunMonthPriors.payrollRunId })
    .from(payrollRunMonthPriors)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payrollRunMonthPriors.tenantId),
        eq(payrollRuns.id, payrollRunMonthPriors.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payrollRunMonthPriors.tenantId, tenantId),
        eq(payrollRunMonthPriors.priorPayrollRunId, runId),
        inArray(payrollRuns.status, ["locked", "paid"]),
      ),
    );
  return [...new Set(rows.map((row) => row.id))].sort();
}

async function assertNoLiveDependents(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<void> {
  const dependents = await loadLiveDependentRunIds(tx, tenantId, runId);
  if (dependents.length > 0)
    throw new HttpError(
      409,
      "PAYROLL_RUN_REVERSAL_BLOCKED",
      `Payroll lain di bulan pajak ini dihitung dari payroll ini. Batalkan payroll yang lebih baru dulu. (${dependents.join(", ")})`,
    );
}

async function writeRun(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
  next: PayrollRun,
): Promise<void> {
  const updated = await tx
    .update(payrollRuns)
    .set({
      status: next.status,
      reversal: next.reversal,
      updatedAt: new Date(next.updatedAt),
    })
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.id, runId),
        eq(payrollRuns.status, "locked"),
      ),
    )
    .returning({ id: payrollRuns.id });
  if (updated.length !== 1)
    throw new HttpError(
      409,
      "PAYROLL_RUN_INVALID_TRANSITION",
      "Perubahan status payroll tidak diizinkan.",
    );
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  action: string,
  before: PayrollRun,
  after: PayrollRun,
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action,
      objectType: "payroll_run",
      objectId: after.id,
      reason: null,
      maskedChanges: {
        before: {
          status: before.status,
          reversalStatus: before.reversal?.status ?? null,
        },
        after: {
          status: after.status,
          reversalStatus: after.reversal?.status ?? null,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    AUDIT_FIELDS,
  );
}

/** Ask to cancel a locked run. Status stays `locked`; a second person decides. */
export async function requestPayrollRunReversalInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  payrollRunId: PayrollRunId,
  reason: string,
  now = new Date(),
): Promise<PayrollRun> {
  const tenantId = context.tenant.tenantId;
  // OPEN Q-b: the PRD names no request permission; payroll.lock is the default.
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.lock",
  );
  const row = await lockRunRow(tx, tenantId, payrollRunId);
  const run = toPayrollRun(row);
  const next = applyPayrollRunCommand(run, {
    action: "request_reversal",
    actorId: actor,
    reason,
    at: now.toISOString(),
  });
  // Fast fail only; the decision re-checks under the month lock.
  await assertNoLiveDependents(tx, tenantId, payrollRunId);
  await writeRun(tx, tenantId, payrollRunId, next);
  await audit(
    tx,
    context,
    actor,
    "payroll.run.reversal_requested",
    run,
    next,
    now,
  );
  return next;
}

/** Approve or reject a pending reversal (someone other than the requester). */
export async function decidePayrollRunReversalInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  payrollRunId: PayrollRunId,
  decision: "approve" | "reject",
  now = new Date(),
): Promise<PayrollRun> {
  const tenantId = context.tenant.tenantId;
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.cancel.approve",
  );
  // LOCK 1: tax month. LOCK 2: run row.
  const month = await lockPayrollRunMonth(tx, tenantId, payrollRunId);
  const row = await lockRunRow(tx, tenantId, payrollRunId);
  if (
    row.legalEntityId !== month.legalEntityId ||
    row.payDate !== month.payDate
  )
    throw new HttpError(
      409,
      "PAYROLL_PPH21_RUN_MISMATCH",
      "Payroll berubah saat diproses. Coba lagi.",
    );
  const run = toPayrollRun(row);
  const next = applyPayrollRunCommand(run, {
    action: decision === "approve" ? "approve_reversal" : "reject_reversal",
    actorId: actor,
    at: now.toISOString(),
  });
  if (decision === "reject") {
    await writeRun(tx, tenantId, payrollRunId, next);
    await audit(
      tx,
      context,
      actor,
      "payroll.run.reversal_rejected",
      run,
      next,
      now,
    );
    return next;
  }
  if (hasUnsupportedTotals(run)) throw unsupported();
  await assertNoRapelSideEffects(tx, tenantId, payrollRunId);
  await assertNoLiveDependents(tx, tenantId, payrollRunId);
  const { totals, reversal } = next;
  if (totals === null || reversal === null)
    throw new HttpError(
      409,
      "PAYROLL_RUN_INVALID_TRANSITION",
      "Perubahan status payroll tidak diizinkan.",
    );
  await writeRun(tx, tenantId, payrollRunId, next);
  await emitPayrollEvent(tx, context, payrollReversed, {
    aggregateId: payrollRunId,
    actor: { type: "user", id: actor },
    payload: {
      payrollRunId: next.id,
      legalEntityId: next.legalEntityId,
      runType: next.runType,
      periodStart: next.periodStart,
      periodEnd: next.periodEnd,
      payDate: next.payDate,
      totals,
      requestedBy: reversal.requestedBy,
      approvedBy: actor,
      reversedAt: now.toISOString(),
    },
    now,
  });
  await audit(tx, context, actor, "payroll.run.reversed", run, next, now);
  return next;
}
