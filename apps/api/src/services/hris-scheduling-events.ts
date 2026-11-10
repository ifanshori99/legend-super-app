// Shift events for the outbox (PRD v1.7 §3 F26 "Notifikasi Jadwal"; bead
// legend-jstx). Both events share the `shift` aggregate, so one per-assignment
// sequence orders them: a published shift that is later swapped away or
// cancelled reads as v1 published, v2 cancelled, v3 published, ... The caller
// holds the assignment row lock (or the outlet-week lock on publish), which
// serialises the sequence. Ids and dates only: no name, pay or reason text.
import { and, eq, sql } from "drizzle-orm";
import {
  createUlid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { shiftCancelled, shiftPublished } from "@starter/shared/hris";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import type { shiftAssignments } from "../db/schema/hris-scheduling.ts";
import { appendOutbox } from "./core-outbox.ts";
import type { Tx } from "./hris-access.ts";

export type ShiftEventRow = typeof shiftAssignments.$inferSelect;

/** Cloud sync plus the notification consumer (rule in notification-adapters). */
export const SHIFT_EVENT_DESTINATIONS = ["cloud-sync", "notification"] as const;

async function nextShiftEventSequence(
  tx: Tx,
  tenantId: string,
  destination: string,
  assignmentId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, destination),
        eq(domainEventOutbox.aggregateType, shiftPublished.entry.aggregateType),
        eq(domainEventOutbox.aggregateId, assignmentId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** `shift.published` for the assignment's current owner, once per destination. */
export async function appendShiftPublished(
  tx: Tx,
  context: ScopedTenantContext,
  row: ShiftEventRow,
  publishedByUserId: string,
  publishedAt: Date,
  now: Date,
): Promise<void> {
  const publishedBy = userIdSchema.parse(publishedByUserId);
  for (const destination of SHIFT_EVENT_DESTINATIONS) {
    const sequence = await nextShiftEventSequence(
      tx,
      row.tenantId,
      destination,
      row.id,
    );
    const event = shiftPublished.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: row.tenantId,
      outletId: row.outletId,
      name: shiftPublished.name,
      version: shiftPublished.version,
      aggregateType: shiftPublished.entry.aggregateType,
      aggregateId: row.id,
      sequence,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: publishedBy },
      deviceId: null,
      idempotencyKey: `${shiftPublished.name}:${row.id}:${sequence}`,
      payloadSchemaRef: shiftPublished.payloadSchemaRef,
      payload: {
        shiftAssignmentId: row.id,
        employeeId: row.employeeId,
        outletId: row.outletId,
        shiftTemplateId: row.shiftTemplateId,
        stationId: row.stationId,
        businessDate: row.businessDate,
        segments: row.segments,
        publishedBy,
        publishedAt: publishedAt.toISOString(),
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination,
      direction: null,
      peerId: null,
    });
  }
}

/**
 * `shift.cancelled` for the employee who no longer works the shift:
 * `cancelled` (manager cancelled a published shift) or `swapped_away`
 * (`previousEmployeeId` handed it over in an approved swap/cover).
 */
export async function appendShiftCancelled(
  tx: Tx,
  context: ScopedTenantContext,
  row: ShiftEventRow,
  previousEmployeeId: string,
  reason: "cancelled" | "swapped_away",
  cancelledByUserId: string,
  now: Date,
): Promise<void> {
  const cancelledBy = userIdSchema.parse(cancelledByUserId);
  for (const destination of SHIFT_EVENT_DESTINATIONS) {
    const sequence = await nextShiftEventSequence(
      tx,
      row.tenantId,
      destination,
      row.id,
    );
    const event = shiftCancelled.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: row.tenantId,
      outletId: row.outletId,
      name: shiftCancelled.name,
      version: shiftCancelled.version,
      aggregateType: shiftCancelled.entry.aggregateType,
      aggregateId: row.id,
      sequence,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: cancelledBy },
      deviceId: null,
      idempotencyKey: `${shiftCancelled.name}:${row.id}:${sequence}`,
      payloadSchemaRef: shiftCancelled.payloadSchemaRef,
      payload: {
        shiftAssignmentId: row.id,
        employeeId: previousEmployeeId,
        outletId: row.outletId,
        businessDate: row.businessDate,
        cause: reason,
        cancelledBy,
        cancelledAt: now.toISOString(),
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination,
      direction: null,
      peerId: null,
    });
  }
}
