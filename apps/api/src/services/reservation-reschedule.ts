// Staff decision on a guest's reschedule request (PRD v1.7 §3.22; bead
// legend-9txo). The guest side only records the request
// (reservation-public.ts); here staff approve or decline it. Routes:
// routes/reservation-public.routes.ts.
// - Approve moves `reservedFor` (and `pax` when the guest asked for another
//   party size) and re-holds the SAME tables for the new time through the
//   booking path (`replaceHolds`). A table taken at the new time is
//   RESERVATION_SLOT_TAKEN and everything rolls back: the request stays
//   pending. The DP and the policy snapshot (RSV-03) are not touched.
// - Money rule (RSV-03): the free-cancellation window is measured from the
//   ORIGINAL time, with the same machine as a cancel
//   (`cancellationDepositOutcome` on the policy snapshot). When a cancel right
//   now would not refund the DP in full, approving is refused
//   (RESERVATION_RESCHEDULE_LATE); otherwise a guest could move the booking out
//   and cancel for a full refund. Staff can still decline.
// - A larger party must still fit the tables already held.
// - Locks are taken in the booking order: outlet holds, then the request row,
//   then the reservation row.
// - Both decisions are idempotent by state: repeating the same decision on a
//   resolved request returns the stored result; the opposite decision is
//   RESERVATION_RESCHEDULE_RESOLVED.
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  assertOutletInScope,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  GUEST_LINK_GRACE_HOURS,
  ReservationError,
  cancellationDepositOutcome,
  reservationEvents,
  reservationPolicySnapshotSchema,
  resolveRescheduleResultSchema,
  type DeclineRescheduleInput,
  type ResolveRescheduleResult,
} from "@starter/shared/reservation";
import { db } from "../db/index.ts";
import { tables } from "../db/schema/index.ts";
import { reservations } from "../db/schema/reservation.ts";
import {
  reservationGuestLinks,
  reservationRescheduleRequests,
} from "../db/schema/reservation-public.ts";
import { withTenant } from "../db/tenant.ts";
import {
  MANAGE_PERMISSION,
  appendEnvelope,
  assertPermission,
  auditReservation,
  loadHeldDeposit,
  loadHolds,
  lockOutletHolds,
  lockReservation,
  mapHoldViolation,
  readReservation,
  reconcileDeposit,
  replaceHolds,
  type ReservationRow,
  type Tx,
} from "./reservation-core.ts";
import { assertAssignableTables } from "./reservation-booking.ts";
import { toRescheduleRequest } from "./reservation-public.ts";

type RescheduleRow = typeof reservationRescheduleRequests.$inferSelect;

async function lockRequest(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  requestId: string,
): Promise<RescheduleRow> {
  const [row] = await tx
    .select()
    .from(reservationRescheduleRequests)
    .where(
      and(
        eq(reservationRescheduleRequests.tenantId, context.tenant.tenantId),
        eq(reservationRescheduleRequests.outletId, outletId),
        eq(reservationRescheduleRequests.id, requestId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw new ReservationError("RESERVATION_NOT_FOUND");
  return row;
}

async function resultOf(
  tx: Tx,
  context: ScopedTenantContext,
  request: RescheduleRow,
  reservation: ReservationRow,
): Promise<ResolveRescheduleResult> {
  return resolveRescheduleResultSchema.parse({
    request: toRescheduleRequest(request),
    reservation: await readReservation(tx, context, reservation),
  });
}

async function markResolved(
  tx: Tx,
  context: ScopedTenantContext,
  request: RescheduleRow,
  status: "approved" | "declined",
  actorUserId: string,
  now: Date,
  previousReservedFor: Date | null = null,
): Promise<RescheduleRow> {
  const [updated] = await tx
    .update(reservationRescheduleRequests)
    .set({
      status,
      resolvedAt: now,
      resolvedBy: actorUserId,
      previousReservedFor,
    })
    .where(
      and(
        eq(reservationRescheduleRequests.tenantId, context.tenant.tenantId),
        eq(reservationRescheduleRequests.id, request.id),
      ),
    )
    .returning();
  if (!updated) throw new Error("Reschedule update returned no row");
  return updated;
}

/**
 * RSV-03: refuses a move once a cancel of the ORIGINAL time would no longer
 * refund the DP in full. The amount is what a cancel would split: the held
 * remainder of a settled DP, or the full DP still to be paid (a booking
 * waiting for its DP must not escape the window by moving first).
 */
export async function assertFreeCancellationWindowOpen(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
  now: Date,
): Promise<void> {
  if (row.depositIdr <= 0) return;
  const policy = reservationPolicySnapshotSchema.parse(row.policySnapshot);
  const exposed =
    row.depositPaymentId === null
      ? row.depositIdr
      : (
          await loadHeldDeposit(
            tx,
            context,
            row.depositPaymentId,
            row.depositIdr,
          )
        ).heldIdr;
  if (exposed <= 0) return;
  if (now >= row.reservedFor)
    throw new ReservationError("RESERVATION_RESCHEDULE_LATE");
  const outcome = cancellationDepositOutcome(policy, {
    depositPaidIdr: exposed,
    reservedFor: row.reservedFor.toISOString(),
    cancelledAt: now.toISOString(),
  });
  if (outcome.refundIdr < exposed)
    throw new ReservationError("RESERVATION_RESCHEDULE_LATE");
}

/** Staff approve: the booking moves to the requested time. */
export async function approveRescheduleRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  requestId: string,
  now?: Date,
): Promise<ResolveRescheduleResult> {
  try {
    return await withTenant(db, context, async (tx) => {
      await assertPermission(tx, context, actorUserId, MANAGE_PERMISSION, {
        type: "outlet",
        id: outletId,
      });
      assertOutletInScope(context.outletScope, outletId);
      await lockOutletHolds(tx, context, outletId);
      const request = await lockRequest(tx, context, outletId, requestId);
      let row = await lockReservation(
        tx,
        context,
        outletId,
        request.reservationId,
      );
      // Read the clock only after the locks: an approve that queued behind
      // another transaction must be judged at the time it really decides.
      const decidedAt = now ?? new Date();
      if (request.status === "approved")
        return resultOf(tx, context, request, row);
      if (request.status !== "pending")
        throw new ReservationError("RESERVATION_RESCHEDULE_RESOLVED");
      row = await reconcileDeposit(tx, context, row, decidedAt);
      if (row.status !== "pending_deposit" && row.status !== "confirmed")
        throw new ReservationError("RESERVATION_TRANSITION_INVALID");
      if (request.requestedFor <= decidedAt)
        throw new ReservationError("RESERVATION_RESCHEDULE_INVALID");
      await assertFreeCancellationWindowOpen(tx, context, row, decidedAt);
      const heldTableIds = [
        ...new Set(
          (await loadHolds(tx, context, [row.id]))
            .filter((hold) => hold.releasedAt === null)
            .map((hold) => hold.tableId),
        ),
      ].sort();
      const newPax = request.partySize ?? row.pax;
      if (newPax > row.pax && heldTableIds.length > 0) {
        const seats = await tx
          .select({ capacity: tables.capacity })
          .from(tables)
          .where(
            and(
              eq(tables.tenantId, context.tenant.tenantId),
              eq(tables.outletId, outletId),
              inArray(tables.id, heldTableIds),
            ),
          );
        if (seats.reduce((sum, table) => sum + table.capacity, 0) < newPax)
          throw new ReservationError("RESERVATION_SLOT_UNAVAILABLE");
      }
      const [moved] = await tx
        .update(reservations)
        .set({
          reservedFor: request.requestedFor,
          pax: newPax,
          updatedAt: decidedAt,
        })
        .where(
          and(
            eq(reservations.tenantId, context.tenant.tenantId),
            eq(reservations.id, row.id),
          ),
        )
        .returning();
      if (!moved) throw new Error("Reservation update returned no row");
      if (heldTableIds.length > 0) {
        await assertAssignableTables(tx, context, outletId, heldTableIds);
        await replaceHolds(tx, context, moved, heldTableIds);
      }
      // The guest's link stays valid and now outlives the new booking time.
      await tx
        .update(reservationGuestLinks)
        .set({
          expiresAt: new Date(
            moved.reservedFor.getTime() + GUEST_LINK_GRACE_HOURS * 3_600_000,
          ),
        })
        .where(
          and(
            eq(reservationGuestLinks.tenantId, context.tenant.tenantId),
            eq(reservationGuestLinks.reservationId, row.id),
            isNull(reservationGuestLinks.revokedAt),
          ),
        );
      const resolved = await markResolved(
        tx,
        context,
        request,
        "approved",
        actorUserId,
        decidedAt,
        row.reservedFor,
      );
      await appendEnvelope(
        tx,
        context,
        reservationEvents["reservation.rescheduled"],
        {
          aggregateId: row.id,
          outletId,
          actorUserId,
          payload: {
            reservationId: row.id,
            requestId: request.id,
            previousReservedFor: row.reservedFor.toISOString(),
            reservedFor: moved.reservedFor.toISOString(),
            previousPax: row.pax,
            pax: moved.pax,
            tableIds: heldTableIds,
          },
          now: decidedAt,
          idempotencyKey: `reservation.rescheduled:${request.id}`,
        },
      );
      await auditReservation(tx, context, {
        actorUserId,
        outletId,
        action: "reservation.reschedule_approved",
        reservationId: row.id,
        reason: null,
        before: { status: row.status },
        after: { status: moved.status },
        now: decidedAt,
      });
      return resultOf(tx, context, resolved, moved);
    });
  } catch (error) {
    throw mapHoldViolation(error);
  }
}

/** Staff decline: the request closes, the booking stays as it was. */
export async function declineRescheduleRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  requestId: string,
  input: DeclineRescheduleInput,
  now?: Date,
): Promise<ResolveRescheduleResult> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, MANAGE_PERMISSION, {
      type: "outlet",
      id: outletId,
    });
    assertOutletInScope(context.outletScope, outletId);
    await lockOutletHolds(tx, context, outletId);
    const request = await lockRequest(tx, context, outletId, requestId);
    const row = await lockReservation(
      tx,
      context,
      outletId,
      request.reservationId,
    );
    const decidedAt = now ?? new Date();
    if (request.status === "declined")
      return resultOf(tx, context, request, row);
    if (request.status !== "pending")
      throw new ReservationError("RESERVATION_RESCHEDULE_RESOLVED");
    const resolved = await markResolved(
      tx,
      context,
      request,
      "declined",
      actorUserId,
      decidedAt,
    );
    await auditReservation(tx, context, {
      actorUserId,
      outletId,
      action: "reservation.reschedule_declined",
      reservationId: row.id,
      reason: input.reason ?? null,
      before: { status: row.status },
      after: { status: row.status },
      now: decidedAt,
    });
    return resultOf(tx, context, resolved, row);
  });
}
