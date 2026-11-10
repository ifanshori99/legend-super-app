// OPS-04 equipment service reminder (WS-14 legend-o032; PRD v1.7 §3 F45
// "Operasional Harian"). A maintenance schedule that is due within
// REMINDER_HORIZON_DAYS (or already overdue) queues one reminder through the
// transactional outbox so the notification consumer can tell the outlet
// supervisors before the machine is serviced late.
//
// `reminded_for_due_at` records the `next_due_at` the last reminder was queued
// for. The guarded update (`reminded_for_due_at IS DISTINCT FROM next_due_at`)
// is what makes the reminder exactly-once per due date: running the sweep
// again updates no row and emits nothing, while completing a service moves
// `next_due_at` and so re-arms the next reminder.
import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { operationsEvents } from "@starter/shared/operations";
import { equipment, maintenanceSchedules } from "../db/schema/operations.ts";
import {
  emitOperationsEvent,
  OPERATIONS_NOTIFICATION_DESTINATION,
} from "./operations-events.ts";
import type { OperationsTx } from "./operations-idempotency.ts";

/** A schedule due within this many days of the sweep is reminded. */
export const REMINDER_HORIZON_DAYS = 7;

/** One relay tick reminds at most this many schedules; the next tick continues. */
const REMINDER_SWEEP_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Queues the service reminder for every due schedule in the context's outlet
 * scope and returns how many this sweep reminded. The relay calls it once per
 * tick; running it twice in a row reminds nothing the second time.
 *
 * `FOR UPDATE SKIP LOCKED` (on the schedule rows only) keeps two overlapping
 * ticks from selecting the same schedules: the loser skips them and the
 * winner's guarded update is the only reminder. The partial order follows
 * `maintenance_schedules_tenant_outlet_due_idx` (tenant, outlet, due, id).
 */
export async function sweepEquipmentServiceReminders(
  tx: OperationsTx,
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<number> {
  assertTrustedScopedContext(context);
  const horizon = new Date(now.getTime() + REMINDER_HORIZON_DAYS * DAY_MS);
  const due = await tx
    .select({
      id: maintenanceSchedules.id,
      outletId: maintenanceSchedules.outletId,
      equipmentId: maintenanceSchedules.equipmentId,
      vendorId: maintenanceSchedules.vendorId,
    })
    .from(maintenanceSchedules)
    .innerJoin(
      equipment,
      and(
        eq(equipment.tenantId, maintenanceSchedules.tenantId),
        eq(equipment.id, maintenanceSchedules.equipmentId),
      ),
    )
    .where(
      and(
        eq(maintenanceSchedules.tenantId, context.tenant.tenantId),
        lte(maintenanceSchedules.nextDueAt, horizon),
        sql`${maintenanceSchedules.remindedForDueAt} IS DISTINCT FROM ${maintenanceSchedules.nextDueAt}`,
        ne(equipment.status, "retired"),
        // RLS already narrows the rows; the explicit filter keeps an
        // outlet-scoped caller from depending on the policy alone (TEN-03).
        context.outletScope.kind === "outlets"
          ? inArray(maintenanceSchedules.outletId, [
              ...context.outletScope.outletIds,
            ])
          : undefined,
      ),
    )
    .orderBy(asc(maintenanceSchedules.nextDueAt), asc(maintenanceSchedules.id))
    .limit(REMINDER_SWEEP_LIMIT)
    .for("update", { skipLocked: true, of: maintenanceSchedules });

  let reminded = 0;
  for (const schedule of due) {
    const [updated] = await tx
      .update(maintenanceSchedules)
      .set({
        remindedForDueAt: sql`${maintenanceSchedules.nextDueAt}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(maintenanceSchedules.tenantId, context.tenant.tenantId),
          eq(maintenanceSchedules.id, schedule.id),
          sql`${maintenanceSchedules.remindedForDueAt} IS DISTINCT FROM ${maintenanceSchedules.nextDueAt}`,
        ),
      )
      .returning({ nextDueAt: maintenanceSchedules.nextDueAt });
    if (!updated) continue;
    await emitOperationsEvent(
      tx,
      context,
      operationsEvents["equipment_service.reminded"],
      {
        aggregateId: schedule.id,
        outletId: schedule.outletId,
        // The sweep is a system action, not a request by one employee.
        actor: { type: "system" },
        payload: {
          scheduleId: schedule.id,
          equipmentId: schedule.equipmentId,
          nextDueAt: updated.nextDueAt.toISOString(),
          vendorId: schedule.vendorId,
          remindedAt: now.toISOString(),
        },
        // `notification` routes the envelope to the notification consumer
        // (worker-main), which resolves the supervisors from the outlet.
        destination: OPERATIONS_NOTIFICATION_DESTINATION,
        now,
      },
    );
    reminded += 1;
  }
  return reminded;
}
