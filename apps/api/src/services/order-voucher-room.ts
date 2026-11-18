// legend-eajpb (1095): how much an apology voucher bound to a failed-item
// report may still be worth. Together with the vouchers, cashier refunds and
// live recovery refunds the order already gave, a new voucher never takes the
// money handed back past what the guest paid ("jangan sampai rugi").
//
// The caller MUST already hold the `orders` row lock (FOR UPDATE) of the order
// in the same transaction, taken after the issue lock (issue, then order; the
// same order the cashier refund and `assertLineNotManuallyRefunded` use). Plain
// reads, no lock of its own: never lock an issue here.
//
// - An order that is voided (cloud, edge, or an edge void still parked) has
//   nothing left to give: 0.
// - Order room: what the guest paid less everything given (`orderGivenOf`).
// - Line room (Q25 per item): the failed line's share of the bill less what
//   was given for it (`lineRoomIdr`), the cashier refunds that named items
//   counted with the deposit part they released, as `refundPosOrder` does.
// - The result is the smaller of the two. On a deposit order `paidIdr` leaves
//   the deposit out, so the room only shrinks (conservative).

import { asc, and, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { posOrderRefunds } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { lineRoomIdr, orderGivenOf } from "./order-given.ts";
import { orderMoneyBackLaneOf } from "./order-refund-lane.ts";
import type { Tx } from "./permission-resolver.ts";
import { depositRefundedByPosRefund } from "./pos-deposit-refund.ts";

export async function voucherRoomIdr(
  tx: Tx,
  context: ScopedTenantContext,
  input: { orderId: string; orderItemId: string },
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const { orderId, orderItemId } = input;

  // A cashier refund alone leaves room (it is counted in `given` below); a
  // void of any kind leaves none.
  const lane = await orderMoneyBackLaneOf(tx, tenantId, orderId);
  if (lane !== null && lane !== "pos_refunded") return 0;

  const [order] = await tx
    .select({ totalIdr: orders.totalIdr, subtotalIdr: orders.subtotalIdr })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)));
  if (!order) return 0;

  const given = await orderGivenOf(tx, tenantId, orderId);
  const orderRoomIdr = Math.max(0, given.paidIdr - given.givenIdr);
  if (orderRoomIdr === 0) return 0;

  const items = await tx
    .select({
      id: orderItems.id,
      quantity: orderItems.quantity,
      lineTotalIdr: orderItems.lineTotalIdr,
    })
    .from(orderItems)
    .where(
      and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId)),
    );
  const refunds = await tx
    .select({
      id: posOrderRefunds.id,
      amountIdr: posOrderRefunds.amountIdr,
      items: posOrderRefunds.items,
    })
    .from(posOrderRefunds)
    .where(
      and(
        eq(posOrderRefunds.tenantId, tenantId),
        eq(posOrderRefunds.orderId, orderId),
      ),
    )
    .orderBy(asc(posOrderRefunds.refundedAt), asc(posOrderRefunds.id));
  const depositOfRefund = await depositRefundedByPosRefund(
    tx,
    context,
    orderId,
  );
  const lineRoom = lineRoomIdr(
    order,
    items,
    refunds.map((row) => ({
      ...row,
      amountIdr: row.amountIdr + (depositOfRefund.get(row.id) ?? 0),
    })),
    given,
    [{ itemId: orderItemId }],
  );
  return Math.max(0, Math.min(orderRoomIdr, lineRoom));
}
