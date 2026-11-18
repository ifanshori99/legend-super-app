// Cloud -> edge forwarding of QR orders (bead legend-0835; PRD v1.7 §3 F5
// "Pesanan Pelanggan dari Cloud", §4 Alur F step 2). Used by the cloud QR
// order service inside `placeQrOrder`'s transaction:
//   - outlet without an active edge node: QR flow unchanged, nothing queued;
//   - edge node active and link up: the placed order is queued cloud_to_edge
//     in the same transaction (committed with the order or not at all);
//   - edge node active and link down: the order is refused (EDGE_LINK_DOWN),
//     the guest asks a waiter, who takes the order with captain order.
//
// Which node: an outlet has at most one active primary and one standby
// (edge_nodes_active_role_key). The primary serves the outlet, so it is
// preferred; a standby is used only when the primary is absent or its link is
// stale. "Has edge" = any active node.
import { and, asc, eq } from "drizzle-orm";
import {
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import {
  QR_ORDER_FORWARD_AGGREGATE,
  QR_ORDER_PLACED_EDGE_EVENT,
  QR_ORDER_PLACED_EDGE_SCHEMA_REF,
  QR_ORDER_PLACED_EDGE_VERSION,
  qrOrderPlacedEdgePayloadSchema,
  type QrOrderPlacedEdgePayload,
} from "@starter/shared/qr-order";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { isHeartbeatFresh } from "./link-freshness.ts";
import type { orderItems, orders } from "../db/schema/qr-order.ts";
import {
  enqueueEdgeEvent,
  type EdgeTx,
} from "../services/edge-queue.service.ts";

export type OutletEdgeLinkState = {
  hasEdge: boolean;
  linkUp: boolean;
  /** The node to queue for (a live one when any; else the primary/first). */
  edgeNodeId: string | null;
};

/**
 * Edge link state of one outlet, read on the caller's tenant transaction
 * (tenant + outlet scope apply through RLS and the explicit filters).
 */
export async function getOutletEdgeLinkState(
  tx: EdgeTx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date = new Date(),
): Promise<OutletEdgeLinkState> {
  const nodes = await tx
    .select({
      id: edgeNodes.id,
      role: edgeNodes.role,
      lastHeartbeatAt: edgeNodes.lastHeartbeatAt,
    })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, context.tenant.tenantId),
        eq(edgeNodes.outletId, outletId as OutletId),
        eq(edgeNodes.status, "active"),
      ),
    )
    // 'primary' sorts before 'standby'.
    .orderBy(asc(edgeNodes.role));
  if (nodes.length === 0)
    return { hasEdge: false, linkUp: false, edgeNodeId: null };
  const live = nodes.find((node) =>
    isHeartbeatFresh(node.lastHeartbeatAt, now),
  );
  return live
    ? { hasEdge: true, linkUp: true, edgeNodeId: live.id }
    : { hasEdge: true, linkUp: false, edgeNodeId: nodes[0]?.id ?? null };
}

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

/** The `qr_order.placed` payload for one order and its lines. */
export function qrOrderPlacedPayload(
  order: OrderRow,
  items: readonly OrderItemRow[],
): QrOrderPlacedEdgePayload {
  return qrOrderPlacedEdgePayloadSchema.parse({
    order: {
      id: order.id,
      number: order.number,
      channel: order.channel,
      serviceType: order.serviceType,
      tableSessionId: order.tableSessionId,
      paymentMode: order.paymentMode,
      subtotalIdr: order.subtotalIdr,
      discountIdr: order.discountIdr,
      serviceChargeIdr: order.serviceChargeIdr,
      taxIdr: order.taxIdr,
      roundingIdr: order.roundingIdr,
      totalIdr: order.totalIdr,
      depositAppliedIdr: order.depositAppliedIdr,
      status: order.status,
      businessDate: order.businessDate,
      taxResult: order.taxResult ?? null,
      note: order.note,
      placedAt: toIsoDateTime(order.placedAt),
      firedAt: order.firedAt ? toIsoDateTime(order.firedAt) : null,
      createdAt: toIsoDateTime(order.createdAt),
      updatedAt: toIsoDateTime(order.updatedAt),
    },
    items: items.map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      variantId: item.variantId,
      name: item.name,
      quantity: item.quantity,
      unitPriceIdr: item.unitPriceIdr,
      modifiersTotalIdr: item.modifiersTotalIdr,
      lineTotalIdr: item.lineTotalIdr,
      modifiers: item.modifiers,
      note: item.note,
      course: item.course,
      fireStatus: item.fireStatus,
      status: item.status,
      reservedBusinessDate: item.reservedBusinessDate,
      createdAt: toIsoDateTime(item.createdAt),
      updatedAt: toIsoDateTime(item.updatedAt),
    })),
  });
}

/**
 * The envelope. The event id IS the order id (a ULID) and the aggregate is
 * the order's own `qr_order` stream at sequence 1, so re-queueing the same
 * order is a no-op (enqueueEdgeEvent returns the original link sequence).
 */
export function qrOrderPlacedEvent(
  context: ScopedTenantContext,
  order: OrderRow,
  items: readonly OrderItemRow[],
  now: Date,
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: order.id,
    tenantId: context.tenant.tenantId,
    outletId: order.outletId,
    name: QR_ORDER_PLACED_EDGE_EVENT,
    version: QR_ORDER_PLACED_EDGE_VERSION,
    aggregateType: QR_ORDER_FORWARD_AGGREGATE,
    aggregateId: order.id,
    sequence: 1,
    occurredAt: toIsoDateTime(now),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${QR_ORDER_PLACED_EDGE_EVENT}:${order.id}`,
    payloadSchemaRef: QR_ORDER_PLACED_EDGE_SCHEMA_REF,
    payload: qrOrderPlacedPayload(order, items),
  });
}

/** Queues the placed order for the edge node on the caller's transaction. */
export async function forwardQrOrderToEdge(
  tx: EdgeTx,
  context: ScopedTenantContext,
  input: {
    edgeNodeId: string;
    order: OrderRow;
    items: readonly OrderItemRow[];
    now: Date;
  },
): Promise<void> {
  await enqueueEdgeEvent(tx, context, {
    edgeNodeId: input.edgeNodeId,
    direction: "cloud_to_edge",
    kind: "transaction_event",
    event: qrOrderPlacedEvent(context, input.order, input.items, input.now),
  });
}
