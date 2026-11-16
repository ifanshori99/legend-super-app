// Staff reservation reads and lifecycle (PRD v1.7 §3.22; Alur H; RSV-02 seating
// with the paid DP allocated to the bill, RSV-03 cancellation / no-show decided
// by the policy snapshot; bead legend-t8bz). Routes: routes/reservation.routes.ts.
import { and, asc, eq, gt, lt, or } from "drizzle-orm";
import {
  assertOutletInScope,
  decodeCursor,
  encodeCursor,
  idr,
  type OutletId,
  type TenantId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  ReservationError,
  assertReservationTransition,
  cancellationDepositOutcome,
  depositIsSettled,
  noShowDepositOutcome,
  reservationCloseResultSchema,
  reservationDetailSchema,
  reservationPolicySnapshotSchema,
  seatReservationResultSchema,
  type CancelReservationInput,
  type ListReservationsQuery,
  type MarkNoShowInput,
  type ReservationDepositOutcome,
  type ReservationCloseResult,
  type ReservationDetail,
  type SeatReservationInput,
  type SeatReservationResult,
  type Reservation,
} from "@starter/shared/reservation";
import { db } from "../db/index.ts";
import { outlets } from "../db/schema/index.ts";
import {
  reservationDepositAllocations,
  reservations,
} from "../db/schema/reservation.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  MANAGE_PERMISSION,
  VIEW_PERMISSION,
  appendReservationEvent,
  assertPermission,
  auditReservation,
  claimIdempotencyKey,
  loadDepositStatuses,
  loadHeldDeposit,
  loadHolds,
  lockDepositLink,
  lockOutletHolds,
  lockReservation,
  mapHoldViolation,
  reconcileDeposit,
  readReservation,
  releaseHolds,
  replaceHolds,
  storeIdempotencyResult,
  toReservation,
  toSlot,
  type Tx,
} from "./reservation-core.ts";
import { assertAssignableTables } from "./reservation-booking.ts";
import {
  addDays,
  localDate,
  requestFingerprint,
  zonedInstant,
} from "./reservation-plan.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { cancelPaymentLinkInTx } from "./payment.service.ts";
import {
  assertDepositLinkProvenInTx,
  confirmDepositLinkUnpaidAtProvider,
} from "./payment-provider-proof.ts";
import { sessionDepositCredit } from "./reservation-deposit-credit.ts";
import { requestDepositRefund } from "./reservation-refunds.ts";
import {
  activeSessionForTable,
  openStaffSeatedSession,
} from "./table-session.service.ts";
import { confirmChargeLinksUnpaid } from "./order-recovery-charge.ts";

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

const outletTarget = (outletId: OutletId) =>
  ({ type: "outlet", id: outletId }) as const;

async function outletZone(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<string> {
  assertOutletInScope(context.outletScope, outletId);
  const [outlet] = await tx
    .select({ timezone: outlets.timezone })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    );
  if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  return outlet.timezone;
}

// ---------------------------------------------------------------- reads

export async function listReservations(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  query: ListReservationsQuery,
  now = new Date(),
): Promise<Page<Reservation>> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      VIEW_PERMISSION,
      outletTarget(outletId),
    );
    const timeZone = await outletZone(tx, context, outletId);
    const filters = [
      eq(reservations.tenantId, context.tenant.tenantId),
      eq(reservations.outletId, outletId),
    ];
    if (query.date) {
      filters.push(
        gt(
          reservations.reservedFor,
          new Date(zonedInstant(query.date, "00:00", timeZone).getTime() - 1),
        ),
      );
      const next = zonedInstant(addDays(query.date, 1), "00:00", timeZone);
      filters.push(lt(reservations.reservedFor, next));
    } else {
      // "All upcoming": from the start of the outlet's current business date.
      filters.push(
        gt(
          reservations.reservedFor,
          new Date(
            zonedInstant(
              localDate(now, timeZone),
              "00:00",
              timeZone,
            ).getTime() - 1,
          ),
        ),
      );
    }
    if (query.status) filters.push(eq(reservations.status, query.status));
    if (query.zoneId) filters.push(eq(reservations.zoneId, query.zoneId));
    if (query.cursor) {
      let keys;
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      }
      const [at, id] = keys;
      if (typeof at !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          gt(reservations.reservedFor, new Date(at)),
          and(
            eq(reservations.reservedFor, new Date(at)),
            gt(reservations.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(reservations)
      .where(and(...filters))
      .orderBy(asc(reservations.reservedFor), asc(reservations.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const holds = await loadHolds(
      tx,
      context,
      page.map((row) => row.id),
    );
    const statuses = await loadDepositStatuses(
      tx,
      context,
      page.flatMap((row) =>
        row.depositPaymentId ? [row.depositPaymentId] : [],
      ),
    );
    const last = page.at(-1);
    return {
      data: page.map((row) =>
        toReservation(
          row,
          holds,
          row.depositPaymentId
            ? (statuses.get(row.depositPaymentId) ?? null)
            : null,
        ),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.reservedFor.toISOString(), last.id])
            : null,
      },
    };
  });
}

export async function getReservation(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
): Promise<ReservationDetail> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      VIEW_PERMISSION,
      outletTarget(outletId),
    );
    assertOutletInScope(context.outletScope, outletId);
    const [row] = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.outletId, outletId),
          eq(reservations.id, reservationId),
        ),
      );
    if (!row) throw new ReservationError("RESERVATION_NOT_FOUND");
    const holds = await loadHolds(tx, context, [row.id]);
    return reservationDetailSchema.parse({
      reservation: await readReservation(tx, context, row),
      preOrder: null,
      tableSlots: holds.map(toSlot),
    });
  });
}

/**
 * Consumer entry for `payment.paid` of a DP (and the lazy path of every
 * mutation): confirms the reservation when its intent is settled.
 */
export async function confirmReservationDeposit(
  context: ScopedTenantContext,
  outletId: OutletId,
  reservationId: string,
  now = new Date(),
): Promise<Reservation> {
  return withTenant(db, context, async (tx) => {
    const row = await reconcileDeposit(
      tx,
      context,
      await lockReservation(tx, context, outletId, reservationId),
      now,
    );
    return readReservation(tx, context, row);
  });
}

// ---------------------------------------------------------------- seat (RSV-02)

/**
 * RSV-02: the host seats the party. The required DP must be settled (a
 * tentative table assignment is fine before that, seating is not); the paid DP
 * is allocated to the opened table session's bill.
 */
export async function seatReservation(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
  input: SeatReservationInput,
  idempotencyKey: string,
  now = new Date(),
): Promise<SeatReservationResult> {
  const tableIds = [...new Set(input.tableIds)];
  const fingerprint = requestFingerprint("reservation.seat", {
    outletId,
    reservationId,
    tableIds: [...tableIds].sort(),
  });
  try {
    // legend-ukbq3: seating can expire a stale session on these tables and its
    // open charges. Their payment links are confirmed unpaid at the provider
    // before the transaction (network I/O stays outside it); an unconfirmed
    // answer (409 PAYMENT_PROVIDER_UNCONFIRMED) propagates and nothing is seated.
    const activeSessionIds = await withTenant(db, context, async (tx) => {
      const ids = new Set<string>();
      for (const tableId of [...tableIds].sort()) {
        const active = await activeSessionForTable(
          tx,
          context.tenant.tenantId,
          tableId,
        );
        if (active) ids.add(active.id);
      }
      return [...ids];
    });
    for (const sessionId of activeSessionIds)
      await confirmChargeLinksUnpaid(context, { sessionId }, now);
    return await withTenant(db, context, async (tx) => {
      await assertPermission(
        tx,
        context,
        actorUserId,
        MANAGE_PERMISSION,
        outletTarget(outletId),
      );
      assertOutletInScope(context.outletScope, outletId);
      const claim = await claimIdempotencyKey(tx, context, {
        outletId,
        key: idempotencyKey,
        operation: "reservation.seat",
        fingerprint,
      });
      if (claim.kind === "replay")
        return seatReservationResultSchema.parse(claim.response);
      await lockOutletHolds(tx, context, outletId);
      let row = await lockReservation(tx, context, outletId, reservationId);
      // Serialize the deposit snapshot with settlement and refund writers.
      await lockDepositLink(tx, context, row);
      row = await reconcileDeposit(tx, context, row, now);
      if (row.status === "pending_deposit")
        throw new ReservationError("RESERVATION_DEPOSIT_UNPAID");
      assertReservationTransition(row.status, "seated");
      // C11 (RSV-02): a required DP must be settled, whatever the status says.
      let depositPaid = idr(0);
      if (row.depositIdr > 0) {
        const deposit = row.depositPaymentId
          ? await loadHeldDeposit(
              tx,
              context,
              row.depositPaymentId,
              row.depositIdr,
            )
          : { status: null, heldIdr: idr(0) };
        if (!depositIsSettled(deposit.status))
          throw new ReservationError("RESERVATION_DEPOSIT_UNPAID");
        // RSV-02: only funds the intent still holds become prepaid credit. A
        // DP refunded by WS-05 keeps the reservation valid (it was paid when
        // the reservation was confirmed) but credits only what is left: zero
        // after a full refund, the remainder after a partial one (RSV-03).
        depositPaid = deposit.heldIdr;
      }
      // The host may seat the party on other tables than the tentative ones.
      const held = (await loadHolds(tx, context, [row.id]))
        .filter((hold) => hold.releasedAt === null)
        .map((hold) => hold.tableId);
      if (
        held.length !== tableIds.length ||
        held.some((id) => !(tableIds as string[]).includes(id))
      ) {
        await assertAssignableTables(tx, context, outletId, tableIds);
        await replaceHolds(tx, context, row, tableIds);
      }
      // The session opens on the primary (first) table; every table is locked
      // in ascending id order and checked inside the table-session service.
      const opened = await openStaffSeatedSession(tx, context, {
        outletId,
        tableIds,
        pax: row.pax,
        confirmedBy: actorUserId,
        reservationId: row.id,
        now,
      });
      const sessionId = opened.sessionId;

      // RSV-02: the paid DP becomes prepaid credit on the session's bill.
      if (depositPaid > 0 && row.depositPaymentId !== null)
        await tx.insert(reservationDepositAllocations).values({
          tenantId: context.tenant.tenantId,
          outletId,
          reservationId: row.id,
          tableSessionId: sessionId,
          paymentIntentId: row.depositPaymentId,
          amountIdr: depositPaid,
          allocatedAt: now,
        });
      const [updated] = await tx
        .update(reservations)
        .set({
          status: "seated",
          seatedAt: now,
          tableSessionId: sessionId,
          updatedAt: now,
        })
        .where(
          and(
            eq(reservations.tenantId, context.tenant.tenantId),
            eq(reservations.id, row.id),
          ),
        )
        .returning();
      if (!updated) throw new Error("Reservation update returned no row");
      await appendReservationEvent(tx, context, "reservation.seated", {
        reservationId: row.id,
        outletId,
        actorUserId,
        now,
        payload: {
          reservationId: row.id,
          tableSessionId: sessionId,
          tableIds,
          pax: row.pax,
          depositAllocatedIdr: depositPaid,
        },
      });
      const result = seatReservationResultSchema.parse({
        reservation: await readReservation(tx, context, updated),
        tableSessionId: sessionId,
      });
      await storeIdempotencyResult(
        tx,
        context,
        idempotencyKey,
        row.id,
        result as unknown as Record<string, unknown>,
      );
      return result;
    });
  } catch (error) {
    throw mapHoldViolation(error);
  }
}

// ---------------------------------------------------------------- close (RSV-03)

async function closeReservation(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
  kind: "cancelled" | "no_show",
  reason: string | null,
  idempotencyKey: string,
  now: Date,
): Promise<ReservationCloseResult> {
  const fingerprint = requestFingerprint(`reservation.${kind}`, {
    outletId,
    reservationId,
    reason,
  });
  // legend-ukbq3: ask the payment provider before closing the DP link locally
  // (network I/O, so outside the transaction and the reservation/link locks).
  // Authorization runs first so an unauthorized caller never reaches the
  // provider. Money already at the provider is applied once by the helper; the
  // transaction below then re-reads it (reconcileDeposit / paid-deposit path).
  // An unconfirmed provider answer throws 409 PAYMENT_PROVIDER_UNCONFIRMED and
  // nothing is cancelled.
  const depositLinkId = await withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      MANAGE_PERMISSION,
      outletTarget(outletId),
    );
    assertOutletInScope(context.outletScope, outletId);
    const [found] = await tx
      .select({ linkId: reservations.depositPaymentLinkId })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.outletId, outletId),
          eq(reservations.id, reservationId),
        ),
      )
      .limit(1);
    return found?.linkId ?? null;
  });
  // legend-m7tnt: fail closed. Every DP code (pending, expired, superseded,
  // failed) is asked, a `pending` answer holds the close at any local status,
  // and unresolved unallocated funds hold it until reconciled.
  const askedIntentIds =
    depositLinkId === null
      ? []
      : (await confirmDepositLinkUnpaidAtProvider(context, depositLinkId, now))
          .askedIntentIds;
  const done = await withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      MANAGE_PERMISSION,
      outletTarget(outletId),
    );
    assertOutletInScope(context.outletScope, outletId);
    const claim = await claimIdempotencyKey(tx, context, {
      outletId,
      key: idempotencyKey,
      operation: `reservation.${kind}`,
      fingerprint,
    });
    if (claim.kind === "replay")
      return {
        result: reservationCloseResultSchema.parse(claim.response),
        refund: null,
      };
    let row = await lockReservation(tx, context, outletId, reservationId);
    // Payment lock order (payment-late-settlement.ts, "Urutan kunci
    // pembayaran"): reservation -> DP link -> its intents (ascending id). A
    // settlement of that link locks the reservation first, so it either
    // committed before this point (reconcileDeposit below then sees the paid
    // intent and the paid-deposit path applies) or waits for this transaction
    // and finds the booking closed.
    const dpLink = await lockDepositLink(tx, context, row);
    // legend-m7tnt: re-check under the lock what the provider proof read
    // outside it (a code opened since, funds parked since).
    if (row.depositPaymentLinkId !== null)
      await assertDepositLinkProvenInTx(
        tx,
        context,
        row.depositPaymentLinkId,
        askedIntentIds,
      );
    row = await reconcileDeposit(tx, context, row, now);
    // legend-em6p: the DP intent is locked after the reservation row
    // (reservations -> payment_intents) and the close time taken under it, so
    // a forfeit's closed_at follows commit order against refunds and sales on
    // the same intent. After reconcileDeposit: it may only now link a DP the
    // gateway already settled. `now` still drives the policy and no-show-due
    // checks.
    const closedAt =
      row.depositPaymentId === null
        ? now
        : await lockIntentsForFact(
            tx,
            context.tenant.tenantId,
            [row.depositPaymentId],
            now,
          );
    assertReservationTransition(row.status, kind);
    // A paid intent on the DP link that reconcileDeposit did not record means
    // the unpaid-deposit path would drop real money: refuse, the caller
    // retries once the payment consumer has booked the deposit.
    if (row.depositPaymentId === null && dpLink.heldIntentId !== null)
      throw new ReservationError("RESERVATION_DEPOSIT_PAYMENT_PENDING");
    // RSV-03: always the snapshot taken at booking, never the live policy.
    const policy = reservationPolicySnapshotSchema.parse(row.policySnapshot);
    let paid = idr(0);
    if (row.depositIdr > 0 && row.depositPaymentId !== null) {
      // RSV-03: only money the intent still holds can be refunded/forfeited.
      // A fully refunded DP is settled (RSV-02) but has nothing left to move;
      // a partly refunded one splits only its remainder.
      paid = (
        await loadHeldDeposit(tx, context, row.depositPaymentId, row.depositIdr)
      ).heldIdr;
    }
    if (kind === "no_show" && now < row.reservedFor)
      throw new ReservationError(
        "RESERVATION_TRANSITION_INVALID",
        "Reservasi belum jatuh tempo; gunakan pembatalan.",
      );
    const outcome: ReservationDepositOutcome =
      kind === "cancelled"
        ? cancellationDepositOutcome(policy, {
            depositPaidIdr: paid,
            reservedFor: row.reservedFor.toISOString(),
            cancelledAt: now.toISOString(),
          })
        : noShowDepositOutcome(policy, { depositPaidIdr: paid });
    const closeReason = reason ?? "Tamu tidak datang.";
    const [updated] = await tx
      .update(reservations)
      .set({
        status: kind,
        closedAt,
        closeReason,
        closedBy: actorUserId,
        depositRefundIdr: idr(outcome.refundIdr),
        depositForfeitedIdr: idr(outcome.forfeitedIdr),
        refundStatus: outcome.refundIdr > 0 ? "pending" : "not_required",
        updatedAt: now,
      })
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, row.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Reservation update returned no row");
    // The DP link stops taking money and its pending intents expire (link
    // already locked above). A code past its expiry stays `pending` for the
    // poller; the closed reservation parks that late payment.
    if (row.depositPaymentLinkId !== null)
      await cancelPaymentLinkInTx(tx, context, {
        linkId: row.depositPaymentLinkId,
        now,
        reason: "cancelled",
      });
    await releaseHolds(tx, context, row.id, now);
    await appendReservationEvent(
      tx,
      context,
      kind === "cancelled" ? "reservation.cancelled" : "reservation.no_show",
      {
        reservationId: row.id,
        outletId,
        actorUserId,
        now,
        payload: {
          reservationId: row.id,
          closedBy: "staff",
          reason: closeReason,
          depositPaidIdr: paid,
          depositRefundIdr: outcome.refundIdr,
          depositForfeitedIdr: outcome.forfeitedIdr,
          policyVersion: outcome.policyVersion,
        },
      },
    );
    await auditReservation(tx, context, {
      actorUserId,
      outletId,
      action: `reservation.${kind}`,
      reservationId: row.id,
      reason: closeReason,
      before: { status: row.status, depositPaidIdr: paid },
      after: {
        status: kind,
        depositRefundIdr: outcome.refundIdr,
        depositForfeitedIdr: outcome.forfeitedIdr,
        policyVersion: outcome.policyVersion,
        resolution: outcome.resolution,
      },
      now,
    });
    const result = reservationCloseResultSchema.parse({
      reservation: await readReservation(tx, context, updated),
      depositOutcome: outcome,
    });
    await storeIdempotencyResult(
      tx,
      context,
      idempotencyKey,
      row.id,
      result as unknown as Record<string, unknown>,
    );
    return {
      result,
      refund:
        outcome.refundIdr > 0 && row.depositPaymentId !== null
          ? { intentId: row.depositPaymentId, refundIdr: outcome.refundIdr }
          : null,
    };
  });
  if (done.refund)
    await requestDepositRefund(
      context,
      outletId,
      reservationId,
      done.refund,
      kind,
      actorUserId,
    );
  return done.result;
}

export function cancelReservation(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
  input: CancelReservationInput,
  idempotencyKey: string,
  now = new Date(),
): Promise<ReservationCloseResult> {
  return closeReservation(
    context,
    actorUserId,
    outletId,
    reservationId,
    "cancelled",
    input.reason,
    idempotencyKey,
    now,
  );
}

export function markReservationNoShow(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
  input: MarkNoShowInput,
  idempotencyKey: string,
  now = new Date(),
): Promise<ReservationCloseResult> {
  return closeReservation(
    context,
    actorUserId,
    outletId,
    reservationId,
    "no_show",
    input.note ?? null,
    idempotencyKey,
    now,
  );
}

/**
 * Convenience for the bill module: the DP credit on a table session (RSV-02).
 * legend-e7zj: what each allocation's DP intent still holds, so a WS-05 refund
 * filed after seating lowers it (reservation-deposit-credit.ts).
 */
export async function depositCreditForSession(
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
): Promise<number> {
  return sessionDepositCredit(tx, tenantId, tableSessionId);
}
