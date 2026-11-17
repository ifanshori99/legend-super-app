// Breakfast order consumers of WS-05 payment events and the fire / unpaid
// sweep (bead oa0qk; owner Q43: a ticket's breakfast MUST be paid before it
// reaches the kitchen / KDS; PRD v1.7 §3 F22, FAC-10).
//
// Routed here by order-payment-consumers.ts `deliverOrderPaymentEvent` for an
// order of channel `facility`, inside the outbox consumption transaction.
// Every handler re-reads the locked rows; the event only says where to look.
//
// payment.paid is the ONLY source of the paid mark. The order becomes `paid`
// (never fired here: the sweep or the staff endpoint fires it at fire_at) only
// when (a) it is still `awaiting_payment`, (b) the event's intent is settled on
// the order's link, (c) the link total equals the order total and is covered,
// (d) one code covered it alone, (e) no refund is already filed against that
// code, and (f) the ticket is still usable and the session has not ended
// (at < ends_at; a payment between fire_at and ends_at is still a sale and the
// next sweep fires it).
// Everything else that carries verified money goes back to the guest:
// - a second code paid after the order was paid, or a payment on a cancelled
//   order: a refund request for what the code holds (`requestBreakfastRefund`,
//   `requestQrDoublePaymentRefund` for the `double_payment` funds);
// - a bill covered only by several codes together, a payment at or after the
//   ticket's ends_at or for a dead ticket, or a code with a refund already filed: the order is
//   cancelled and every code that put money toward it is refunded.
// A replay finds the order paid / cancelled and files nothing twice (the
// refund keys are once per intent and kind).
//
// Sweep (`fireDueBreakfastOrders`, worker relay tick): fires paid orders that
// are due (a paid order whose fire time is at or after ends_at is cancelled and
// refunded in full instead, even if the worker was down; it counts as
// cancelled) and cancels unpaid ones only once the ticket session ended (now >=
// ends_at) or the ticket is dead; until then an unpaid order stays
// `awaiting_payment`. A payment that lands on a cancelled order afterwards is
// refunded by the handler above.
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { uuidSchema, z, type ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { paymentIntents, paymentLinks } from "../db/schema/index.ts";
import { accessTickets, facilityLinkedOrders } from "../db/schema/facility.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { auditFacility } from "./facility-shared.ts";
import {
  assertBreakfastLinkHoldsNoMoney,
  BREAKFAST_PAID_INTENT_STATUSES,
  cancelBreakfastOrderTx,
  confirmBreakfastLinkUnpaid,
  DEAD_TICKET_STATUSES,
  FACILITY_SYSTEM_ACTOR,
  fireBreakfastOrderTx,
  lockBreakfastOrder,
  lockBreakfastPayLink,
  requestBreakfastRefund,
  type LockedBreakfast,
} from "./facility-breakfast-money.ts";
import type { Tx } from "./menu-internals.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { netAllocatedIdrSql } from "./payment-net-allocated-sql.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { requestQrDoublePaymentRefund } from "./qr-order-late-payment.ts";

export type BreakfastPaidOutcome =
  | "ignored"
  | "paid"
  | "unchanged"
  | "not_settled"
  | "amount_mismatch"
  | "currency_mismatch"
  | "double_payment_refund_requested"
  | "late_payment_on_cancelled_order"
  | "late_payment_refunded"
  | "refund_committed"
  | "split_payment_refunded";

export type BreakfastClosedOutcome = "ignored" | "unchanged";

export type BreakfastFundsOutcome =
  "ignored" | "unchanged" | "funds_refund_requested";

const paidPayloadSchema = z.looseObject({
  intentId: uuidSchema,
  paymentLinkId: uuidSchema,
  currency: z.string().optional(),
});
const fundsPayloadSchema = z.looseObject({
  unallocatedFundId: uuidSchema,
  intentId: uuidSchema,
});
const closedPayloadSchema = z.looseObject({
  intentId: uuidSchema,
  reason: z.string().optional(),
});

/** Intent statuses that put money on the bill (a completed refund moves on). */
const SETTLED_INTENT_STATUSES: readonly string[] = [
  ...BREAKFAST_PAID_INTENT_STATUSES,
  "refunded",
];

/** The breakfast order that owns `paymentLinkId`, or null. */
async function orderIdOfLink(
  tx: Tx,
  context: ScopedTenantContext,
  paymentLinkId: string,
): Promise<string | null> {
  const [order] = await tx
    .select({ id: orders.id, channel: orders.channel })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, context.tenant.tenantId),
        eq(orders.paymentLinkId, paymentLinkId),
      ),
    );
  return order && order.channel === "facility" ? order.id : null;
}

/**
 * What each settled code of the link put toward the bill: its provider
 * evidence less the part booked as unallocated funds (overpayment or double
 * payment) and what the provider refunded on its own. One statement, one snapshot (same record the QR consumer reads).
 */
async function allocatedIdrByIntent(
  tx: Tx,
  context: ScopedTenantContext,
  paymentLinkId: string,
): Promise<Map<string, number>> {
  const result = await tx.execute<{ id: string; allocated: string }>(sql`
    SELECT i.id,
           (${netAllocatedIdrSql(sql`i.tenant_id`, sql`i.id`)})::text AS allocated
      FROM payment_intents i
     WHERE i.tenant_id = ${context.tenant.tenantId}
       AND i.payment_link_id = ${paymentLinkId}
       AND i.status IN ('paid', 'partially_refunded', 'refunded')`);
  return new Map(result.rows.map((row) => [row.id, Number(row.allocated)]));
}

/** Refunds `intentId`'s double-payment funds; true when a request was filed. */
async function refundDoublePayment(
  tx: Tx,
  context: ScopedTenantContext,
  order: { id: string; outletId: string },
  paymentLinkId: string,
  intentId: string,
  now: Date,
): Promise<boolean> {
  const ids = await requestQrDoublePaymentRefund(tx, context, {
    order,
    paymentLinkId,
    intentId,
    now,
    source: {
      requestedBy: FACILITY_SYSTEM_ACTOR,
      reason:
        "Refund pembayaran ganda (pesanan sarapan fasilitas sudah dibayar dengan kode lain)",
    },
  });
  return ids.length > 0;
}

/** ORD-02 for breakfast: marks a pay-first breakfast order paid. Replay safe. */
export async function handleBreakfastPaymentPaid(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<BreakfastPaidOutcome> {
  if (event.name !== "payment.paid") return "ignored";
  const tenantId = context.tenant.tenantId;
  if (event.tenantId !== tenantId) return "ignored";
  const payload = paidPayloadSchema.safeParse(event.payload);
  if (!payload.success) return "ignored";
  const { intentId, paymentLinkId, currency } = payload.data;
  const orderId = await orderIdOfLink(tx, context, paymentLinkId);
  if (orderId === null) return "ignored";
  // Lock order: orders -> facility_linked_orders -> payment_intents.
  const locked = await lockBreakfastOrder(tx, context, orderId);
  if (!locked) return "ignored";
  const { order, linked } = locked;

  if (linked.status === "paid" || linked.status === "fired") {
    // The same code again is a replay. Another code paid after the order was
    // paid: WS-05 booked it as `double_payment` funds; give it back.
    if (linked.paidIntentId === intentId) return "unchanged";
    return (await refundDoublePayment(
      tx,
      context,
      order,
      paymentLinkId,
      intentId,
      now,
    ))
      ? "double_payment_refund_requested"
      : "unchanged";
  }

  if (linked.status === "cancelled") {
    // The cancel already filed the refund of the code that paid the order.
    if (linked.paidIntentId === intentId) return "unchanged";
    // Money that arrived after the order was cancelled never revives it.
    const refund = await requestBreakfastRefund(tx, context, {
      order,
      paymentLinkId,
      intentId,
      maxIdr: null,
      kind: "late",
      now,
    });
    const double = await refundDoublePayment(
      tx,
      context,
      order,
      paymentLinkId,
      intentId,
      now,
    );
    logger.warn(
      { orderId: order.id, intentId, refundId: refund.refundId },
      "Breakfast: payment settled after the order was cancelled; refund requested",
    );
    return refund.refundId !== null || double
      ? "late_payment_on_cancelled_order"
      : "unchanged";
  }

  // awaiting_payment
  if (currency !== undefined && currency !== "IDR") return "currency_mismatch";
  const [link] = await tx
    .select({ paidIdr: paymentLinks.paidIdr, totalIdr: paymentLinks.totalIdr })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, tenantId),
        eq(paymentLinks.id, paymentLinkId),
      ),
    )
    // Link before intent (WS-05 order): the refuse path below closes the link
    // after locking the intents.
    .for("update");
  if (!link) return "not_settled";
  // PAY-01: the bill the guest paid is the server's order total, exactly.
  if (link.totalIdr !== linked.totalIdr || order.totalIdr !== linked.totalIdr) {
    logger.warn(
      { orderId: order.id, paymentLinkId },
      "Breakfast: payment link total differs from the order total",
    );
    return "amount_mismatch";
  }
  if (link.paidIdr < link.totalIdr) return "not_settled";
  const [intent] = await tx
    .select({ status: paymentIntents.status })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, intentId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
      ),
    );
  if (!intent || !SETTLED_INTENT_STATUSES.includes(intent.status))
    return "not_settled";

  const allocated = await allocatedIdrByIntent(tx, context, paymentLinkId);
  const own = allocated.get(intentId) ?? 0;
  // The code that covered the bill alone: the event's own, else the one other.
  let payerId: string | null = null;
  if (own >= linked.totalIdr) payerId = intentId;
  else
    for (const [id, amount] of allocated)
      if (amount > 0 && amount >= linked.totalIdr) {
        payerId = id;
        break;
      }
  if (payerId === null && own === 0) {
    // This code put nothing toward the bill and none covered it alone: the
    // codes that did report with their own events. Its money goes back.
    return (await refundDoublePayment(
      tx,
      context,
      order,
      paymentLinkId,
      intentId,
      now,
    ))
      ? "double_payment_refund_requested"
      : "unchanged";
  }

  const contributors = [...allocated]
    .filter(([id, amount]) => amount > 0 || id === payerId)
    .map(([id]) => id);
  const at = await lockIntentsForFact(
    tx,
    tenantId,
    [intentId, ...(payerId === null ? [] : [payerId]), ...contributors],
    now,
  );

  // Why this payment cannot become a sale (money goes back instead).
  let refuse: "late" | "split" | "committed" | null = null;
  if (payerId === null) refuse = "split";
  else {
    const [ticket] = await tx
      .select({ status: accessTickets.status, endsAt: accessTickets.endsAt })
      .from(accessTickets)
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, linked.accessTicketId),
        ),
      );
    if (
      !ticket ||
      DEAD_TICKET_STATUSES.includes(ticket.status) ||
      at.getTime() >= ticket.endsAt.getTime()
    )
      refuse = "late";
    else {
      const [code] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, tenantId),
            eq(paymentIntents.id, payerId),
            eq(paymentIntents.paymentLinkId, paymentLinkId),
          ),
        );
      if (!code) return "not_settled";
      // Any refund already filed against the code (even pending) means the
      // money may go back: never sell the food on top of it.
      if ((await refundableBalance(tx, code)).reserved > 0n)
        refuse = "committed";
    }
  }

  if (refuse !== null) {
    await cancelBreakfastOrderTx(tx, context, locked, {
      reason: `payment_${refuse}`,
      actorUserId: null,
      now: at,
    });
    const refundIds: (string | null)[] = [];
    for (const id of new Set([intentId, ...contributors]))
      refundIds.push(
        (
          await requestBreakfastRefund(tx, context, {
            order,
            paymentLinkId,
            intentId: id,
            maxIdr: null,
            kind: "late",
            now: at,
          })
        ).refundId,
      );
    await refundDoublePayment(tx, context, order, paymentLinkId, intentId, at);
    logger.warn(
      { orderId: order.id, intentId, refuse, refundIds },
      "Breakfast: payment cannot become a sale; order cancelled, money refunded",
    );
    return refuse === "split"
      ? "split_payment_refunded"
      : refuse === "committed"
        ? "refund_committed"
        : "late_payment_refunded";
  }

  const [paid] = await tx
    .update(facilityLinkedOrders)
    .set({
      status: "paid",
      paidIdr: linked.totalIdr,
      paidIntentId: payerId,
      paidAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(facilityLinkedOrders.tenantId, tenantId),
        eq(facilityLinkedOrders.id, linked.id),
        eq(facilityLinkedOrders.status, "awaiting_payment"),
      ),
    )
    .returning({ id: facilityLinkedOrders.id });
  if (!paid) throw new Error("Breakfast paid mark returned no row");
  await auditFacility(tx, context, null, at, {
    action: "facility.breakfast.paid",
    objectType: "facility_linked_order",
    objectId: linked.id,
    outletId: linked.outletId,
    before: { id: linked.id, status: "awaiting_payment" },
    after: { id: linked.id, status: "paid" },
  });
  // A code the guest switched away from, paid on the same bill as well.
  if (
    await refundDoublePayment(tx, context, order, paymentLinkId, intentId, at)
  )
    logger.warn(
      { orderId: order.id, intentId },
      "Breakfast: paid by a code whose bill another code also covered; refund requested",
    );
  return "paid";
}

/**
 * payment.expired / payment.failed: nothing to undo. The order stays
 * `awaiting_payment` (the guest may open another code on the same link) and
 * the sweep cancels it once the ticket session ends; a settlement that still arrives later is
 * refunded by `handleBreakfastPaymentPaid`.
 */
export async function handleBreakfastPaymentClosed(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
): Promise<BreakfastClosedOutcome> {
  if (event.name !== "payment.expired" && event.name !== "payment.failed")
    return "ignored";
  if (event.tenantId !== context.tenant.tenantId) return "ignored";
  const payload = closedPayloadSchema.safeParse(event.payload);
  if (!payload.success) return "ignored";
  if (payload.data.reason === "superseded") return "ignored";
  const [intent] = await tx
    .select({ paymentLinkId: paymentIntents.paymentLinkId })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, payload.data.intentId),
      ),
    );
  if (!intent) return "ignored";
  return (await orderIdOfLink(tx, context, intent.paymentLinkId)) === null
    ? "ignored"
    : "unchanged";
}

/**
 * payment.funds_unallocated of a breakfast bill (bead 519): verified money the
 * gateway parked because the code can no longer settle the bill (cancelled
 * order, closed code, wrong amount). It is never kept: exactly one full refund
 * request per fund goes back to the guest, whatever the order state. A fund
 * that is resolved, or already has a live refund, files nothing (replay safe);
 * the amount is the locked fund row's, never the event's.
 */
export async function handleBreakfastFundsUnallocated(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<BreakfastFundsOutcome> {
  if (event.name !== "payment.funds_unallocated") return "ignored";
  if (event.tenantId !== context.tenant.tenantId) return "ignored";
  const payload = fundsPayloadSchema.safeParse(event.payload);
  if (!payload.success) return "ignored";
  const { unallocatedFundId, intentId } = payload.data;
  const [intent] = await tx
    .select({ paymentLinkId: paymentIntents.paymentLinkId })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, intentId),
      ),
    );
  if (!intent) return "ignored";
  const orderId = await orderIdOfLink(tx, context, intent.paymentLinkId);
  if (orderId === null) return "ignored";
  // Lock order: orders -> facility_linked_orders -> intent -> fund -> refund.
  const locked = await lockBreakfastOrder(tx, context, orderId);
  if (!locked) return "ignored";
  const ids = await requestQrDoublePaymentRefund(tx, context, {
    order: locked.order,
    paymentLinkId: intent.paymentLinkId,
    intentId,
    now,
    fundId: unallocatedFundId,
    source: {
      requestedBy: FACILITY_SYSTEM_ACTOR,
      reason:
        "Refund uang sarapan fasilitas yang masuk setelah tagihan tidak bisa dipakai (pesanan dibatalkan atau kode ditutup)",
    },
  });
  if (ids.length === 0) return "unchanged";
  logger.warn(
    { orderId: locked.order.id, intentId, unallocatedFundId, refundIds: ids },
    "Breakfast: unallocated funds refund requested",
  );
  return "funds_refund_requested";
}

// ---- Sweep (relay tick) ---------------------------------------------------------

async function dueOrderIds(
  context: ScopedTenantContext,
  status: "paid" | "awaiting_payment",
  now: Date,
  limit: number,
): Promise<string[]> {
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({ orderId: facilityLinkedOrders.orderId })
      .from(facilityLinkedOrders)
      .leftJoin(
        accessTickets,
        and(
          eq(accessTickets.tenantId, facilityLinkedOrders.tenantId),
          eq(accessTickets.id, facilityLinkedOrders.accessTicketId),
        ),
      )
      .where(
        and(
          eq(facilityLinkedOrders.tenantId, context.tenant.tenantId),
          eq(facilityLinkedOrders.status, status),
          lte(facilityLinkedOrders.fireAt, now),
          // An unpaid order is a candidate only once the cancel is allowed
          // (ticket dead or session over), so rows that may still be paid do
          // not fill the batch.
          status === "awaiting_payment"
            ? or(
                isNull(accessTickets.id),
                inArray(
                  accessTickets.status,
                  DEAD_TICKET_STATUSES as (typeof accessTickets.$inferSelect.status)[],
                ),
                lte(accessTickets.endsAt, now),
              )
            : undefined,
        ),
      )
      // Least recently touched first: a row that keeps failing is bumped
      // (`markSweepFailure`) and drops behind the rest instead of pinning the
      // head of every batch.
      .orderBy(
        asc(facilityLinkedOrders.updatedAt),
        asc(facilityLinkedOrders.fireAt),
        asc(facilityLinkedOrders.orderId),
      )
      .limit(limit),
  );
  return rows.map((row) => row.orderId);
}

/**
 * Moves a failed row behind the untouched ones (the failed transaction rolled
 * back, so this runs in its own). Best effort: a failure here is only logged.
 */
async function markSweepFailure(
  context: ScopedTenantContext,
  orderId: string,
  status: "paid" | "awaiting_payment",
  now: Date,
): Promise<void> {
  try {
    await withTenant(db, context, (tx) =>
      tx
        .update(facilityLinkedOrders)
        .set({ updatedAt: now })
        .where(
          and(
            eq(facilityLinkedOrders.tenantId, context.tenant.tenantId),
            eq(facilityLinkedOrders.orderId, orderId),
            eq(facilityLinkedOrders.status, status),
          ),
        ),
    );
  } catch (error) {
    logger.error(
      { orderId, err: error instanceof Error ? error.message : "unknown" },
      "Breakfast sweep: could not bump a failed order",
    );
  }
}

/**
 * Fires paid breakfast orders whose fire_at passed and cancels unpaid ones
 * whose fire_at passed only when the ticket session ended or the ticket is
 * dead. Each order has its own transaction under its row
 * locks; a rerun finds it fired / cancelled and changes nothing. Only a `paid`
 * order is ever fired (`fireBreakfastOrderTx`); one that fails is logged and
 * retried on the next tick without blocking the others.
 */
export async function fireDueBreakfastOrders(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 100,
): Promise<{ fired: number; cancelled: number; failed: number }> {
  let fired = 0;
  let cancelled = 0;
  let failed = 0;
  const run = async (
    orderId: string,
    act: (tx: Tx, locked: LockedBreakfast) => Promise<boolean>,
    expected: "paid" | "awaiting_payment",
  ): Promise<boolean> => {
    try {
      return await withTenant(db, context, async (tx) => {
        const locked = await lockBreakfastOrder(tx, context, orderId);
        if (!locked || locked.linked.status !== expected) return false;
        return act(tx, locked);
      });
    } catch (error) {
      failed += 1;
      logger.error(
        { orderId, err: error instanceof Error ? error.message : "unknown" },
        "Breakfast sweep: order failed; retried on the next tick",
      );
      await markSweepFailure(context, orderId, expected, now);
      return false;
    }
  };
  for (const orderId of await dueOrderIds(context, "paid", now, limit)) {
    const done = await run(
      orderId,
      async (tx, locked) => {
        const result = await fireBreakfastOrderTx(tx, context, locked, {
          actorUserId: null,
          now,
        });
        if (result.outcome === "cancelled" || result.outcome === "ended")
          cancelled += 1;
        return result.outcome === "fired";
      },
      "paid",
    );
    if (done) fired += 1;
  }
  for (const orderId of await dueOrderIds(
    context,
    "awaiting_payment",
    now,
    limit,
  )) {
    // Provider proof outside any lock (legend-ukbq3): money found there is
    // settled on the intent, but the worker records the order `paid` later (via
    // the outbox), so `run` below may still see it `awaiting_payment`: the guard
    // there then refuses (409) and the order is retried on a later tick, once
    // the paid mark is in. An unclear answer holds this order until the next
    // tick.
    try {
      await confirmBreakfastLinkUnpaid(context, orderId, now);
    } catch (error) {
      failed += 1;
      logger.warn(
        { orderId, err: error instanceof Error ? error.message : "unknown" },
        "Breakfast sweep: provider could not confirm the pay link; retried on the next tick",
      );
      await markSweepFailure(context, orderId, "awaiting_payment", now);
      continue;
    }
    const done = await run(
      orderId,
      async (tx, locked) => {
        // The guest may still pay until the ticket session ends: a paid-late
        // order is fired by the next paid pass. Cancel only when the session is
        // over or the ticket is dead.
        const [ticket] = await tx
          .select({
            status: accessTickets.status,
            endsAt: accessTickets.endsAt,
          })
          .from(accessTickets)
          .where(
            and(
              eq(accessTickets.tenantId, context.tenant.tenantId),
              eq(accessTickets.id, locked.linked.accessTicketId),
            ),
          );
        if (
          ticket &&
          !DEAD_TICKET_STATUSES.includes(ticket.status) &&
          now.getTime() < ticket.endsAt.getTime()
        )
          return false;
        // Link before intent; refuse while the link holds money not yet marked.
        if (locked.order.paymentLinkId !== null)
          await lockBreakfastPayLink(tx, context, locked.order.paymentLinkId);
        await assertBreakfastLinkHoldsNoMoney(tx, context, locked);
        await cancelBreakfastOrderTx(tx, context, locked, {
          reason: "payment_window_closed",
          actorUserId: null,
          now,
        });
        return true;
      },
      "awaiting_payment",
    );
    if (done) cancelled += 1;
  }
  return { fired, cancelled, failed };
}
