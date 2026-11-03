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
import { and, eq, isNull, or } from "drizzle-orm";
import {
  idr,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { depositIsSettled } from "@starter/shared/reservation";
import { z } from "zod";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { reservations } from "../db/schema/reservation.ts";
import { withTenant } from "../db/tenant.ts";
import { auditReservation, lockReservation } from "./reservation-core.ts";
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
    if (!intent || !depositIsSettled(intent.status)) return null;
    const amount = idr(intent.amountIdr);
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
  if (row.status === "pending_deposit") {
    const after = await confirmReservationDeposit(
      context,
      row.outletId,
      row.id,
      now,
    );
    return after.status === "confirmed" ? "confirmed" : "unchanged";
  }
  if (
    (row.status === "cancelled" || row.status === "no_show") &&
    row.depositPaymentId === null &&
    (await refundLateDeposit(context, row, intentId, now))
  )
    return "late_refund_requested";
  return "unchanged";
}
