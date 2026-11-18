// legend-9pz9: `order.paid` for a QR pay-first sale. The sale is made when
// the order fires to the kitchen after its money is verified (gateway paid,
// or the reservation DP covers it); `fireQrOrder` calls this in the same
// transaction that writes `fired_at`, with the same instant as `paidAt`.
// Only an `awaiting_payment` order fires, so a replay emits nothing new: one
// order.paid per QR order.
//
// Contract with WS-07 (docs/design/auto-journals.md): the order row has
// channel `qr`, payment_mode `pay_first`, `fired_at` set and
// `payment_intent_id` pinned to the intent that paid (null when nothing was
// left to pay); there is no pos_orders row. The payload carries the revenue
// split of the row, the DP as `paidDepositIdr`, and one gateway tender for
// the rest. No shift, cashier or device: the guest paid on their phone.

import { and, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { PaymentMethod } from "@starter/shared/payment";
import type { PosTenderMethod } from "@starter/shared/pos";
import { paymentIntents } from "../db/schema/index.ts";
import type { Tx } from "./menu-internals.ts";
import { orderRevenueSplit } from "./order-revenue.ts";
import { appendPosEvent, type OrderRow } from "./pos-order-support.ts";

/**
 * The POS tender method a QR payment intent books as. A QR guest pays by
 * QRIS, VA, e-wallet or card (`GUEST_PAYMENT_METHODS`); any other method has no QR
 * meaning and fails closed.
 */
export function qrTenderMethod(method: PaymentMethod): PosTenderMethod {
  switch (method) {
    case "qris":
      return "qris";
    case "va":
      return "va";
    case "ewallet":
      return "ewallet";
    case "card":
      return "card";
    default:
      throw new RangeError(`Method ${method} is not a QR order payment method`);
  }
}

export async function appendQrOrderPaid(
  tx: Tx,
  context: ScopedTenantContext,
  order: OrderRow,
  input: {
    now: Date;
    paidIntentId: string | null;
    /** `facility`: a ticket's breakfast order (bead oa0qk) books the same way. */
    channel?: "qr" | "facility";
  },
): Promise<void> {
  const split = orderRevenueSplit(order);
  const dueIdr = order.totalIdr - order.depositAppliedIdr;
  if (dueIdr < 0)
    throw new Error("QR order deposit applied exceeds the order total");
  let tenders: { method: PosTenderMethod; amountIdr: number }[] = [];
  if (dueIdr > 0) {
    if (input.paidIntentId === null)
      throw new Error("A QR sale with an amount due needs the paying intent");
    const [intent] = await tx
      .select({ method: paymentIntents.method })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, input.paidIntentId),
        ),
      );
    if (!intent) throw new Error("QR order paying intent not found");
    tenders = [{ method: qrTenderMethod(intent.method), amountIdr: dueIdr }];
  }
  await appendPosEvent(tx, context, "order.paid", {
    order,
    payload: {
      orderId: order.id,
      outletId: order.outletId,
      businessDate: order.businessDate,
      channel: input.channel ?? "qr",
      serviceType: order.serviceType,
      ...split,
      paidCashIdr: 0,
      paidGatewayIdr: dueIdr,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      paidDepositIdr: order.depositAppliedIdr,
      tenders,
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: input.now.toISOString(),
    },
    caller: null,
    now: input.now,
  });
}
