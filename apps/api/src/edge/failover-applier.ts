// Failover window on the edge (1271 F4; docs/briefs/1271-edge-failover-cards.md
// D2, D4, F1 ralat). Cloud -> edge, aggregate `pos_failover_window`:
//
// - `pos_failover_window.state` (full window, master data): upserts the edge's
//   copy of the window (same table as the cloud; `idempotency_key` = window
//   id). While the copy is `active`/`returning` the POS write gate refuses
//   every edge sale, shift and drawer write (FAILOVER_ACTIVE,
//   services/pos-edge-outlet.ts). A state never lifts the block of a return:
//   only the closing event closes the copy.
// - `pos_failover_window.closed` (the last event of the window): in ONE
//   transaction, closes every listed device's interrupted edge shift with its
//   switchover count C1 (services/pos-shift-failover-close.ts) and marks the
//   copy closed, which lifts the block. A replay is a no-op: the link skips a
//   known event id, a final copy is left alone, a shift closed by the window
//   is not found open again.
// - Split brain or no usable approver: nothing is closed, the copy stays
//   open (the edge keeps refusing POS writes: never two sellers), an
//   `edge_sync_conflicts` row keeps the event, and a
//   `pos_failover_edge_refusal.recorded` notice goes up so the cloud alerts
//   the outlet's managers (the edge has no staff to alert).
//
// Edge -> cloud (cloud side): the refusal notice notifies the outlet's
// supervisors and owners once (notification id = event id).
//
// Fail closed like the other appliers: a wrong direction, tenant, outlet or
// payload is a CoreError (the link records an `applier_refused` conflict).
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  CoreError,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
  type OutletId,
  type TenantId,
} from "@starter/shared/core";
import {
  conflictResolution,
  FAILOVER_EDGE_REFUSAL_AGGREGATE,
  FAILOVER_WINDOW_AGGREGATE,
  failoverEdgeRefusedEvent,
  failoverWindowClosedEvent,
  failoverWindowClosedPayloadSchema,
  failoverWindowStateEvent,
  failoverWindowStatePayloadSchema,
  type FailoverWindow,
  type FailoverWindowStatus,
} from "@starter/shared/edge";
import type { EventEnvelope } from "@starter/shared/events";
import { outletFailoverWindows } from "../db/schema/edge-failover.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import type { FailoverWindowRow } from "../services/edge-failover-window.ts";
import {
  enqueueEdgeEvent,
  type EdgeTx,
} from "../services/edge-queue.service.ts";
import { notifyOutletSupervisors } from "../services/edge-sync-conflict-alert.ts";
import {
  closeShiftsForFailoverReturn,
  type FailoverCloseRefusal,
} from "../services/pos-shift-failover-close.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import { assertEdgeEventScope } from "./deferred-event-applier.ts";
import { redactEdgeEnvelopeSecrets } from "./envelope-secrets.ts";
import type { EdgeApplyMeta } from "./ports.ts";

// ------------------------------------------------------------------ edge side

const RANK: Record<FailoverWindowStatus, number> = {
  active: 0,
  returning: 1,
  closed: 2,
  cancelled: 2,
};

const isFinal = (status: FailoverWindowStatus) =>
  status === "closed" || status === "cancelled";

/** Cloud -> edge scope: the context's tenant and this node's own outlet. */
async function assertCloudEventScope(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<OutletId> {
  if (meta.direction !== "cloud_to_edge")
    throw new CoreError("FORBIDDEN", `${event.name} only comes from the cloud`);
  const tenantId = meta.context.tenant.tenantId;
  if (event.tenantId !== tenantId)
    throw new CoreError("FORBIDDEN", "Event tenant does not match the context");
  if (event.aggregateType !== FAILOVER_WINDOW_AGGREGATE)
    throw new CoreError("VALIDATION_ERROR", "Wrong failover aggregate type");
  const [node] = await tx
    .select({ outletId: edgeNodes.outletId })
    .from(edgeNodes)
    .where(
      and(eq(edgeNodes.tenantId, tenantId), eq(edgeNodes.id, meta.edgeNodeId)),
    );
  if (!node || !event.outletId || node.outletId !== event.outletId)
    throw new CoreError(
      "FORBIDDEN",
      "Event outlet does not match the edge node",
    );
  return outletIdSchema.parse(node.outletId);
}

async function lockCopy(
  tx: EdgeTx,
  tenantId: TenantId,
  windowId: string,
): Promise<FailoverWindowRow | null> {
  const [row] = await tx
    .select()
    .from(outletFailoverWindows)
    .where(
      and(
        eq(outletFailoverWindows.tenantId, tenantId),
        eq(outletFailoverWindows.id, windowId),
      ),
    )
    .for("update");
  return row ?? null;
}

const dateOrNull = (value: string | null) =>
  value === null ? null : new Date(value);

/** The window's node when this database holds it, else this node. */
async function copyNodeId(
  tx: EdgeTx,
  tenantId: TenantId,
  outletId: OutletId,
  window: FailoverWindow,
  meta: EdgeApplyMeta,
): Promise<string> {
  const [node] = await tx
    .select({ id: edgeNodes.id })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, tenantId),
        eq(edgeNodes.outletId, outletId),
        eq(edgeNodes.id, window.edgeNodeId),
      ),
    );
  return node?.id ?? meta.edgeNodeId;
}

/** Applies `pos_failover_window.state` to the edge copy. */
export async function applyFailoverWindowState(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertCloudEventScope(tx, event, meta);
  const parsed = failoverWindowStatePayloadSchema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError("VALIDATION_ERROR", "Invalid failover window state");
  const window = parsed.data.window;
  if (window.outletId !== outletId || event.aggregateId !== window.id)
    throw new CoreError("VALIDATION_ERROR", "Window does not match its event");
  const tenantId = meta.context.tenant.tenantId;
  // Only the closing event closes the copy (it closes the shifts with it).
  const status: FailoverWindowStatus =
    window.status === "closed" ? "returning" : window.status;
  const returning = status === "returning";
  const copy = await lockCopy(tx, tenantId, window.id);
  const now = new Date();
  if (!copy) {
    await tx.insert(outletFailoverWindows).values({
      id: window.id,
      tenantId,
      outletId,
      edgeNodeId: await copyNodeId(tx, tenantId, outletId, window, meta),
      status,
      reason: window.reason,
      override: window.override,
      // F1 ralat: the copy's idempotency key is the window id.
      idempotencyKey: window.id,
      activatedBy: window.activatedBy,
      activatedAt: new Date(window.activatedAt),
      edgeHeartbeatAt: dateOrNull(window.edgeHeartbeatAt),
      businessDateFrom: window.businessDateFrom,
      businessDateTo: window.businessDateTo,
      returnStartedAt: returning ? dateOrNull(window.returnStartedAt) : null,
      returnStartedBy: returning ? window.returnStartedBy : null,
      cancelledAt: dateOrNull(window.cancelledAt),
      cancelledBy: window.cancelledBy,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  // Final, or not newer than the copy: nothing to change.
  if (isFinal(copy.status) || RANK[status] <= RANK[copy.status]) return;
  if (copy.status === "returning" && status === "cancelled")
    throw new CoreError("CONFLICT", "A returning window cannot be cancelled");
  await tx
    .update(outletFailoverWindows)
    .set({
      status,
      businessDateTo: window.businessDateTo,
      returnStartedAt: returning ? dateOrNull(window.returnStartedAt) : null,
      returnStartedBy: returning ? window.returnStartedBy : null,
      cancelledAt: dateOrNull(window.cancelledAt),
      cancelledBy: window.cancelledBy,
      updatedAt: now,
    })
    .where(
      and(
        eq(outletFailoverWindows.tenantId, tenantId),
        eq(outletFailoverWindows.id, window.id),
      ),
    );
}

function refusalNoticeId(closingEventId: string): string {
  const hex = createHash("sha256")
    .update(`${FAILOVER_EDGE_REFUSAL_AGGREGATE}\0${closingEventId}`)
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/** Keeps the refused closing event and tells the cloud (one notice per event). */
async function recordRefusal(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  outletId: OutletId,
  windowId: string,
  refused: FailoverCloseRefusal[],
): Promise<void> {
  const tenantId = meta.context.tenant.tenantId;
  const detail = refused
    .map((entry) => `${entry.reason}:${entry.shiftId}`)
    .join(",")
    .slice(0, 500);
  await tx.execute(
    sql`INSERT INTO edge_sync_conflicts (id, tenant_id, outlet_id, edge_node_id, direction, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, reason, resolution, existing_sequence, detail, event) VALUES (gen_random_uuid(), ${tenantId}::uuid, ${outletId}::uuid, ${meta.edgeNodeId}::uuid, ${meta.direction}, ${ulidToUuid(event.id)}::uuid, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${meta.kind}, 'applier_refused', ${conflictResolution(meta.kind)}, ${Math.max(0, event.sequence - 1)}, ${detail}, ${JSON.stringify(redactEdgeEnvelopeSecrets(event))}::jsonb) ON CONFLICT DO NOTHING`,
  );
  const id = refusalNoticeId(event.id);
  const definition = failoverEdgeRefusedEvent;
  await enqueueEdgeEvent(tx, meta.context, {
    edgeNodeId: meta.edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    event: definition.envelopeSchema.parse({
      id,
      tenantId,
      outletId,
      name: definition.name,
      version: definition.version,
      aggregateType: FAILOVER_EDGE_REFUSAL_AGGREGATE,
      aggregateId: id,
      sequence: 1,
      occurredAt: new Date().toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `${definition.name}:${id}`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: {
        windowId,
        closingEventId: event.id,
        shifts: refused,
      },
    }),
  });
}

/** Applies `pos_failover_window.closed`: shifts closed with C1, copy closed. */
export async function applyFailoverWindowClosed(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertCloudEventScope(tx, event, meta);
  const parsed = failoverWindowClosedPayloadSchema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError("VALIDATION_ERROR", "Invalid failover closing event");
  const payload = parsed.data;
  if (event.aggregateId !== payload.windowId)
    throw new CoreError("VALIDATION_ERROR", "Window does not match its event");
  const tenantId = meta.context.tenant.tenantId;
  const copy = await lockCopy(tx, tenantId, payload.windowId);
  if (copy && copy.outletId !== outletId)
    throw new CoreError("FORBIDDEN", "Window of another outlet");
  // Replay, or the copy already ended.
  if (copy && isFinal(copy.status)) return;
  const now = new Date();
  const actorId = event.actor.type === "user" ? event.actor.id : null;
  const lastDate =
    payload.businessDates[payload.businessDates.length - 1] ?? null;

  if (payload.status === "cancelled") {
    // A cancel is only possible before any failover shift (F3).
    if (payload.shifts.length > 0)
      throw new CoreError("VALIDATION_ERROR", "A cancel closes no shift");
    if (!copy) return;
    if (copy.status !== "active")
      throw new CoreError("CONFLICT", "A returning window cannot be cancelled");
    if (actorId === null)
      throw new CoreError("VALIDATION_ERROR", "A cancel names its manager");
    await tx
      .update(outletFailoverWindows)
      .set({
        status: "cancelled",
        cancelledAt: new Date(event.occurredAt),
        cancelledBy: actorId,
        businessDateTo:
          copy.businessDateTo ?? lastDate ?? copy.businessDateFrom,
        closingEventId: ulidToUuid(event.id),
        updatedAt: now,
      })
      .where(
        and(
          eq(outletFailoverWindows.tenantId, tenantId),
          eq(outletFailoverWindows.id, copy.id),
        ),
      );
    return;
  }

  const managers = [
    copy?.activatedBy ?? null,
    copy?.returnStartedBy ?? null,
    actorId,
  ].filter((id): id is string => id !== null);
  const result = await closeShiftsForFailoverReturn(tx, meta.context, {
    outletId,
    windowId: payload.windowId,
    closingEventId: ulidToUuid(event.id),
    managers: [...new Set(managers)],
    shifts: payload.shifts,
    now,
  });
  if (result.refused.length > 0) {
    // D2: never guesses. The copy stays open, so the edge keeps refusing.
    await recordRefusal(
      tx,
      event,
      meta,
      outletId,
      payload.windowId,
      result.refused,
    );
    return;
  }
  if (!copy) return;
  if (copy.status === "active") {
    // The `returning` state never arrived (dead letter): step through it.
    if (actorId === null)
      throw new CoreError("VALIDATION_ERROR", "A return names its manager");
    await tx
      .update(outletFailoverWindows)
      .set({
        status: "returning",
        returnStartedAt: new Date(event.occurredAt),
        returnStartedBy: actorId,
        businessDateTo: lastDate ?? copy.businessDateFrom,
        updatedAt: now,
      })
      .where(
        and(
          eq(outletFailoverWindows.tenantId, tenantId),
          eq(outletFailoverWindows.id, copy.id),
        ),
      );
  }
  await tx
    .update(outletFailoverWindows)
    .set({
      status: "closed",
      closedAt: now,
      closingEventId: copy.closingEventId ?? ulidToUuid(event.id),
      updatedAt: now,
    })
    .where(
      and(
        eq(outletFailoverWindows.tenantId, tenantId),
        eq(outletFailoverWindows.id, copy.id),
      ),
    );
}

/**
 * Edge boot (startEdgeRuntime): routes the window events to the edge copy.
 * The window aggregate is master data on the receiver (full state, cloud
 * wins, a newer sequence applies across a gap). Idempotent.
 */
export function registerFailoverEdgeApplier(): void {
  registerEdgeEventHandler(
    "cloud_to_edge",
    failoverWindowStateEvent.name,
    applyFailoverWindowState,
  );
  registerEdgeEventHandler(
    "cloud_to_edge",
    failoverWindowClosedEvent.name,
    applyFailoverWindowClosed,
  );
  registerEdgeAggregateKind(FAILOVER_WINDOW_AGGREGATE, "master_data");
}

// ----------------------------------------------------------------- cloud side

/** Applies the edge's refusal notice: alert the outlet's managers once. */
export async function applyFailoverEdgeRefusal(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const parsed = failoverEdgeRefusedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success || event.aggregateId !== event.id || event.sequence !== 1)
    throw new CoreError("VALIDATION_ERROR", "Invalid failover refusal notice");
  const payload = parsed.data.payload;
  const [window] = await tx
    .select({ id: outletFailoverWindows.id })
    .from(outletFailoverWindows)
    .where(
      and(
        eq(outletFailoverWindows.tenantId, meta.context.tenant.tenantId),
        eq(outletFailoverWindows.outletId, outletId),
        eq(outletFailoverWindows.id, payload.windowId),
      ),
    );
  if (!window)
    throw new CoreError("NOT_FOUND", "Failover window of the notice not found");
  await notifyOutletSupervisors(
    tx,
    meta.context,
    {
      tenantId: tenantIdSchema.parse(meta.context.tenant.tenantId),
      outletId,
      alsoOwners: true,
      id: event.id,
      eventName: event.name,
      aggregateType: FAILOVER_EDGE_REFUSAL_AGGREGATE,
      aggregateId: event.id,
      payload: {
        windowId: payload.windowId,
        edgeNodeId: meta.edgeNodeId,
        shiftCount: String(payload.shifts.length),
        reason: payload.shifts[0]!.reason,
      },
      title: "Server lokal menolak penutupan mode cloud",
      body: "Shift di server lokal masih berjalan setelah laci dihitung, atau tidak ada manajer yang dikenal. Server lokal tetap mengunci kasir sampai diperiksa. Hubungi teknisi.",
    },
    new Date(),
  );
}

/** Cloud boot (registerEdgeLink): the edge's refusal notice. Idempotent. */
export function registerFailoverRefusalCloudApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    failoverEdgeRefusedEvent.name,
    applyFailoverEdgeRefusal,
  );
  registerEdgeAggregateKind(
    FAILOVER_EDGE_REFUSAL_AGGREGATE,
    "transaction_event",
  );
}
