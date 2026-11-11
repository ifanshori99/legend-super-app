// Money state machine of a ticket's breakfast order (bead oa0qk; owner Q43: a
// ticket's breakfast MUST be paid before it reaches the kitchen / KDS; PRD v1.7
// §3 F22 "Sarapan Siap Saat Keluar Shower", FAC-10).
//
// The order is an `orders` row of channel `facility` (pay_first) plus a
// `facility_linked_orders` row that holds
//   awaiting_payment -> paid -> fired | cancelled.
// `orders.status` stays `awaiting_payment` until the kitchen gets the order
// (`sent`), so the QR void path (`voidAwaitingPaymentOrderTx`) releases stock for both
// an unpaid and a paid-not-fired order.
//
// Lock order everywhere: orders row -> facility_linked_orders row ->
// payment_intents rows (ascending). The paid mark comes ONLY from the verified
// `payment.paid` consumer (facility-breakfast-consumers.ts); every path to the
// kitchen goes through `fireBreakfastOrderTx`, which refuses an order that is
// not `paid`, and the DB trigger on `kitchen_tickets` (kds.custom.sql) backs it
// up for any other writer.
//
// Money rules ("jangan sampai rugi"):
// - a refund request is capped by `refundableBalance` (never more than the
//   intent holds) and by what this order paid less what it already refunded;
// - firing re-checks the paid intent under its row lock: a refund already
//   filed against it (`reserved > 0`) cancels the order and returns the rest
//   instead of selling food for money that is going back (a fired facility
//   order counts as "sale in use" in `refundableBalance` like a fired QR one).
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  createUlid,
  idr,
  ulidToUuid,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { FacilityError } from "@starter/shared/facility";
import { paymentIntents, paymentRefunds } from "../db/schema/index.ts";
import { accessTickets, facilityLinkedOrders } from "../db/schema/facility.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { recordAudit } from "./core-audit.ts";
import { auditFacility } from "./facility-shared.ts";
import { routeFiredItemsToKitchen } from "./kds.service.ts";
import type { Tx } from "./menu-internals.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { openRefundChainSafely } from "./payment-refund.service.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import { cancelPaymentLinkInTx } from "./payment.service.ts";
import { pendingRefundIdr } from "./pos-order-late-payment.ts";
import { QR_SYSTEM_ACTOR } from "./qr-order-late-payment.ts";
import { appendQrOrderPaid } from "./qr-order-paid.ts";
import { voidAwaitingPaymentOrderTx } from "./qr-order.service.ts";
import { recordTaxSnapshots } from "./tax.service.ts";

export type BreakfastOrderRow = typeof orders.$inferSelect;
export type BreakfastLinkedRow = typeof facilityLinkedOrders.$inferSelect;
export type LockedBreakfast = {
  order: BreakfastOrderRow;
  linked: BreakfastLinkedRow;
};

/** Intent statuses that still hold money for the order. */
export const BREAKFAST_PAID_INTENT_STATUSES = [
  "paid",
  "partially_refunded",
] as const;

/** A ticket in one of these statuses will never use its breakfast. */
const DEAD_TICKET_STATUSES = ["cancelled", "refunded", "no_show"] as const;

const REFUND_AUDIT_FIELDS = ["amountIdr", "status", "refundId"] as const;

/** Locks the order row, then its linked row. Null when it is not a breakfast order. */
export async function lockBreakfastOrder(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<LockedBreakfast | null> {
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, orderId),
        eq(orders.channel, "facility"),
      ),
    )
    .for("update");
  if (!order) return null;
  const [linked] = await tx
    .select()
    .from(facilityLinkedOrders)
    .where(
      and(
        eq(facilityLinkedOrders.tenantId, tenantId),
        eq(facilityLinkedOrders.orderId, order.id),
      ),
    )
    .for("update");
  return linked ? { order, linked } : null;
}

/**
 * Files a refund request (WS-05; approval stays with another person) for money
 * `intentId` holds. `maxIdr` caps it (cancel after pay: what the order paid
 * less what it already refunded); `null` returns everything the intent still
 * holds (late, double or split payments: the money never belonged to a sale).
 * Idempotent per (intent, kind). Run inside the locking transaction.
 */
export async function requestBreakfastRefund(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: { id: string; outletId: string };
    paymentLinkId: string;
    intentId: string;
    maxIdr: number | null;
    kind: "cancel" | "late";
    now: Date;
  },
): Promise<{ refundId: string | null; amountIdr: number }> {
  const tenantId = context.tenant.tenantId;
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, input.intentId),
        eq(paymentIntents.paymentLinkId, input.paymentLinkId),
      ),
    )
    .for("update");
  if (
    !intent ||
    !intent.paidAt ||
    !(BREAKFAST_PAID_INTENT_STATUSES as readonly string[]).includes(
      intent.status,
    )
  )
    return { refundId: null, amountIdr: 0 };
  return idempotentPaymentAdminWrite(
    tx,
    context,
    QR_SYSTEM_ACTOR,
    `facility-breakfast-refund:${input.kind}:${intent.id}`,
    "refund.create",
    { paymentIntentId: intent.id, reason: `facility_breakfast_${input.kind}` },
    async () => {
      const { cap, reserved } = await refundableBalance(tx, intent);
      // A cancel never adds to a refund that is already filed (even pending).
      // A late or double payment follows the QR rule: a pending refund is not
      // subtracted, its approval fails `cap_exceeded` if both would pay.
      const pending = await pendingRefundIdr(tx, tenantId, intent.id);
      const free =
        input.kind === "cancel" ? cap - reserved : cap - (reserved - pending);
      const wanted =
        input.maxIdr === null ? free : BigInt(Math.max(0, input.maxIdr));
      const amount = free < wanted ? free : wanted;
      if (amount <= 0n) return { refundId: null, amountIdr: 0 };
      const [inserted] = await tx
        .insert(paymentRefunds)
        .values({
          tenantId: intent.tenantId,
          outletId: intent.outletId,
          paymentIntentId: intent.id,
          amountIdr: idr(Number(amount)),
          reason:
            input.kind === "cancel"
              ? "Refund pembatalan pesanan sarapan fasilitas"
              : "Refund pembayaran sarapan fasilitas yang tidak dapat diproses (terlambat, ganda, atau pesanan batal)",
          note: null,
          requestedBy: QR_SYSTEM_ACTOR,
        })
        .returning();
      if (!inserted) throw new Error("Refund insert returned no row");
      const row = await openRefundChainSafely(tx, context, inserted, input.now);
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(input.now.getTime()),
          tenantId,
          outletId: row.outletId,
          actorType: "system",
          actorId: null,
          deviceId: null,
          action: "payment.refund_requested",
          objectType: "payment_refund",
          objectId: row.id,
          reason: row.reason,
          maskedChanges: {
            before: null,
            after: { amountIdr: row.amountIdr, status: row.status },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: input.now.toISOString(),
        },
        REFUND_AUDIT_FIELDS,
      );
      await appendPaymentEvent(tx, context, {
        name: "payment.refund_requested",
        aggregateId: row.id,
        outletId: row.outletId,
        actor: { type: "system" },
        payload: {
          refundId: row.id,
          paymentIntentId: row.paymentIntentId,
          amountIdr: row.amountIdr,
        },
        now: input.now,
      });
      return { refundId: row.id, amountIdr: Number(amount) };
    },
  );
}

/**
 * Cancels a breakfast order that was not fired. Unpaid: void, refund 0. Paid:
 * void and refund at most `paid_idr - refunded_idr`. A cancelled order answers
 * with refund 0 (idempotent); a fired one is refused. Locked rows in, locked
 * rows out.
 */
export async function cancelBreakfastOrderTx(
  tx: Tx,
  context: ScopedTenantContext,
  locked: LockedBreakfast,
  input: { reason: string; actorUserId: string | null; now: Date },
): Promise<{ linked: BreakfastLinkedRow; refundIdr: number }> {
  const { order, linked } = locked;
  if (linked.status === "cancelled") return { linked, refundIdr: 0 };
  if (linked.status === "fired")
    throw new FacilityError("BREAKFAST_ALREADY_FIRED");
  await voidAwaitingPaymentOrderTx(
    tx,
    context,
    order.id,
    { reason: input.reason, actorUserId: input.actorUserId },
    input.now,
  );
  // Every cancel closes the pay link, paid or not: a code the guest still holds
  // must not take money for a cancelled order (a late payment is refunded in
  // full by the consumer, but it should not be possible to start one).
  if (order.paymentLinkId !== null)
    await cancelPaymentLinkInTx(tx, context, {
      linkId: order.paymentLinkId,
      now: input.now,
      reason: "breakfast_cancelled",
    });
  let refundIdr = 0;
  if (linked.status === "paid") {
    if (linked.paidIntentId === null || order.paymentLinkId === null)
      throw new Error("A paid breakfast order has its payment");
    const refund = await requestBreakfastRefund(tx, context, {
      order,
      paymentLinkId: order.paymentLinkId,
      intentId: linked.paidIntentId,
      maxIdr: linked.paidIdr - linked.refundedIdr,
      kind: "cancel",
      now: input.now,
    });
    refundIdr = refund.amountIdr;
  }
  const [cancelled] = await tx
    .update(facilityLinkedOrders)
    .set({
      status: "cancelled",
      cancelledAt: input.now,
      refundedIdr: idr(linked.refundedIdr + refundIdr),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(facilityLinkedOrders.tenantId, context.tenant.tenantId),
        eq(facilityLinkedOrders.id, linked.id),
      ),
    )
    .returning();
  if (!cancelled) throw new Error("Breakfast cancel returned no row");
  await auditFacility(tx, context, input.actorUserId, input.now, {
    action: "facility.breakfast.cancelled",
    objectType: "facility_linked_order",
    objectId: linked.id,
    outletId: linked.outletId,
    before: { id: linked.id, status: linked.status },
    after: { id: linked.id, status: "cancelled" },
  });
  return { linked: cancelled, refundIdr };
}

export type BreakfastFireOutcome = "fired" | "already_fired" | "cancelled";

/**
 * THE way a breakfast order reaches the kitchen. Refuses anything that is not
 * `paid` (BREAKFAST_NOT_PAID), is idempotent for a fired order, and refuses a
 * cancelled one. Re-checks the paid intent under its row lock: a refund already
 * filed against it, or a ticket that will never be used, cancels the order and
 * returns the rest instead of firing.
 */
export async function fireBreakfastOrderTx(
  tx: Tx,
  context: ScopedTenantContext,
  locked: LockedBreakfast,
  input: { actorUserId: string | null; now: Date },
): Promise<{ linked: BreakfastLinkedRow; outcome: BreakfastFireOutcome }> {
  const { order, linked } = locked;
  const tenantId = context.tenant.tenantId;
  if (linked.status === "fired") return { linked, outcome: "already_fired" };
  if (linked.status === "cancelled")
    throw new FacilityError("BREAKFAST_ORDER_CANCELLED");
  if (
    linked.status !== "paid" ||
    linked.paidAt === null ||
    linked.paidIntentId === null ||
    linked.paidIdr !== linked.totalIdr ||
    order.paymentLinkId === null
  )
    throw new FacilityError("BREAKFAST_NOT_PAID");

  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, linked.paidIntentId),
        eq(paymentIntents.paymentLinkId, order.paymentLinkId),
      ),
    )
    .for("update");
  if (
    !intent ||
    !(BREAKFAST_PAID_INTENT_STATUSES as readonly string[]).includes(
      intent.status,
    )
  ) {
    // The money is gone (refunded) or the intent is missing: nothing to sell.
    // Cancel instead of throwing so the fire sweep does not retry forever.
    const cancelled = await cancelBreakfastOrderTx(tx, context, locked, {
      reason: "payment_refunded",
      actorUserId: input.actorUserId,
      now: input.now,
    });
    return { linked: cancelled.linked, outcome: "cancelled" };
  }
  const at = await lockIntentsForFact(
    tx,
    context.tenant.tenantId,
    [intent.id],
    input.now,
  );

  const [ticket] = await tx
    .select({ status: accessTickets.status })
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        eq(accessTickets.id, linked.accessTicketId),
      ),
    );
  const ticketDead =
    !ticket ||
    (DEAD_TICKET_STATUSES as readonly string[]).includes(ticket.status);
  const balance = await refundableBalance(tx, intent);
  if (ticketDead || balance.reserved > 0n) {
    const cancelled = await cancelBreakfastOrderTx(tx, context, locked, {
      reason: ticketDead ? "ticket_closed" : "refund_committed",
      actorUserId: input.actorUserId,
      now: at,
    });
    return { linked: cancelled.linked, outcome: "cancelled" };
  }

  const [fired] = await tx
    .update(orders)
    .set({
      status: "sent",
      firedAt: at,
      paymentIntentId: intent.id,
      updatedAt: at,
    })
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, order.id),
        eq(orders.status, "awaiting_payment"),
      ),
    )
    .returning();
  if (!fired)
    throw new Error("Breakfast order is not awaiting payment; not fired again");
  const items = await tx
    .update(orderItems)
    .set({ fireStatus: "fired", updatedAt: at })
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, order.id),
        ne(orderItems.status, "voided"),
      ),
    )
    .returning({ id: orderItems.id });
  // The linked row turns `fired` BEFORE routing: the kitchen_tickets trigger
  // (kds.custom.sql) reads it and refuses anything not paid/fired.
  const [firedLinked] = await tx
    .update(facilityLinkedOrders)
    .set({ status: "fired", firedAt: at, updatedAt: at })
    .where(
      and(
        eq(facilityLinkedOrders.tenantId, tenantId),
        eq(facilityLinkedOrders.id, linked.id),
        eq(facilityLinkedOrders.status, "paid"),
      ),
    )
    .returning();
  if (!firedLinked) throw new Error("Breakfast fire returned no row");
  await routeFiredItemsToKitchen(tx, context, {
    outletId: order.outletId,
    orderId: order.id,
    itemIds: items.map((item) => item.id),
    actor: null,
    now: at,
    // The guest already paid: a missing station must not fail the fire.
    onUnresolved: "skip",
  });
  // The sale is made here, with its money verified (like fireQrOrder): WS-07
  // books it from order.paid at `fired_at`. One fire per order, so one event.
  if (order.taxResult)
    await recordTaxSnapshots(tx, context, {
      sourceType: "order",
      sourceId: ulidToUuid(order.id),
      outletId: order.outletId,
      businessDate: order.businessDate,
      result: order.taxResult,
    });
  await appendQrOrderPaid(tx, context, fired, {
    now: at,
    paidIntentId: intent.id,
    channel: "facility",
  });
  await auditFacility(tx, context, input.actorUserId, at, {
    action: "facility.breakfast.fired",
    objectType: "facility_linked_order",
    objectId: linked.id,
    outletId: linked.outletId,
    before: { id: linked.id, status: linked.status },
    after: { id: linked.id, status: "fired" },
  });
  return { linked: firedLinked, outcome: "fired" };
}

/** Item ids of an order, for the DTO. */
export async function breakfastLines(
  tx: Tx,
  tenantId: TenantId,
  orderIds: readonly string[],
) {
  if (orderIds.length === 0) return [];
  return tx
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        inArray(orderItems.orderId, [...orderIds]),
      ),
    )
    .orderBy(orderItems.id);
}
