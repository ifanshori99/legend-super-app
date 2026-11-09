// Edge side of the cloud -> edge QR order forwarding (bead legend-0835). The
// cloud queues one `qr_order.placed` transaction event per placed order
// (edge/qr-order-forwarding.ts); this applier writes the order and its lines
// into the edge's local `orders` / `order_items` inside the link's receive
// transaction, so the kitchen works from the edge.
//
// Idempotent: the order and every line are inserted `ON CONFLICT (id) DO
// NOTHING`. A replay (the link delivers at least once) never overwrites an
// order the edge has already progressed (fired, served, paid).
//
// Failure modes are fail closed, like every applier: an order whose menu item
// is not (yet) on the edge throws a foreign key error, the receive transaction
// rolls back, nothing is acknowledged and the cloud keeps the event queued.
import { and, eq } from "drizzle-orm";
import { CoreError } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  QR_ORDER_FORWARD_AGGREGATE,
  QR_ORDER_PLACED_EDGE_EVENT,
  qrOrderPlacedEdgePayloadSchema,
} from "@starter/shared/qr-order";
import { tableSessions } from "../db/schema/floor.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import type { EdgeApplyMeta } from "./ports.ts";

/** Writes one forwarded QR order; replays are no-ops. */
export async function applyQrOrderPlaced(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const tenantId = meta.context.tenant.tenantId;
  if (event.tenantId !== tenantId)
    throw new CoreError("FORBIDDEN", "Event tenant does not match the context");
  const { order, items } = qrOrderPlacedEdgePayloadSchema.parse(event.payload);
  if (!event.outletId || event.aggregateId !== order.id)
    throw new CoreError("VALIDATION_ERROR", "Event does not match its order");
  const outletId = event.outletId;

  // The guest's table session is cloud data. Keep the link when the edge
  // already holds it; otherwise keep the reference in `external_ref` so the
  // order is never lost to a missing local session row.
  let tableSessionId: string | null = null;
  if (order.tableSessionId !== null) {
    const [session] = await tx
      .select({ id: tableSessions.id })
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.id, order.tableSessionId),
        ),
      );
    tableSessionId = session?.id ?? null;
  }

  await tx
    .insert(orders)
    .values({
      id: order.id,
      tenantId,
      outletId,
      number: order.number,
      channel: order.channel,
      serviceType: order.serviceType,
      tableSessionId,
      customerProfileId: null,
      externalRef:
        order.tableSessionId !== null && tableSessionId === null
          ? `qr-session:${order.tableSessionId}`
          : null,
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
      taxResult: order.taxResult as typeof orders.$inferInsert.taxResult,
      note: order.note,
      createdBy: null,
      placedAt: new Date(order.placedAt),
      firedAt: order.firedAt ? new Date(order.firedAt) : null,
      createdAt: new Date(order.createdAt),
      updatedAt: new Date(order.updatedAt),
    })
    .onConflictDoNothing({ target: orders.id });

  await tx
    .insert(orderItems)
    .values(
      items.map((item) => ({
        id: item.id,
        tenantId,
        outletId,
        orderId: order.id,
        menuItemId: item.menuItemId,
        variantId: item.variantId,
        name: item.name,
        quantity: item.quantity,
        unitPriceIdr: item.unitPriceIdr,
        modifiersTotalIdr: item.modifiersTotalIdr,
        lineTotalIdr: item.lineTotalIdr,
        modifiers: item.modifiers as typeof orderItems.$inferInsert.modifiers,
        note: item.note,
        course: item.course,
        fireStatus: item.fireStatus,
        status: item.status,
        reservedBusinessDate: item.reservedBusinessDate,
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
      })),
    )
    .onConflictDoNothing({ target: orderItems.id });
}

/**
 * Registers `qr_order.placed` on the cloud_to_edge dispatcher and classifies
 * the QR order aggregate as an append-only transaction event (receiver side,
 * edge boot; applier-registry.ts). Other event types keep going to the
 * applier installed before (or the refusing default). Idempotent.
 */
export function registerQrOrderEdgeApplier(): void {
  registerEdgeEventHandler(
    "cloud_to_edge",
    QR_ORDER_PLACED_EDGE_EVENT,
    applyQrOrderPlaced,
  );
  registerEdgeAggregateKind(QR_ORDER_FORWARD_AGGREGATE, "transaction_event");
}
