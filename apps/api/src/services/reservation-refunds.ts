// DP refunds of cancelled / no-show reservations through the WS-05 refund
// request (PRD v1.7 §3.22 "DP & Kebijakan", RSV-03; §3.13 refunds; bead
// legend-t8bz).
//
// The cancel / no-show transaction (reservation-lifecycle.ts) decides the split
// from the policy snapshot and records `refund_status = 'pending'` with
// `deposit_refund_idr`. After it commits, `requestDepositRefund` asks WS-05 for
// the refund. Rules:
// - The WS-05 refund REQUEST is created here (a `payment_refunds` row in
//   `pending`), by the system actor `system:reservation`: the closing host may
//   lack `payment.reconcile`, and the refund follows from the snapshot rule,
//   not from the host's discretion. The APPROVAL stays with WS-05
//   (`approveRefund`: another person with `payment.reconcile`, provider wired);
//   nothing here approves or pays out money.
// - Idempotent: the reservation row lock plus `refund_payment_refund_id` make a
//   replay or a racing worker a no-op, and the WS-05 admin idempotency key
//   `reservation-refund:<reservationId>` backs it up in the same transaction.
//   `refund_status = 'requested'` is written only together with the
//   `payment_refunds` row (database check `reservations_refund_request_check`).
// - The amount and intent are re-read from the locked reservation; a caller's
//   numbers that disagree fail closed.
// - A failure never loses the decision: the row stays `pending`, the attempt is
//   counted and `retryPendingRefunds` (worker tick) retries with backoff, up to
//   `REFUND_MAX_ATTEMPTS`; then it stays `pending` with an audit row for a
//   human (WS-05 refund screen).
import {
  createUlid,
  idr,
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db/index.ts";
import { paymentIntents, paymentRefunds } from "../db/schema/index.ts";
import { reservations } from "../db/schema/reservation.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { openRefundChainSafely } from "./payment-refund.service.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import { RESERVATION_SYSTEM_ACTOR } from "./reservation-deposit-payment.ts";
import { auditReservation, type Tx } from "./reservation-core.ts";
import { assertDepositReturnNotReversed } from "./payment-refund-deposit-return.ts";

/** Attempts before the retry sweep stops and leaves the refund to a human. */
export const REFUND_MAX_ATTEMPTS = 8;
/** Reservations retried per tenant per tick. */
const REFUND_RETRY_BATCH = 50;
const MINUTE = 60_000;

/** Exponential backoff after `attempts` failures: 1, 2, 4 … min, max 6 h. */
export function refundBackoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 360) * MINUTE;
}

export const depositRefundKey = (reservationId: string) =>
  `reservation-refund:${reservationId}`;

type AttemptOutcome = "requested" | "already" | "skipped";

const refundFailure = (message: string) =>
  new HttpError(409, "CONFLICT", message);

/** WS-05 refund request by the system actor (createRefund minus the RBAC check). */
async function createSystemRefundRequest(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    reservationId: string;
    intentId: string;
    amountIdr: number;
    reason: string;
    now: Date;
  },
): Promise<string> {
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, input.intentId),
      ),
    )
    .for("update");
  if (!intent) throw refundFailure("DP payment not found.");
  const response = await idempotentPaymentAdminWrite(
    tx,
    context,
    RESERVATION_SYSTEM_ACTOR,
    depositRefundKey(input.reservationId),
    "refund.create",
    {
      paymentIntentId: input.intentId,
      amountIdr: input.amountIdr,
      reason: input.reason,
    },
    async () => {
      if (
        !intent.paidAt ||
        !["paid", "partially_refunded"].includes(intent.status)
      )
        throw refundFailure("Payment is not refundable.");
      // 1218 r5: after the intent lock, before the refund row exists.
      await assertDepositReturnNotReversed(
        tx,
        context.tenant.tenantId,
        intent.id,
      );
      const { cap, reserved } = await refundableBalance(tx, intent);
      if (reserved + BigInt(input.amountIdr) > cap)
        throw refundFailure("Refund exceeds available paid amount.");
      const [inserted] = await tx
        .insert(paymentRefunds)
        .values({
          tenantId: intent.tenantId,
          outletId: intent.outletId,
          paymentIntentId: intent.id,
          amountIdr: idr(input.amountIdr),
          reason: input.reason,
          note: null,
          requestedBy: RESERVATION_SYSTEM_ACTOR,
        })
        .returning();
      if (!inserted) throw new Error("Refund insert returned no row");
      const row = await openRefundChainSafely(tx, context, inserted, input.now);
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(input.now.getTime()),
          tenantId: context.tenant.tenantId,
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
        ["amountIdr", "status"],
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
      return { refundId: row.id };
    },
  );
  return response.refundId;
}

async function attemptRefund(
  context: ScopedTenantContext,
  outletId: OutletId | null,
  reservationId: string,
  expected: { intentId: string; refundIdr: number } | null,
  kind: string,
  actorUserId: string | null,
  now: Date,
): Promise<AttemptOutcome> {
  return withTenant(db, context, async (tx) => {
    const filters = [
      eq(reservations.tenantId, context.tenant.tenantId),
      eq(reservations.id, reservationId),
    ];
    if (outletId !== null) filters.push(eq(reservations.outletId, outletId));
    const [row] = await tx
      .select()
      .from(reservations)
      .where(and(...filters))
      .for("update");
    if (!row) return "skipped";
    if (row.refundStatus === "requested" || row.refundPaymentRefundId !== null)
      return "already";
    if (row.refundStatus !== "pending") return "skipped";
    const intentId = row.depositPaymentId;
    const amount = row.depositRefundIdr ?? 0;
    if (intentId === null || amount <= 0)
      throw refundFailure("The DP refund decision is incomplete.");
    if (
      expected !== null &&
      (expected.intentId !== intentId || expected.refundIdr !== amount)
    )
      throw refundFailure("The DP refund does not match the decision.");
    const refundId = await createSystemRefundRequest(tx, context, {
      reservationId: row.id,
      intentId,
      amountIdr: amount,
      reason: `Refund DP reservasi (${kind})`.slice(0, 500),
      now,
    });
    await tx
      .update(reservations)
      .set({
        refundStatus: "requested",
        refundPaymentRefundId: refundId,
        refundNextAttemptAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, row.id),
        ),
      );
    await auditReservation(tx, context, {
      actorUserId,
      outletId: row.outletId,
      action: "reservation.refund_requested",
      reservationId: row.id,
      reason: kind,
      before: { refundStatus: row.refundStatus },
      after: {
        refundStatus: "requested",
        depositRefundIdr: amount,
        paymentRefundId: refundId,
      },
      now,
    });
    return "requested";
  });
}

/** Counts a failed attempt and schedules the next one (or gives up, audited). */
async function recordFailedAttempt(
  context: ScopedTenantContext,
  reservationId: string,
  now: Date,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .update(reservations)
      .set({ refundAttempts: sql`${reservations.refundAttempts} + 1` })
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, reservationId),
          eq(reservations.refundStatus, "pending"),
        ),
      )
      .returning();
    if (!row) return;
    const exhausted = row.refundAttempts >= REFUND_MAX_ATTEMPTS;
    await tx
      .update(reservations)
      .set({
        refundNextAttemptAt: exhausted
          ? null
          : new Date(now.getTime() + refundBackoffMs(row.refundAttempts)),
      })
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, reservationId),
        ),
      );
    if (exhausted)
      await auditReservation(tx, context, {
        actorUserId: null,
        outletId: row.outletId,
        action: "reservation.refund_retry_exhausted",
        reservationId,
        reason: "WS-05 refund request failed; needs manual follow-up",
        before: { refundStatus: "pending" },
        after: { refundStatus: "pending", refundAttempts: row.refundAttempts },
        now,
      });
  });
}

async function requestWithRetryBookkeeping(
  context: ScopedTenantContext,
  outletId: OutletId | null,
  reservationId: string,
  expected: { intentId: string; refundIdr: number } | null,
  kind: string,
  actorUserId: string | null,
  now: Date,
): Promise<AttemptOutcome | "failed"> {
  try {
    return await attemptRefund(
      context,
      outletId,
      reservationId,
      expected,
      kind,
      actorUserId,
      now,
    );
  } catch (error) {
    // Ids and the error code only: never request data or secrets.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "UNKNOWN";
    logger.warn(
      { reservationId, code },
      "Reservation DP refund request failed; will retry",
    );
    try {
      await recordFailedAttempt(context, reservationId, now);
    } catch {
      logger.warn({ reservationId }, "Reservation refund retry not recorded");
    }
    return "failed";
  }
}

/**
 * Asks WS-05 for the DP refund decided by a cancel / no-show (called by the
 * lifecycle after the close transaction committed). Never throws: a failure
 * leaves `refund_status = 'pending'` for `retryPendingRefunds`. Idempotent; a
 * replay never creates a second refund request.
 */
export async function requestDepositRefund(
  context: ScopedTenantContext,
  outletId: string,
  reservationId: string,
  refund: { intentId: string; refundIdr: number },
  kind: string,
  actorUserId: string | null,
): Promise<void> {
  const outlet = outletIdSchema.safeParse(outletId);
  if (!outlet.success) {
    logger.warn({ reservationId }, "Reservation DP refund: invalid outlet");
    return;
  }
  await requestWithRetryBookkeeping(
    context,
    outlet.data,
    reservationId,
    refund,
    kind,
    actorUserId,
    new Date(),
  );
}

/**
 * Worker sweep: retries due `pending` DP refunds (settled intent, refund
 * amount above zero, attempts left), oldest first, in a bounded batch.
 */
export async function retryPendingRefunds(
  context: ScopedTenantContext,
  now: Date = new Date(),
  limit = REFUND_RETRY_BATCH,
): Promise<{ requested: number; failed: number }> {
  const due = await withTenant(db, context, async (tx) =>
    tx
      .select({
        id: reservations.id,
        outletId: reservations.outletId,
        status: reservations.status,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.refundStatus, "pending"),
          isNull(reservations.refundPaymentRefundId),
          isNotNull(reservations.depositPaymentId),
          gt(reservations.depositRefundIdr, idr(0)),
          lt(reservations.refundAttempts, REFUND_MAX_ATTEMPTS),
          or(
            isNull(reservations.refundNextAttemptAt),
            lte(reservations.refundNextAttemptAt, now),
          ),
        ),
      )
      .orderBy(asc(reservations.closedAt), asc(reservations.id))
      .limit(limit),
  );
  let requested = 0;
  let failed = 0;
  for (const row of due) {
    const outcome = await requestWithRetryBookkeeping(
      context,
      row.outletId,
      row.id,
      null,
      row.status,
      null,
      now,
    );
    if (outcome === "requested") requested += 1;
    if (outcome === "failed") failed += 1;
  }
  return { requested, failed };
}
