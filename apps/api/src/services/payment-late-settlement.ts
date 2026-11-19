/**
 * Late settlement guard (PAY-04). A verified gateway payment can arrive for an
 * intent that already closed as `failed` or `expired`. It may still settle the
 * bill (flagged `late_payment`) only while that bill is open. When the bill is
 * already covered by other payments, or its order or tender was voided,
 * completed or failed, or its reservation deposit was cancelled or no-show, the intent must not become paid: the caller parks the
 * money as unallocated funds instead. The caller must hold the bill owner, bill and
 * intent row locks (see the lock order above), so the answer cannot change before its write.
 */
import type { ScopedTenantContext } from "@starter/shared/core";
import { reservationPolicySnapshotSchema } from "@starter/shared/reservation";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { orders, posOrders, posOrderTenders, reservations } from "../db/schema";
import {
  outstandingIdr,
  type PaymentIntentRow,
  type PaymentLinkRow,
} from "./payment-support";
import type { Tx } from "./permission-resolver";

/**
 * LOCK ORDER FOR PAYMENTS (legend-s0u8c). Every writer that settles, fails or
 * cancels money for a bill takes row locks in this one order, so none can
 * deadlock and none decides from a state another commits underneath it:
 *
 *   1. bill owner: reservations row (deposit link), OR orders rows
 *      (ORDER BY id) then their pos_orders rows (ORDER BY order_id);
 *   1b. pos_qris_holds of the bill (ORDER BY id), then pos_order_tenders
 *      (legend-yhia9: cashier cancel, manager release, hold check job,
 *      handlePosPaymentPaid / handlePosPaymentClosed and the hold guards all
 *      lock orders -> pos_orders -> pos_qris_holds -> tender -> link -> intent);
 *   2. payment_links (the bill);
 *   3. payment_intents (ORDER BY id when several);
 *   4. funds / refunds (payment_unallocated_funds, refunds).
 *
 * Settlement (webhook via confirmPayment, the poller, a held amount mismatch)
 * calls `lockBillOwner` first, then locks link and intent, and reads the
 * business status only after that. POS cancel (mutatePosOrder: order, pos_order,
 * link) and reservation cancel (reservation, link, re-check intents) follow the
 * same order.
 */

/**
 * Locks the owner(s) of a bill, step 1 of the lock order above. Returns the
 * number of owner rows locked (0 for a bill without a reservation or order).
 */
export async function lockBillOwner(
  tx: Tx,
  context: ScopedTenantContext,
  linkId: string,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const reservationRows = await tx
    .select({ id: reservations.id })
    .from(reservations)
    .where(
      and(
        eq(reservations.tenantId, tenantId),
        eq(reservations.depositPaymentLinkId, linkId),
      ),
    )
    .orderBy(asc(reservations.id))
    .for("update");
  const orderRows = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        or(
          eq(orders.paymentLinkId, linkId),
          inArray(
            orders.id,
            tx
              .select({ orderId: posOrderTenders.orderId })
              .from(posOrderTenders)
              .where(
                and(
                  eq(posOrderTenders.tenantId, tenantId),
                  eq(posOrderTenders.paymentLinkId, linkId),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(orders.id))
    .for("update");
  const orderIds = orderRows.map((row) => row.id);
  let posRows = 0;
  if (orderIds.length > 0)
    posRows = (
      await tx
        .select({ orderId: posOrders.orderId })
        .from(posOrders)
        .where(
          and(
            eq(posOrders.tenantId, tenantId),
            inArray(posOrders.orderId, orderIds),
          ),
        )
        .orderBy(asc(posOrders.orderId))
        .for("update")
    ).length;
  return reservationRows.length + orderRows.length + posRows;
}

const CLOSED_ORDER_STATUSES = ["voided", "completed"] as const;
const CLOSED_TENDER_STATUSES = ["voided", "failed"];

/** Same fallback as `DEPOSIT_ATTACH_GRACE_MINUTES` in `reservation-core.ts`
 * (not imported: that module imports the payment services). */
const DEPOSIT_WINDOW_FALLBACK_MINUTES = 30;

/**
 * legend-pdi5u: a reservation deposit confirmed AFTER its payment window is
 * proven late. `confirmedAt` is the evidence time (the provider's paid time or
 * the first receipt), never the local clock at processing. The window is the
 * later of the reservation's link limit and the intent's own expiry, and only
 * a reservation still `pending_deposit` is affected: the money is then parked
 * as unallocated funds instead of crediting the reservation or the bill.
 */
export async function depositProvenLate(
  tx: Tx,
  context: ScopedTenantContext,
  link: PaymentLinkRow,
  intent: PaymentIntentRow,
  confirmedAt: Date,
): Promise<boolean> {
  const [reservation] = await tx
    .select({
      createdAt: reservations.createdAt,
      policySnapshot: reservations.policySnapshot,
      depositLinkExpiresAt: reservations.depositLinkExpiresAt,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.tenantId, context.tenant.tenantId),
        eq(reservations.depositPaymentLinkId, link.id),
        eq(reservations.status, "pending_deposit"),
      ),
    )
    .limit(1);
  if (!reservation) return false;
  const policy = reservationPolicySnapshotSchema.safeParse(
    reservation.policySnapshot,
  );
  const windowMinutes = policy.success
    ? policy.data.paymentWindowMinutes
    : DEPOSIT_WINDOW_FALLBACK_MINUTES;
  const linkLimit =
    reservation.depositLinkExpiresAt ??
    new Date(reservation.createdAt.getTime() + windowMinutes * 60_000);
  const limit = Math.max(linkLimit.getTime(), intent.expiresAt.getTime());
  return confirmedAt.getTime() > limit;
}

export async function billClosedForLateSettlement(
  tx: Tx,
  context: ScopedTenantContext,
  link: PaymentLinkRow,
  intent: PaymentIntentRow,
  confirmedAt: Date,
): Promise<boolean> {
  // Covered, fully or partly, by another payment since this intent closed.
  if (outstandingIdr(link) < intent.amountIdr) return true;
  if (await depositProvenLate(tx, context, link, intent, confirmedAt))
    return true;

  const tenantId = context.tenant.tenantId;
  const [closedOrder] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.paymentLinkId, link.id),
        inArray(orders.status, [...CLOSED_ORDER_STATUSES]),
      ),
    )
    .limit(1);
  if (closedOrder) return true;

  // A reservation deposit link whose reservation was cancelled or no-show.
  const [closedReservation] = await tx
    .select({ id: reservations.id })
    .from(reservations)
    .where(
      and(
        eq(reservations.tenantId, tenantId),
        eq(reservations.depositPaymentLinkId, link.id),
        inArray(reservations.status, ["cancelled", "no_show"]),
      ),
    )
    .limit(1);
  if (closedReservation) return true;

  const [closedTender] = await tx
    .select({ id: posOrderTenders.id })
    .from(posOrderTenders)
    .leftJoin(
      orders,
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, posOrderTenders.orderId),
      ),
    )
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.paymentLinkId, link.id),
        or(
          inArray(posOrderTenders.status, CLOSED_TENDER_STATUSES),
          inArray(orders.status, [...CLOSED_ORDER_STATUSES]),
        ),
      ),
    )
    .limit(1);
  return closedTender !== undefined;
}
