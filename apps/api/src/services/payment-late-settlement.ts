/**
 * Late settlement guard (PAY-04). A verified gateway payment can arrive for an
 * intent that already closed as `failed` or `expired`. It may still settle the
 * bill (flagged `late_payment`) only while that bill is open. When the bill is
 * already covered by other payments, or its order or tender was voided,
 * completed or failed, or its reservation deposit was cancelled or no-show, the intent must not become paid: the caller parks the
 * money as unallocated funds instead. The caller must hold the bill and intent
 * row locks, so the answer cannot change before its write.
 */
import type { ScopedTenantContext } from "@starter/shared/core";
import { and, eq, inArray, or } from "drizzle-orm";
import { orders, posOrderTenders, reservations } from "../db/schema";
import {
  outstandingIdr,
  type PaymentIntentRow,
  type PaymentLinkRow,
} from "./payment-support";
import type { Tx } from "./permission-resolver";

const CLOSED_ORDER_STATUSES = ["voided", "completed"] as const;
const CLOSED_TENDER_STATUSES = ["voided", "failed"];

export async function billClosedForLateSettlement(
  tx: Tx,
  context: ScopedTenantContext,
  link: PaymentLinkRow,
  intent: PaymentIntentRow,
): Promise<boolean> {
  // Covered, fully or partly, by another payment since this intent closed.
  if (outstandingIdr(link) < intent.amountIdr) return true;

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
