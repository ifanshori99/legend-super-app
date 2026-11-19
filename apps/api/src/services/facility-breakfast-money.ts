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
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  idr,
  ulidToUuid,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { FacilityError } from "@starter/shared/facility";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import {
  paymentIntents,
  paymentLinks,
  paymentRefunds,
} from "../db/schema/index.ts";
import { db } from "../db/index.ts";
import { accessTickets, facilityLinkedOrders } from "../db/schema/facility.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import { auditFacility } from "./facility-shared.ts";
import { routeFiredItemsToKitchen } from "./kds.service.ts";
import type { Tx } from "./menu-internals.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { systemRefundMayRefile } from "./system-refund-followup.ts";
import { confirmLinkUnpaidAtProvider } from "./payment-provider-proof.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { openRefundChainSafely } from "./payment-refund.service.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import { cancelPaymentLinkInTx } from "./payment.service.ts";
import { pendingRefundIdr } from "./pos-order-late-payment.ts";
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
export const DEAD_TICKET_STATUSES: readonly string[] = [
  "cancelled",
  "refunded",
  "no_show",
];

/**
 * Requester of every breakfast refund request (cancel, late, double payment).
 * Listed in `systemRefundActorSchema`, so the refund screen names it.
 */
export const FACILITY_SYSTEM_ACTOR: SystemRefundActor = "system:facility";

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
 * Locks the pay link row. Repo lock order is link -> intent (the WS-05
 * confirmation, `cancelPaymentLinkInTx`), so take this BEFORE locking any
 * intent of the link in a transaction that may close the link: the full order
 * is orders -> facility_linked_orders -> payment_links -> payment_intents.
 */
export async function lockBreakfastPayLink(
  tx: Tx,
  context: ScopedTenantContext,
  linkId: string,
): Promise<void> {
  await tx
    .select({ id: paymentLinks.id })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, context.tenant.tenantId),
        eq(paymentLinks.id, linkId),
      ),
    )
    .for("update");
}

/**
 * Guard for the callers that cancel an UNPAID order (pay on a dead ticket, member
 * cancel, sweep; legend-ukbq3). Call it in the transaction that holds the order
 * rows, AFTER `lockBreakfastPayLink`, before `cancelBreakfastOrderTx`. Money can
 * reach an intent of the link before the worker records the order `paid`
 * (`payment.paid` goes through the outbox): cancelling then would close the link
 * and the consumer would refund the whole payment as late. Refuses with 409 so
 * the caller retries once the paid mark is recorded and takes the paid (refund)
 * path. Not part of `cancelBreakfastOrderTx`: the consumer cancels there too, to
 * refund a late payment.
 */
export async function assertBreakfastLinkHoldsNoMoney(
  tx: Tx,
  context: ScopedTenantContext,
  locked: LockedBreakfast,
): Promise<void> {
  const { order, linked } = locked;
  if (order.paymentLinkId === null || linked.status !== "awaiting_payment")
    return;
  const [taken] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.paymentLinkId, order.paymentLinkId),
        inArray(paymentIntents.status, [...BREAKFAST_PAID_INTENT_STATUSES]),
      ),
    )
    .limit(1);
  if (taken)
    throw new CoreError(
      "CONFLICT",
      "Pembayaran sudah diterima; tunggu konfirmasi.",
    );
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
    /** Refund that failed and is being replaced: own key, same lock and cap. */
    keySuffix?: string;
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
    FACILITY_SYSTEM_ACTOR,
    // The re-file key must stay within idempotencyKeySchema (100 chars):
    // "fb-refile:cancel:" (17) + intent uuid (36) + ":" + refund uuid (36) = 90,
    // "fb-refile:late:" (15) gives 88. The longer
    // `facility-breakfast-refund:cancel:` form would be 106. Both prefixes are
    // reserved (payment-admin-idempotency.ts) and the late one is a
    // late-payment refund prefix (payment-refund.service.ts).
    input.keySuffix
      ? `fb-refile:${input.kind}:${intent.id}:${input.keySuffix}`
      : `facility-breakfast-refund:${input.kind}:${intent.id}`,
    "refund.create",
    {
      paymentIntentId: intent.id,
      reason: `facility_breakfast_${input.kind}`,
      ...(input.keySuffix ? { failedRefundId: input.keySuffix } : {}),
    },
    async () => {
      const { cap, reserved } = await refundableBalance(tx, intent);
      // A cancel never adds to a refund that is already filed (even pending).
      // A late or double payment follows the QR rule: a pending refund is not
      // subtracted, its approval fails `cap_exceeded` if both would pay.
      // A re-file (keySuffix) of either kind subtracts pending too: it only
      // files the real remainder, so live refunds never exceed what was paid.
      const pending = await pendingRefundIdr(tx, tenantId, intent.id);
      const free =
        input.kind === "cancel" || input.keySuffix
          ? cap - reserved
          : cap - (reserved - pending);
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
          requestedBy: FACILITY_SYSTEM_ACTOR,
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
 * A refund failed (rejected, expired, provider failure) on the intent of a
 * CANCELLED breakfast order: the cancel may have found the money held by that
 * refund (admin refund pending, nothing free), so the guest is owed it again.
 * Files the remaining obligation (paid less the refunds still live) under its
 * own key `fb-refile:cancel:<intentId>:<failedRefundId>`, with
 * the same intent lock and cap as the cancel refund, so live refunds never add
 * up to more than was paid. A fund refund is not filed again. A failed
 * breakfast refund (requested by `system:facility`) is filed again only while
 * `systemRefundMayRefile` allows (legend-weuo2: a failure a new request can
 * fix, not a rejection, at most `MAX_SYSTEM_REFUND_REFILE_ATTEMPTS` failures
 * per intent); otherwise it ends as a follow-up item for a person
 * (`settleSystemRefundFailure`). The same holds for
 * the LATE refund of the intent (`facility-breakfast-refund:late:<intentId>`,
 * filed for a late, double or split payment, or a cancel that found the order
 * paid by another code): when a refund other than that one fails, the rest is
 * filed again as kind late under `fb-refile:late:<intentId>:<failedRefundId>`
 * (maxIdr null, `cap - reserved` formula like every re-file, so pending refunds
 * are subtracted and the live total never passes what was paid). Called from
 * `failRefund` (payment-refund.service.ts) inside its transaction, which
 * already holds the intent lock; the order and linked rows are only read, never
 * locked, so the repo lock order (orders -> linked -> link -> intents) is not
 * inverted. `refunded_idr` is not touched for the same reason.
 */
export async function refileBreakfastRefundAfterFailure(
  tx: Tx,
  context: ScopedTenantContext,
  refund: typeof paymentRefunds.$inferSelect,
  now: Date,
): Promise<void> {
  if (refund.unallocatedFundId !== null) return;
  if (
    refund.requestedBy === FACILITY_SYSTEM_ACTOR &&
    !(await systemRefundMayRefile(tx, refund))
  )
    return;
  const tenantId = context.tenant.tenantId;
  const [intent] = await tx
    .select({ paymentLinkId: paymentIntents.paymentLinkId })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, refund.paymentIntentId),
      ),
    );
  if (!intent) return;
  const [row] = await tx
    .select({
      order: { id: orders.id, outletId: orders.outletId },
      status: facilityLinkedOrders.status,
      paidIntentId: facilityLinkedOrders.paidIntentId,
      paidIdr: facilityLinkedOrders.paidIdr,
      refundedIdr: facilityLinkedOrders.refundedIdr,
    })
    .from(orders)
    .innerJoin(
      facilityLinkedOrders,
      and(
        eq(facilityLinkedOrders.tenantId, orders.tenantId),
        eq(facilityLinkedOrders.orderId, orders.id),
      ),
    )
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.paymentLinkId, intent.paymentLinkId),
        eq(orders.channel, "facility"),
      ),
    )
    .limit(1);
  if (!row) return;
  if (row.status === "cancelled" && row.paidIntentId === refund.paymentIntentId)
    await requestBreakfastRefund(tx, context, {
      order: row.order,
      paymentLinkId: intent.paymentLinkId,
      intentId: refund.paymentIntentId,
      // `refunded_idr` still counts the cancel refund that just failed (and
      // is never lowered), so a system refund re-files up to what the order
      // paid; `cap - reserved` inside keeps live refunds within the payment.
      maxIdr:
        refund.requestedBy === FACILITY_SYSTEM_ACTOR
          ? row.paidIdr
          : Math.max(0, row.paidIdr - row.refundedIdr),
      kind: "cancel",
      keySuffix: refund.id,
      now,
    });
  // Late path: the intent has a late refund request (once per intent), or a
  // re-file of one (`fb-refile:late:<intentId>:<failedRefundId>`, so a re-filed
  // late refund that fails is filed again too, within the attempt limit).
  const lateKey = `facility-breakfast-refund:late:${refund.paymentIntentId}`;
  const lateRefileKey = `fb-refile:late:${refund.paymentIntentId}:`;
  const keys = await tx.execute(sql`
    SELECT 1
      FROM payment_admin_idempotency
     WHERE tenant_id = ${tenantId}
       AND (key = ${lateKey}
         OR key LIKE ${`${lateKey}:%`}
         OR key LIKE ${`${lateRefileKey}%`})
     LIMIT 1
  `);
  if (keys.rows.length === 0) return;
  await requestBreakfastRefund(tx, context, {
    order: row.order,
    paymentLinkId: intent.paymentLinkId,
    intentId: refund.paymentIntentId,
    maxIdr: null,
    kind: "late",
    keySuffix: refund.id,
    now,
  });
}

/**
 * Provider proof before a breakfast cancel (legend-ukbq3). Call it OUTSIDE any
 * transaction and lock, before the transaction that runs `cancelBreakfastOrderTx`
 * (it does network I/O). Asks the provider about the pay link of the order: money
 * already there is applied once through the normal settlement path, so the
 * caller's own locked re-read finds the order `paid` and takes the existing paid
 * (refund) path instead of a local cancel; an unclear answer throws 409
 * `PAYMENT_PROVIDER_UNCONFIRMED` and nothing is cancelled. An order without a
 * link, or already cancelled or fired, needs no proof.
 */
export async function confirmBreakfastLinkUnpaid(
  context: ScopedTenantContext,
  orderId: string,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const found = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({
        linkId: orders.paymentLinkId,
        status: facilityLinkedOrders.status,
      })
      .from(orders)
      .innerJoin(
        facilityLinkedOrders,
        and(
          eq(facilityLinkedOrders.tenantId, orders.tenantId),
          eq(facilityLinkedOrders.orderId, orders.id),
        ),
      )
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)));
    return row ?? null;
  });
  if (!found || found.linkId === null) return;
  if (found.status === "cancelled" || found.status === "fired") return;
  await confirmLinkUnpaidAtProvider(context, found.linkId, now);
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

/**
 * Thrown by `fireBreakfastOrderTx` before it would cancel an order locally
 * (legend-9sw2w) while the provider was not asked about the order's other open
 * codes. Nothing was written: the caller rolls back, runs
 * `confirmBreakfastLinkUnpaid` OUTSIDE any transaction and lock, then calls
 * again with `providerProven: true`.
 */
export class BreakfastProviderProofNeeded extends Error {
  constructor() {
    super("Breakfast cancel needs the payment provider's word first");
    this.name = "BreakfastProviderProofNeeded";
  }
}

export type BreakfastFireOutcome =
  | "fired"
  | "already_fired"
  | "cancelled"
  // Cancelled and refunded in full because the fact time is at or after the
  // ticket's ends_at (the ticket itself is not dead).
  | "ended";

/**
 * THE way a breakfast order reaches the kitchen. Refuses anything that is not
 * `paid` (BREAKFAST_NOT_PAID), is idempotent for a fired order, and refuses a
 * cancelled one. Re-checks the paid intent under its row lock: a refund already
 * filed against it, a ticket that will never be used, or a fact time at or
 * after the ticket's ends_at cancels the order and returns the rest instead of
 * firing (outcome `ended` for the last one). Every local cancel needs
 * `providerProven` (legend-9sw2w; see `BreakfastProviderProofNeeded`): another
 * open code of the link may already hold money at the provider.
 */
export async function fireBreakfastOrderTx(
  tx: Tx,
  context: ScopedTenantContext,
  locked: LockedBreakfast,
  input: {
    actorUserId: string | null;
    now: Date;
    /** The provider was asked about the link's other codes (outside the lock). */
    providerProven?: boolean;
  },
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

  // Link before intent: the cancel paths below close the link.
  await lockBreakfastPayLink(tx, context, order.paymentLinkId);
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
    if (!input.providerProven) throw new BreakfastProviderProofNeeded();
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
    .select({ status: accessTickets.status, endsAt: accessTickets.endsAt })
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        eq(accessTickets.id, linked.accessTicketId),
      ),
    );
  const ticketDead = !ticket || DEAD_TICKET_STATUSES.includes(ticket.status);
  // Never to the kitchen at or after ends_at, even if the worker was down.
  const ended = !!ticket && at.getTime() >= ticket.endsAt.getTime();
  const balance = await refundableBalance(tx, intent);
  if (ticketDead || ended || balance.reserved > 0n) {
    if (!input.providerProven) throw new BreakfastProviderProofNeeded();
    const cancelled = await cancelBreakfastOrderTx(tx, context, locked, {
      reason: ticketDead
        ? "ticket_closed"
        : ended
          ? "ticket_ended"
          : "refund_committed",
      actorUserId: input.actorUserId,
      now: at,
    });
    return {
      linked: cancelled.linked,
      outcome: ended && !ticketDead ? "ended" : "cancelled",
    };
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
