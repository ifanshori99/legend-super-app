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
// Fail closed like stock-moved-applier.ts: a wrong direction, tenant or
// outlet throws a CoreError and the link records an `applier_refused`
// conflict instead of stalling.
import { and, eq } from "drizzle-orm";
import { CoreError, isOutletInScope } from "@starter/shared/core";
import { eventCatalog } from "@starter/shared/events";
import type { EventEnvelope } from "@starter/shared/events";
import { logger } from "../lib/logger.ts";
import { edgeDeferredEvents } from "../db/schema/edge-deferred-event.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
  setEdgeDefaultAggregateKind,
  setEdgeUnhandledEventHandler,
} from "./applier-registry.ts";
import type { EdgeEventHandler } from "./applier-registry.ts";
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
 * Parks one edge event in the deferred inbox; replays write nothing.
 * `parkedReason`: "deferred" for an explicit WS-04 registration,
 * "unclassified" for the generic fallback.
 */
export async function applyEdgeDeferredEvent(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  parkedReason: EdgeParkedReason = "deferred",
): Promise<void> {
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

  await tx
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
      envelope: event,
      parkedReason,
    })
    .onConflictDoNothing({
      target: [edgeDeferredEvents.tenantId, edgeDeferredEvents.eventId],
    });
}

// Stable identities: the registry treats a different handler as a wiring bug.
const applyExplicitDeferred: EdgeEventHandler = (tx, event, meta) =>
  applyEdgeDeferredEvent(tx, event, meta, "deferred");

const applyUnclassified: EdgeEventHandler = async (tx, event, meta) => {
  logger.warn(
    {
      eventName: event.name,
      aggregateType: event.aggregateType,
      tenantId: event.tenantId,
    },
    "Edge event parked as unclassified",
  );
  await applyEdgeDeferredEvent(tx, event, meta, "unclassified");
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
 * start of every shift, `day.closed` every night), so all are parked.
 */
export function posDeferredAggregates(): string[] {
  return [
    ...new Set(
      eventCatalog
        .filter((entry) => entry.workstream === "WS-04")
        .map((entry) => entry.aggregateType),
    ),
  ];
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
 */
export function registerEdgeDeferredFallback(): void {
  setEdgeDefaultAggregateKind("edge_to_cloud", "transaction_event");
  setEdgeUnhandledEventHandler("edge_to_cloud", applyUnclassified);
}
