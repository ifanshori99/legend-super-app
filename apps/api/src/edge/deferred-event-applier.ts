// Cloud side of the edge -> cloud events that are accepted but not applied yet
// (bead legend-9fhs). The edge queues every `cloud-sync` outbox row, including
// POS `order.*`. With no classifier the cloud link threw
// `EdgeEventUnclassifiedError` and rolled the whole batch back, so one order
// event stalled the link (and `stock.moved` behind it).
//
// This handler parks the full envelope in `edge_deferred_events`, idempotent
// by (tenant_id, event_id). It deliberately appends nothing to the cloud
// outbox and calls no domain service (no order mirror, recipe deduction or
// GL): the edge already deducted stock and `stock.moved` carries it. A future
// POS-order applier backfills from this table (bead legend-078n).
//
// Never re-emit onto the cloud outbox (legend-078n): the cloud worker would
// deduct stock a second time. Two guards enforce it, also for that future
// applier: edge/apply-scope.ts (appendOutbox refuses order.* / order_issue.recorded
// / day.closed inside an edge_to_cloud handler) and
// recipe-deduction.service.ts (deliverRecipeDeductionEvent skips an order that
// has a parked row here).
//
// Fail closed like stock-moved-applier.ts: a wrong direction, tenant or
// outlet throws a CoreError and the link records an `applier_refused`
// conflict instead of stalling.
import { and, eq } from "drizzle-orm";
import {
  CoreError,
  isOutletInScope,
  type OutletId,
} from "@starter/shared/core";
import { eventCatalog } from "@starter/shared/events";
import type { EventEnvelope } from "@starter/shared/events";
import { RECEIPT_RUN_AGGREGATE } from "@starter/shared/pos";
import { logger } from "../lib/logger.ts";
import { edgeDeferredEvents } from "../db/schema/edge-deferred-event.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { notifyEdgeEventParkedUnclassified } from "../services/edge-sync-conflict-alert.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
  setEdgeDefaultAggregateKind,
  setEdgeUnhandledEventHandler,
} from "./applier-registry.ts";
import type { EdgeEventHandler } from "./applier-registry.ts";
import { redactEdgeEnvelopeSecrets } from "./envelope-secrets.ts";
import type { EdgeApplyMeta } from "./ports.ts";

/** Aggregate type of the POS order events (`order.paid`, ...). */
export const ORDER_AGGREGATE = "order";

/** Every catalog event name of `aggregateType` (`order` -> `order.*`). */
export function catalogEventNamesOf(aggregateType: string): string[] {
  const prefix = `${aggregateType}.`;
  return eventCatalog
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(prefix));
}

/** Why an event sits in the deferred inbox. */
export type EdgeParkedReason = "deferred" | "unclassified";

/**
 * Fail-closed scope of one edge -> cloud event (shared by every edge
 * applier): edge direction, the context's tenant, an outlet inside the node
 * scope that is the edge node's own outlet. Returns the outlet id. Throws a
 * CoreError (the link records an `applier_refused` conflict).
 */
export async function assertEdgeEventScope(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<OutletId> {
  if (meta.direction !== "edge_to_cloud")
    throw new CoreError(
      "FORBIDDEN",
      `${event.name} is only accepted from an edge`,
    );
  const tenantId = meta.context.tenant.tenantId;
  if (event.tenantId !== tenantId)
    throw new CoreError("FORBIDDEN", "Event tenant does not match the context");
  const outletId = event.outletId;
  // Defence in depth: through the link an outlet-less event never gets here.
  // The edge queue refuses it (edge-queue.service.ts) and db-link-store
  // rejects an outlet other than the node's before the applier runs.
  if (!outletId)
    throw new CoreError("CONFLICT", "Event has no outlet; it cannot be parked");
  if (!isOutletInScope(meta.context.outletScope, outletId))
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
  return outletId;
}

/**
 * Parks one edge event in the deferred inbox; replays write nothing.
 * `parkedReason`: "deferred" for an explicit WS-04 registration,
 * "unclassified" for the generic fallback. Returns true only when this call
 * inserted the row (false on a replay).
 */
export async function applyEdgeDeferredEvent(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  parkedReason: EdgeParkedReason = "deferred",
): Promise<boolean> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const tenantId = meta.context.tenant.tenantId;

  const inserted = await tx
    .insert(edgeDeferredEvents)
    .values({
      tenantId,
      outletId,
      edgeNodeId: meta.edgeNodeId,
      eventId: event.id,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateSequence: event.sequence,
      eventName: event.name,
      // legend-kyie: never park pin hash material.
      envelope: redactEdgeEnvelopeSecrets(event),
      parkedReason,
    })
    .onConflictDoNothing({
      target: [edgeDeferredEvents.tenantId, edgeDeferredEvents.eventId],
    })
    .returning({ eventId: edgeDeferredEvents.eventId });
  return inserted.length > 0;
}

/**
 * Runs after a "deferred" event is parked (also on a replay), in the same
 * transaction. The registry allows one handler per event, so a domain that
 * must react to a parked event (order cost, legend-pd9t) adds a hook here
 * instead of replacing the parking handler.
 */
export type EdgeParkedEventHook = (
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
) => Promise<void>;

const parkedEventHooks = new Map<string, EdgeParkedEventHook>();

/** Idempotent; a different hook for a taken event name throws (wiring bug). */
export function registerEdgeParkedEventHook(
  eventName: string,
  hook: EdgeParkedEventHook,
): void {
  const existing = parkedEventHooks.get(eventName);
  if (existing && existing !== hook)
    throw new Error(`A parked-event hook for ${eventName} is already set`);
  parkedEventHooks.set(eventName, hook);
}

// Stable identities: the registry treats a different handler as a wiring bug.
const applyExplicitDeferred: EdgeEventHandler = async (tx, event, meta) => {
  await applyEdgeDeferredEvent(tx, event, meta, "deferred");
  await parkedEventHooks.get(event.name)?.(tx, event, meta);
};

const applyUnclassified: EdgeEventHandler = async (tx, event, meta) => {
  logger.warn(
    {
      eventName: event.name,
      aggregateType: event.aggregateType,
      tenantId: event.tenantId,
    },
    "Edge event parked as unclassified",
  );
  const parked = await applyEdgeDeferredEvent(tx, event, meta, "unclassified");
  // Alarm once, when the row is NEW (a redelivery inserts nothing). Savepoint
  // and silent catch: a missing alarm must not stop the batch (the parked row
  // is the durable evidence). Event name, aggregate type and node only.
  if (!parked) return;
  const tenantId = meta.context.tenant.tenantId;
  const outletId = event.outletId!; // applyEdgeDeferredEvent refused a null
  try {
    // One alarm per event name per outlet per 24 hours (checked against the
    // alarms actually sent, in edge-sync-conflict-alert.ts).
    await tx.transaction((savepoint) =>
      notifyEdgeEventParkedUnclassified(savepoint, meta.context, {
        tenantId,
        outletId,
        edgeNodeId: meta.edgeNodeId,
        eventName: event.name,
        aggregateType: event.aggregateType,
      }),
    );
  } catch {
    // Intentionally silent: no payload or ids in logs (ports.ts rule).
  }
};

/**
 * Routes every catalog event of `aggregateType` (edge -> cloud) to the
 * deferred inbox and classifies the aggregate as an append-only transaction
 * event. Idempotent.
 */
export function registerDeferredEdgeAggregate(
  aggregateType: string,
  eventNames: readonly string[] = catalogEventNamesOf(aggregateType),
): void {
  for (const eventName of eventNames)
    registerEdgeEventHandler("edge_to_cloud", eventName, applyExplicitDeferred);
  registerEdgeAggregateKind(aggregateType, "transaction_event");
}

/**
 * Aggregates the edge POS (WS-04) appends to the `cloud-sync` outbox. Any one
 * of them without a classifier stalls the link (`cashier_shift.opened` at the
 * start of every shift, `day.closed` every night), so all are parked, except
 * `receipt_run` (legend-zy43): it has its own applier (receipt-run-applier.ts)
 * and a second handler for `receipt_run.reported` would crash the registry.
 */
export function posDeferredAggregates(): string[] {
  return [
    ...new Set(
      eventCatalog
        .filter((entry) => entry.workstream === "WS-04")
        .map((entry) => entry.aggregateType),
    ),
  ].filter((aggregateType) => aggregateType !== RECEIPT_RUN_AGGREGATE);
}

/** Cloud boot (registerEdgeLink): parks POS events instead of stalling. */
export function registerPosDeferredEdgeApplier(): void {
  for (const aggregateType of posDeferredAggregates())
    registerDeferredEdgeAggregate(aggregateType);
}

/**
 * Generic edge -> cloud fallback: any aggregate or event no domain registered
 * is classified as an append-only transaction event and parked with
 * `parked_reason='unclassified'`, so one unknown event never stalls the link.
 * Call after the explicit registrations (explicit handlers and kinds win).
 * Logs the event name, aggregate type and tenant only, never the payload.
 * Each NEW parked event alarms the outlet supervisors once.
 */
export function registerEdgeDeferredFallback(): void {
  setEdgeDefaultAggregateKind("edge_to_cloud", "transaction_event");
  setEdgeUnhandledEventHandler("edge_to_cloud", applyUnclassified);
}
