// Edge -> cloud outbox of the emergency button (bead legend-bod; design
// docs/design/edge-emergency.md D-09). Every state change of a `panic_alerts`
// row queues one `panic_alert.*` event on the SAME transaction, so the change
// and its event commit together or not at all. The cloud applier
// (edge/panic-alert-applier.ts) dedupes by event id and aggregate sequence.
//
// Aggregate `panic_alert`, aggregate id = alert id. `raised` is sequence 1; the
// next sequence is read under a row lock on the alert, so two writers (press
// fold, receipt batch, acknowledge) cannot take the same number. Resolve is
// cloud-only: it travels cloud -> edge through `queuePanicAlertResolvedToEdge`,
// a separate stream with its own sequence, and never through the edge writer.
import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { CoreError, createUlid } from "@starter/shared/core";
import type {
  OutletId,
  ScopedTenantContext,
  TenantId,
} from "@starter/shared/core";
import {
  PANIC_ALERT_AGGREGATE_TYPE,
  panicAlertEvents,
  panicAlertIdFromDigest,
  panicAlertIdMaterial,
  type PanicAlertEventKey,
} from "@starter/shared/facility";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { panicAlerts } from "../db/schema/panic-alert.ts";
import { enqueueEdgeEvent, type EdgeTx } from "./edge-queue.service.ts";
import { isPanicEdgeProcess } from "./panic-edge-ownership.ts";

/** The alert id of a press burst: SHA-256(tenant, device, first event id), v5-shaped. */
export function panicAlertIdFor(
  tenantId: string,
  deviceId: string,
  firstDeviceEventId: string,
): string {
  return panicAlertIdFromDigest(
    createHash("sha256")
      .update(panicAlertIdMaterial(tenantId, deviceId, firstDeviceEventId))
      .digest(),
  );
}

/** The active edge node of the outlet, or null (a cloud-only outlet queues nothing). */
export async function activePanicEdgeNodeId(
  tx: EdgeTx,
  tenantId: string,
  outletId: string,
): Promise<string | null> {
  const [node] = await tx
    .select({ id: edgeNodes.id })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, tenantId as TenantId),
        eq(edgeNodes.outletId, outletId as OutletId),
        eq(edgeNodes.status, "active"),
      ),
    )
    .orderBy(asc(edgeNodes.createdAt))
    .limit(1);
  return node?.id ?? null;
}

/** The events the edge writes (edge -> cloud); `resolved` is cloud -> edge. */
type PanicAlertEdgeEventKey = Exclude<PanicAlertEventKey, "resolved">;

type PayloadOf<K extends PanicAlertEventKey> = z.input<
  (typeof panicAlertEvents)[K]["payloadSchema"]
>;

/** One event to queue: the key picks the name, the payload is validated by it. */
export type PanicAlertOutboxEvent = {
  [K in PanicAlertEdgeEventKey]: { key: K; payload: PayloadOf<K> };
}[PanicAlertEdgeEventKey];

function envelopeActor(event: PanicAlertOutboxEvent) {
  switch (event.key) {
    case "raised":
    case "pressed":
      return { type: "device" as const, id: event.payload.deviceId };
    case "acknowledged":
      return { type: "user" as const, id: event.payload.acknowledgedBy };
    case "delivered":
      return { type: "system" as const };
  }
}

function envelopeDeviceId(event: PanicAlertOutboxEvent): string | null {
  switch (event.key) {
    case "raised":
    case "pressed":
      return event.payload.deviceId;
    case "acknowledged":
      return event.payload.ackDeviceId;
    case "delivered":
      return null;
  }
}

/**
 * Queues one `panic_alert.*` event edge -> cloud on the caller's transaction.
 * The `panic_alerts` row must already exist (insert it first for `raised`).
 * Call it only when the state really changed: every call queues a new event.
 * Returns the queued sequence, or null when this server is not an edge node or
 * the outlet has no active edge node (the cloud never queues edge -> cloud events).
 */
export async function queuePanicAlertEvent(
  tx: EdgeTx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    alertId: string;
    event: PanicAlertOutboxEvent;
    now?: Date;
    /** Skip the node lookup when the caller already has it. */
    edgeNodeId?: string;
  },
): Promise<number | null> {
  if (!isPanicEdgeProcess()) return null;
  const tenantId = context.tenant.tenantId;
  const edgeNodeId =
    input.edgeNodeId ??
    (await activePanicEdgeNodeId(tx, tenantId, input.outletId));
  if (!edgeNodeId) return null;
  if (input.event.payload.alertId !== input.alertId)
    throw new CoreError("VALIDATION_ERROR", "Event alert does not match");
  // Row lock: serialises the sequence number of this aggregate.
  const [alert] = await tx
    .select({ id: panicAlerts.id })
    .from(panicAlerts)
    .where(
      and(
        eq(panicAlerts.tenantId, tenantId),
        eq(panicAlerts.id, input.alertId),
      ),
    )
    .for("update");
  if (!alert) throw new CoreError("NOT_FOUND", "Panic alert not found");
  const last = await tx.execute(
    sql`SELECT MAX(aggregate_sequence) AS last FROM edge_outbound_queue WHERE edge_node_id = ${edgeNodeId}::uuid AND direction = 'edge_to_cloud' AND aggregate_type = ${PANIC_ALERT_AGGREGATE_TYPE} AND aggregate_id = ${input.alertId}`,
  );
  const sequence = Number(last.rows[0]?.last ?? 0) + 1;
  // `raised` is idempotent: a replay of the first press (a standby database
  // that lost the alert row) must not queue a second `raised` nor fail.
  if (input.event.key === "raised" && sequence !== 1) return 1;
  const definition = panicAlertEvents[input.event.key];
  const now = input.now ?? new Date();
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: PANIC_ALERT_AGGREGATE_TYPE,
    aggregateId: input.alertId,
    sequence,
    occurredAt: now.toISOString(),
    actor: envelopeActor(input.event),
    deviceId: envelopeDeviceId(input.event),
    idempotencyKey: `${PANIC_ALERT_AGGREGATE_TYPE}:${input.alertId}:${sequence}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.event.payload,
  });
  await enqueueEdgeEvent(tx, context, {
    edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    event,
  });
  return sequence;
}

/**
 * Queues `panic_alert.resolved` cloud -> edge on the caller's transaction (the
 * cloud resolve, G1). Call it only when the resolve really changed the alert.
 * Aggregate `panic_alert`, id = alert id; the cloud -> edge stream has its own
 * sequence per (edge node, direction, aggregate), so it never meets the edge
 * writer. Returns the queued sequence, or null when the outlet has no active
 * edge node (a cloud-only outlet queues nothing).
 */
export async function queuePanicAlertResolvedToEdge(
  tx: EdgeTx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    alertId: string;
    payload: PayloadOf<"resolved">;
    now?: Date;
  },
): Promise<number | null> {
  const tenantId = context.tenant.tenantId;
  const edgeNodeId = await activePanicEdgeNodeId(tx, tenantId, input.outletId);
  if (!edgeNodeId) return null;
  if (input.payload.alertId !== input.alertId)
    throw new CoreError("VALIDATION_ERROR", "Event alert does not match");
  const last = await tx.execute(
    sql`SELECT MAX(aggregate_sequence) AS last FROM edge_outbound_queue WHERE edge_node_id = ${edgeNodeId}::uuid AND direction = 'cloud_to_edge' AND aggregate_type = ${PANIC_ALERT_AGGREGATE_TYPE} AND aggregate_id = ${input.alertId}`,
  );
  const sequence = Number(last.rows[0]?.last ?? 0) + 1;
  const definition = panicAlertEvents.resolved;
  const now = input.now ?? new Date();
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: PANIC_ALERT_AGGREGATE_TYPE,
    aggregateId: input.alertId,
    sequence,
    occurredAt: now.toISOString(),
    actor: { type: "user" as const, id: input.payload.resolvedBy },
    deviceId: null,
    idempotencyKey: `${PANIC_ALERT_AGGREGATE_TYPE}:${input.alertId}:resolved:${sequence}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await enqueueEdgeEvent(tx, context, {
    edgeNodeId,
    direction: "cloud_to_edge",
    kind: "transaction_event",
    event,
  });
  return sequence;
}
