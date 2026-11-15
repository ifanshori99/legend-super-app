// Cloud side of the edge -> cloud `panic_alert.*` up-sync (bead legend-bod.5;
// design docs/design/edge-emergency.md D-06, D-09). The edge keeps one alert
// per press burst and queues raised / pressed / delivered / acknowledged; this
// handler runs in the cloud link's receive transaction (edge/db-link-store.ts
// applyInbound) and mirrors the state into the cloud's own panic_alerts.
//
// A safety record is never refused for a stale reference: when the room or the
// button was deleted in the cloud while the edge was offline, `raised` is still
// stored with its label snapshots and an `edge_sync_conflicts` row
// `panic_alert_unknown_ref` is written for a supervisor. Everything else
// fails closed (CoreError, recorded by the link as `applier_refused`).
//
// Every write is idempotent and monotonic: `raised` never overwrites an
// existing alert, counters only go up, the acknowledgement is set once. The
// link orders one stream, and a standby continues the primary's sequences, so
// the link accepts any aggregate sequence (as access-applier.ts) and these
// handlers keep the state correct themselves. The one event the cloud sends
// back is `panic_alert.resolved` (a manager closed the incident): the edge
// handler below closes its copy, see applyResolved.
import { and, eq, sql } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  isOutletInScope,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import type { OutletId, TenantId } from "@starter/shared/core";
import { conflictResolution } from "@starter/shared/edge";
import type { EventEnvelope } from "@starter/shared/events";
import {
  PANIC_ALERT_AGGREGATE_TYPE,
  panicAlertAcknowledgedEvent,
  panicAlertDeliveredEvent,
  panicAlertPressedEvent,
  panicAlertRaisedEvent,
  panicAlertResolvedEvent,
} from "@starter/shared/facility";
import { devices } from "../db/schema/device.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { facilityUnits } from "../db/schema/facility.ts";
import { panicAlerts, panicPressEvents } from "../db/schema/panic-alert.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { notifyEdgeSyncConflictRecorded } from "../services/edge-sync-conflict-alert.ts";
import { appendOutbox } from "../services/core-outbox.ts";
import { panicAlertIdFor } from "../services/panic-alert-outbox.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeAggregateLastSequence,
  registerEdgeEventHandler,
  type EdgeLastSequenceHook,
} from "./applier-registry.ts";
import { logger } from "../lib/logger.ts";
import { redactEdgeEnvelopeSecrets } from "./envelope-secrets.ts";
import type { EdgeApplyMeta } from "./ports.ts";

/** Outbox destination the notification worker reads (same as facility incidents). */
const PANIC_NOTIFICATION_DESTINATION = "notification";

export const PANIC_ALERT_UNKNOWN_REF_REASON = "panic_alert_unknown_ref";
export const PANIC_PRESS_ALERT_CONFLICT_REASON = "panic_press_alert_conflict";

/** Checks the envelope belongs to the node's tenant, outlet and this alert. */
async function assertEnvelope(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  alertId: string,
): Promise<{ tenantId: TenantId; outletId: OutletId }> {
  if (meta.direction !== "edge_to_cloud")
    throw new CoreError(
      "FORBIDDEN",
      "panic_alert events are only accepted from an edge",
    );
  const tenantId = meta.context.tenant.tenantId;
  if (event.tenantId !== tenantId)
    throw new CoreError("FORBIDDEN", "Event tenant does not match the context");
  const outletId = event.outletId;
  if (!outletId || !isOutletInScope(meta.context.outletScope, outletId))
    throw new CoreError("FORBIDDEN", "Event outlet is outside the node scope");
  const [node] = await tx
    .select({ outletId: edgeNodes.outletId })
    .from(edgeNodes)
    .where(
      and(eq(edgeNodes.tenantId, tenantId), eq(edgeNodes.id, meta.edgeNodeId)),
    );
  if (!node || node.outletId !== outletId)
    throw new CoreError(
      "FORBIDDEN",
      "Event outlet does not match the edge node",
    );
  if (
    event.aggregateType !== PANIC_ALERT_AGGREGATE_TYPE ||
    event.aggregateId !== alertId
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Event does not match its panic alert",
    );
  return { tenantId, outletId: outletId as OutletId };
}

/** The alert's outlet, or a refusal: later events need `raised` first. */
async function requireAlert(
  tx: EdgeTx,
  tenantId: TenantId,
  outletId: OutletId,
  alertId: string,
): Promise<void> {
  const [alert] = await tx
    .select({ outletId: panicAlerts.outletId })
    .from(panicAlerts)
    .where(
      and(eq(panicAlerts.tenantId, tenantId), eq(panicAlerts.id, alertId)),
    );
  if (!alert) throw new CoreError("NOT_FOUND", "Panic alert is not known");
  if (alert.outletId !== outletId)
    throw new CoreError("FORBIDDEN", "Alert belongs to another outlet");
}

/** Records the reference conflict once per event (idempotent), like the link. */
async function recordUnknownRef(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  outletId: string,
  detail: string,
): Promise<void> {
  await recordPanicConflict(
    tx,
    event,
    meta,
    outletId,
    PANIC_ALERT_UNKNOWN_REF_REASON,
    detail,
  );
}

async function recordPanicConflict(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  outletId: string,
  reason: string,
  detail: string,
): Promise<void> {
  const conflictId = createUlid();
  const inserted = await tx.execute(
    sql`INSERT INTO edge_sync_conflicts (id, tenant_id, outlet_id, edge_node_id, direction, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, reason, resolution, existing_sequence, detail, event) VALUES (${ulidToUuid(conflictId)}::uuid, ${meta.context.tenant.tenantId}::uuid, ${outletId}::uuid, ${meta.edgeNodeId}::uuid, ${meta.direction}, ${ulidToUuid(event.id)}::uuid, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${meta.kind}, ${reason}, ${conflictResolution(meta.kind)}, ${Math.max(0, event.sequence - 1)}, ${detail}, ${JSON.stringify(redactEdgeEnvelopeSecrets(event))}::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
  );
  if (inserted.rows.length === 0) return;
  // Supervisor alert in a savepoint: a missing alert never fails the batch
  // (the conflict row is the durable evidence), as in db-link-store.ts.
  try {
    await tx.transaction((savepoint) =>
      notifyEdgeSyncConflictRecorded(savepoint, meta.context, {
        id: conflictId,
        tenantId: tenantIdSchema.parse(meta.context.tenant.tenantId),
        outletId: outletIdSchema.parse(outletId),
        edgeNodeId: meta.edgeNodeId,
        aggregateType: event.aggregateType,
        reason,
      }),
    );
  } catch {
    // Intentionally silent: no payload or ids in logs (ports.ts rule).
  }
}

/**
 * Links a press to its alert. A press already linked to another alert (the
 * edge and the cloud disagree) keeps its first link: both alerts are stored
 * and an `edge_sync_conflicts` row is written for a supervisor (D-09).
 */
async function linkPress(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  link: {
    tenantId: TenantId;
    outletId: OutletId;
    deviceId: string;
    deviceEventId: string;
    alertId: string;
    receivedAt: string;
  },
): Promise<void> {
  const inserted = await tx
    .insert(panicPressEvents)
    .values({
      tenantId: link.tenantId,
      outletId: link.outletId,
      deviceId: link.deviceId,
      deviceEventId: link.deviceEventId,
      alertId: link.alertId,
      receivedAt: new Date(link.receivedAt),
    })
    .onConflictDoNothing()
    .returning({ alertId: panicPressEvents.alertId });
  if (inserted.length > 0) return;
  const [existing] = await tx
    .select({ alertId: panicPressEvents.alertId })
    .from(panicPressEvents)
    .where(
      and(
        eq(panicPressEvents.tenantId, link.tenantId),
        eq(panicPressEvents.deviceId, link.deviceId),
        eq(panicPressEvents.deviceEventId, link.deviceEventId),
      ),
    );
  if (!existing || existing.alertId === link.alertId) return;
  await recordPanicConflict(
    tx,
    event,
    meta,
    link.outletId,
    PANIC_PRESS_ALERT_CONFLICT_REASON,
    "The press is already linked to another alert in the cloud",
  );
}

async function applyRaised(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const parsed = panicAlertRaisedEvent.payloadSchema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Invalid panic_alert.raised payload",
    );
  const payload = parsed.data;
  const { tenantId, outletId } = await assertEnvelope(
    tx,
    event,
    meta,
    payload.alertId,
  );
  if (payload.outletId !== outletId)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Payload outlet does not match the event outlet",
    );
  // The id is derived from the first press, so a payload cannot name an id
  // that belongs to another device or event.
  if (
    payload.alertId !==
    panicAlertIdFor(tenantId, payload.deviceId, payload.firstDeviceEventId)
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Alert id does not match its first press",
    );

  const inserted = await tx
    .insert(panicAlerts)
    .values({
      id: payload.alertId,
      tenantId,
      outletId,
      deviceId: payload.deviceId,
      unitId: payload.unitId,
      firstDeviceEventId: payload.firstDeviceEventId,
      unitCodeSnapshot: payload.unitCodeSnapshot,
      facilityNameSnapshot: payload.facilityNameSnapshot,
      deviceLabelSnapshot: payload.deviceLabelSnapshot,
      kind: payload.kind,
      triggeredAt: payload.triggeredAt ? new Date(payload.triggeredAt) : null,
      receivedAt: new Date(payload.receivedAt),
      pressCount: 1,
      origin: "edge",
      originEdgeNodeId: meta.edgeNodeId,
      linkOffline: payload.linkOffline,
    })
    .onConflictDoNothing()
    .returning({ id: panicAlerts.id });
  await linkPress(tx, event, meta, {
    tenantId,
    outletId,
    deviceId: payload.deviceId,
    deviceEventId: payload.firstDeviceEventId,
    alertId: payload.alertId,
    receivedAt: payload.receivedAt,
  });
  // A re-delivered `raised` resets nothing and checks nothing twice.
  if (inserted.length === 0) return;

  // FAC-08 (legend-kmjax): page the staff on duty outside the LAN. Only the
  // first insert queues it, in this same transaction, so a replay never pages
  // twice. The worker rule (panicAlertRaisedRule) picks the recipients.
  await appendOutbox(tx, meta.context, {
    id: createUlid(),
    event,
    destination: PANIC_NOTIFICATION_DESTINATION,
    direction: null,
    peerId: null,
  });

  const [device] = await tx
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(eq(devices.tenantId, tenantId), eq(devices.id, payload.deviceId)),
    );
  let unitKnown = true;
  if (payload.unitId) {
    const [unit] = await tx
      .select({ id: facilityUnits.id })
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, tenantId),
          eq(facilityUnits.id, payload.unitId),
        ),
      );
    unitKnown = Boolean(unit);
  }
  if (!device || !unitKnown)
    await recordUnknownRef(
      tx,
      event,
      meta,
      outletId,
      !device
        ? "The alert's button no longer exists in the cloud"
        : "The alert's room no longer exists in the cloud",
    );
}

async function applyPressed(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const parsed = panicAlertPressedEvent.payloadSchema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Invalid panic_alert.pressed payload",
    );
  const payload = parsed.data;
  const { tenantId, outletId } = await assertEnvelope(
    tx,
    event,
    meta,
    payload.alertId,
  );
  await requireAlert(tx, tenantId, outletId, payload.alertId);
  await linkPress(tx, event, meta, {
    tenantId,
    outletId,
    deviceId: payload.deviceId,
    deviceEventId: payload.deviceEventId,
    alertId: payload.alertId,
    receivedAt: payload.receivedAt,
  });
  // The count never goes down: keep the higher of the two.
  await tx
    .update(panicAlerts)
    .set({
      pressCount: sql`GREATEST(${panicAlerts.pressCount}, ${payload.pressCount})`,
    })
    .where(
      and(
        eq(panicAlerts.tenantId, tenantId),
        eq(panicAlerts.id, payload.alertId),
      ),
    );
}

async function applyDelivered(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const parsed = panicAlertDeliveredEvent.payloadSchema.safeParse(
    event.payload,
  );
  if (!parsed.success)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Invalid panic_alert.delivered payload",
    );
  const payload = parsed.data;
  const { tenantId, outletId } = await assertEnvelope(
    tx,
    event,
    meta,
    payload.alertId,
  );
  await requireAlert(tx, tenantId, outletId, payload.alertId);
  const first = payload.firstDeliveredAt
    ? new Date(payload.firstDeliveredAt)
    : null;
  const fallback = payload.fallbackShownAt
    ? new Date(payload.fallbackShownAt)
    : null;
  await tx
    .update(panicAlerts)
    .set({
      deliveredCount: sql`GREATEST(${panicAlerts.deliveredCount}, ${payload.deliveredCount})`,
      firstDeliveredAt: sql`CASE WHEN ${first}::timestamptz IS NULL THEN ${panicAlerts.firstDeliveredAt} WHEN ${panicAlerts.firstDeliveredAt} IS NULL THEN ${first}::timestamptz ELSE LEAST(${panicAlerts.firstDeliveredAt}, ${first}::timestamptz) END`,
      fallbackShownAt: sql`COALESCE(${panicAlerts.fallbackShownAt}, ${fallback}::timestamptz)`,
    })
    .where(
      and(
        eq(panicAlerts.tenantId, tenantId),
        eq(panicAlerts.id, payload.alertId),
      ),
    );
}

async function applyAcknowledged(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const parsed = panicAlertAcknowledgedEvent.payloadSchema.safeParse(
    event.payload,
  );
  if (!parsed.success)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Invalid panic_alert.acknowledged payload",
    );
  const payload = parsed.data;
  const { tenantId, outletId } = await assertEnvelope(
    tx,
    event,
    meta,
    payload.alertId,
  );
  await requireAlert(tx, tenantId, outletId, payload.alertId);
  // Set once: a later acknowledgement (edge or cloud) never replaces the first.
  await tx
    .update(panicAlerts)
    .set({
      acknowledgedAt: new Date(payload.acknowledgedAt),
      acknowledgedBy: payload.acknowledgedBy,
      ackDeviceId: payload.ackDeviceId,
    })
    .where(
      and(
        eq(panicAlerts.tenantId, tenantId),
        eq(panicAlerts.id, payload.alertId),
        sql`${panicAlerts.acknowledgedAt} IS NULL`,
      ),
    );
}

/**
 * Edge side of the cloud -> edge `panic_alert.resolved` (G2). A manager closed
 * the incident in the cloud: the edge stores `resolved_*` set once, and counts
 * the resolve as the acknowledgement when nobody acknowledged (D-07; no ack
 * device). An acknowledged alert leaves the open-alert reads, so the resend
 * loop stops, the POS fallback drops it and a socket that connects later never
 * gets it. A replay changes nothing. An alert the edge does not know is a
 * logged no-op, not a conflict: the cloud also queues a failover copy of the
 * resolve for a node that never held the alert, and there is nothing to close.
 * The event counts as applied (no `edge_sync_conflicts` row, no supervisor
 * alarm).
 */
async function applyResolved(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  if (meta.direction !== "cloud_to_edge")
    throw new CoreError(
      "FORBIDDEN",
      "panic_alert.resolved is only accepted from the cloud",
    );
  const parsed = panicAlertResolvedEvent.payloadSchema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Invalid panic_alert.resolved payload",
    );
  const payload = parsed.data;
  const tenantId = meta.context.tenant.tenantId;
  const outletId = event.outletId;
  if (event.tenantId !== tenantId)
    throw new CoreError("FORBIDDEN", "Event tenant does not match the context");
  if (!outletId || !isOutletInScope(meta.context.outletScope, outletId))
    throw new CoreError("FORBIDDEN", "Event outlet is outside the node scope");
  if (
    event.aggregateType !== PANIC_ALERT_AGGREGATE_TYPE ||
    event.aggregateId !== payload.alertId
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Event does not match its panic alert",
    );
  const [alert] = await tx
    .select({ outletId: panicAlerts.outletId })
    .from(panicAlerts)
    .where(
      and(
        eq(panicAlerts.tenantId, tenantId),
        eq(panicAlerts.id, payload.alertId),
      ),
    );
  if (!alert) {
    // Ids only (ports.ts rule: no payload in logs).
    logger.info(
      { alertId: payload.alertId, outletId },
      "Ignored panic_alert.resolved for an alert this edge does not hold",
    );
    return;
  }
  if (alert.outletId !== outletId)
    throw new CoreError("FORBIDDEN", "Alert belongs to another outlet");
  const resolvedAt = new Date(payload.resolvedAt);
  // COALESCE keeps every set-once column as it is: the first resolve and the
  // first acknowledgement (edge or cloud) win, a replay writes the same values.
  await tx
    .update(panicAlerts)
    .set({
      resolvedAt: sql`COALESCE(${panicAlerts.resolvedAt}, ${resolvedAt}::timestamptz)`,
      resolvedBy: sql`COALESCE(${panicAlerts.resolvedBy}, ${payload.resolvedBy})`,
      resolutionNote: sql`CASE WHEN ${panicAlerts.resolvedAt} IS NULL THEN ${payload.resolutionNote}::varchar ELSE ${panicAlerts.resolutionNote} END`,
      acknowledgedAt: sql`COALESCE(${panicAlerts.acknowledgedAt}, ${resolvedAt}::timestamptz)`,
      acknowledgedBy: sql`COALESCE(${panicAlerts.acknowledgedBy}, ${payload.resolvedBy})`,
    })
    .where(
      and(
        eq(panicAlerts.tenantId, tenantId),
        eq(panicAlerts.id, payload.alertId),
      ),
    );
}

/**
 * The link accepts any aggregate sequence of `panic_alert` (see the header):
 * its default would also count the sender's own queue, which a database that
 * is both edge and cloud (the tests, a promoted standby) would read as a
 * duplicate of every event.
 */
const acceptIncomingSequence: EdgeLastSequenceHook = async (_tx, aggregate) =>
  aggregate.sequence === undefined ? null : aggregate.sequence - 1;

/**
 * Boot (registerEdgeLink, edge runtime): routes the four edge `panic_alert.*`
 * events (cloud) and the cloud's `panic_alert.resolved` (edge) to their
 * handlers and classifies the aggregate as an append-only transaction
 * event. Idempotent.
 */
export function registerPanicAlertEdgeApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    panicAlertRaisedEvent.name,
    applyRaised,
  );
  registerEdgeEventHandler(
    "edge_to_cloud",
    panicAlertPressedEvent.name,
    applyPressed,
  );
  registerEdgeEventHandler(
    "edge_to_cloud",
    panicAlertDeliveredEvent.name,
    applyDelivered,
  );
  registerEdgeEventHandler(
    "edge_to_cloud",
    panicAlertAcknowledgedEvent.name,
    applyAcknowledged,
  );
  registerEdgeEventHandler(
    "cloud_to_edge",
    panicAlertResolvedEvent.name,
    applyResolved,
  );
  registerEdgeAggregateKind(PANIC_ALERT_AGGREGATE_TYPE, "transaction_event");
  registerEdgeAggregateLastSequence(
    "edge_to_cloud",
    PANIC_ALERT_AGGREGATE_TYPE,
    acceptIncomingSequence,
  );
  // The edge already holds its own `raised` (sequence 1 and up, edge_to_cloud)
  // of the same alert: the default would count that queue and read the cloud's
  // first `resolved` (sequence 1) as a collision.
  registerEdgeAggregateLastSequence(
    "cloud_to_edge",
    PANIC_ALERT_AGGREGATE_TYPE,
    acceptIncomingSequence,
  );
}
