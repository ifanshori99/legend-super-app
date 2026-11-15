// Cloud side of the edge -> cloud `stock.moved` up-sync (bead legend-s4r6).
// The edge posts its stock movements locally (services/inventory.service.ts
// `recordStockMovementInTransaction`), emits `stock.moved` on its `cloud-sync`
// outbox and worker/transport.ts queues it edge_to_cloud. This handler runs in
// the cloud link's receive transaction (edge/db-link-store.ts applyInbound):
// it writes the same ledger row on the cloud (same id, quantity, cost, source,
// time), updates the cloud balance and re-emits `stock.moved` on the cloud
// outbox for the inventory -> GL bridge. On the cloud `cloud-sync` is a local
// sink, so the movement is never queued back to the edge.
//
// Fail closed: a payload that does not parse, an event outside the node's
// tenant/outlet, a source an edge never posts, a source of another outlet, a
// different movement under a recorded ledger id, or a location/item/batch the
// cloud does not hold throws a CoreError / 4xx HttpError; the link records it
// as an `applier_refused` conflict (db-link-store.ts). Identical replays are
// no-ops.
import { and, eq } from "drizzle-orm";
import { CoreError, isOutletInScope } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { stockMovedEventPayloadSchema } from "@starter/shared/inventory";
import { edgeNodes } from "../db/schema/edge-node.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { recordReplicatedStockMovementInTransaction } from "../services/inventory.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import { recomputeEdgeOrderCost } from "./order-edge-applier.ts";
import type { EdgeApplyMeta } from "./ports.ts";

export const STOCK_MOVED_EVENT = "stock.moved";
/** Aggregate type of `stock.moved` (one aggregate per ledger row). */
export const STOCK_AGGREGATE = "stock";

/** Applies one edge `stock.moved` on the cloud; replays write nothing. */
export async function applyEdgeStockMoved(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  if (meta.direction !== "edge_to_cloud")
    throw new CoreError(
      "FORBIDDEN",
      "stock.moved is only accepted from an edge",
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

  const parsed = stockMovedEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError("VALIDATION_ERROR", "Invalid stock.moved payload");
  const payload = parsed.data;
  if (
    event.aggregateType !== STOCK_AGGREGATE ||
    event.aggregateId !== payload.ledgerEntryId
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Event does not match its ledger row",
    );

  await recordReplicatedStockMovementInTransaction(
    tx,
    meta.context,
    event,
    payload,
  );

  // legend-pd9t: an order's sale row changes the cost snapshot of its parked
  // order.paid; legend-8qm1d: so does a return row (netted once voided).
  // Also on a replay: the recompute assigns, so it never doubles.
  if (
    payload.sourceType === "order" &&
    (payload.movementType === "sale" || payload.movementType === "return")
  )
    await recomputeEdgeOrderCost(tx, tenantId, payload.sourceId);
}

/**
 * Cloud boot (registerEdgeLink): routes edge `stock.moved` to this handler
 * and classifies the stock aggregate as an append-only transaction event.
 * Idempotent.
 */
export function registerStockMovedEdgeApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    STOCK_MOVED_EVENT,
    applyEdgeStockMoved,
  );
  registerEdgeAggregateKind(STOCK_AGGREGATE, "transaction_event");
}
