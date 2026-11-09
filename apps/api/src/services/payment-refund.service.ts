// Refund approval and provider payout (beads legend-hvvn, legend-rbjw; PAY-04).
//
// A refund is a request until the approval matrix (platform-approval.service)
// approves it: `pending` -> `approved` -> `completed` | `failed`. The chain is
// opened lazily by the first approve/reject call, so every requester (a user or
// a system actor such as `system:reservation`) takes one code path. Money only
// moves after approval, through `PaymentRefundPort`, and a refund is `completed`
// only on provider success:
// - a throw/timeout is an UNKNOWN outcome: the refund stays `approved`, the
//   attempt is counted and the same provider idempotency key is retried;
// - only a returned `failed` result is a definitive decline (`failed`,
//   `provider_declined`), which releases the reserved amount.
// The provider is never called inside a database transaction. Lock order is
// payment intent -> unallocated fund -> refund everywhere; the payout claim
// transaction locks only the refund, or that same chain for a fund refund (a
// short lease, then the provider call). Every send first re-validates the
// approval; one that no longer holds is quarantined, never sent.

import {
  AccessError,
  assertSurfaceAccess,
  type PermissionCode,
} from "@starter/shared/access";
import {
  CoreError,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { approvalResolvedEvent, IdentityError } from "@starter/shared/identity";
import { paymentRefundEscalatedEvent } from "@starter/shared/payment";
import type * as contract from "@starter/shared/payment/admin";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
import {
  approvalRequests,
  paymentEvidence,
  paymentIntents,
  paymentRefundEscalationSettings,
  paymentRefunds,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  emitOperationsEvent,
  OPERATIONS_NOTIFICATION_DESTINATION,
} from "./operations-events.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import {
  authorize,
  conflict,
  hasSourceDocument,
  missing,
  refundableBalance,
  refundAudit,
  refundView,
  refundViewFor,
  type Intent,
  type Refund,
} from "./payment-admin.service.ts";
import {
  paymentRefundGateway,
  UNCONFIGURED_REFUND_PROVIDER,
  type GatewayRefundLookup,
} from "./payment-refund-gateway.ts";
import {
  appendPaymentEvent,
  assertPaymentPermission,
} from "./payment-support.ts";
import {
  cancelApprovalRequest,
  decideApprovalRequest,
  getApprovalChainOutcome,
  openApprovalRequest,
} from "./platform-approval.service.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver.ts";

/** Approval matrix identity of a refund (single use through the unique chain id). */
export const REFUND_SOURCE_MODULE = "payment";
const REFUND_ACTION_TYPE = "refund";
const REFUND_OBJECT_TYPE = "payment_refund";
const REFUND_DEADLINE_MINUTES = 1440;
/** Lease on an in-flight provider call; another worker skips while it holds. */
const PAYOUT_CLAIM_MS = 120_000;
/** Deadline of one provider call; a timeout is an unknown outcome. */
const PROVIDER_TIMEOUT_MS = 30_000;
/** The sweep stops paying after this many attempts and flags the refund for ops. */
const PAYOUT_MAX_ATTEMPTS = 8;
const PAYOUT_BACKOFF_CAP_MINUTES = 60;
const PAYOUT_SWEEP_BATCH = 20;
/** Time budget of one sweep round: no new refund is claimed once it is spent. */
const PAYOUT_SWEEP_BUDGET_MS = 20_000;
/** A refund the provider still reports `pending` this long after approval needs ops. */
const PAYOUT_PENDING_MAX_HOURS = 72;
export const MANUAL_RECONCILIATION = "MANUAL_RECONCILIATION";
/** The fund has no usable evidence of its own: ops must map it (retry with sourceEvidenceId). */
export const EVIDENCE_MAPPING_REQUIRED = "EVIDENCE_MAPPING_REQUIRED";
/**
 * The approval of an `approved` refund failed the send-time re-validation
 * (legend-tvhq): it is never sent again by sweep or retry. Ops reconcile it.
 */
export const PAYOUT_QUARANTINED = "PAYOUT_QUARANTINED";

type Fund = typeof paymentUnallocatedFunds.$inferSelect;
type Locked = { intent: Intent; fund: Fund | null; refund: Refund };
type DecideOptions = { readonly mfaVerified: boolean };

// ------------------------------------------------------------------ locks

/** Locks intent -> fund (if any) -> refund, in that order, and re-reads the refund. */
async function lockRefundGraph(
  tx: Tx,
  tenantId: Refund["tenantId"],
  refundId: string,
): Promise<Locked> {
  const [probe] = await tx
    .select()
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.id, refundId),
      ),
    );
  if (!probe) throw missing();
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, probe.paymentIntentId),
      ),
    )
    .for("update");
  if (!intent) throw missing();
  let fund: Fund | null = null;
  if (probe.unallocatedFundId) {
    const [row] = await tx
      .select()
      .from(paymentUnallocatedFunds)
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, tenantId),
          eq(paymentUnallocatedFunds.id, probe.unallocatedFundId),
        ),
      )
      .for("update");
    if (!row) throw missing();
    fund = row;
  }
  const [refund] = await tx
    .select()
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.id, refundId),
      ),
    )
    .for("update");
  if (!refund) throw missing();
  return { intent, fund, refund };
}

async function loadView(
  context: ScopedTenantContext,
  refundId: string,
  viewerId: string | null = null,
) {
  return withTenant(db, context, async (tx) => {
    const [refund] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!refund) throw missing();
    return viewerId === null
      ? refundView(tx, refund)
      : refundViewFor(tx, context, refund, viewerId);
  });
}

/** Supervisor authority: the permission that stands for a PIN or phone approval. */
const SUPERVISOR_PERMISSION = "pos.refund.approve";

/** Boolean form of assertPaymentPermission: only a denial is `false`. */
async function holdsPermission(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  permission: PermissionCode,
  outletId: string,
  now: Date,
): Promise<boolean> {
  try {
    await assertPaymentPermission(
      tx,
      context,
      userId,
      permission,
      { type: "outlet", id: outletId },
      now,
    );
    return true;
  } catch (error) {
    if (error instanceof AccessError) return false;
    throw error;
  }
}

/**
 * holdsPermission as of an earlier decision instant `at`: only assignments
 * recorded by then (`assignedAt <= at`) and active at `at` count. An API grant
 * may backdate `validFrom`, so a later grant must never pass an old approval;
 * a role ended after `at` still covers it.
 */
async function heldAt(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  permission: PermissionCode,
  outletId: string,
  at: Date,
): Promise<boolean> {
  const data = await loadTenantAccessInTransaction(tx, context, userId);
  return resolveAccessSnapshot({
    tenant: context.tenant,
    userId,
    ...data,
    assignments: data.assignments.filter(
      (assignment) => Date.parse(assignment.assignedAt) <= at.getTime(),
    ),
    mfaVerified: false,
    now: at,
  }).allows(permission, { type: "outlet", id: outletId });
}

// ------------------------------------------------------------ transitions

/**
 * `pending` -> `approved` under the locks. Fails closed: when the cap (or the
 * fund) no longer allows the refund, it ends `failed` (`cap_exceeded`) and that
 * failed row is returned, so the refund is never stuck `pending` forever.
 */
async function applyApproval(
  tx: Tx,
  context: ScopedTenantContext,
  locked: Locked,
  approvedBy: string,
  now: Date,
): Promise<Refund> {
  const { intent, fund, refund } = locked;
  if (approvedBy.toLowerCase() === refund.requestedBy.toLowerCase())
    throw new AccessError("APPROVER_IS_REQUESTER");
  // A user-filed refund of a sale is never paid from here: the owning module
  // refunds it (order.refunded). Legacy pending rows fail closed. System
  // requesters and unallocated funds (never journalled) are exempt.
  if (
    !refund.unallocatedFundId &&
    hasSourceDocument(intent) &&
    isUserId(refund.requestedBy)
  )
    return failRefund(tx, context, refund, {
      reason: "source_document",
      action: "payment.refund_failed",
      actorId: approvedBy,
      note: null,
      now,
    });
  // This refund is itself reserved (pending), so reserved must still fit the cap.
  const fits = fund
    ? !fund.resolution
    : await refundableBalance(tx, intent).then(
        ({ cap, reserved }) => reserved <= cap,
      );
  if (!fits)
    return failRefund(tx, context, refund, {
      reason: "cap_exceeded",
      action: "payment.refund_failed",
      actorId: approvedBy,
      note: null,
      now,
    });
  const [updated] = await tx
    .update(paymentRefunds)
    .set({ status: "approved", approvedBy, decidedAt: now, updatedAt: now })
    .where(
      and(
        eq(paymentRefunds.tenantId, refund.tenantId),
        eq(paymentRefunds.id, refund.id),
        eq(paymentRefunds.status, "pending"),
      ),
    )
    .returning();
  if (!updated) throw new Error("refund changed under its row lock");
  await refundAudit(tx, context, {
    actorId: approvedBy,
    row: updated,
    action: "payment.refund_approved",
    now,
    before: { status: "pending" },
  });
  return updated;
}

/** Ends a refund `failed`; `failed` releases the reservation (refundableBalance). */
async function failRefund(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  input: {
    reason: contract.RefundFailureReason;
    action: string;
    actorId: string | null;
    note: string | null;
    providerRef?: string | null;
    code?: string;
    /** Another worker holds the lease: leave its lease fields alone. */
    keepLease?: boolean;
    /** Extra audit facts merged into `after` (e.g. the quarantine defect). */
    detail?: Record<string, unknown>;
    now: Date;
  },
): Promise<Refund> {
  const [updated] = await tx
    .update(paymentRefunds)
    .set({
      status: "failed",
      failureReason: input.reason,
      decidedAt: refund.decidedAt ?? input.now,
      providerRef: input.providerRef ?? refund.providerRef,
      ...(input.keepLease
        ? {}
        : { payoutClaimedUntil: null, payoutClaimToken: null }),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(paymentRefunds.tenantId, refund.tenantId),
        eq(paymentRefunds.id, refund.id),
        sql`${paymentRefunds.status} IN ('pending', 'approved')`,
      ),
    )
    .returning();
  if (!updated) throw new Error("refund changed under its row lock");
  await refundAudit(tx, context, {
    actorId: input.actorId,
    row: updated,
    action: input.action,
    now: input.now,
    reason: input.note,
    before: { status: refund.status },
    after: {
      amountIdr: updated.amountIdr,
      status: updated.status,
      failureReason: input.reason,
      ...(input.code ? { providerCode: input.code } : {}),
      ...input.detail,
    },
  });
  return updated;
}

/** `approved` -> `completed`: only called on provider success. */
async function completeRefund(
  tx: Tx,
  context: ScopedTenantContext,
  locked: Locked,
  providerRef: string,
  now: Date,
  opts: { keepLease?: boolean } = {},
): Promise<Refund> {
  const { intent, fund, refund } = locked;
  const approver = refund.approvedBy;
  if (approver === null) throw new Error("approved refund has no approver");
  const [updated] = await tx
    .update(paymentRefunds)
    .set({
      status: "completed",
      providerRef,
      completedAt: now,
      ...(opts.keepLease
        ? {}
        : { payoutClaimedUntil: null, payoutClaimToken: null }),
      lastPayoutError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentRefunds.tenantId, refund.tenantId),
        eq(paymentRefunds.id, refund.id),
        eq(paymentRefunds.status, "approved"),
      ),
    )
    .returning();
  if (!updated) throw new Error("refund changed under its row lock");
  if (fund) {
    // The excess left the account: the fund is resolved by this refund.
    await tx
      .update(paymentUnallocatedFunds)
      .set({
        resolution: "refund",
        resolvedBy: approver,
        resolvedAt: now,
        approvalRef: refund.id,
      })
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, fund.tenantId),
          eq(paymentUnallocatedFunds.id, fund.id),
          sql`${paymentUnallocatedFunds.resolution} IS NULL`,
        ),
      );
  } else {
    const result = await tx.execute(sql`
      SELECT coalesce(sum(amount_idr), 0)::text AS total FROM payment_refunds
      WHERE tenant_id = ${intent.tenantId} AND payment_intent_id = ${intent.id}::uuid
        AND status = 'completed' AND unallocated_fund_id IS NULL
    `);
    const refunded = BigInt(String(result.rows[0]!.total));
    await tx
      .update(paymentIntents)
      .set({
        status:
          refunded >= BigInt(intent.amountIdr)
            ? "refunded"
            : "partially_refunded",
        updatedAt: now,
      })
      .where(
        and(
          eq(paymentIntents.tenantId, intent.tenantId),
          eq(paymentIntents.id, intent.id),
        ),
      );
  }
  await refundAudit(tx, context, {
    actorId: null,
    row: updated,
    action: "payment.refund_completed",
    now,
    before: { status: "approved" },
  });
  await appendPaymentEvent(tx, context, {
    name: "payment.refunded",
    aggregateId: updated.id,
    outletId: updated.outletId,
    actor: { type: "system" },
    payload: {
      refundId: updated.id,
      paymentIntentId: updated.paymentIntentId,
      amountIdr: updated.amountIdr,
      unallocatedFundId: updated.unallocatedFundId,
    },
    now,
  });
  return updated;
}

// ------------------------------------------------------- approval chain

type ChainRow = typeof approvalRequests.$inferSelect;

async function chainRowsOf(
  tx: Tx,
  tenantId: Refund["tenantId"],
  chainId: string,
): Promise<ChainRow[]> {
  return tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(asc(approvalRequests.level));
}

/** The chain must be this refund's own: bound to its value and payment (single use). */
function chainBound(rows: readonly ChainRow[], refund: Refund): boolean {
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.sourceModule === REFUND_SOURCE_MODULE &&
        row.actionType === REFUND_ACTION_TYPE &&
        row.objectType === REFUND_OBJECT_TYPE &&
        row.objectId.toLowerCase() === refund.id.toLowerCase() &&
        row.amountIdr === refund.amountIdr,
    )
  );
}

function assertChainBound(rows: readonly ChainRow[], refund: Refund): void {
  if (!chainBound(rows, refund))
    throw new CoreError(
      "VALIDATION_ERROR",
      "Approval chain does not match this refund.",
    );
}

/** requestReason must be 3..500 characters. */
function requestReasonOf(reason: string): string {
  const trimmed = reason.trim().slice(0, 500);
  return trimmed.length < 3 ? `Refund ${trimmed}`.trim() : trimmed;
}

function isUserId(id: string): boolean {
  return userIdSchema.safeParse(id).success;
}

/**
 * Applies the chain's terminal outcome to a still-`pending` refund, under the
 * intent -> fund -> refund locks. The chain is re-read from the database: an
 * event or a caller only triggers this, it is never the authority.
 */
async function settleLocked(
  tx: Tx,
  context: ScopedTenantContext,
  locked: Locked,
  now: Date,
): Promise<Refund> {
  const { refund } = locked;
  if (refund.status !== "pending" || refund.approvalChainId === null)
    return refund;
  const outcome = await getApprovalChainOutcome(tx, {
    chainId: refund.approvalChainId,
    sourceModule: REFUND_SOURCE_MODULE,
  });
  const rows = await chainRowsOf(tx, refund.tenantId, refund.approvalChainId);
  assertChainBound(rows, refund);
  if (outcome === "pending") return refund;
  if (outcome === "approved") {
    const last = rows.at(-1);
    if (!last?.decidedBy) throw new Error("approved chain has no approver");
    // Every approver must hold payment.reconcile or pos.refund.approve at this
    // outlet (the inbox route does not check the outlet), and at least one must
    // hold pos.refund.approve (supervisor authority). The chain is already
    // resolved, so a pending refund could never be decided again: fail it closed
    // instead (never paid, and the approval.resolved consumer does not retry
    // forever).
    let supervisorApproved = false;
    for (const row of rows) {
      if (row.status !== "approved" || !row.decidedBy) continue;
      const supervisor = await holdsPermission(
        tx,
        context,
        row.decidedBy,
        SUPERVISOR_PERMISSION,
        refund.outletId,
        now,
      );
      if (supervisor) supervisorApproved = true;
      const allowed =
        supervisor ||
        (await holdsPermission(
          tx,
          context,
          row.decidedBy,
          "payment.reconcile",
          refund.outletId,
          now,
        ));
      if (!allowed)
        return failRefund(tx, context, refund, {
          reason: "approver_unauthorized",
          action: "payment.refund_failed",
          actorId: null,
          note: null,
          now,
        });
    }
    if (!supervisorApproved)
      return failRefund(tx, context, refund, {
        reason: "approver_unauthorized",
        action: "payment.refund_failed",
        actorId: null,
        note: "supervisor_required",
        now,
      });
    return applyApproval(tx, context, locked, last.decidedBy, now);
  }
  if (outcome === "rejected") {
    const rejected = rows.find((row) => row.status === "rejected");
    return failRefund(tx, context, refund, {
      reason: "rejected",
      action: "payment.refund_rejected",
      actorId: rejected?.decidedBy ?? null,
      note: rejected?.reason ?? null,
      now,
    });
  }
  // expired / cancelled: nobody approved in time (or the request was withdrawn).
  return failRefund(tx, context, refund, {
    reason: "approval_expired",
    action: "payment.refund_expired",
    actorId: null,
    note: null,
    now,
  });
}

/** Settles a refund from its approval chain (consumer, or right after a decision). */
export async function settleRefundFromChain(
  context: ScopedTenantContext,
  refundId: string,
  now: Date = new Date(),
): Promise<Refund> {
  return withTenant(db, context, async (tx) =>
    settleLocked(
      tx,
      context,
      await lockRefundGraph(tx, context.tenant.tenantId, refundId),
      now,
    ),
  );
}

// ------------------------------------------------- approve / reject calls

type Decision = "approved" | "rejected";

/** Same answer as createRefund: a sale's payment is refunded by its module. */
const sourceDocumentRefused = () =>
  new HttpError(
    409,
    "REFUND_SOURCE_DOCUMENT",
    "Payment belongs to a sales document; refund it from the owning module.",
  );
type FirstStep =
  | { readonly kind: "done" }
  | { readonly kind: "capped"; readonly reason?: string | null }
  | { readonly kind: "payout" }
  | { readonly kind: "decide"; readonly requestId: string | null };

async function decideRefund(
  context: ScopedTenantContext,
  actor: string,
  refundId: string,
  decision: Decision,
  reason: string,
  key: string,
  opts: DecideOptions,
) {
  const now = new Date();
  const first = await withTenant(
    db,
    context,
    async (tx): Promise<FirstStep> => {
      const locked = await lockRefundGraph(
        tx,
        context.tenant.tenantId,
        refundId,
      );
      const { refund } = locked;
      await authorize(tx, context, actor, "payment.reconcile", refund.outletId);
      if (refund.requestedBy === actor)
        throw new AccessError("APPROVER_IS_REQUESTER");
      // Idempotent by key, in this same transaction: a retried call (also a
      // submit-only call or a direct reject, which leave no keyed chain row)
      // replays the first step; the same key with another body is refused.
      return idempotentPaymentAdminWrite(
        tx,
        context,
        actor,
        key,
        `refund.${decision}`,
        { refundId: refund.id, reason },
        async (): Promise<FirstStep> => {
          // Replay: this actor already recorded this decision with this key on a
          // level of the chain. Return the current state (settling a still-pending
          // refund whose settle step may not have run), never a conflict.
          if (refund.approvalChainId !== null) {
            const chain = await chainRowsOf(
              tx,
              refund.tenantId,
              refund.approvalChainId,
            );
            const replay = chain.some(
              (row) =>
                row.decisionIdempotencyKey === key &&
                row.status === decision &&
                row.decidedBy?.toLowerCase() === actor.toLowerCase(),
            );
            if (replay)
              return refund.status === "pending"
                ? { kind: "decide", requestId: null }
                : { kind: "done" };
          }
          if (refund.status !== "pending") {
            // A reject (or an approve of a failed refund) never succeeds silently;
            // an approve of an approved/completed refund is a replay: same view.
            if (decision === "rejected" || refund.status === "failed")
              throw conflict("Refund is no longer pending.");
            return { kind: "done" };
          }

          let chainId = refund.approvalChainId;
          const systemRequester = !isUserId(refund.requestedBy);
          if (systemRequester && decision === "rejected") {
            // No user requested it, so any authorised human may decline it directly.
            if (chainId !== null)
              await cancelApprovalRequest(tx, context, {
                chainId,
                sourceModule: REFUND_SOURCE_MODULE,
                actorUserId: actor,
                now,
              });
            await failRefund(tx, context, refund, {
              reason: "rejected",
              action: "payment.refund_rejected",
              actorId: actor,
              note: reason,
              now,
            });
            return { kind: "done" };
          }
          let justOpened = false;
          if (chainId === null) {
            const opened = await openApprovalRequest(tx, context, {
              sourceModule: REFUND_SOURCE_MODULE,
              actionType: REFUND_ACTION_TYPE,
              objectType: REFUND_OBJECT_TYPE,
              objectId: refund.id,
              amountIdr: refund.amountIdr,
              outletId: refund.outletId,
              // A system requester has no user row: the first human acting submits.
              requestedBy: systemRequester ? actor : refund.requestedBy,
              source: "user",
              requestReason: requestReasonOf(refund.reason),
              payload: {
                paymentIntentId: refund.paymentIntentId,
                unallocatedFundId: refund.unallocatedFundId,
              },
              deadlineMinutes: REFUND_DEADLINE_MINUTES,
              now,
            });
            if (!opened.required) {
              // Below every tier of the matrix: this one authorised person decides.
              if (decision === "approved") {
                // Supervisor authority is required on top of payment.reconcile;
                // the throw rolls back the opened request, so the refund stays
                // pending with no chain row.
                if (
                  !(await holdsPermission(
                    tx,
                    context,
                    actor,
                    SUPERVISOR_PERMISSION,
                    refund.outletId,
                    now,
                  ))
                )
                  throw new AccessError(
                    "PERMISSION_DENIED",
                    "Your account cannot perform this action.",
                  );
                const applied = await applyApproval(
                  tx,
                  context,
                  locked,
                  actor,
                  now,
                );
                return applied.status === "approved"
                  ? { kind: "payout" }
                  : { kind: "capped", reason: applied.failureReason };
              }
              await failRefund(tx, context, refund, {
                reason: "rejected",
                action: "payment.refund_rejected",
                actorId: actor,
                note: reason,
                now,
              });
              return { kind: "done" };
            }
            await tx
              .update(paymentRefunds)
              .set({ approvalChainId: opened.chainId, updatedAt: now })
              .where(
                and(
                  eq(paymentRefunds.tenantId, refund.tenantId),
                  eq(paymentRefunds.id, refund.id),
                ),
              );
            chainId = opened.chainId;
            justOpened = true;
          }

          const rows = await chainRowsOf(tx, refund.tenantId, chainId);
          assertChainBound(rows, refund);
          // The submitter of a system-requested refund is the chain requester: their
          // first call only submits, another person decides (never the submitter).
          if (systemRequester && rows[0]?.requestedBy === actor) {
            if (justOpened) return { kind: "done" };
            throw new AccessError("APPROVER_IS_REQUESTER");
          }
          const open = rows.find((row) => row.status === "pending");
          return { kind: "decide", requestId: open?.id ?? null };
        },
      );
    },
  );

  let raced = false;
  if (first.kind === "decide" && first.requestId !== null) {
    try {
      await decideApprovalRequest(
        context.tenant,
        actor,
        first.requestId,
        { decision, reason },
        { mfaVerified: opts.mfaVerified, idempotencyKey: key },
      );
    } catch (error) {
      // Someone else decided (or the deadline passed) between our read and the
      // decision: settle from the chain instead of failing the caller.
      raced =
        error instanceof IdentityError &&
        (error.code === "APPROVAL_REQUEST_NOT_PENDING" ||
          error.code === "APPROVAL_REQUEST_EXPIRED");
      if (!raced) throw error;
    }
  }
  if (first.kind === "capped") {
    if (first.reason === "source_document") throw sourceDocumentRefused();
    throw conflict("Refund exceeds available paid amount.");
  }
  if (first.kind === "decide") {
    const settled = await settleRefundFromChain(context, refundId);
    // A reject must never approve or pay; a failed refund (cap exceeded, or
    // rejected by someone else meanwhile) is not an approval either. The
    // failure is already committed.
    if (decision === "rejected" && settled.status !== "failed")
      throw conflict("Refund could not be rejected.");
    if (decision === "approved" && settled.status === "failed") {
      if (settled.failureReason === "source_document")
        throw sourceDocumentRefused();
      throw conflict("Refund could not be approved.");
    }
    // Our decision did not land (another approver took this level): the state
    // above is settled, but a still-pending refund is not a success for us.
    if (raced && settled.status === "pending")
      throw conflict("Approval level was already decided; refresh.");
    // Without a refund gateway nothing is claimed: the refund stays approved
    // and the sweep pays it once a gateway is installed.
    if (settled.status === "approved" && refundGatewayInstalled())
      await runRefundPayout(context, refundId);
  } else if (first.kind === "payout" && refundGatewayInstalled()) {
    await runRefundPayout(context, refundId);
  }
  return loadView(context, refundId, actor);
}

export async function approveRefund(
  context: ScopedTenantContext,
  actor: string,
  params: { refundId: string },
  input: contract.ApproveRefundInput,
  key: string,
  opts: DecideOptions,
) {
  return decideRefund(
    context,
    actor,
    params.refundId,
    "approved",
    input.note?.trim() || "Refund disetujui.",
    key,
    opts,
  );
}

export async function rejectRefund(
  context: ScopedTenantContext,
  actor: string,
  params: { refundId: string },
  input: { reason: string },
  key: string,
  opts: DecideOptions,
) {
  return decideRefund(
    context,
    actor,
    params.refundId,
    "rejected",
    input.reason.trim(),
    key,
    opts,
  );
}

// ---------------------------------------------------------------- payout

/** Short, PII-free code of an unknown provider outcome (never the message). */
function errorCodeOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  const raw =
    typeof code === "string"
      ? code
      : error instanceof Error
        ? error.name
        : "UNKNOWN";
  return raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100) || "UNKNOWN";
}

/** Why an `approved` refund's approval no longer allows a payout. */
type ApprovalDefect =
  | "approver_unauthorized"
  | "supervisor_required"
  | "chain_unbound"
  | "chain_not_approved";

/**
 * Re-validates the approval of an `approved` refund under the current rules,
 * right before a payout send (legend-tvhq): an approval recorded before the
 * supervisor rule, whose payout failed, must not be paid by a later sweep or
 * retry. Same rules as decideRefund's direct path (one approver with
 * payment.reconcile and pos.refund.approve) and settleLocked (every chain
 * approver holds either, at least one holds pos.refund.approve). Permissions
 * are read as of each decision (`refund.decidedAt`, each chain row's
 * `decidedAt`; see heldAt), so a role ended later does not undo an approval.
 * Returns the defect, or null when the approval holds.
 */
async function approvalDefectOf(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  now: Date,
): Promise<ApprovalDefect | null> {
  const approver = refund.approvedBy;
  if (
    approver === null ||
    approver.toLowerCase() === refund.requestedBy.toLowerCase()
  )
    return "approver_unauthorized";
  const holds = (userId: string, permission: PermissionCode, at: Date) =>
    heldAt(tx, context, userId, permission, refund.outletId, at);
  if (refund.approvalChainId === null) {
    const decidedAt = refund.decidedAt ?? now;
    if (!(await holds(approver, SUPERVISOR_PERMISSION, decidedAt)))
      return "supervisor_required";
    if (!(await holds(approver, "payment.reconcile", decidedAt)))
      return "approver_unauthorized";
    return null;
  }
  const rows = await chainRowsOf(tx, refund.tenantId, refund.approvalChainId);
  if (!chainBound(rows, refund)) return "chain_unbound";
  const outcome = await getApprovalChainOutcome(tx, {
    chainId: refund.approvalChainId,
    sourceModule: REFUND_SOURCE_MODULE,
  });
  if (outcome !== "approved") return "chain_not_approved";
  let supervisorApproved = false;
  for (const row of rows) {
    if (row.status !== "approved" || !row.decidedBy) continue;
    const decidedAt = row.decidedAt ?? now;
    const supervisor = await holds(
      row.decidedBy,
      SUPERVISOR_PERMISSION,
      decidedAt,
    );
    if (supervisor) supervisorApproved = true;
    else if (!(await holds(row.decidedBy, "payment.reconcile", decidedAt)))
      return "approver_unauthorized";
  }
  return supervisorApproved ? null : "supervisor_required";
}

/**
 * Quarantines a refund whose approval failed re-validation: it stays
 * `approved` (the amount stays reserved; an earlier attempt may have reached
 * the provider) but is never sent again. Audited and logged once. The lease is
 * dropped too, so a stale worker's late finish is fenced off (keepLease).
 */
async function quarantinePayout(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  defect: ApprovalDefect,
  now: Date,
): Promise<Refund> {
  const [held] = await tx
    .update(paymentRefunds)
    .set({
      lastPayoutError: PAYOUT_QUARANTINED,
      payoutClaimedUntil: null,
      payoutClaimToken: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentRefunds.tenantId, refund.tenantId),
        eq(paymentRefunds.id, refund.id),
      ),
    )
    .returning();
  if (!held) throw new Error("refund changed under its row lock");
  await refundAudit(tx, context, {
    actorId: null,
    row: held,
    action: "payment.refund_payout_quarantined",
    now,
    reason: defect,
    before: { status: refund.status },
  });
  logger.error(
    { refundId: refund.id, defect },
    "Refund payout quarantined: approval failed re-validation; reconcile manually (never release or re-open it after paying by hand at the provider)",
  );
  return held;
}

type PayoutClaim =
  | { readonly run: false; readonly refund: Refund }
  | {
      readonly run: true;
      readonly refund: Refund;
      readonly token: string;
      /** An earlier attempt may have reached the provider: look before re-sending. */
      readonly lookupFirst: boolean;
      /** False for a quarantined refund: look the provider up, never send. */
      readonly send: boolean;
      readonly paymentProviderRef: string | null;
      /** Intent facts the refund port needs to pick credentials. */
      readonly integrationId: string | null;
      readonly outletId: string;
    };

/** Rejects when the deadline signal fires, even if the adapter ignores it. */
function withDeadline<T>(signal: AbortSignal, call: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      call.catch(() => undefined);
      return onAbort();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * A provider answer that contradicts a terminal refund moves no state; ops get
 * an audit row and an error log (ids only) to reconcile by hand.
 */
async function recordProviderConflict(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  provider: "succeeded" | "failed",
  now: Date,
): Promise<void> {
  logger.error(
    { refundId: refund.id, status: refund.status, provider },
    "Refund provider result contradicts a terminal refund; reconcile manually",
  );
  await refundAudit(tx, context, {
    actorId: null,
    row: refund,
    action: "payment.refund_provider_conflict",
    now,
    before: { status: refund.status },
    after: {
      amountIdr: refund.amountIdr,
      status: refund.status,
      providerCode: provider,
    },
  });
}

function contradicts(
  status: Refund["status"],
  provider: GatewayRefundLookup["status"],
): provider is "succeeded" | "failed" {
  return (
    (status === "failed" && provider === "succeeded") ||
    (status === "completed" && provider === "failed")
  );
}

/** A payout result never erases a quarantine flag (set by a sweep meanwhile). */
const keepQuarantine = (next: string | null) =>
  sql`CASE WHEN ${paymentRefunds.lastPayoutError} = ${PAYOUT_QUARANTINED} THEN ${PAYOUT_QUARANTINED} ELSE ${next}::text END`;

/** False while the fail-closed default port is installed (no adapter). */
function refundGatewayInstalled(): boolean {
  return paymentRefundGateway().provider !== UNCONFIGURED_REFUND_PROVIDER;
}

/**
 * Pays an `approved` refund out through the refund port. The claim lease (with a
 * fencing token) makes concurrent callers skip; the provider dedupes on
 * `refund:<id>`, so a retry after an unknown outcome can never pay twice. After
 * an earlier attempt the provider is asked first and only a `not_found` answer
 * is re-sent. A throw or timeout is NOT a failure.
 */
export async function runRefundPayout(
  context: ScopedTenantContext,
  refundId: string,
  now: Date = new Date(),
): Promise<Refund> {
  // Before any claim or write: an attempt counted against no provider would
  // make a later first send look like a possible duplicate.
  if (!refundGatewayInstalled())
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Belum ada gateway refund yang aktif. Refund akan dicoba lagi nanti.",
    );
  const token = randomUUID();
  const claim = await withTenant(
    db,
    context,
    async (tx): Promise<PayoutClaim> => {
      const [probe] = await tx
        .select({ unallocatedFundId: paymentRefunds.unallocatedFundId })
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.tenantId, context.tenant.tenantId),
            eq(paymentRefunds.id, refundId),
          ),
        );
      if (!probe) throw missing();
      // A fund refund may store its evidence mapping below: lock intent -> fund
      // -> refund like mapFundEvidence. Any other refund locks only itself.
      const [refund] = probe.unallocatedFundId
        ? [
            (await lockRefundGraph(tx, context.tenant.tenantId, refundId))
              .refund,
          ]
        : await tx
            .select()
            .from(paymentRefunds)
            .where(
              and(
                eq(paymentRefunds.tenantId, context.tenant.tenantId),
                eq(paymentRefunds.id, refundId),
              ),
            )
            .for("update");
      if (!refund) throw missing();
      if (refund.status !== "approved") return { run: false, refund };
      if (refund.payoutClaimedUntil && refund.payoutClaimedUntil > now)
        return { run: false, refund };
      // Quarantine is final for sending. A refund an earlier attempt may have
      // brought to the provider is still looked up (lookup-only), so a paid,
      // failed or pending payout settles; a never-sent one just stays held.
      const maybeSent =
        refund.payoutAttempts > 0 ||
        refund.payoutPendingPolls > 0 ||
        refund.providerRef !== null;
      let send = true;
      if (refund.lastPayoutError === PAYOUT_QUARANTINED) {
        if (!maybeSent) return { run: false, refund };
        send = false;
      } else {
        const defect = await approvalDefectOf(tx, context, refund, now);
        if (defect !== null) {
          const held = await quarantinePayout(tx, context, refund, defect, now);
          if (!maybeSent) return { run: false, refund: held };
          send = false;
        }
      }
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, refund.tenantId),
            eq(paymentIntents.id, refund.paymentIntentId),
          ),
        );
      if (!intent) throw missing();
      let paymentProviderRef = intent.providerRef;
      // Lookup-only needs no source transaction: never map or hold here. But a
      // fund refund never looks at the intent's own payment (another payment
      // of the intent could settle it by mistake): read the fund's stored
      // evidence mapping, else null.
      if (refund.unallocatedFundId && !send) {
        const [fund] = await tx
          .select({ evidenceId: paymentUnallocatedFunds.evidenceId })
          .from(paymentUnallocatedFunds)
          .where(
            and(
              eq(paymentUnallocatedFunds.tenantId, refund.tenantId),
              eq(paymentUnallocatedFunds.id, refund.unallocatedFundId),
            ),
          );
        const [evidence] = fund?.evidenceId
          ? await tx
              .select({ providerRef: paymentEvidence.providerRef })
              .from(paymentEvidence)
              .where(
                and(
                  eq(paymentEvidence.tenantId, refund.tenantId),
                  eq(paymentEvidence.paymentIntentId, refund.paymentIntentId),
                  eq(paymentEvidence.id, fund.evidenceId),
                ),
              )
          : [];
        paymentProviderRef = evidence?.providerRef ?? null;
      }
      if (refund.unallocatedFundId && send) {
        // The fund's own evidence is the transaction to refund; never the
        // intent's providerRef. A fund without one resolves only when the intent
        // has exactly one evidence row (the mapping is certain), else it holds.
        const [fund] = await tx
          .select({ evidenceId: paymentUnallocatedFunds.evidenceId })
          .from(paymentUnallocatedFunds)
          .where(
            and(
              eq(paymentUnallocatedFunds.tenantId, refund.tenantId),
              eq(paymentUnallocatedFunds.id, refund.unallocatedFundId),
            ),
          );
        const evidenceRows = await tx
          .select({
            id: paymentEvidence.id,
            providerRef: paymentEvidence.providerRef,
          })
          .from(paymentEvidence)
          .where(
            and(
              eq(paymentEvidence.tenantId, refund.tenantId),
              eq(paymentEvidence.paymentIntentId, refund.paymentIntentId),
              ...(fund?.evidenceId
                ? [eq(paymentEvidence.id, fund.evidenceId)]
                : []),
            ),
          )
          .limit(2);
        let evidence: (typeof evidenceRows)[number] | undefined;
        if (fund?.evidenceId) evidence = evidenceRows[0];
        else if (fund && evidenceRows.length === 1) {
          // The single evidence is certain only while no other fund owns it and
          // no other unmapped fund of this intent could claim it too (legacy rows).
          const [owned] = await tx
            .select({ id: paymentUnallocatedFunds.id })
            .from(paymentUnallocatedFunds)
            .where(
              and(
                eq(paymentUnallocatedFunds.tenantId, refund.tenantId),
                ne(paymentUnallocatedFunds.id, refund.unallocatedFundId),
                or(
                  eq(paymentUnallocatedFunds.evidenceId, evidenceRows[0]!.id),
                  and(
                    isNull(paymentUnallocatedFunds.evidenceId),
                    eq(
                      paymentUnallocatedFunds.paymentIntentId,
                      refund.paymentIntentId,
                    ),
                  ),
                ),
              ),
            )
            .limit(1);
          if (!owned) {
            evidence = evidenceRows[0]!;
            // Store the mapping with the send (legend-wam2): once a second
            // evidence row arrives the fallback no longer resolves, and a
            // pending payout must still be polled with this source.
            await tx
              .update(paymentUnallocatedFunds)
              .set({ evidenceId: evidence.id })
              .where(
                and(
                  eq(paymentUnallocatedFunds.tenantId, refund.tenantId),
                  eq(paymentUnallocatedFunds.id, refund.unallocatedFundId),
                  isNull(paymentUnallocatedFunds.evidenceId),
                ),
              );
            await refundAudit(tx, context, {
              actorId: null,
              row: refund,
              action: "payment.refund_fund_evidence_mapped",
              now,
              before: { evidenceId: null },
              after: { evidenceId: evidence.id },
            });
          }
        }
        if (!evidence) {
          const [held] = await tx
            .update(paymentRefunds)
            .set({ lastPayoutError: EVIDENCE_MAPPING_REQUIRED, updatedAt: now })
            .where(
              and(
                eq(paymentRefunds.tenantId, refund.tenantId),
                eq(paymentRefunds.id, refund.id),
              ),
            )
            .returning();
          if (refund.lastPayoutError !== EVIDENCE_MAPPING_REQUIRED)
            logger.warn(
              { refundId: refund.id },
              "refund payout held: fund evidence mapping required",
            );
          return { run: false, refund: held ?? refund };
        }
        paymentProviderRef = evidence.providerRef;
      }
      const [claimed] = await tx
        .update(paymentRefunds)
        .set({
          // A held refund that now resolves (one evidence row arrived) must not
          // keep reporting EVIDENCE_MAPPING_REQUIRED while its payout runs.
          lastPayoutError: sql`nullif(${paymentRefunds.lastPayoutError}, ${EVIDENCE_MAPPING_REQUIRED})`,
          payoutClaimedUntil: new Date(now.getTime() + PAYOUT_CLAIM_MS),
          payoutClaimToken: token,
          payoutAttempts: sql`${paymentRefunds.payoutAttempts} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentRefunds.tenantId, refund.tenantId),
            eq(paymentRefunds.id, refund.id),
          ),
        )
        .returning();
      if (!claimed) throw new Error("refund claim returned no row");
      return {
        run: true,
        refund: claimed,
        token,
        lookupFirst: maybeSent,
        send,
        paymentProviderRef,
        integrationId: intent.gatewayIntegrationId,
        outletId: intent.outletId,
      };
    },
  );
  if (!claim.run) return claim.refund;

  const { refund } = claim;
  const idempotencyKey = `refund:${refund.id}`;
  const port = paymentRefundGateway();
  let result = null as GatewayRefundLookup | null;
  let unknownCode: string | null = null;
  try {
    if (claim.lookupFirst) {
      const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      result = await withDeadline(
        signal,
        port.getRefundStatus({
          context,
          idempotencyKey,
          providerRef: refund.providerRef,
          paymentIntentId: refund.paymentIntentId,
          paymentProviderRef: claim.paymentProviderRef,
          integrationId: claim.integrationId,
          outletId: claim.outletId,
          amountIdr: refund.amountIdr,
          signal,
        }),
      );
    }
    // Never seen by the provider (or first attempt): send with the same key.
    // A quarantined refund is never sent.
    if (claim.send && (result === null || result.status === "not_found")) {
      const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      result = await withDeadline(
        signal,
        port.refund({
          context,
          refundId: refund.id,
          idempotencyKey,
          paymentIntentId: refund.paymentIntentId,
          paymentProviderRef: claim.paymentProviderRef,
          integrationId: claim.integrationId,
          outletId: claim.outletId,
          amountIdr: refund.amountIdr,
          reason: refund.reason,
          signal,
        }),
      );
    }
  } catch (error) {
    result = null;
    unknownCode = errorCodeOf(error);
  }

  const recordedAt = new Date();
  // Widened on purpose: the narrowing from the try block above would hide `not_found`.
  const outcome: GatewayRefundLookup | null =
    result as GatewayRefundLookup | null;
  return withTenant(db, context, async (tx) => {
    const locked = await lockRefundGraph(
      tx,
      context.tenant.tenantId,
      refund.id,
    );
    // A webhook or another worker finished it meanwhile: never downgrade a
    // terminal state; a contradicting answer is only reported.
    if (locked.refund.status !== "approved") {
      if (outcome !== null && contradicts(locked.refund.status, outcome.status))
        await recordProviderConflict(
          tx,
          context,
          locked.refund,
          outcome.status,
          recordedAt,
        );
      return locked.refund;
    }
    // A stale worker (its lease expired and another took over) may still report
    // what the provider said, but never touches the new holder's lease.
    const keepLease = locked.refund.payoutClaimToken !== claim.token;
    if (outcome === null || outcome.status === "not_found") {
      if (keepLease) return locked.refund;
      const [updated] = await tx
        .update(paymentRefunds)
        .set({
          lastPayoutError: keepQuarantine(unknownCode ?? "NOT_FOUND"),
          payoutClaimedUntil: null,
          payoutClaimToken: null,
          updatedAt: recordedAt,
        })
        .where(
          and(
            eq(paymentRefunds.tenantId, refund.tenantId),
            eq(paymentRefunds.id, refund.id),
          ),
        )
        .returning();
      return updated ?? locked.refund;
    }
    if (outcome.status === "succeeded")
      return completeRefund(
        tx,
        context,
        locked,
        outcome.providerRef,
        recordedAt,
        { keepLease },
      );
    if (outcome.status === "failed")
      return failRefund(tx, context, locked.refund, {
        reason: "provider_declined",
        action: "payment.refund_failed",
        actorId: null,
        note: null,
        providerRef: outcome.providerRef,
        code: outcome.code,
        keepLease,
        now: recordedAt,
      });
    const [updated] = await tx
      .update(paymentRefunds)
      .set({
        providerRef: outcome.providerRef,
        // The provider answered: give back the claim's attempt and count a poll.
        // Only the lease holder does: a stale worker must not undo the current
        // holder's attempt (that one may still end unknown).
        ...(keepLease
          ? {}
          : {
              payoutAttempts: sql`greatest(${paymentRefunds.payoutAttempts} - 1, 0)`,
              payoutPendingPolls: sql`${paymentRefunds.payoutPendingPolls} + 1`,
              lastPayoutError: keepQuarantine(null),
              payoutClaimedUntil: null,
              payoutClaimToken: null,
              updatedAt: recordedAt,
            }),
      })
      .where(
        and(
          eq(paymentRefunds.tenantId, refund.tenantId),
          eq(paymentRefunds.id, refund.id),
        ),
      )
      .returning();
    return updated ?? locked.refund;
  });
}

const ESCALATION_PENDING_UNAPPROVED_HOURS = 24;
const ESCALATION_PROVIDER_PENDING_HOURS = 72;
const ESCALATION_PAYOUT_STALLED_HOURS = 24;

/**
 * Marks refunds that wait too long as escalated, once per reason, and tells
 * outlet managers and finance through the notification outbox. Case
 * `pending_unapproved`: `pending` with no approval chain, aged from
 * `created_at` (default 24 h). Case `provider_pending`: `approved` with the
 * provider still answering `pending`, aged from `decided_at` (default 72 h).
 * Case `payout_stalled`: `approved` with no provider polls whose payout is
 * stuck (with a gateway: `last_payout_error` is `MANUAL_RECONCILIATION`,
 * `PAYOUT_QUARANTINED` or `EVIDENCE_MAPPING_REQUIRED`; without a gateway: any
 * such refund, since nothing will pay it), aged from `payout_stall_detected_at`
 * (default 24 h). That stall clock is owned here: it is stamped when a stall is
 * first seen and cleared when the refund is no longer stalled. Polls never
 * decrease, so `payout_stalled` and `provider_pending` cannot alternate.
 * Thresholds are per tenant (`payment_refund_escalation_settings`). It writes
 * only `payout_stall_detected_at`, `escalated_at` and `escalation_reason`: it
 * never cancels, pays, or touches `status`, `updated_at` (the payout backoff
 * reads it) or any payout column. Returns the number of refunds escalated.
 */
export async function escalateStaleRefunds(
  context: ScopedTenantContext,
  now: Date = new Date(),
  limit = 100,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [settings] = await tx
      .select()
      .from(paymentRefundEscalationSettings)
      .where(eq(paymentRefundEscalationSettings.tenantId, tenantId));
    const gatewayInstalled = refundGatewayInstalled();
    // coalesce keeps NOT(stalled) two-valued when last_payout_error is NULL.
    const stalled = and(
      eq(paymentRefunds.status, "approved"),
      sql`${paymentRefunds.payoutPendingPolls} = 0`,
      gatewayInstalled
        ? sql`coalesce(${paymentRefunds.lastPayoutError}, '') IN (${sql.join(
            [
              MANUAL_RECONCILIATION,
              PAYOUT_QUARANTINED,
              EVIDENCE_MAPPING_REQUIRED,
            ].map((value) => sql`${value}`),
            sql`, `,
          )})`
        : undefined,
    );
    // Stall clock: reset where no longer stalled, then stamp where newly stalled.
    const resetGuard = and(
      eq(paymentRefunds.tenantId, tenantId),
      sql`${paymentRefunds.payoutStallDetectedAt} IS NOT NULL`,
      sql`NOT (${stalled})`,
    );
    const stampGuard = and(
      eq(paymentRefunds.tenantId, tenantId),
      stalled,
      isNull(paymentRefunds.payoutStallDetectedAt),
      sql`${paymentRefunds.escalationReason} IS DISTINCT FROM 'payout_stalled'`,
    );
    for (const [guard, value] of [
      [resetGuard, null],
      [stampGuard, now],
    ] as const) {
      const rows = await tx
        .select({ id: paymentRefunds.id })
        .from(paymentRefunds)
        .where(guard)
        .orderBy(asc(paymentRefunds.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) continue;
      await tx
        .update(paymentRefunds)
        .set({ payoutStallDetectedAt: value })
        .where(
          and(
            guard,
            inArray(
              paymentRefunds.id,
              rows.map((row) => row.id),
            ),
          ),
        );
    }
    const cases = [
      {
        reason: "pending_unapproved",
        hours:
          settings?.pendingUnapprovedHours ??
          ESCALATION_PENDING_UNAPPROVED_HOURS,
        age: sql`${paymentRefunds.createdAt}`,
        stale: and(
          eq(paymentRefunds.status, "pending"),
          isNull(paymentRefunds.approvalChainId),
          isNull(paymentRefunds.escalatedAt),
        ),
      },
      {
        reason: "provider_pending",
        hours:
          settings?.providerPendingHours ?? ESCALATION_PROVIDER_PENDING_HOURS,
        age: sql`coalesce(${paymentRefunds.decidedAt}, ${paymentRefunds.createdAt})`,
        stale: and(
          eq(paymentRefunds.status, "approved"),
          sql`${paymentRefunds.payoutPendingPolls} > 0`,
          sql`${paymentRefunds.escalationReason} IS DISTINCT FROM 'provider_pending'`,
        ),
      },
      {
        reason: "payout_stalled",
        hours: settings?.payoutStalledHours ?? ESCALATION_PAYOUT_STALLED_HOURS,
        age: sql`${paymentRefunds.payoutStallDetectedAt}`,
        stale: and(
          stalled,
          sql`${paymentRefunds.payoutStallDetectedAt} IS NOT NULL`,
          sql`${paymentRefunds.escalationReason} IS DISTINCT FROM 'payout_stalled'`,
        ),
      },
    ] as const;
    let escalated = 0;
    for (const item of cases) {
      const guard = and(
        eq(paymentRefunds.tenantId, tenantId),
        item.stale,
        sql`${item.age} + ${item.hours} * interval '1 hour' <= ${now}`,
      );
      const candidates = await tx
        .select({
          id: paymentRefunds.id,
          before: paymentRefunds.escalationReason,
          beforeAt: paymentRefunds.escalatedAt,
          waitingSince: sql<Date>`${item.age}`,
        })
        .from(paymentRefunds)
        .where(guard)
        .orderBy(asc(item.age), asc(paymentRefunds.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (candidates.length === 0) continue;
      const updated = await tx
        .update(paymentRefunds)
        .set({ escalatedAt: now, escalationReason: item.reason })
        .where(
          and(
            guard,
            inArray(
              paymentRefunds.id,
              candidates.map((row) => row.id),
            ),
          ),
        )
        .returning();
      const before = new Map(candidates.map((row) => [row.id, row]));
      for (const row of updated) {
        const candidate = before.get(row.id);
        await refundAudit(tx, context, {
          actorId: null,
          row,
          action: "payment.refund_escalated",
          now,
          reason: null,
          before: {
            escalationReason: candidate?.before ?? null,
            escalatedAt: candidate?.beforeAt?.toISOString() ?? null,
          },
          after: {
            escalationReason: item.reason,
            escalatedAt: now.toISOString(),
            status: row.status,
            thresholdHours: item.hours,
          },
        });
        await emitOperationsEvent(tx, context, paymentRefundEscalatedEvent, {
          aggregateId: row.id,
          outletId: row.outletId,
          actor: { type: "system" },
          payload: {
            refundId: row.id,
            outletId: row.outletId,
            amountIdr: row.amountIdr,
            reason: item.reason,
            waitingSince: new Date(
              candidate?.waitingSince ?? row.createdAt,
            ).toISOString(),
            thresholdHours: item.hours,
            escalatedAt: now.toISOString(),
          },
          destination: OPERATIONS_NOTIFICATION_DESTINATION,
          now,
        });
        escalated += 1;
      }
    }
    return escalated;
  });
}

/**
 * Worker sweep for `approved` refunds whose payout is not finished: lease free,
 * oldest first, with backoff by attempts (2^attempts minutes, at most an hour
 * after the last attempt; provider `pending` polls back off on their own
 * counter). After `PAYOUT_MAX_ATTEMPTS` unknown outcomes, or a `pending` answer
 * older than 72 hours, the refund stays `approved`, is flagged
 * `MANUAL_RECONCILIATION` and logged for ops. A round stops claiming new
 * refunds once `budgetMs` is spent. First it escalates refunds that wait too
 * long or whose payout is stalled (`escalateStaleRefunds`, also without a
 * gateway); a failure there is logged and never blocks payouts.
 */
export async function sweepApprovedRefundPayouts(
  context: ScopedTenantContext,
  now: Date = new Date(),
  limit = PAYOUT_SWEEP_BATCH,
  budgetMs = PAYOUT_SWEEP_BUDGET_MS,
  /** Checked before each claim (worker shutdown): stop starting new payouts. */
  shouldStop: () => boolean = () => false,
): Promise<{ attempted: number; exhausted: number; escalated: number }> {
  let escalated = 0;
  try {
    escalated = await escalateStaleRefunds(context, now);
  } catch {
    logger.warn(
      { tenantId: context.tenant.tenantId },
      "Refund escalation sweep failed",
    );
  }
  // No gateway: claim nothing and flag nothing (see runRefundPayout).
  if (!refundGatewayInstalled())
    return { attempted: 0, exhausted: 0, escalated };
  const tenantId = context.tenant.tenantId;
  const leaseFree = sql`(${paymentRefunds.payoutClaimedUntil} IS NULL OR ${paymentRefunds.payoutClaimedUntil} <= ${now})`;
  const decidedAtOrCreated = sql`coalesce(${paymentRefunds.decidedAt}, ${paymentRefunds.createdAt})`;
  const pendingTooLong = sql`(${paymentRefunds.payoutPendingPolls} > 0 AND ${decidedAtOrCreated} + ${PAYOUT_PENDING_MAX_HOURS} * interval '1 hour' <= ${now})`;
  const { due, exhausted } = await withTenant(db, context, async (tx) => {
    const due = await tx
      .select({ id: paymentRefunds.id, outletId: paymentRefunds.outletId })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.status, "approved"),
          sql`${paymentRefunds.payoutAttempts} < ${PAYOUT_MAX_ATTEMPTS}`,
          sql`NOT ${pendingTooLong}`,
          // A quarantined refund is swept only for its lookup (maybe sent).
          sql`(${paymentRefunds.lastPayoutError} IS DISTINCT FROM ${PAYOUT_QUARANTINED} OR ${paymentRefunds.payoutAttempts} > 0 OR ${paymentRefunds.providerRef} IS NOT NULL OR ${paymentRefunds.payoutPendingPolls} > 0)`,
          leaseFree,
          sql`${paymentRefunds.updatedAt} + least(power(2, ${paymentRefunds.payoutAttempts} + ${paymentRefunds.payoutPendingPolls}), ${PAYOUT_BACKOFF_CAP_MINUTES}) * interval '1 minute' <= ${now}`,
        ),
      )
      .orderBy(asc(paymentRefunds.updatedAt), asc(paymentRefunds.id))
      .limit(limit);
    const exhausted = await tx
      .update(paymentRefunds)
      .set({ lastPayoutError: MANUAL_RECONCILIATION })
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.status, "approved"),
          sql`(${paymentRefunds.payoutAttempts} >= ${PAYOUT_MAX_ATTEMPTS} OR ${pendingTooLong})`,
          leaseFree,
          sql`${paymentRefunds.lastPayoutError} IS DISTINCT FROM ${MANUAL_RECONCILIATION}`,
          // A quarantine keeps its own (more specific) flag.
          sql`${paymentRefunds.lastPayoutError} IS DISTINCT FROM ${PAYOUT_QUARANTINED}`,
        ),
      )
      .returning({ id: paymentRefunds.id });
    return { due, exhausted };
  });
  for (const row of exhausted)
    logger.error(
      { refundId: row.id },
      "Refund payout gave up after repeated attempts; reconcile manually",
    );
  let attempted = 0;
  // Each payout may take up to a minute: advance the (possibly injected) clock
  // by the real elapsed time so a later row's lease is not born expired.
  const started = Date.now();
  for (const row of due) {
    if (shouldStop() || Date.now() - started >= budgetMs) break;
    try {
      await runRefundPayout(
        outletContext(context.tenant, row.outletId),
        row.id,
        new Date(now.getTime() + (Date.now() - started)),
      );
      attempted += 1;
    } catch {
      // Ids only: one broken refund must not stop the batch.
      logger.warn({ refundId: row.id }, "Refund payout sweep attempt failed");
    }
  }
  return { attempted, exhausted: exhausted.length, escalated };
}

const quarantined = () =>
  new HttpError(
    409,
    "PAYOUT_QUARANTINED",
    "Refund approval failed re-validation; it cannot be paid out. Reconcile it manually; after paying by hand at the provider, never release or re-open it.",
  );

export async function retryRefundPayout(
  context: ScopedTenantContext,
  actor: string,
  params: { refundId: string; sourceEvidenceId?: string },
  key: string,
) {
  // The provider key is `refund:<id>`, so a retry is naturally idempotent.
  void key;
  // Before the evidence mapping below writes anything.
  if (!refundGatewayInstalled())
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Belum ada gateway refund yang aktif. Refund akan dicoba lagi nanti.",
    );
  await withTenant(db, context, async (tx) => {
    const [refund] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, params.refundId),
        ),
      );
    if (!refund) throw missing();
    await authorize(tx, context, actor, "payment.reconcile", refund.outletId);
    if (refund.status !== "approved")
      throw conflict("Only an approved refund can be retried.");
    if (refund.lastPayoutError === PAYOUT_QUARANTINED) {
      // A maybe-sent quarantined refund runs lookup-only; nothing to map.
      const maybeSent =
        refund.payoutAttempts > 0 ||
        refund.payoutPendingPolls > 0 ||
        refund.providerRef !== null;
      if (!maybeSent) throw quarantined();
      return;
    }
    if (params.sourceEvidenceId)
      await mapFundEvidence(
        tx,
        context,
        actor,
        refund,
        params.sourceEvidenceId,
      );
  });
  const result = await runRefundPayout(context, params.refundId);
  if (
    result.status === "approved" &&
    result.lastPayoutError === PAYOUT_QUARANTINED
  )
    throw quarantined();
  if (
    result.status === "approved" &&
    result.lastPayoutError === EVIDENCE_MAPPING_REQUIRED
  )
    throw new HttpError(
      409,
      "EVIDENCE_MAPPING_REQUIRED",
      "Map the fund to its source evidence (sourceEvidenceId) before retrying.",
    );
  return loadView(context, params.refundId, actor);
}

// ------------------------------------------- quarantine ops (legend-e8z5)

/** An earlier attempt may have reached the provider (lookup-only settles it). */
function maybeSentOf(refund: Refund): boolean {
  return (
    refund.payoutAttempts > 0 ||
    refund.payoutPendingPolls > 0 ||
    refund.providerRef !== null
  );
}

type QuarantineAction = "release" | "reopen";

/**
 * Withdraws the refund's own still-pending chain. Only a chain bound to this
 * refund (chainBound): a chain id pointing at another refund's live chain
 * (`chain_unbound`) is left alone, or that refund would fail as expired.
 */
async function cancelOwnOpenChain(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  actor: string,
  now: Date,
): Promise<void> {
  if (refund.approvalChainId === null) return;
  const rows = await chainRowsOf(tx, refund.tenantId, refund.approvalChainId);
  if (
    !chainBound(rows, refund) ||
    !rows.some((row) => row.status === "pending")
  )
    return;
  await cancelApprovalRequest(tx, context, {
    chainId: refund.approvalChainId,
    sourceModule: REFUND_SOURCE_MODULE,
    actorUserId: actor,
    now,
  });
}

/**
 * Ops action on a never-sent quarantined refund, which otherwise reserves its
 * amount forever. `release` ends it `failed` (`approver_unauthorized`, frees
 * the amount); `reopen` returns it to `pending` without its approval, so the
 * normal approve/reject flow (matrix, supervisor, MFA, distinct actor) decides
 * it again; the old chain stays as history. Both first cancel the refund's
 * own still-pending level (its approval.resolved then settles nothing: the
 * refund is failed or no longer points at it). A maybe-sent refund is refused: it
 * still settles through its provider lookup. Never use either after ops paid
 * the customer by hand at the provider.
 *
 * Under the intent -> fund -> refund locks. The actor checks (payment.reconcile,
 * pos.refund.approve at the outlet, not the requester, MFA on the dashboard)
 * run before the idempotent write; the state checks inside it, so a same-key
 * replay returns the stored result instead of a 409.
 */
async function actOnQuarantine(
  context: ScopedTenantContext,
  actor: string,
  refundId: string,
  action: QuarantineAction,
  note: string,
  key: string,
  opts: DecideOptions,
) {
  const now = new Date();
  await withTenant(db, context, async (tx) => {
    const locked = await lockRefundGraph(tx, context.tenant.tenantId, refundId);
    const { refund } = locked;
    await authorize(tx, context, actor, "payment.reconcile", refund.outletId);
    if (
      !(await holdsPermission(
        tx,
        context,
        actor,
        SUPERVISOR_PERMISSION,
        refund.outletId,
        now,
      ))
    )
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot perform this action.",
      );
    if (actor.toLowerCase() === refund.requestedBy.toLowerCase())
      throw new AccessError("APPROVER_IS_REQUESTER");
    const access = await loadTenantAccessInTransaction(tx, context, actor);
    assertSurfaceAccess({
      principal: {
        tenantId: context.tenant.tenantId,
        userId: userIdSchema.parse(actor),
        assignments: access.assignments,
      },
      roles: access.roles,
      surface: "dashboard",
      mfaVerified: opts.mfaVerified,
      now,
    });
    return idempotentPaymentAdminWrite(
      tx,
      context,
      actor,
      key,
      `refund.quarantine_${action}`,
      { refundId: refund.id, note },
      async () => {
        if (
          refund.status !== "approved" ||
          refund.lastPayoutError !== PAYOUT_QUARANTINED
        )
          throw new HttpError(
            409,
            "REFUND_NOT_QUARANTINED",
            "Only an approved refund held by the payout quarantine can be released or re-opened.",
          );
        if (maybeSentOf(refund))
          throw new HttpError(
            409,
            "REFUND_PAYOUT_MAYBE_SENT",
            "A payout attempt may have reached the provider; the provider lookup settles this refund.",
          );
        const defect = await approvalDefectOf(tx, context, refund, now);
        // Its own chain still open (never resolved) would block a new one
        // and leave a level in the inbox.
        await cancelOwnOpenChain(tx, context, refund, actor, now);
        if (action === "release") {
          await failRefund(tx, context, refund, {
            reason: "approver_unauthorized",
            action: "payment.refund_quarantine_released",
            actorId: actor,
            note,
            detail: { defect },
            now,
          });
          return { action };
        }
        const [reopened] = await tx
          .update(paymentRefunds)
          .set({
            status: "pending",
            approvedBy: null,
            decidedAt: null,
            approvalChainId: null,
            lastPayoutError: null,
            payoutClaimedUntil: null,
            payoutClaimToken: null,
            payoutStallDetectedAt: null,
            // A reopened refund starts a new wait: it may escalate again (legend-n9kn).
            escalatedAt: null,
            escalationReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(paymentRefunds.tenantId, refund.tenantId),
              eq(paymentRefunds.id, refund.id),
              eq(paymentRefunds.status, "approved"),
              eq(paymentRefunds.lastPayoutError, PAYOUT_QUARANTINED),
              eq(paymentRefunds.payoutAttempts, 0),
              eq(paymentRefunds.payoutPendingPolls, 0),
              isNull(paymentRefunds.providerRef),
            ),
          )
          .returning();
        if (!reopened) throw new Error("refund changed under its row lock");
        await refundAudit(tx, context, {
          actorId: actor,
          row: reopened,
          action: "payment.refund_quarantine_reopened",
          now,
          reason: note,
          before: {
            status: refund.status,
            approvalChainId: refund.approvalChainId,
            approvedBy: refund.approvedBy,
            decidedAt: refund.decidedAt?.toISOString() ?? null,
            defect,
          },
          after: { amountIdr: reopened.amountIdr, status: reopened.status },
        });
        return { action };
      },
    );
  });
  return loadView(context, refundId, actor);
}

export async function releaseQuarantinedRefund(
  context: ScopedTenantContext,
  actor: string,
  params: { refundId: string },
  input: contract.QuarantinedRefundActionInput,
  key: string,
  opts: DecideOptions,
) {
  return actOnQuarantine(
    context,
    actor,
    params.refundId,
    "release",
    input.note.trim(),
    key,
    opts,
  );
}

export async function reopenQuarantinedRefund(
  context: ScopedTenantContext,
  actor: string,
  params: { refundId: string },
  input: contract.QuarantinedRefundActionInput,
  key: string,
  opts: DecideOptions,
) {
  return actOnQuarantine(
    context,
    actor,
    params.refundId,
    "reopen",
    input.note.trim(),
    key,
    opts,
  );
}

function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || isUniqueViolation(candidate.cause, depth + 1)
  );
}

/** Maps an unmapped fund to the evidence it came from, once (no remapping). */
async function mapFundEvidence(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  refund: Refund,
  evidenceId: string,
) {
  const now = new Date();
  const tenantId = refund.tenantId;
  if (!refund.unallocatedFundId)
    throw conflict("Refund is not paid from an unallocated fund.");
  // Lock the intent first (same order as lockRefundGraph): every fund that could
  // claim this evidence belongs to it, so two mappings to one evidence serialize
  // and the "used by another fund" check below cannot race.
  const [intent] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, refund.paymentIntentId),
      ),
    )
    .for("update");
  if (!intent) throw missing();
  const [fund] = await tx
    .select()
    .from(paymentUnallocatedFunds)
    .where(
      and(
        eq(paymentUnallocatedFunds.tenantId, tenantId),
        eq(paymentUnallocatedFunds.id, refund.unallocatedFundId),
      ),
    )
    .for("update");
  if (!fund) throw missing();
  const [evidence] = await tx
    .select({ id: paymentEvidence.id })
    .from(paymentEvidence)
    .where(
      and(
        eq(paymentEvidence.tenantId, tenantId),
        eq(paymentEvidence.paymentIntentId, refund.paymentIntentId),
        eq(paymentEvidence.id, evidenceId),
      ),
    );
  if (!evidence) throw conflict("Evidence does not belong to this payment.");
  if (fund.evidenceId === evidenceId) return;
  if (fund.evidenceId) throw conflict("Fund is already mapped to evidence.");
  const [used] = await tx
    .select({ id: paymentUnallocatedFunds.id })
    .from(paymentUnallocatedFunds)
    .where(
      and(
        eq(paymentUnallocatedFunds.tenantId, tenantId),
        eq(paymentUnallocatedFunds.evidenceId, evidenceId),
        ne(paymentUnallocatedFunds.id, fund.id),
      ),
    )
    .limit(1);
  if (used) throw conflict("Evidence is already mapped to another fund.");
  try {
    await tx
      .update(paymentUnallocatedFunds)
      .set({ evidenceId })
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, tenantId),
          eq(paymentUnallocatedFunds.id, fund.id),
        ),
      );
  } catch (error) {
    // payment_unallocated_funds_evidence_key: the backstop for the check above.
    if (isUniqueViolation(error))
      throw conflict("Evidence is already mapped to another fund.");
    throw error;
  }
  // Lock the refund (after intent and fund, the lockRefundGraph order) so the
  // audit's escalation `before` is the row this update really changes.
  const [current] = await tx
    .select({ escalationReason: paymentRefunds.escalationReason })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.id, refund.id),
      ),
    )
    .for("update");
  const [cleared] = await tx
    .update(paymentRefunds)
    .set({
      lastPayoutError: null,
      // Ops resolved the stall: a later stall is a new wait and alerts again,
      // like a quarantine reopen (legend-ix8i). Other reasons stay.
      payoutStallDetectedAt: null,
      escalatedAt: sql`CASE WHEN ${paymentRefunds.escalationReason} = 'payout_stalled' THEN NULL ELSE ${paymentRefunds.escalatedAt} END`,
      escalationReason: sql`CASE WHEN ${paymentRefunds.escalationReason} = 'payout_stalled' THEN NULL ELSE ${paymentRefunds.escalationReason} END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.id, refund.id),
        eq(paymentRefunds.lastPayoutError, EVIDENCE_MAPPING_REQUIRED),
      ),
    )
    .returning();
  await refundAudit(tx, context, {
    actorId: actor,
    row: cleared ?? refund,
    action: "payment.refund_fund_evidence_mapped",
    now,
    before: {
      evidenceId: null,
      escalationReason: current?.escalationReason ?? refund.escalationReason,
    },
    after: {
      evidenceId,
      escalationReason: cleared
        ? cleared.escalationReason
        : (current?.escalationReason ?? refund.escalationReason),
    },
  });
}

// ------------------------------------------------- provider webhook / poll

const PROVIDER_KEY =
  /^refund:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type RefundProviderUpdate = {
  readonly providerRef?: string;
  readonly idempotencyKey?: string;
  readonly status: "succeeded" | "failed";
  readonly code?: string;
  readonly amountIdr?: number;
};

/**
 * Applies an asynchronous provider result (webhook or poll). Only an `approved`
 * refund transitions; a replay of the same terminal state is a no-op and a
 * contradicting update is refused without any write.
 */
export async function applyRefundProviderUpdate(
  context: ScopedTenantContext,
  update: RefundProviderUpdate,
  now: Date = new Date(),
) {
  const keyedId = update.idempotencyKey
    ? PROVIDER_KEY.exec(update.idempotencyKey)?.[1]
    : undefined;
  if (!update.providerRef && !keyedId) throw missing();
  const refundId = await withTenant(db, context, async (tx) => {
    const found = await tx
      .select({ id: paymentRefunds.id })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          keyedId
            ? eq(paymentRefunds.id, keyedId.toLowerCase())
            : eq(paymentRefunds.providerRef, update.providerRef!),
        ),
      )
      .limit(2);
    // A provider reference must identify exactly one refund.
    if (found.length > 1) throw conflict("Provider reference is ambiguous.");
    return found[0]?.id ?? null;
  });
  if (refundId === null) throw missing();

  // The provider result is authoritative: applied under the refund lock, so an
  // in-flight payout then finds a terminal state and records nothing. A
  // contradiction is audited and committed first, then refused.
  const refused = await withTenant(db, context, async (tx) => {
    const locked = await lockRefundGraph(tx, context.tenant.tenantId, refundId);
    const { refund } = locked;
    // Never re-point a refund at another provider transaction.
    if (
      refund.providerRef &&
      update.providerRef &&
      refund.providerRef !== update.providerRef
    )
      throw conflict("Provider reference does not match the refund.");
    if (update.amountIdr !== undefined && update.amountIdr !== refund.amountIdr)
      throw conflict("Provider amount does not match the refund.");
    if (contradicts(refund.status, update.status)) {
      await recordProviderConflict(tx, context, refund, update.status, now);
      return "Refund is not awaiting a provider result.";
    }
    if (update.status === "succeeded") {
      if (refund.status === "completed") return null;
      if (refund.status !== "approved")
        throw conflict("Refund is not awaiting a provider result.");
      const providerRef = update.providerRef ?? refund.providerRef;
      if (!providerRef) throw conflict("Provider reference is required.");
      await completeRefund(tx, context, locked, providerRef, now);
      return null;
    }
    if (
      refund.status === "failed" &&
      refund.failureReason === "provider_declined"
    )
      return null;
    if (refund.status !== "approved")
      throw conflict("Refund is not awaiting a provider result.");
    await failRefund(tx, context, refund, {
      reason: "provider_declined",
      action: "payment.refund_failed",
      actorId: null,
      note: null,
      providerRef: update.providerRef ?? null,
      code: update.code,
      now,
    });
    return null;
  });
  if (refused !== null) throw conflict(refused);
  return loadView(context, refundId);
}

// ------------------------------------------------------------- consumer

/** Envelope as the worker hands it to `deliverEvent`. */
export type DomainEvent = EventEnvelope;

function sourceModuleOf(event: DomainEvent): unknown {
  const payload: unknown = event.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>).sourceModule
    : undefined;
}

function refuse(message: string): never {
  // No payload, ids only in the message the outbox stores as lastError.
  throw new CoreError("VALIDATION_ERROR", message);
}

/**
 * `approval.resolved` consumer for refund chains (like the POS override one):
 * re-reads the chain from the database and settles the refund (status
 * transition only, no provider call). Ignores other events and source modules;
 * throws (no write) on a malformed or foreign refund event. Replay safe.
 */
export async function handleRefundApprovalResolved(
  context: ScopedTenantContext,
  event: DomainEvent,
  now: Date = new Date(),
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  if (sourceModuleOf(event) !== REFUND_SOURCE_MODULE) return;
  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success)
    refuse("approval.resolved for payment has an unknown shape");
  const resolved = parsed.data;
  if (resolved.tenantId.toLowerCase() !== context.tenant.tenantId.toLowerCase())
    refuse("approval.resolved tenant does not match the worker context");
  // Other payment approvals are not ours.
  if (resolved.payload.objectType !== REFUND_OBJECT_TYPE) return;
  if (resolved.outletId === null)
    refuse("approval.resolved for payment_refund has no outlet");
  const scoped = outletContext(context.tenant, resolved.outletId);

  const owner = await withTenant(db, scoped, async (tx) => {
    const [row] = await tx
      .select({ id: paymentRefunds.id })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.approvalChainId, resolved.payload.chainId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  // Never opened by a refund of ours (or at another outlet): nothing to settle.
  if (owner === null) return;
  if (owner.id.toLowerCase() !== resolved.payload.objectId.toLowerCase())
    refuse("approval.resolved chain belongs to another refund");

  // Settle only: the payout is started by the approve call or the payout sweep,
  // never from an event (a provider call must not sit inside event delivery).
  await settleRefundFromChain(scoped, owner.id, now);
}
