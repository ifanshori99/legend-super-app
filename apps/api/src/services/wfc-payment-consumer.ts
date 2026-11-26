// Settlement of paid WFC passes (brief 1270 card W2): the `payment.paid`
// consumer and the hold sweep. Cloud only; both lock with `lockWfcClaim` (link
// first, then claim), the order the payment confirmation uses.
//
// - On time: a `payment.paid` of the claim's link confirms the claim (seat
//   issued, `paid_idr` = price) only while it is `pending_payment`, the code
//   was paid before the hold ran out (the provider's payment time, not the
//   delivery time), the slot has not ended, the link was never cancelled and
//   paid in full, and sales are still on. The database guard proves the link.
// - Late (most restrictive, W1 re-review): anything else never issues a seat.
//   A pending claim is cancelled and its link closed; the money of a cancelled
//   claim is recorded (`paid_idr`, when the link is paid in full) and refunded
//   in full through a WS-05 refund request by `system:wfc` (approval stays
//   with a person). One request per paid code, capped by what the code still
//   holds (`refundableBalance`, which leaves parked double payments to their
//   own flow) and by the price less what the link already has in refunds.
// - A second paid code of a confirmed claim changes nothing: the payment layer
//   parks it as unallocated money (one pass, the rest parked).
// - Both paths share `settleWfcIntent`. The refund is filed in a savepoint: a
//   refund that fails is logged and the claim stays cancelled with its money
//   recorded, so the event never stalls (W2 review no. 1); only lock errors
//   throw (retried).
// - Sweep: a pending claim past its hold is cancelled and its link closed,
//   unless a code of the link already holds money: then the consumer settles
//   it, and past a 15 minute grace the sweep does. Cancelled claims with a paid
//   code and no late refund request yet get that request.
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import { z } from "zod";
import { db } from "../db/index.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { paymentIntents, paymentLinks } from "../db/schema/payment.ts";
import { wfcSeatReservations } from "../db/schema/wfc-seat.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { recordAudit } from "./core-audit.ts";
import { auditFacility, pgErrorCode, type Tx } from "./facility-shared.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { openRefundChainSafely } from "./payment-refund.service.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import { cancelPaymentLinkInTx } from "./payment.service.ts";
import { lockWfcClaim, type WfcClaimRow } from "./wfc-claim-lock.ts";
import { wfcEdgeProcess } from "./wfc-sale.service.ts";
import { wfcSalesEnabled } from "./wfc-sales-gate.ts";

/** Requester of every WFC refund the system files (listed in the contract). */
export const WFC_SYSTEM_ACTOR: SystemRefundActor = "system:wfc";
/** Idempotency key of the late refund of one paid code (reserved prefix). */
const WFC_LATE_REFUND_PREFIX = "wfc-late-refund:";
export const wfcLateRefundKey = (intentId: string) =>
  `${WFC_LATE_REFUND_PREFIX}${intentId}`;
/** How long after a hold ends the sweep leaves a paid code to the consumer. */
export const WFC_SETTLE_GRACE_MS = 15 * 60_000;

const PAID_INTENT_STATUSES = ["paid", "partially_refunded"] as const;
const LOCK_NOT_AVAILABLE = "55P03";
const DEADLOCK_DETECTED = "40P01";
const SWEEP_BATCH = 100;

const paymentPaidPayloadSchema = z.object({
  intentId: uuidSchema,
  paymentLinkId: uuidSchema,
});

export type WfcPaymentOutcome =
  | "ignored"
  | "confirmed"
  | "unchanged"
  | "late_refund_requested"
  /** Claim cancelled and its money recorded; the refund is left to the sweep. */
  | "late_refund_failed";

type IntentRow = typeof paymentIntents.$inferSelect;
type LinkRow = typeof paymentLinks.$inferSelect;

async function loadLink(
  tx: Tx,
  context: ScopedTenantContext,
  linkId: string,
): Promise<LinkRow | null> {
  const [link] = await tx
    .select()
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, context.tenant.tenantId),
        eq(paymentLinks.id, linkId),
      ),
    )
    .limit(1);
  return link ?? null;
}

/** Refunds (not failed, not of a parked fund) of every code of the link. */
async function linkRefundsIdr(
  tx: Tx,
  context: ScopedTenantContext,
  linkId: string,
): Promise<bigint> {
  const result = await tx.execute(sql`
    SELECT coalesce(sum(r.amount_idr), 0)::text AS total
      FROM payment_refunds r
      JOIN payment_intents i
        ON i.tenant_id = r.tenant_id AND i.id = r.payment_intent_id
     WHERE r.tenant_id = ${context.tenant.tenantId}
       AND i.payment_link_id = ${linkId}::uuid
       AND r.status <> 'failed'
       AND r.unallocated_fund_id IS NULL
  `);
  return BigInt(String(result.rows[0]?.total ?? "0"));
}

/** The request a late refund key stands for (one fingerprint everywhere). */
const lateRefundRequest = (intentId: string) => ({
  paymentIntentId: intentId,
  reason: "wfc_late_payment",
});

/**
 * Closes the late refund key of the code that paid for a seat (W2 re-review
 * P2): a pass that is cancelled later (W3) never gets a full automatic refund
 * from a replayed event or the sweep; its money follows the cancellation rule.
 */
async function closeLateRefund(
  tx: Tx,
  context: ScopedTenantContext,
  intentId: string,
): Promise<void> {
  await idempotentPaymentAdminWrite(
    tx,
    context,
    WFC_SYSTEM_ACTOR,
    wfcLateRefundKey(intentId),
    "refund.create",
    lateRefundRequest(intentId),
    () => Promise.resolve({ refundId: null as string | null }),
  );
}

/**
 * Files the full refund of a paid code of a claim that never got (or lost) its
 * seat. Idempotent per code (a replay returns null). Runs under the claim
 * lock; locks the intent.
 */
async function requestLateRefund(
  tx: Tx,
  context: ScopedTenantContext,
  claim: WfcClaimRow,
  intentId: string,
  now: Date,
): Promise<string | null> {
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, intentId),
        eq(paymentIntents.paymentLinkId, claim.paymentLinkId!),
      ),
    )
    .for("update");
  if (
    !intent ||
    !intent.paidAt ||
    !(PAID_INTENT_STATUSES as readonly string[]).includes(intent.status)
  )
    return null;
  // A replay answers the stored response; only a first run files a refund.
  let filed = false;
  const response = await idempotentPaymentAdminWrite(
    tx,
    context,
    WFC_SYSTEM_ACTOR,
    wfcLateRefundKey(intent.id),
    "refund.create",
    lateRefundRequest(intent.id),
    async () => {
      const { cap, reserved } = await refundableBalance(tx, intent);
      const free = cap - reserved;
      const claimLeft =
        BigInt(claim.priceIdr) -
        (await linkRefundsIdr(tx, context, claim.paymentLinkId!));
      const amount = free < claimLeft ? free : claimLeft;
      if (amount <= 0n) return { refundId: null as string | null };
      const [inserted] = await tx
        .insert(paymentRefunds)
        .values({
          tenantId: intent.tenantId,
          outletId: intent.outletId,
          paymentIntentId: intent.id,
          amountIdr: idr(Number(amount)),
          reason:
            "Refund pass WFC yang tidak dapat diterbitkan (bayar telat, pesanan kursi batal, atau penjualan ditutup)",
          note: null,
          requestedBy: WFC_SYSTEM_ACTOR,
        })
        .returning();
      if (!inserted) throw new Error("Refund insert returned no row");
      const row = await openRefundChainSafely(tx, context, inserted, now);
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
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
          createdAt: now.toISOString(),
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
        now,
      });
      filed = true;
      return { refundId: row.id as string | null };
    },
  );
  return filed ? response.refundId : null;
}

async function setClaim(
  tx: Tx,
  context: ScopedTenantContext,
  claimId: string,
  values: Partial<typeof wfcSeatReservations.$inferInsert>,
): Promise<WfcClaimRow> {
  const [row] = await tx
    .update(wfcSeatReservations)
    .set(values)
    .where(
      and(
        eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
        eq(wfcSeatReservations.id, claimId),
      ),
    )
    .returning();
  if (!row) throw new Error("WFC claim changed under its lock");
  return row;
}

/** Cancels a pending claim and closes its link (caller holds link and claim). */
async function cancelPending(
  tx: Tx,
  context: ScopedTenantContext,
  claim: WfcClaimRow,
  reason: string,
  now: Date,
): Promise<WfcClaimRow> {
  if (claim.paymentLinkId !== null)
    await cancelPaymentLinkInTx(tx, context, {
      linkId: claim.paymentLinkId,
      now,
      reason,
    });
  const row = await setClaim(tx, context, claim.id, {
    status: "cancelled",
    holdExpiresAt: null,
    updatedAt: now,
  });
  await auditFacility(tx, context, null, now, {
    action: "wfc.claim_released",
    objectType: "wfc_seat_reservation",
    objectId: claim.id,
    outletId: claim.outletId,
    before: { status: claim.status },
    after: { status: row.status, source: reason },
  });
  return row;
}

function onTime(
  claim: WfcClaimRow,
  link: LinkRow,
  intent: IntentRow,
  now: Date,
): boolean {
  return (
    claim.status === "pending_payment" &&
    claim.holdExpiresAt !== null &&
    intent.paidAt !== null &&
    intent.paidAt < claim.holdExpiresAt &&
    now < claim.endsAt &&
    link.paidIdr === link.totalIdr &&
    link.totalIdr === claim.priceIdr &&
    claim.paymentLinkExpiresAt !== null &&
    link.expiresAt !== null &&
    link.expiresAt.getTime() === claim.paymentLinkExpiresAt.getTime() &&
    wfcSalesEnabled() &&
    !wfcEdgeProcess()
  );
}

/** Lock errors are retried (event redelivery, next sweep); never swallowed. */
function isLockError(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === LOCK_NOT_AVAILABLE || code === DEADLOCK_DETECTED;
}

/**
 * Settles one paid code of a claim the caller locked (`lockWfcClaim`): the one
 * decision shared by the consumer and the sweep. On time: the seat is issued.
 * Otherwise the claim is (or stays) cancelled, its money recorded, and the
 * refund filed in a savepoint: a refund that fails is logged and left for the
 * sweep (no throw), so the event and the claim never stall. Lock errors throw.
 */
export async function settleWfcIntent(
  tx: Tx,
  context: ScopedTenantContext,
  locked: WfcClaimRow,
  intentId: string,
  now: Date,
): Promise<WfcPaymentOutcome> {
  let claim = locked;
  if (claim.paymentLinkId === null) return "unchanged";
  const link = await loadLink(tx, context, claim.paymentLinkId);
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, intentId),
        eq(paymentIntents.paymentLinkId, claim.paymentLinkId),
      ),
    )
    .limit(1);
  if (
    !link ||
    !intent ||
    !intent.paidAt ||
    !(PAID_INTENT_STATUSES as readonly string[]).includes(intent.status)
  )
    return "unchanged";
  if (onTime(claim, link, intent, now)) {
    const row = await setClaim(tx, context, claim.id, {
      status: "confirmed",
      paidIdr: claim.priceIdr,
      holdExpiresAt: null,
      updatedAt: now,
    });
    await auditFacility(tx, context, null, now, {
      action: "wfc.claim_confirmed",
      objectType: "wfc_seat_reservation",
      objectId: claim.id,
      outletId: claim.outletId,
      before: { status: claim.status },
      after: { status: row.status, priceIdr: row.priceIdr },
    });
    await closeLateRefund(tx, context, intent.id);
    return "confirmed";
  }
  if (claim.status === "pending_payment")
    claim = await cancelPending(tx, context, claim, "wfc_late_payment", now);
  if (claim.status !== "cancelled") return "unchanged";
  // The money of a claim that never got its seat: recorded once (when the
  // link holds the full price), then refunded in full.
  const linkNow = await loadLink(tx, context, link.id);
  if (claim.paidIdr === 0 && linkNow && linkNow.paidIdr === linkNow.totalIdr)
    claim = await setClaim(tx, context, claim.id, {
      paidIdr: claim.priceIdr,
      updatedAt: now,
    });
  const cancelled = claim;
  let refundId: string | null;
  try {
    refundId = await tx.transaction((savepoint) =>
      requestLateRefund(savepoint, context, cancelled, intent.id, now),
    );
  } catch (error) {
    if (isLockError(error)) throw error;
    logger.error(
      {
        claimId: claim.id,
        intentId: intent.id,
        code: pgErrorCode(error) ?? (error as { code?: unknown }).code,
      },
      "WFC late refund not filed; the hold sweep retries it",
    );
    // Seen by the audit trail, and moved to the back of the sweep's retry
    // queue so a refund that keeps failing never holds the others.
    await setClaim(tx, context, claim.id, { updatedAt: now });
    await auditFacility(tx, context, null, now, {
      action: "wfc.late_refund_failed",
      objectType: "wfc_seat_reservation",
      objectId: claim.id,
      outletId: claim.outletId,
      before: null,
      after: { status: claim.status, source: "late_payment" },
    });
    return "late_refund_failed";
  }
  if (refundId === null) return "unchanged";
  await auditFacility(tx, context, null, now, {
    action: "wfc.late_payment_refund",
    objectType: "wfc_seat_reservation",
    objectId: claim.id,
    outletId: claim.outletId,
    before: null,
    after: { status: claim.status, source: "late_payment" },
  });
  return "late_refund_requested";
}

/**
 * `payment.paid` consumer of WFC links. Idempotent and replay safe; ignores
 * other events, other tenants and links that fund no claim. Throws only on
 * lock errors (redelivered); a failed refund is left to the sweep.
 */
export async function handleWfcPaymentPaid(
  context: ScopedTenantContext,
  event: EventEnvelope,
  now: Date = new Date(),
): Promise<WfcPaymentOutcome> {
  if (event.name !== "payment.paid") return "ignored";
  if (event.tenantId !== context.tenant.tenantId) return "ignored";
  if (wfcEdgeProcess()) return "ignored";
  const payload = paymentPaidPayloadSchema.safeParse(event.payload);
  if (!payload.success) return "ignored";
  const { intentId, paymentLinkId } = payload.data;
  const found = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ id: wfcSeatReservations.id })
      .from(wfcSeatReservations)
      .where(
        and(
          eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
          eq(wfcSeatReservations.paymentLinkId, paymentLinkId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (!found) return "ignored";
  return withTenant(db, context, async (tx) =>
    settleWfcIntent(
      tx,
      context,
      await lockWfcClaim(tx, context, found.id),
      intentId,
      now,
    ),
  );
}

export type WfcSweepResult = {
  /** Unpaid holds past their hold, cancelled and their link closed. */
  released: number;
  /** Paid codes the consumer left (lost event, failed refund) settled now. */
  settled: number;
  /** Rows left for the next run (locked, within the grace, or failed). */
  skipped: number;
};

/** Paid code of the claim's link the sweep should settle, oldest first. */
async function unsettledPaidCode(
  tx: Tx,
  context: ScopedTenantContext,
  claim: WfcClaimRow,
  before: Date,
): Promise<string | null> {
  if (claim.paymentLinkId === null) return null;
  const result = await tx.execute(sql`
    SELECT i.id::text AS id
      FROM payment_intents i
     WHERE i.tenant_id = ${context.tenant.tenantId}
       AND i.payment_link_id = ${claim.paymentLinkId}::uuid
       AND i.status IN ('paid', 'partially_refunded')
       AND i.paid_at IS NOT NULL
       AND i.paid_at <= ${before.toISOString()}::timestamptz
       AND NOT EXISTS (
             SELECT 1 FROM payment_admin_idempotency k
              WHERE k.tenant_id = i.tenant_id
                AND k.key = ${WFC_LATE_REFUND_PREFIX} || i.id::text)
     ORDER BY i.paid_at, i.id
     LIMIT 1
  `);
  const id = result.rows[0]?.id;
  return typeof id === "string" ? id : null;
}

/** Does a code of the claim's link hold money? */
async function linkHasPaidCode(
  tx: Tx,
  context: ScopedTenantContext,
  claim: WfcClaimRow,
): Promise<boolean> {
  if (claim.paymentLinkId === null) return false;
  const [paid] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.paymentLinkId, claim.paymentLinkId),
        inArray(paymentIntents.status, [...PAID_INTENT_STATUSES]),
      ),
    )
    .limit(1);
  return paid !== undefined;
}

/**
 * The hold sweep (bounded batches, oldest first):
 * - a pending claim past its hold with no paid code is cancelled and its link
 *   closed;
 * - a pending claim whose code took money and whose hold ended more than
 *   `WFC_SETTLE_GRACE_MS` ago (the consumer never settled it) is settled by
 *   `settleWfcIntent`: a seat when paid on time, else a refund;
 * - a cancelled claim with a paid code older than the grace and no late refund
 *   request yet (a refund that failed, or an event never delivered) is settled
 *   again, which files that refund.
 * A claim another transaction holds is left for the next run.
 */
export async function sweepWfcHolds(
  context: ScopedTenantContext,
  now: Date = new Date(),
  limit = SWEEP_BATCH,
): Promise<WfcSweepResult> {
  const result: WfcSweepResult = { released: 0, settled: 0, skipped: 0 };
  if (wfcEdgeProcess()) return result;
  const graceEnd = new Date(now.getTime() - WFC_SETTLE_GRACE_MS);
  const { lapsed, unrefunded } = await withTenant(db, context, async (tx) => {
    const lapsedRows = await tx
      .select({ id: wfcSeatReservations.id })
      .from(wfcSeatReservations)
      .where(
        and(
          eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
          eq(wfcSeatReservations.status, "pending_payment"),
          isNotNull(wfcSeatReservations.holdExpiresAt),
          lte(wfcSeatReservations.holdExpiresAt, now),
        ),
      )
      .orderBy(asc(wfcSeatReservations.holdExpiresAt))
      .limit(limit);
    const unrefundedRows = await tx.execute(sql`
      SELECT c.id::text AS id
        FROM wfc_seat_reservations c
       WHERE c.tenant_id = ${context.tenant.tenantId}
         AND c.status = 'cancelled'
         AND c.payment_link_id IS NOT NULL
         AND EXISTS (
               SELECT 1 FROM payment_intents i
                WHERE i.tenant_id = c.tenant_id
                  AND i.payment_link_id = c.payment_link_id
                  AND i.status IN ('paid', 'partially_refunded')
                  AND i.paid_at IS NOT NULL
                  AND i.paid_at <= ${graceEnd.toISOString()}::timestamptz
                  AND NOT EXISTS (
                        SELECT 1 FROM payment_admin_idempotency k
                         WHERE k.tenant_id = i.tenant_id
                           AND k.key = ${WFC_LATE_REFUND_PREFIX} || i.id::text))
       ORDER BY c.updated_at, c.id
       LIMIT ${limit}
    `);
    return {
      lapsed: lapsedRows.map((row) => row.id),
      unrefunded: unrefundedRows.rows.map((row) => String(row.id)),
    };
  });
  const visit = async (
    id: string,
    step: (tx: Tx, claim: WfcClaimRow) => Promise<keyof WfcSweepResult>,
  ) => {
    try {
      const outcome = await withTenant(db, context, async (tx) =>
        step(tx, await lockWfcClaim(tx, context, id)),
      );
      result[outcome] += 1;
    } catch (error) {
      result.skipped += 1;
      if (!isLockError(error))
        logger.warn({ claimId: id }, "WFC hold sweep failed for a claim");
    }
  };
  for (const id of lapsed)
    await visit(id, async (tx, claim) => {
      if (
        claim.status !== "pending_payment" ||
        claim.holdExpiresAt === null ||
        claim.holdExpiresAt > now
      )
        return "skipped";
      if (await linkHasPaidCode(tx, context, claim)) {
        // The consumer's turn first; past the grace the sweep settles it.
        if (claim.holdExpiresAt > graceEnd) return "skipped";
        const code = await unsettledPaidCode(tx, context, claim, now);
        if (code === null) return "skipped";
        const outcome = await settleWfcIntent(tx, context, claim, code, now);
        return outcome === "unchanged" ? "skipped" : "settled";
      }
      await cancelPending(tx, context, claim, "wfc_hold_lapsed", now);
      return "released";
    });
  for (const id of unrefunded)
    await visit(id, async (tx, claim) => {
      if (claim.status !== "cancelled") return "skipped";
      const code = await unsettledPaidCode(tx, context, claim, graceEnd);
      if (code === null) return "skipped";
      const outcome = await settleWfcIntent(tx, context, claim, code, now);
      return outcome === "late_refund_requested" ? "settled" : "skipped";
    });
  return result;
}
