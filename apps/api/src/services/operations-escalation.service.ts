// OPS-01 supervisor escalation (bead legend-5zkp; PRD v1.7 §3 F45
// "Operasional Harian"). A checklist run that passes its deadline while still
// unfinished is marked `missed` on the server and its supervisor alert is
// queued in the same transaction through the transactional outbox, so the
// notification consumer delivers it even if the worker dies right after
// commit.
//
// Two callers share `markChecklistRunMissed`:
//   - the checklist service, when a supervisor records a manual miss;
//   - `sweepMissedChecklistRuns`, which the worker relay runs on every tick.
// Both run inside the caller's tenant transaction. The status guard
// (`pending`/`in_progress` -> `missed`) is what makes the alert exactly-once:
// a run already finished or missed updates no row, so no second alert is ever
// emitted. `alerted_at` records when the alert was queued for the consumer;
// the notification consumer's own delivery is outside this transaction, which
// is why `alerted_at` is evidence of hand-off, not of delivery.
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { operationsEvents } from "@starter/shared/operations";
import { opsChecklistRuns } from "../db/schema/operations.ts";
import {
  emitOperationsEvent,
  OPERATIONS_NOTIFICATION_DESTINATION,
} from "./operations-events.ts";
import type { OperationsTx } from "./operations-idempotency.ts";

/** One relay tick marks at most this many runs; the next tick continues. */
const MISSED_SWEEP_LIMIT = 200;

const UNFINISHED_STATUSES = ["pending", "in_progress"] as const;

/**
 * The sweep holds a `Date`; the contract run a checklist service loads carries
 * `dueAt` as its ISO string. Both name the same instant, so accept either
 * instead of making every caller convert.
 */
function dueAtInstant(dueAt: Date | string): Date {
  return dueAt instanceof Date ? dueAt : new Date(dueAt);
}

/**
 * Marks one overdue run missed and queues its supervisor alert.
 *
 * Returns true only when THIS call performed the transition. A run that is
 * already completed, failed or missed returns false and emits nothing: the
 * sweep may run every few seconds, but the supervisor is alerted once.
 *
 * OPS-01 SLA: the alert is queued at detection. The contract's
 * `checklistAlertDeadline` (packages/shared/src/operations/machines.ts)
 * documents the 15-minute bound the notification consumer must meet, which is
 * why the event carries `detectedAt`.
 */
export async function markChecklistRunMissed(
  tx: OperationsTx,
  context: ScopedTenantContext,
  run: {
    id: string;
    templateId: string;
    shiftDate: string;
    assignedTo: string;
    outletId: string;
    dueAt: Date | string;
  },
  now: Date = new Date(),
): Promise<boolean> {
  assertTrustedScopedContext(context);
  const [updated] = await tx
    .update(opsChecklistRuns)
    .set({
      status: "missed",
      missedAt: now,
      // Delivery evidence: the notification event is in the same transaction,
      // so a committed row always has its alert queued.
      alertedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(opsChecklistRuns.tenantId, context.tenant.tenantId),
        eq(opsChecklistRuns.id, run.id),
        inArray(opsChecklistRuns.status, [...UNFINISHED_STATUSES]),
      ),
    )
    .returning({ id: opsChecklistRuns.id });
  if (!updated) return false;
  await emitOperationsEvent(tx, context, operationsEvents["checklist.missed"], {
    aggregateId: run.id,
    outletId: run.outletId,
    // The sweep is a system action, not a request by one employee: the
    // contract's `checklist.missed` payload names the assignee instead.
    actor: { type: "system" },
    payload: {
      runId: run.id,
      templateId: run.templateId,
      shiftDate: run.shiftDate,
      assignedTo: run.assignedTo,
      dueAt: dueAtInstant(run.dueAt).toISOString(),
      detectedAt: now.toISOString(),
    },
    // `notification` routes the envelope to the notification consumer
    // (worker-main), which builds the supervisor alert from the payload.
    destination: OPERATIONS_NOTIFICATION_DESTINATION,
    now,
  });
  return true;
}

/**
 * Marks every overdue unfinished run in the context's outlet scope missed and
 * returns how many this sweep transitioned. The relay calls it once per tick;
 * running it twice in a row marks nothing the second time.
 *
 * `FOR UPDATE SKIP LOCKED` keeps two overlapping ticks from selecting the same
 * rows: the loser skips them and the winner's guarded update is the only
 * transition. The partial index `ops_checklist_runs_tenant_outlet_status_idx`
 * (tenant, outlet, status, due_at) serves the scan.
 */
export async function sweepMissedChecklistRuns(
  tx: OperationsTx,
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<number> {
  assertTrustedScopedContext(context);
  const due = await tx
    .select({
      id: opsChecklistRuns.id,
      templateId: opsChecklistRuns.templateId,
      shiftDate: opsChecklistRuns.shiftDate,
      assignedTo: opsChecklistRuns.assignedTo,
      outletId: opsChecklistRuns.outletId,
      dueAt: opsChecklistRuns.dueAt,
    })
    .from(opsChecklistRuns)
    .where(
      and(
        eq(opsChecklistRuns.tenantId, context.tenant.tenantId),
        inArray(opsChecklistRuns.status, [...UNFINISHED_STATUSES]),
        lte(opsChecklistRuns.dueAt, now),
        // RLS already narrows the rows; the explicit filter keeps an
        // outlet-scoped caller from depending on the policy alone (TEN-03).
        context.outletScope.kind === "outlets"
          ? inArray(opsChecklistRuns.outletId, [
              ...context.outletScope.outletIds,
            ])
          : undefined,
      ),
    )
    .orderBy(asc(opsChecklistRuns.dueAt), asc(opsChecklistRuns.id))
    .limit(MISSED_SWEEP_LIMIT)
    .for("update", { skipLocked: true });

  let marked = 0;
  for (const run of due) {
    if (await markChecklistRunMissed(tx, context, run, now)) marked += 1;
  }
  return marked;
}
