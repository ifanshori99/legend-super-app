// Staff resend of the DP payment link of a `pending_deposit` reservation (PRD
// v1.7 §3.22 "DP & Kebijakan"; RSV-02; bead legend-gbkw). Route:
// routes/reservation.routes.ts.
//
// - Only a `pending_deposit` booking, and only while the payment window frozen
//   in its policy snapshot is open (created_at + paymentWindowMinutes, RSV-03:
//   never the live policy). A DP paid in the meantime confirms the booking
//   first (reconcileDeposit), so it is refused as a wrong status.
// - A stored link that is still valid is returned as it is (unsealed). Else a
//   new bill link is opened through the deposit port, outside the first
//   transaction because the payment service has its own, and stored sealed.
//   Two racing resends may each open a link; only the first stored one is
//   returned, the other token is discarded unseen.
// - A new link is never opened while the old link still has a payment in
//   flight (a pending intent the guest may yet pay), and a settled one confirms
//   the booking instead (reconcileDeposit): replacing the stored link would
//   orphan that payment. Refusals are returned from the transaction and thrown
//   after it commits, so a confirmation or release found on the way persists.
// - The idempotency result keeps only the reservation id (never the link, which
//   is a guest credential); a replay returns the link stored at that time.
import { and, eq } from "drizzle-orm";
import {
  assertOutletInScope,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  ReservationError,
  reservationDepositLinkSchema,
  reservationPolicySnapshotSchema,
  type ReservationDepositLink,
} from "@starter/shared/reservation";
import { db } from "../db/index.ts";
import { reservations } from "../db/schema/reservation.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import {
  DEPOSIT_ATTACH_GRACE_MINUTES,
  MANAGE_PERMISSION,
  assertPermission,
  auditReservation,
  claimIdempotencyKey,
  loadDepositState,
  lockReservation,
  reconcileDeposit,
  storeIdempotencyResult,
  type ReservationRow,
  type Tx,
} from "./reservation-core.ts";
import { linkAad } from "./reservation-booking.ts";
import { reservationDepositPort } from "./reservation-ports.ts";
import { requestFingerprint } from "./reservation-plan.ts";

const MINUTE = 60_000;
const AUDIT_ACTION = "reservation.deposit_link_resent";

/** End of the frozen payment window: the booking time plus the snapshot's minutes. */
function windowEnd(row: ReservationRow): Date {
  const snapshot = reservationPolicySnapshotSchema.safeParse(
    row.policySnapshot,
  );
  const minutes = snapshot.success
    ? snapshot.data.paymentWindowMinutes
    : DEPOSIT_ATTACH_GRACE_MINUTES;
  return new Date(row.createdAt.getTime() + minutes * MINUTE);
}

/** The stored link when it can still be paid at `now`, else null. */
function validStoredLink(
  row: ReservationRow,
  tenantId: string,
  now: Date,
): ReservationDepositLink | null {
  if (
    row.depositPaymentLinkId === null ||
    row.depositLinkSealed === null ||
    row.depositLinkExpiresAt === null ||
    row.depositLinkExpiresAt <= now
  )
    return null;
  return reservationDepositLinkSchema.parse({
    paymentLinkId: row.depositPaymentLinkId,
    amountIdr: row.depositIdr,
    paymentPath: openSecret(row.depositLinkSealed, linkAad(tenantId, row.id)),
    expiresAt: row.depositLinkExpiresAt.toISOString(),
  });
}

/** Why the link cannot be (re)sent for this row, or null when it can. */
function statusBlock(row: ReservationRow, now: Date): ReservationError | null {
  if (row.status !== "pending_deposit" || row.depositIdr <= 0)
    return new ReservationError("RESERVATION_DEPOSIT_NOT_PENDING");
  if (now >= windowEnd(row))
    return new ReservationError("RESERVATION_DEPOSIT_WINDOW_CLOSED");
  return null;
}

/**
 * A new link replaces the stored one, and the deposit state only follows the
 * current link: a payment still open on the old link would be orphaned. The row
 * is already reconciled, so a settled intent has confirmed the booking and a
 * payable-until beyond the old link's expiry means a pending intent is live.
 */
async function oldLinkBlock(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
  now: Date,
): Promise<ReservationError | null> {
  if (row.depositPaymentLinkId === null && row.depositPaymentId === null)
    return null;
  const state = await loadDepositState(tx, context, row);
  if (
    state.settledIntentId === null &&
    state.payableUntil <= now &&
    !state.providerPending
  )
    return null;
  return new ReservationError("RESERVATION_DEPOSIT_PAYMENT_PENDING");
}

async function auditResend(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
  reused: boolean,
  now: Date,
): Promise<void> {
  await auditReservation(tx, context, {
    actorUserId,
    outletId,
    action: AUDIT_ACTION,
    reservationId,
    reason: reused
      ? "Tautan DP yang berlaku dikirim ulang."
      : "Tautan DP baru dibuat.",
    before: { status: "pending_deposit" },
    after: { status: "pending_deposit" },
    now,
  });
}

type Refused = { kind: "refused"; error: ReservationError };
type FirstStep =
  | { kind: "done"; link: ReservationDepositLink }
  | { kind: "mint"; expiresInMinutes: number }
  | Refused;
type SecondStep = { kind: "done"; link: ReservationDepositLink } | Refused;

export async function resendReservationDepositLink(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
  idempotencyKey: string,
  now = new Date(),
): Promise<ReservationDepositLink> {
  const tenantId = context.tenant.tenantId;
  const fingerprint = requestFingerprint("reservation.deposit_link", {
    outletId,
    reservationId,
  });
  const first = await withTenant(
    db,
    context,
    async (tx): Promise<FirstStep> => {
      await assertPermission(tx, context, actorUserId, MANAGE_PERMISSION, {
        type: "outlet",
        id: outletId,
      });
      assertOutletInScope(context.outletScope, outletId);
      const claim = await claimIdempotencyKey(tx, context, {
        outletId,
        key: idempotencyKey,
        operation: "reservation.deposit_link",
        fingerprint,
      });
      const locked = await lockReservation(
        tx,
        context,
        outletId,
        reservationId,
      );
      const row = await reconcileDeposit(tx, context, locked, now);
      const blocked = statusBlock(row, now);
      if (blocked) return { kind: "refused", error: blocked };
      const stored = validStoredLink(row, tenantId, now);
      if (claim.kind === "replay") {
        // A replay returns the link stored then, only while it is still payable.
        if (stored === null)
          return {
            kind: "refused",
            error: new ReservationError("RESERVATION_DEPOSIT_LINK_EXPIRED"),
          };
        return { kind: "done", link: stored };
      }
      if (stored !== null) {
        await auditResend(
          tx,
          context,
          actorUserId,
          outletId,
          row.id,
          true,
          now,
        );
        await storeIdempotencyResult(tx, context, idempotencyKey, row.id, {
          reservationId: row.id,
        });
        return { kind: "done", link: stored };
      }
      const live = await oldLinkBlock(tx, context, row, now);
      if (live) return { kind: "refused", error: live };
      // Whole minutes, rounded down: the new link must not outlive the frozen
      // window. Under a minute left there is nothing worth opening.
      const expiresInMinutes = Math.floor(
        (windowEnd(row).getTime() - now.getTime()) / MINUTE,
      );
      if (expiresInMinutes < 1)
        return {
          kind: "refused",
          error: new ReservationError("RESERVATION_DEPOSIT_WINDOW_CLOSED"),
        };
      return { kind: "mint", expiresInMinutes };
    },
  );
  if (first.kind === "refused") throw first.error;
  if (first.kind === "done") return first.link;

  // Outside the transaction: a payment-side failure (503) changes nothing.
  const current = await withTenant(db, context, (tx) =>
    lockReservation(tx, context, outletId, reservationId),
  );
  const opened = await reservationDepositPort().openDeposit({
    context,
    outletId,
    reservationId,
    amountIdr: current.depositIdr,
    expiresInMinutes: first.expiresInMinutes,
    now,
  });

  const second = await withTenant(
    db,
    context,
    async (tx): Promise<SecondStep> => {
      const locked = await lockReservation(
        tx,
        context,
        outletId,
        reservationId,
      );
      // Re-checked under the lock: the guest may have opened a payment on the old
      // link, or paid it, since the first step.
      const row = await reconcileDeposit(tx, context, locked, now);
      const blocked = statusBlock(row, now);
      if (blocked) return { kind: "refused", error: blocked };
      // A racing resend stored a link first: it wins, ours is discarded unseen.
      const winner = validStoredLink(row, tenantId, now);
      if (winner !== null) {
        await storeIdempotencyResult(tx, context, idempotencyKey, row.id, {
          reservationId: row.id,
        });
        return { kind: "done", link: winner };
      }
      const live = await oldLinkBlock(tx, context, row, now);
      if (live) return { kind: "refused", error: live };
      await tx
        .update(reservations)
        .set({
          depositPaymentLinkId: opened.paymentLinkId,
          depositLinkSealed: sealSecret(
            opened.paymentPath,
            linkAad(tenantId, reservationId),
          ),
          depositLinkExpiresAt: new Date(opened.expiresAt),
          updatedAt: now,
        })
        .where(
          and(
            eq(reservations.tenantId, tenantId),
            eq(reservations.id, reservationId),
          ),
        );
      await auditResend(
        tx,
        context,
        actorUserId,
        outletId,
        reservationId,
        false,
        now,
      );
      await storeIdempotencyResult(tx, context, idempotencyKey, reservationId, {
        reservationId,
      });
      return {
        kind: "done",
        link: reservationDepositLinkSchema.parse({
          paymentLinkId: opened.paymentLinkId,
          amountIdr: row.depositIdr,
          paymentPath: opened.paymentPath,
          expiresAt: new Date(opened.expiresAt).toISOString(),
        }),
      };
    },
  );
  if (second.kind === "refused") throw second.error;
  return second.link;
}
