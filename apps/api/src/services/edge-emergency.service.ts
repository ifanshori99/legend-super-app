import { and, eq, isNull, sql } from "drizzle-orm";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { edgeEmergencyDeliveries } from "../db/schema/edge-node.ts";
import { facilityIncidents, facilityUnits } from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { publishEmergency } from "../edge/emergency-realtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { enqueueEdgeEvent, type EdgeTx } from "./edge-queue.service.ts";

export async function isEmergencyOnDuty(
  userId: string,
  tenantId: string,
  outletId: string,
): Promise<boolean> {
  const { identity, edgeMode } = getEdgeRuntimeState();
  if (
    !edgeMode ||
    !identity ||
    identity.scope.tenantId !== tenantId ||
    identity.scope.outletId !== outletId
  )
    return false;
  return withTenant(db, identity.context, async (tx) => {
    const result = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM employees e
        WHERE e.tenant_id = ${tenantId}::uuid AND e.user_id = ${userId} AND e.status = 'active'
        AND (
          EXISTS (SELECT 1 FROM shift_assignments s CROSS JOIN LATERAL jsonb_array_elements(s.segments) seg
            WHERE s.tenant_id = e.tenant_id AND s.employee_id = e.id AND s.outlet_id = ${outletId}::uuid
              AND s.status IN ('published', 'swapped') AND (seg->>'startsAt')::timestamptz <= now() AND (seg->>'endsAt')::timestamptz > now())
          OR (SELECT a.type FROM attendance_logs a WHERE a.tenant_id = e.tenant_id AND a.employee_id = e.id
            AND a.outlet_id = ${outletId}::uuid AND a.occurred_at <= now() AND a.validity <> 'rejected'
            AND a.type IN ('in', 'out') ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1) = 'in'
        )
      ) AS on_duty`);
    return result.rows[0]?.on_duty === true;
  });
}

type Incident = typeof facilityIncidents.$inferSelect;
export async function queueEmergencyIncident(
  tx: EdgeTx,
  context: ScopedTenantContext,
  row: Incident,
  action: "raised" | "responded",
) {
  const state = getEdgeRuntimeState();
  const identity = state.identity;
  if (!state.edgeMode || !identity) return;
  if (
    identity.scope.tenantId !== row.tenantId ||
    identity.scope.outletId !== row.outletId
  )
    throw new Error("Incident outside edge scope");
  const name = `facility_incident.${action}`;
  const occurredAt = action === "raised" ? row.triggeredAt : row.respondedAt!;
  await enqueueEdgeEvent(tx, context, {
    edgeNodeId: identity.scope.edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    event: {
      id: createUlid(),
      tenantId: row.tenantId,
      outletId: row.outletId,
      name,
      version: 1,
      aggregateType: "facility_incident",
      aggregateId: row.id,
      sequence: action === "raised" ? 1 : 2,
      occurredAt: occurredAt.toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `${name}:${row.id}`,
      payloadSchemaRef: `${name}.v1`,
      payload: {
        incidentId: row.id,
        facilityId: row.facilityId,
        unitId: row.unitId,
        accessTicketId: row.accessTicketId,
        type: row.type,
        triggeredAt: row.triggeredAt.toISOString(),
        offline: row.offline,
        respondedAt: row.respondedAt?.toISOString() ?? null,
        respondedBy: row.respondedBy,
        resolution: row.resolution,
      },
    },
  });
}

export async function ingestEmergency(deviceId: string) {
  const { identity, edgeMode, link } = getEdgeRuntimeState();
  if (!edgeMode || !identity)
    throw new HttpError(503, "EDGE_NOT_READY", "Edge belum siap.");
  const row = await withTenant(db, identity.context, async (tx) => {
    const units = await tx
      .select()
      .from(facilityUnits)
      .where(
        and(
          eq(
            facilityUnits.tenantId,
            tenantIdSchema.parse(identity.scope.tenantId),
          ),
          eq(
            facilityUnits.outletId,
            outletIdSchema.parse(identity.scope.outletId),
          ),
          eq(facilityUnits.panicDeviceId, deviceId),
        ),
      )
      .limit(2);
    if (units.length !== 1)
      throw new HttpError(
        404,
        "PANIC_DEVICE_UNMAPPED",
        "Perangkat belum dipetakan ke bilik.",
      );
    const unit = units[0];
    const [incident] = await tx
      .insert(facilityIncidents)
      .values({
        tenantId: tenantIdSchema.parse(identity.scope.tenantId),
        outletId: outletIdSchema.parse(identity.scope.outletId),
        facilityId: unit.facilityId,
        unitId: unit.id,
        type: "panic",
        triggeredAt: new Date(),
        offline: link.cloudLink !== "connected",
      })
      .returning();
    await tx.insert(edgeEmergencyDeliveries).values({
      tenantId: incident.tenantId,
      outletId: incident.outletId,
      incidentId: incident.id,
    });
    await queueEmergencyIncident(tx, identity.context, incident, "raised");
    return incident;
  });
  void deliverPendingEmergency(identity.context, row).catch(() => {});
  return row;
}

async function deliverPendingEmergency(
  context: ScopedTenantContext,
  row: Incident,
): Promise<void> {
  if (!row.unitId) return;
  const count = await publishEmergency({
    tenantId: row.tenantId,
    outletId: row.outletId,
    incidentId: row.id,
    unitId: row.unitId,
    triggeredAt: row.triggeredAt.toISOString(),
  });
  if (count > 0)
    await withTenant(db, context, (tx) =>
      tx
        .update(edgeEmergencyDeliveries)
        .set({ deliveredAt: new Date() })
        .where(
          and(
            eq(edgeEmergencyDeliveries.tenantId, row.tenantId),
            eq(edgeEmergencyDeliveries.outletId, row.outletId),
            eq(edgeEmergencyDeliveries.incidentId, row.id),
            isNull(edgeEmergencyDeliveries.deliveredAt),
          ),
        ),
    );
}

export async function retryEmergencyIncidents(): Promise<void> {
  const { identity, edgeMode } = getEdgeRuntimeState();
  if (!edgeMode || !identity) return;
  const incidents = await withTenant(db, identity.context, (tx) =>
    tx
      .select({ incident: facilityIncidents })
      .from(edgeEmergencyDeliveries)
      .innerJoin(
        facilityIncidents,
        and(
          eq(facilityIncidents.tenantId, edgeEmergencyDeliveries.tenantId),
          eq(facilityIncidents.outletId, edgeEmergencyDeliveries.outletId),
          eq(facilityIncidents.id, edgeEmergencyDeliveries.incidentId),
        ),
      )
      .where(
        and(
          eq(
            edgeEmergencyDeliveries.tenantId,
            tenantIdSchema.parse(identity.scope.tenantId),
          ),
          eq(
            edgeEmergencyDeliveries.outletId,
            outletIdSchema.parse(identity.scope.outletId),
          ),
          isNull(facilityIncidents.respondedAt),
        ),
      ),
  );
  await Promise.all(
    incidents.map(({ incident }) =>
      deliverPendingEmergency(identity.context, incident),
    ),
  );
}
