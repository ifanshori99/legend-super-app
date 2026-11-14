// Reservation consumers of WS-05 payment events (PRD v1.7 §3.22 "DP &
// Kebijakan"; RSV-02; bead legend-t8bz). Wired in worker-main.ts before the
// deployment's own `deliverEvent`.
//
// `payment.paid` of an intent on a reservation's DP link confirms the
// reservation (`confirmReservationDeposit` → `reconcileDeposit`). Replay safe:
// the confirmation is conditional on `pending_deposit` and its event is keyed
// per reservation, so a redelivered `payment.paid` changes nothing. Payments of
// other bills (no reservation on that link) are ignored.
//
// A DP paid AFTER the reservation was already closed unpaid (the PRD allows a
// late payment on an expired intent, §3.13 "Siklus Pembayaran") belongs to no
// booking any more. PRD silent; safest rule: record it as the reservation's DP
// and request a FULL refund through WS-05 (approval stays with WS-05), never
// keep the guest's money for a booking that no longer exists.
//
// The decision is taken from the row locked by `confirmReservationDeposit`,
// never from the read before it: the stale-hold sweep locks its batch first
// and closes a row afterwards, so a payment delivered while that transaction
// is open would see `pending_deposit`, then find the row cancelled under the
// lock. Reading the status again after the lock is what makes that payment a
// late payment instead of a silent loss.
import { and, eq, isNull, or } from "drizzle-orm";
import {
  idr,
  uuidSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { reservationConfirmedPayloadSchema } from "@starter/shared/reservation";
import { z } from "zod";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { reservations } from "../db/schema/reservation.ts";
import { withTenant } from "../db/tenant.ts";
import {
  auditReservation,
  loadHeldDeposit,
  lockReservation,
} from "./reservation-core.ts";
import { notifyReservationConfirmed } from "./reservation-guest-notify.ts";
import { confirmReservationDeposit } from "./reservation-lifecycle.ts";
import { requestDepositRefund } from "./reservation-refunds.ts";

const paymentPaidPayloadSchema = z.object({
  intentId: uuidSchema,
  paymentLinkId: uuidSchema,
});

export type PaymentPaidOutcome =
  "ignored" | "confirmed" | "unchanged" | "late_refund_requested";

/** The reservation whose DP this intent pays, if any (link, or legacy intent). */
async function findDepositReservation(
  context: ScopedTenantContext,
  intentId: string,
  paymentLinkId: string,
) {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          or(
            eq(reservations.depositPaymentLinkId, paymentLinkId),
            eq(reservations.depositPaymentId, intentId),
          ),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Records a DP that arrived after its reservation closed unpaid and asks WS-05
 * for its full refund. No-op unless the reservation is closed, has no settled
 * DP recorded and the intent on its link is really settled.
 */
async function refundLateDeposit(
  context: ScopedTenantContext,
  row: typeof reservations.$inferSelect,
  intentId: string,
  now: Date,
): Promise<boolean> {
  const refund = await withTenant(db, context, async (tx) => {
    const locked = await lockReservation(tx, context, row.outletId, row.id);
    if (
      (locked.status !== "cancelled" && locked.status !== "no_show") ||
      locked.depositPaymentId !== null ||
      locked.depositPaymentLinkId === null
    )
      return null;
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
          eq(paymentIntents.paymentLinkId, locked.depositPaymentLinkId),
        ),
      );
    if (!intent) return null;
    // RSV-03: a DP refund is only owed for what the intent still holds; a
    // fully refunded intent was already returned and a partly refunded one is
    // refunded only for its remainder, never twice.
    const { heldIdr: amount } = await loadHeldDeposit(
      tx,
      context,
      intent.id,
      intent.amountIdr,
    );
    if (amount <= 0) return null;
    const [updated] = await tx
      .update(reservations)
      .set({
        depositPaymentId: intent.id,
        depositRefundIdr: amount,
        depositForfeitedIdr: idr(0),
        refundStatus: "pending",
        refundAttempts: 0,
        refundNextAttemptAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, locked.id),
          isNull(reservations.depositPaymentId),
        ),
      )
      .returning();
    if (!updated) return null;
    await auditReservation(tx, context, {
      actorUserId: null,
      outletId: locked.outletId,
      action: "reservation.late_deposit_refund",
      reservationId: locked.id,
      reason: "DP paid after the reservation closed",
      before: { status: locked.status, depositPaidIdr: 0 },
      after: {
        status: locked.status,
        depositPaidIdr: amount,
        depositRefundIdr: amount,
        depositForfeitedIdr: 0,
        refundStatus: "pending",
      },
      now,
    });
    return { intentId: intent.id, refundIdr: amount };
  });
  if (!refund) return false;
  await requestDepositRefund(
    context,
    row.outletId,
    row.id,
    refund,
    "late_deposit",
    null,
  );
  return true;
}

/**
 * `payment.paid` consumer (RSV-02). Idempotent and replay safe; ignores events
 * of other names, other tenants and payments of non-reservation bills.
 */
export async function handlePaymentPaid(
  context: ScopedTenantContext,
  event: EventEnvelope,
  now: Date = new Date(),
): Promise<PaymentPaidOutcome> {
  if (event.name !== "payment.paid") return "ignored";
  if (event.tenantId !== context.tenant.tenantId) return "ignored";
  const payload = paymentPaidPayloadSchema.safeParse(event.payload);
  if (!payload.success) return "ignored";
  const { intentId, paymentLinkId } = payload.data;
  const row = await findDepositReservation(context, intentId, paymentLinkId);
  if (!row) return "ignored";
  // Reconcile from the locked row, not the read above: the stale-hold sweep
  // (or a new booking's lazy sweep) may close a `pending_deposit` reservation
  // while this event waits for its lock. The status below is the one the lock
  // saw; a payment that lost that race is a late payment.
  const status =
    row.status === "pending_deposit"
      ? (await confirmReservationDeposit(context, row.outletId, row.id, now))
          .status
      : row.status;
  if (status === "confirmed")
    return row.status === "pending_deposit" ? "confirmed" : "unchanged";
  if (status !== "cancelled" && status !== "no_show") return "unchanged";
  // The reservation closed without ever recording a DP: the amount just paid
  // is refunded in full. `refundLateDeposit` re-locks and re-checks, so a
  // replay or a racing worker is a no-op.
  return (await refundLateDeposit(context, row, intentId, now))
    ? "late_refund_requested"
    : "unchanged";
}

/**
 * `reservation.confirmed` consumer (legend-lb3c): the guest's confirmation
 * message, written only if the booking is still confirmed when the event is
 * consumed. Idempotent; ignores other events and other tenants.
 */
export async function handleReservationConfirmed(
  context: ScopedTenantContext,
  event: EventEnvelope,
  now: Date = new Date(),
): Promise<boolean> {
  if (event.name !== "reservation.confirmed") return false;
  if (event.tenantId !== context.tenant.tenantId || event.outletId === null)
    return false;
  const payload = reservationConfirmedPayloadSchema.safeParse(event.payload);
  if (!payload.success) return false;
  return notifyReservationConfirmed(
    context,
    event.outletId as OutletId,
    payload.data.reservationId,
    now,
  );
}
