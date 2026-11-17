// Payroll run LIFECYCLE routes: create, HR approval, final approval and
// return-to-draft (bead legend-vepv0, decision O6; PRD PAYR-01 "only a run
// approved at two levels by two people locks"). Trusted in-transaction
// writers: the caller owns the tenant transaction (`withTenant`).
//
// Money safety ("jangan sampai rugi"):
//  - Every transition goes through the shared reducer `applyPayrollRunCommand`
//    on the run row read `FOR UPDATE`, so a second approval of the same level
//    (also a racing one) sees the new status and is 409
//    PAYROLL_RUN_INVALID_TRANSITION, with no second write and no second event.
//  - The creator, the HR approver and the final approver are three different
//    people. The service checks it before the write (403
//    PAYROLL_APPROVER_NOT_DISTINCT); `payroll_runs_approvers_guard_trg` is the
//    backstop.
//  - Return-to-draft clears BOTH approvers, the totals, the snapshot and the
//    simulation counter (the reducer), and deletes the stored simulation
//    results: a re-approval needs a fresh simulate and fresh approvals. The
//    trigger does not clear approver columns, so this service must.
//  - A second live regular run for one policy and period (or a second live THR
//    run for one schedule) hits the partial unique indexes
//    `payroll_runs_live_regular_period_key` / `payroll_runs_live_thr_schedule_key`
//    and answers 409; the insert uses ON CONFLICT DO NOTHING so a race cannot
//    abort the transaction.
//  - None of these routes writes payslips, loan deductions or journals.
//
// ASSUMPTIONS (spec silent; flagged for the CTO):
//  - A THR run takes the period of the policy cycle that contains the
//    reference date and the schedule's own pay date; an off-cycle run takes
//    the policy cycle's period and pay date (simulate refuses off-cycle runs).
//  - The pay date adjustment rule moves a pay date off Saturdays, Sundays and
//    tenant-wide national/collective holidays; there is no entity rest-day
//    calendar to read.

import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  createUlid,
  isoDateTimeSchema,
  type BusinessDate,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  PayrollError,
  addDays,
  adjustPayDate,
  applyPayrollRunCommand,
  payrollApprovalRequested,
  payrollPeriodFor,
  payrollRunIdSchema,
  payrollRunTotalsSchema,
  type CreatePayrollRunInput,
  type PayrollRun,
  type PayrollRunId,
} from "@starter/shared/hris/payroll";
import { holidays } from "../db/schema/hris-leave.ts";
import {
  payrollPolicies,
  payrollRunResults,
  payrollRuns,
  thrSchedules,
} from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import { emitPayrollEvent } from "./payroll-events.ts";
import { toRun } from "./payroll-run-lock.service.ts";
import type { Tx } from "./permission-resolver.ts";

const runNotFound = () =>
  new HttpError(404, "PAYROLL_RUN_NOT_FOUND", "Payroll tidak ditemukan.");

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  at: Date,
  action: string,
  runId: PayrollRunId,
  after: Record<string, unknown>,
  reason: string | null = null,
) {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(at.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action,
      objectType: "payroll_run",
      objectId: runId,
      reason,
      maskedChanges: { before: null, after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: at.toISOString(),
    },
    Object.keys(after),
  );
}

/** Creates a draft run for the policy period that contains `referenceDate`. */
export async function createPayrollRunInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  input: Omit<CreatePayrollRunInput, "idempotencyKey">,
  now = new Date(),
): Promise<PayrollRun> {
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.run",
  );
  const tenantId = context.tenant.tenantId;
  // The run's type and its THR schedule agree (also a DB check).
  if ((input.runType === "thr") !== (input.thrScheduleId !== null))
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "Jadwal THR wajib untuk run THR dan hanya untuk run THR.",
    );

  const [policy] = await tx
    .select()
    .from(payrollPolicies)
    .where(
      and(
        eq(payrollPolicies.tenantId, tenantId),
        eq(payrollPolicies.id, input.payrollPolicyId),
      ),
    )
    .limit(1);
  if (!policy)
    throw new HttpError(
      404,
      "PAYROLL_POLICY_NOT_FOUND",
      "Kebijakan payroll tidak ditemukan.",
    );
  if (!policy.isActive)
    throw new HttpError(
      409,
      "PAYROLL_POLICY_INACTIVE",
      "Kebijakan payroll tidak aktif.",
    );

  const period = payrollPeriodFor(policy.cycle, input.referenceDate);
  let payDate = period.payDate;
  if (input.thrScheduleId !== null) {
    const [schedule] = await tx
      .select()
      .from(thrSchedules)
      .where(
        and(
          eq(thrSchedules.tenantId, tenantId),
          eq(thrSchedules.id, input.thrScheduleId),
        ),
      )
      .limit(1);
    if (!schedule)
      throw new HttpError(
        404,
        "THR_SCHEDULE_NOT_FOUND",
        "Jadwal THR tidak ditemukan.",
      );
    if (schedule.legalEntityId !== policy.legalEntityId)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Jadwal THR dan kebijakan payroll harus milik badan hukum yang sama.",
      );
    if (schedule.status !== "scheduled")
      throw new HttpError(
        409,
        "PAYROLL_THR_SCHEDULE_NOT_OPEN",
        "Jadwal THR ini sudah tidak terbuka.",
      );
    payDate = schedule.payDate as BusinessDate;
  } else if (policy.payDateAdjustment !== "none") {
    const rows = await tx
      .select({ date: holidays.date })
      .from(holidays)
      .where(
        and(
          eq(holidays.tenantId, tenantId),
          isNull(holidays.outletId),
          inArray(holidays.type, ["national", "collective"]),
          gte(holidays.date, addDays(payDate, -31)),
          lte(holidays.date, addDays(payDate, 31)),
        ),
      );
    const off = new Set(rows.map((row) => row.date as string));
    payDate = adjustPayDate(
      payDate,
      policy.payDateAdjustment as "previous_working_day" | "next_working_day",
      (date) => {
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        return weekday === 0 || weekday === 6 || off.has(date);
      },
    );
  }

  const [row] = await tx
    .insert(payrollRuns)
    .values({
      tenantId,
      legalEntityId: policy.legalEntityId,
      payrollPolicyId: policy.id,
      runType: input.runType,
      thrScheduleId: input.thrScheduleId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      payDate,
      status: "draft",
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    })
    // One live run per policy and period (or THR schedule): never paid twice.
    .onConflictDoNothing()
    .returning();
  if (!row)
    throw new HttpError(
      409,
      "PAYROLL_RUN_DUPLICATE",
      "Payroll untuk kebijakan dan periode ini sudah ada.",
    );
  await audit(tx, context, actor, now, "payroll.run.created", row.id, {
    runType: row.runType,
    periodStart: row.periodStart,
  });
  return toRun(row);
}

type Approval = "approve_hr" | "approve_final";

async function loadRunForUpdate(
  tx: Tx,
  context: ScopedTenantContext,
  rawRunId: string,
): Promise<PayrollRun> {
  const runId = payrollRunIdSchema.parse(rawRunId);
  const [row] = await tx
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, context.tenant.tenantId),
        eq(payrollRuns.id, runId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw runNotFound();
  return toRun(row);
}

async function approveInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  rawRunId: string,
  action: Approval,
  now: Date,
): Promise<PayrollRun> {
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.approve",
  );
  const run = await loadRunForUpdate(tx, context, rawRunId);
  const at = isoDateTimeSchema.parse(now.toISOString());
  // Status first: a repeated approval is a 409 whoever asks.
  const next = applyPayrollRunCommand(run, { action, actorId: actor, at });
  // The reducer only compares the two approvers: the maker never approves.
  if (actor === run.createdBy)
    throw new PayrollError("PAYROLL_APPROVER_NOT_DISTINCT");

  const [updated] = await tx
    .update(payrollRuns)
    .set(
      action === "approve_hr"
        ? {
            status: next.status,
            approvedByHr: actor,
            approvedByHrAt: now,
            updatedAt: now,
          }
        : {
            status: next.status,
            approvedByFinance: actor,
            approvedByFinanceAt: now,
            updatedAt: now,
          },
    )
    .where(
      and(
        eq(payrollRuns.tenantId, context.tenant.tenantId),
        eq(payrollRuns.id, run.id),
        eq(payrollRuns.status, run.status),
      ),
    )
    .returning();
  if (!updated) throw new PayrollError("PAYROLL_RUN_INVALID_TRANSITION");

  if (action === "approve_hr") {
    // PAYROLL_RUN_SIDE_EFFECTS.approve_hr: the final approver is asked.
    await emitPayrollEvent(tx, context, payrollApprovalRequested, {
      aggregateId: run.id,
      actor: { type: "user", id: actor },
      payload: {
        payrollRunId: run.id,
        legalEntityId: run.legalEntityId,
        runType: run.runType,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        payDate: run.payDate,
        totals: payrollRunTotalsSchema.parse(run.totals),
        approvedByHr: actor,
        approvedByHrAt: at,
      },
      now,
    });
  }
  await audit(
    tx,
    context,
    actor,
    now,
    action === "approve_hr"
      ? "payroll.run.approved_hr"
      : "payroll.run.approved_final",
    run.id,
    { status: updated.status },
  );
  return toRun(updated);
}

export function approvePayrollRunHrInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  runId: string,
  now = new Date(),
) {
  return approveInTransaction(
    tx,
    context,
    actorUserId,
    runId,
    "approve_hr",
    now,
  );
}

export function approvePayrollRunFinalInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  runId: string,
  now = new Date(),
) {
  return approveInTransaction(
    tx,
    context,
    actorUserId,
    runId,
    "approve_final",
    now,
  );
}

/**
 * simulated / hr_approved / approved -> draft. Clears both approvers, the
 * totals and snapshot, and the stored simulation results, so approving again
 * needs a fresh simulate and fresh approvals.
 */
export async function returnPayrollRunToDraftInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  rawRunId: string,
  reason: string,
  now = new Date(),
): Promise<PayrollRun> {
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.run",
  );
  const run = await loadRunForUpdate(tx, context, rawRunId);
  const at = isoDateTimeSchema.parse(now.toISOString());
  const next = applyPayrollRunCommand(run, { action: "return_to_draft", at });
  const tenantId = context.tenant.tenantId;
  const [updated] = await tx
    .update(payrollRuns)
    .set({
      status: next.status,
      simulationCount: next.simulationCount,
      lastSimulatedAt: null,
      totals: null,
      configSnapshot: null,
      approvedByHr: null,
      approvedByHrAt: null,
      approvedByFinance: null,
      approvedByFinanceAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.id, run.id),
        eq(payrollRuns.status, run.status),
      ),
    )
    .returning();
  if (!updated) throw new PayrollError("PAYROLL_RUN_INVALID_TRANSITION");
  // The run is a draft now, which is what lets the results guard delete.
  await tx
    .delete(payrollRunResults)
    .where(
      and(
        eq(payrollRunResults.tenantId, tenantId),
        eq(payrollRunResults.payrollRunId, run.id),
      ),
    );
  await audit(
    tx,
    context,
    actor,
    now,
    "payroll.run.returned_to_draft",
    run.id,
    { from: run.status },
    reason,
  );
  return toRun(updated);
}
