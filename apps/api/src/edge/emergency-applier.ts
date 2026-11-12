import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { CoreError } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { accessTicketIdSchema } from "@starter/shared/facility";
import { assertFacilityPermission } from "../services/facility-shared.ts";
import {
  accessTickets,
  facilityIncidents,
  facilityUnits,
} from "../db/schema/facility.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import { assertEdgeEventScope } from "./deferred-event-applier.ts";
import type { EdgeApplyMeta } from "./ports.ts";

const payloadSchema = z.strictObject({
  incidentId: z.uuid(),
  facilityId: z.uuid(),
  unitId: z.uuid().nullable(),
  accessTicketId: accessTicketIdSchema.nullable(),
  type: z.enum(["panic", "assist", "damage"]),
  triggeredAt: z.iso.datetime(),
  offline: z.boolean(),
  respondedAt: z.iso.datetime().nullable(),
  respondedBy: z.string().min(1).nullable(),
  resolution: z.string().max(500).nullable(),
});

export async function applyEdgeEmergency(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const result = payloadSchema.safeParse(event.payload);
  if (
    !result.success ||
    event.aggregateType !== "facility_incident" ||
    event.aggregateId !== result.data.incidentId
  )
    throw new CoreError("VALIDATION_ERROR", "Invalid facility incident event");
  const data = result.data;
  const tenantId = meta.context.tenant.tenantId;
  if (event.name === "facility_incident.raised") {
    if (
      event.sequence !== 1 ||
      data.respondedAt ||
      data.respondedBy ||
      data.resolution
    )
      throw new CoreError("VALIDATION_ERROR", "Invalid incident raise");
    if (data.unitId) {
      const [unit] = await tx
        .select({ id: facilityUnits.id })
        .from(facilityUnits)
        .where(
          and(
            eq(facilityUnits.tenantId, tenantId),
            eq(facilityUnits.outletId, outletId),
            eq(facilityUnits.facilityId, data.facilityId),
            eq(facilityUnits.id, data.unitId),
          ),
        )
        .limit(1);
      if (!unit)
        throw new CoreError("FORBIDDEN", "Incident unit outside outlet");
    }
    if (data.accessTicketId) {
      const [ticket] = await tx
        .select({ id: accessTickets.id, unitId: accessTickets.unitId })
        .from(accessTickets)
        .where(
          and(
            eq(accessTickets.tenantId, tenantId),
            eq(accessTickets.outletId, outletId),
            eq(accessTickets.facilityId, data.facilityId),
            eq(accessTickets.id, data.accessTicketId),
          ),
        )
        .limit(1);
      if (!ticket || (data.unitId !== null && ticket.unitId !== data.unitId))
        throw new CoreError(
          "FORBIDDEN",
          "Incident ticket outside unit or outlet",
        );
    }
    const inserted = await tx
      .insert(facilityIncidents)
      .values({
        id: data.incidentId,
        tenantId,
        outletId,
        facilityId: data.facilityId,
        unitId: data.unitId,
        accessTicketId: data.accessTicketId,
        type: data.type,
        triggeredAt: new Date(data.triggeredAt),
        offline: data.offline,
      })
      .onConflictDoNothing()
      .returning({ id: facilityIncidents.id });
    if (!inserted.length)
      throw new CoreError("CONFLICT", "Incident already exists");
    return;
  }
  if (
    event.name !== "facility_incident.responded" ||
    event.sequence !== 2 ||
    !data.respondedAt ||
    !data.respondedBy ||
    !data.resolution ||
    Date.parse(data.respondedAt) < Date.parse(data.triggeredAt)
  )
    throw new CoreError("VALIDATION_ERROR", "Invalid incident response");
  const [existing] = await tx
    .select()
    .from(facilityIncidents)
    .where(
      and(
        eq(facilityIncidents.tenantId, tenantId),
        eq(facilityIncidents.outletId, outletId),
        eq(facilityIncidents.id, data.incidentId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !existing ||
    existing.facilityId !== data.facilityId ||
    existing.unitId !== data.unitId ||
    existing.accessTicketId !== data.accessTicketId ||
    existing.type !== data.type ||
    existing.triggeredAt.toISOString() !== data.triggeredAt ||
    existing.offline !== data.offline
  )
    throw new CoreError("CONFLICT", "Incident identity does not match");
  await assertFacilityPermission(
    tx,
    meta.context,
    data.respondedBy,
    "facility.booth.operate",
    outletId,
  );
  if (existing.respondedAt) {
    if (
      existing.respondedAt.toISOString() === data.respondedAt &&
      existing.respondedBy === data.respondedBy &&
      existing.resolution === data.resolution
    )
      return;
    throw new CoreError("CONFLICT", "Incident already responded");
  }
  const rows = await tx
    .update(facilityIncidents)
    .set({
      respondedAt: new Date(data.respondedAt),
      respondedBy: data.respondedBy,
      resolution: data.resolution,
    })
    .where(
      and(
        eq(facilityIncidents.tenantId, tenantId),
        eq(facilityIncidents.outletId, outletId),
        eq(facilityIncidents.id, data.incidentId),
        eq(facilityIncidents.facilityId, data.facilityId),
        isNull(facilityIncidents.respondedAt),
      ),
    )
    .returning({ id: facilityIncidents.id });
  if (!rows.length)
    throw new CoreError("CONFLICT", "Incident response cannot be applied");
}

export function registerEmergencyEdgeApplier(): void {
  registerEdgeAggregateKind("facility_incident", "transaction_event");
  registerEdgeEventHandler(
    "edge_to_cloud",
    "facility_incident.raised",
    applyEdgeEmergency,
  );
  registerEdgeEventHandler(
    "edge_to_cloud",
    "facility_incident.responded",
    applyEdgeEmergency,
  );
}
