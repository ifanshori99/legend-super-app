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
// bill authority group -> POS order (if linked) -> payment intent ->
// unallocated fund -> refund; the payout claim transaction locks only the
// refund, or that same chain for a fund refund (a
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
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
import {
  approvalPolicies,
  approvalRequests,
  paymentEvidence,
  paymentIntents,
  paymentRefundEscalationSettings,
  paymentRefunds,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import { HttpError } from "../lib/http-error.ts";
import { SYSTEM_ACCOUNT_ID } from "../lib/system-account.ts";
import {
  emitOperationsEvent,
  OPERATIONS_NOTIFICATION_DESTINATION,
} from "./operations-events.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import {
  assertNotProviderRefunded,
  providerRefundedBlocks,
  refundBlockedByProviderRefundSql,
} from "./payment-provider-refunded-guard.ts";
import { failedRefundHoldsOrderSql } from "./payment-refund-failed-open.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import {
  lockRefundApprovalScope,
  refundApprovalDecisionTime,
  refundApprovalLimitRefused,
  refundApprovalWithinLimit,
} from "./payment-refund-approval-limits.ts";
import {
  authorize,
  conflict,
  hasSourceDocument,
  missing,
  posSaleInUseRefused,
  qrSaleInUseRefused,
  refundableBalance,
  refundAudit,
  refundView,
  refundViewFor,
  type Intent,
  type Refund,
} from "./payment-admin.service.ts";
import {
  paymentRefundGatewayFor,
  paymentRefundGatewayLegacyMode,
  registeredRefundProviders,
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
  type OpenApprovalRequestInput,
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
/**
 * Deadline of a chain opened when the refund is requested (legend-zi9o): the
 * approver may be a supervisor who is off today, so it gets the longest window
 * the approval service allows (7 days). The decide-time lazy open keeps
 * REFUND_DEADLINE_MINUTES.
 */
const REFUND_REQUEST_DEADLINE_MINUTES = 10080;
/**
 * Requester of the approval chain of a refund the system created (legend-2dnh).
 * A reserved, banned user row without account or roles (migration 0144): it
 * satisfies the requested_by foreign key, can never sign in, and can never
 * decide (decided_by <> requested_by).
 */
export const SYSTEM_APPROVAL_REQUESTER = userIdSchema.parse(SYSTEM_ACCOUNT_ID);
/** Pre-deploy pending refunds opened per tenant by one sweep round. */
const OPEN_PENDING_CHAINS_BATCH = 50;
/**
 * Lock wait of one backfill candidate: a refund whose intent, fund or refund row
 * is held elsewhere (a payout, a webhook, a decision) is skipped for this round
 * instead of holding up the rest of the backfill and the payouts after it.
 */
const OPEN_PENDING_CHAINS_LOCK_TIMEOUT_MS = 2_000;
/**
 * Rotating cursor of the backfill, per tenant: the (created_at, id) of the last
 * refund tried. The next round starts after it, so refunds whose chain can never
 * open do not take every batch and starve newer ones. Process memory only: a
 * restart starts again from the oldest, which is safe (the backfill is idempotent).
 */
const pendingChainCursor = new Map<string, { createdAt: string; id: string }>();

/** Test hook: forget the backfill cursor of one tenant (or all). */
export function resetPendingRefundChainCursor(tenantId?: string): void {
  if (tenantId === undefined) pendingChainCursor.clear();
  else pendingChainCursor.delete(tenantId);
}
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
/**
 * Marker of a `completed` refund finance paid by hand (settleRefundManually,
 * legend-xd2q): no provider payout ever ran, so a later provider success on
 * it means the customer was paid twice (recorded as a conflict).
 */
export const SETTLED_OUTSIDE_PROVIDER = "SETTLED_OUTSIDE_PROVIDER";
/**
 * The provider has no record of a refund an earlier attempt may have sent
 * (legend-xd2q). It is never sent again: lookups continue, a later `pending`
 * answer clears the flag, and ops close it with settle-manually once paid.
 */
export const PAYOUT_NOT_FOUND_MAYBE_SENT = "PAYOUT_NOT_FOUND_MAYBE_SENT";
/**
 * The provider answered the refund POST, but for another payment, amount or
 * idempotency key (legend-r7g2). Money may have moved: never re-sent, never
 * replaced by MANUAL_RECONCILIATION, escalated; ops check the provider
 * dashboard before any settle-manually (the provider ids are in the error log;
 * the audit masks them and keeps status and amount).
 */
export const PAYOUT_IDENTITY_MISMATCH = "DOIT_REFUND_IDENTITY_MISMATCH";

type Fund = typeof paymentUnallocatedFunds.$inferSelect;
type Locked = { intent: Intent; fund: Fund | null; refund: Refund };
type DecideOptions = { readonly mfaVerified: boolean };

/**
 * The reopen marker lives in audit_2y, which is deleted after 2 years. A refund
 * older than this (a margin under 730 days) can no longer prove it was never
 * reopened, so its single-approver decision is treated fail-closed and needs
 * MFA even without an audit row (legend-tx8x).
 */
const REOPEN_AUDIT_RETENTION_DAYS = 700;

// ------------------------------------------------------------------ locks

/** Locks authority group -> POS order -> intent -> fund -> refund, then re-reads. */
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
  // The ceiling is cumulative across intents of one bill. Lock the shared
  // document before individual intent/fund/refund rows and approval chains.
  await lockRefundApprovalScope(tx, tenantId, probe.paymentIntentId);
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
 * Four-eyes for a gateway refund the system filed itself. `system:pos` (key
 * `pos-refund-gateway:<posRefundId>:<intentId>`): the cashier and the approver
 * of the POS refund must not also approve its payout. `system:recovery` (key
 * `order-recovery-refund:<orderIssueId>`, legend-94q2l): the approver of the
 * failed-item refund (ORD-09) and the resolver who filed it. Fails closed: a
 * filed refund whose parties cannot be read counts everyone as a party.
 */
async function isPosRefundParty(
  tx: Tx,
  refund: Refund,
  userId: string,
): Promise<boolean> {
  if (refund.requestedBy === "system:recovery")
    return isRecoveryRefundParty(tx, refund, userId);
  // Only the POS filer (pos-refund-gateway.ts) writes these keys.
  if (refund.requestedBy !== "system:pos") return false;
  const { rows } = await tx.execute<{ key: string }>(
    sql`SELECT key FROM payment_admin_idempotency
        WHERE tenant_id = ${refund.tenantId}
          AND key LIKE 'pos-refund-gateway:%'
          AND response->>'refundId' = ${refund.id}`,
  );
  for (const { key } of rows) {
    const posRefundId = key.split(":")[1] ?? "";
    const { rows: parties } = UUID_PATTERN.test(posRefundId)
      ? await tx.execute<{ requested_by: string; approved_by: string }>(
          sql`SELECT requested_by, approved_by FROM pos_order_refunds
              WHERE tenant_id = ${refund.tenantId} AND id = ${posRefundId}`,
        )
      : { rows: [] };
    const party = parties[0];
    if (
      !party ||
      [party.requested_by, party.approved_by].some(
        (user) => user.toLowerCase() === userId.toLowerCase(),
      )
    )
      return true;
  }
  return false;
}

/**
 * system:recovery refund (legend-94q2l): parties are the approver recorded on
 * the order issue, every decider of the issue's ORD-09 approval chain, plus the
 * resolver and approver kept on the idempotency row that opened the refund.
 * Any missing piece makes everyone a party.
 */
async function isRecoveryRefundParty(
  tx: Tx,
  refund: Refund,
  userId: string,
): Promise<boolean> {
  const who = userId.toLowerCase();
  if (!refund.orderIssueId) return true;
  const { rows: issues } = await tx.execute<{ approved_by: string | null }>(
    sql`SELECT approved_by FROM order_issues
        WHERE tenant_id = ${refund.tenantId} AND id = ${refund.orderIssueId}`,
  );
  const issue = issues[0];
  if (!issue?.approved_by || issue.approved_by.toLowerCase() === who)
    return true;
  // Every decider of every ORD-09 approval level of the issue: the issue keeps
  // only the last approver, an earlier level counts as a party too. The chain
  // is found through the issue's approval_request_id and through the rows that
  // name the issue as their object.
  const { rows: deciders } = await tx.execute<{ decided_by: string }>(
    sql`SELECT decided_by FROM approval_requests
        WHERE tenant_id = ${refund.tenantId}
          AND decided_by IS NOT NULL
          AND (chain_id IN (
                 SELECT a.chain_id FROM approval_requests a
                 JOIN order_issues i
                   ON i.tenant_id = a.tenant_id AND i.approval_request_id = a.id
                 WHERE i.tenant_id = ${refund.tenantId}
                   AND i.id = ${refund.orderIssueId})
               OR (object_type = 'order_issue'
                   AND object_id = ${refund.orderIssueId}::text))`,
  );
  if (deciders.some((row) => row.decided_by.toLowerCase() === who)) return true;
  const { rows } = await tx.execute<{
    resolved_by: string | null;
    approved_by: string | null;
  }>(
    sql`SELECT response->>'resolvedBy' AS resolved_by,
               response->>'approvedBy' AS approved_by
        FROM payment_admin_idempotency
        WHERE tenant_id = ${refund.tenantId}
          AND (key = ${`order-recovery-refund:${refund.orderIssueId}`}
               OR key LIKE ${`order-recovery-refund:${refund.orderIssueId}:%`})
          AND response->>'refundId' = ${refund.id}`,
  );
  if (rows.length === 0) return true;
  return rows.some(
    (row) =>
      !row.resolved_by ||
      !row.approved_by ||
      [row.resolved_by, row.approved_by].some(
        (party) => party.toLowerCase() === who,
      ),
  );
}

/** isPosRefundParty for a direct approval: refused with APPROVER_IS_REQUESTER. */
async function assertNotPosRefundParty(
  tx: Tx,
  refund: Refund,
  approver: string,
): Promise<void> {
  if (await isPosRefundParty(tx, refund, approver))
    throw new AccessError("APPROVER_IS_REQUESTER");
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  await assertNotPosRefundParty(tx, refund, approvedBy);
  if (
    refund.approvalChainId === null &&
    !(await refundApprovalWithinLimit(tx, context, approvedBy, refund, now))
  )
    return failRefund(tx, context, refund, {
      reason: "approver_unauthorized",
      action: "payment.refund_failed",
      actorId: approvedBy,
      note: "approval_limit_exceeded",
      now,
    });
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
  // legend-riqu: decide under the intent row lock (lockRefundGraph holds it;
  // the sale side takes the same lock) at the fact time it gives, never the
  // app clock read before commit.
  const intentAt = await lockIntentsForFact(
    tx,
    refund.tenantId,
    [intent.id],
    now,
  );
  // The intent fact clock still protects captured money. The bill clock also
  // orders approvals on separate intents so historical authority checks never
  // mistake a later owner refund for exposure before an earlier supervisor.
  const at = await refundApprovalDecisionTime(tx, refund, intentAt);
  // This refund is itself reserved (pending), so reserved must still fit the
  // cap; the cap excludes money a captured POS tender still holds.
  let posSaleInUse = 0n;
  let qrSaleInUse = 0n;
  const fits = fund
    ? !fund.resolution
    : await refundableBalance(tx, intent).then(async (balance) => {
        posSaleInUse = balance.posSaleInUse;
        qrSaleInUse = balance.qrSaleInUse;
        // legend-leqj6: a late-payment refund is filed once per intent for
        // what is left after the approved refunds, so other refunds still
        // pending do not count against it (their own approval fails
        // `cap_exceeded` once this one is reserved). Every other approval
        // counts all refunds, including a pending late-payment refund.
        const otherPending = (await isLatePaymentRefund(tx, refund))
          ? await otherPendingRefundIdr(tx, refund)
          : 0n;
        return balance.reserved - otherPending <= balance.cap;
      });
  if (!fits)
    return failRefund(tx, context, refund, {
      reason: "cap_exceeded",
      action: "payment.refund_failed",
      actorId: approvedBy,
      note: null,
      ...(posSaleInUse > 0n || qrSaleInUse > 0n
        ? {
            detail: {
              ...(posSaleInUse > 0n
                ? { posSaleInUseIdr: Number(posSaleInUse) }
                : {}),
              ...(qrSaleInUse > 0n
                ? { qrSaleInUseIdr: Number(qrSaleInUse) }
                : {}),
            },
          }
        : {}),
      now: at,
    });
  const [updated] = await tx
    .update(paymentRefunds)
    .set({ status: "approved", approvedBy, decidedAt: at, updatedAt: at })
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
    now: at,
    before: { status: "pending" },
  });
  return updated;
}

/**
 * legend-leqj6: idempotency key prefixes of the late-payment refund requests
 * (`posLatePaymentRefundKey`, `qrLatePaymentRefundKey`). Spelled out here
 * because those modules import this one's callers (import cycle).
 */
const LATE_PAYMENT_REFUND_KEY_PREFIXES = [
  "pos-late-payment-refund:",
  "qr-late-payment-refund:",
  // Facility breakfast (`requestBreakfastRefund`, kind "late"): same rule, so a
  // pending admin refund does not make the guest's late refund fail the cap.
  "facility-breakfast-refund:late:",
  "fb-refile:late:",
];

/**
 * legend-leqj6: whether `refund` is the late-payment refund of its intent: the
 * request recorded its id under the once-per-intent key, so a refund that only
 * shares the requester (`system:pos`, `system:qr`) is not one.
 * legend-p61pe: the QR request filed after another refund failed has its own
 * key `<key>:<failedRefundId>` and counts the same.
 */
async function isLatePaymentRefund(tx: Tx, refund: Refund): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT 1
      FROM payment_admin_idempotency
     WHERE tenant_id = ${refund.tenantId}
       AND (${sql.join(
         LATE_PAYMENT_REFUND_KEY_PREFIXES.map(
           (prefix) =>
             sql`key = ${prefix + refund.paymentIntentId}
              OR key LIKE ${`${prefix}${refund.paymentIntentId}:%`}`,
         ),
         sql` OR `,
       )})
       AND response->>'refundId' = ${refund.id}
     LIMIT 1
  `);
  return result.rows.length > 0;
}

/**
 * legend-leqj6: refunds of the same intent, other than `refund`, still
 * `pending`, with the filter of `refundableBalance().reserved`. Read under the
 * intent row lock.
 */
async function otherPendingRefundIdr(tx: Tx, refund: Refund): Promise<bigint> {
  const result = await tx.execute(sql`
    SELECT coalesce(sum(amount_idr), 0)::text AS pending
      FROM payment_refunds
     WHERE tenant_id = ${refund.tenantId}
       AND payment_intent_id = ${refund.paymentIntentId}::uuid
       AND id <> ${refund.id}::uuid
       AND status = 'pending'
       AND unallocated_fund_id IS NULL
  `);
  return BigInt(String(result.rows[0]?.pending ?? "0"));
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
  // legend-7uqbs: a fund refund that ends failed while the provider already
  // returned the money (the intent's own refunded answer blocks it, the fund
  // itself was never flagged) would stay open and block the bill forever. Flag
  // the fund once; the caller holds intent -> fund -> refund, so the order
  // holds. The failure's own audit row below is the only one written.
  if (
    updated.unallocatedFundId &&
    (await providerRefundedBlocks(tx, updated.tenantId, updated))
  )
    await tx
      .update(paymentUnallocatedFunds)
      .set({ providerRefundedAt: input.now })
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, updated.tenantId),
          eq(paymentUnallocatedFunds.id, updated.unallocatedFundId),
          isNull(paymentUnallocatedFunds.providerRefundedAt),
        ),
      );
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
  await refileQrLatePaymentAfterFailure(tx, context, updated, input.now);
  // Breakfast order cancelled while this refund held the money: file the rest
  // again. Lazy import: facility-breakfast-money imports this module (cycle).
  const { refileBreakfastRefundAfterFailure } =
    await import("./facility-breakfast-money.ts");
  await refileBreakfastRefundAfterFailure(tx, context, updated, input.now);
  // legend-94q2l: a failed-item refund that did not fail by a person's
  // rejection is filed again. Lazy import: order-recovery-refund imports this
  // module (cycle).
  if (updated.requestedBy === "system:recovery") {
    const { refileRecoveryRefundAfterFailure } =
      await import("./order-recovery-refund.ts");
    await refileRecoveryRefundAfterFailure(tx, context, updated, input.now);
  }
  // legend-weuo2: every re-file path above has run. A failed system refund
  // (facility, QR) that leaves the guest owed money with nothing live to cover
  // it is raised to a person: alarm, audit row, follow-up list.
  const { settleSystemRefundFailure } =
    await import("./system-refund-followup.ts");
  await settleSystemRefundFailure(tx, context, updated, input.now);
  return updated;
}

/**
 * legend-p61pe: a QR order voided (or, SO-885 legend-05pjx, still awaiting
 * payment while a QR hold or an unsettled refund keeps it) because a refund
 * already took the payment's money (`refund_committed`) files its late-payment
 * refund once per intent
 * (qr-order-late-payment.ts), and that request may have found nothing left.
 * When the refund that took the money fails, the guest is owed it again: file
 * a new request under its own key. A failed late-payment refund is not
 * re-filed while it is a system refund that may still be (legend-weuo2: only
 * a failure a new request can fix (not a rejection), at most
 * `MAX_SYSTEM_REFUND_REFILE_ATTEMPTS` failures per intent, see
 * system-refund-followup.ts); the rest stays failed for a person (alarm and
 * follow-up list). A fund refund and an intent that has no QR late-payment
 * request on a voided order are not re-filed either.
 * Lazy import: qr-order-late-payment imports this module (cycle).
 */
async function refileQrLatePaymentAfterFailure(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  now: Date,
): Promise<void> {
  if (refund.unallocatedFundId !== null) return;
  const { systemRefundMayRefile } = await import("./system-refund-followup.ts");
  if (
    refund.requestedBy === "system:qr" &&
    !(await systemRefundMayRefile(tx, refund))
  )
    return;
  const base = `qr-late-payment-refund:${refund.paymentIntentId}`;
  const keys = await tx.execute(sql`
    SELECT key, response->>'refundId' AS refund_id
      FROM payment_admin_idempotency
     WHERE tenant_id = ${refund.tenantId}
       AND (key = ${base} OR key LIKE ${`${base}:%`})
  `);
  if (keys.rows.length === 0) return;
  const [intent] = await tx
    .select({ paymentLinkId: paymentIntents.paymentLinkId })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, refund.tenantId),
        eq(paymentIntents.id, refund.paymentIntentId),
      ),
    );
  if (!intent) return;
  // `orders.id` is a ULID stored in a uuid column: read it through Drizzle.
  const [order] = await tx
    .select({ id: orders.id, outletId: orders.outletId })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, refund.tenantId),
        eq(orders.paymentLinkId, intent.paymentLinkId),
        eq(orders.channel, "qr"),
        // SO-885 legend-05pjx: an order held awaiting payment by the failed
        // refund (the sweep never voids a bill with an unsettled refund) is
        // re-filed too, so staff can approve the new request instead of the
        // order waiting for ever. Safe bounds: the once-only key per failed
        // refund, the late-payment key that must already exist for the intent
        // (checked above), and `requestQrLatePaymentRefund` files only what
        // the paid intent still holds (nothing when nothing is refundable).
        inArray(orders.status, ["voided", "awaiting_payment"]),
      ),
    )
    .limit(1);
  if (!order) return;
  const { requestQrLatePaymentRefund } =
    await import("./qr-order-late-payment.ts");
  await requestQrLatePaymentRefund(tx, context, {
    order,
    paymentLinkId: intent.paymentLinkId,
    intentId: refund.paymentIntentId,
    now,
    keySuffix: refund.id,
  });
}

/**
 * `approved` -> `completed`: called on provider success, or by
 * settleRefundManually (keeps any provider ref the row already had, `marker`
 * SETTLED_OUTSIDE_PROVIDER, the ops actor resolves the fund and owns the audit row).
 */
async function completeRefund(
  tx: Tx,
  context: ScopedTenantContext,
  locked: Locked,
  providerRef: string | null,
  now: Date,
  opts: {
    keepLease?: boolean;
    /** The user who closed it; null (system) on provider success. */
    actorId?: string | null;
    action?: string;
    reason?: string | null;
    /** Extra audit facts merged into `after`. */
    detail?: Record<string, unknown>;
    /** Written to last_payout_error (null on provider success). */
    marker?: string | null;
  } = {},
): Promise<Refund> {
  const { intent, fund, refund } = locked;
  const resolvedBy = opts.actorId ?? refund.approvedBy;
  if (resolvedBy === null) throw new Error("approved refund has no approver");
  // legend-em6p: lock the intent, then take the completion time after every
  // earlier fact (sale, close, refund) on it.
  const at = await lockIntentsForFact(tx, refund.tenantId, [intent.id], now);
  const [updated] = await tx
    .update(paymentRefunds)
    .set({
      status: "completed",
      providerRef,
      completedAt: at,
      ...(opts.keepLease
        ? {}
        : { payoutClaimedUntil: null, payoutClaimToken: null }),
      lastPayoutError: opts.marker ?? null,
      updatedAt: at,
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
        resolvedBy,
        resolvedAt: at,
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
        updatedAt: at,
      })
      .where(
        and(
          eq(paymentIntents.tenantId, intent.tenantId),
          eq(paymentIntents.id, intent.id),
        ),
      );
  }
  await refundAudit(tx, context, {
    actorId: opts.actorId ?? null,
    row: updated,
    action: opts.action ?? "payment.refund_completed",
    now: at,
    reason: opts.reason,
    before: { status: "approved" },
    after: {
      amountIdr: updated.amountIdr,
      status: updated.status,
      ...opts.detail,
    },
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
    now: at,
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
/**
 * The approval request reason: at most 500 and at least 3 characters, counted
 * as PostgreSQL `char_length` does (code points, not UTF-16 units: "👍👍" is 2).
 */
function requestReasonOf(reason: string): string {
  // At most 500 code points and 500 UTF-16 units (openApprovalRequest checks
  // `.length`), never splitting a surrogate pair.
  let kept = "";
  for (const char of reason.trim()) {
    if (kept.length + char.length > 500) break;
    kept += char;
  }
  return Array.from(kept).length >= 3 ? kept : `Refund ${kept}`.trim();
}

function isUserId(id: string): boolean {
  return userIdSchema.safeParse(id).success;
}

/** Approval request of one refund: the same arguments at request time and at decide time. */
function refundApprovalInput(
  refund: Refund,
  requestedBy: string,
  now: Date,
  deadlineMinutes: number,
): OpenApprovalRequestInput {
  return {
    sourceModule: REFUND_SOURCE_MODULE,
    actionType: REFUND_ACTION_TYPE,
    objectType: REFUND_OBJECT_TYPE,
    objectId: refund.id,
    amountIdr: refund.amountIdr,
    outletId: refund.outletId,
    requestedBy,
    source: "user",
    requestReason: requestReasonOf(refund.reason),
    payload: {
      paymentIntentId: refund.paymentIntentId,
      unallocatedFundId: refund.unallocatedFundId,
    },
    deadlineMinutes,
    now,
  };
}

async function setRefundChain(
  tx: Tx,
  refund: Refund,
  chainId: string,
  now: Date,
): Promise<Refund> {
  const [row] = await tx
    .update(paymentRefunds)
    .set({ approvalChainId: chainId, updatedAt: now })
    .where(
      and(
        eq(paymentRefunds.tenantId, refund.tenantId),
        eq(paymentRefunds.id, refund.id),
      ),
    )
    .returning();
  if (!row) throw new Error("Refund chain update returned no row");
  return row;
}

/**
 * Opens the approval chain when a person requests the refund, in the request's
 * transaction, so approvers see it in their inbox without a reconcile holder
 * deciding first (legend-zi9o). Returns the refund with its chain id. A refund
 * below every tier keeps the lazy direct path, and a tenant without refund
 * policy rows is unchanged: decide still fails closed (APPROVAL_POLICY_MISSING).
 * A system-requested refund (legend-2dnh) opens with SYSTEM_APPROVAL_REQUESTER,
 * so any supervisor can decide it.
 */
export async function openRefundChainAtRequest(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  now: Date,
): Promise<Refund> {
  if (refund.approvalChainId !== null) return refund;
  try {
    const opened = await openApprovalRequest(
      tx,
      context,
      refundApprovalInput(
        refund,
        isUserId(refund.requestedBy)
          ? refund.requestedBy
          : SYSTEM_APPROVAL_REQUESTER,
        now,
        REFUND_REQUEST_DEADLINE_MINUTES,
      ),
    );
    if (!opened.required) return refund;
    return await setRefundChain(tx, refund, opened.chainId, now);
  } catch (error) {
    // Only reads ran before this throw, so the transaction stays usable.
    if (
      error instanceof AccessError &&
      error.code === "APPROVAL_POLICY_MISSING"
    )
      return refund;
    throw error;
  }
}

/**
 * `openRefundChainAtRequest` inside a savepoint: a failure is logged (refund id
 * and error code only) and the refund is returned unchanged, so a chain problem
 * never rolls back the caller (a POS payment, a deposit). The decide-time lazy
 * open and the sweep (`openPendingRefundChains`) pick the refund up later.
 */
export async function openRefundChainSafely(
  tx: Tx,
  context: ScopedTenantContext,
  refund: Refund,
  now: Date,
): Promise<Refund> {
  try {
    return await tx.transaction(async (savepoint) =>
      openRefundChainAtRequest(savepoint, context, refund, now),
    );
  } catch (error) {
    logger.error(
      { refundId: refund.id, code: errorCodeOf(error) },
      "Refund approval chain could not be opened at creation",
    );
    return refund;
  }
}

/**
 * Opens the approval chain of `pending` refunds that predate the request-time
 * open (legend-zi9o, legend-2dnh): no chain yet and an amount at or above the
 * lowest tier floor of the tenant's refund matrix. Oldest first from a rotating
 * per-tenant cursor (`pendingChainCursor`), `limit` per call, each in its own
 * transaction under the refund locks with a short lock wait (a failure or a held
 * lock is logged and skipped). Stops early on `shouldStop` (worker shutdown) or once
 * `budgetMs` is spent, so payouts in the same sweep are never starved.
 * Idempotent: an opened refund no longer matches. Returns the number of chains
 * opened.
 */
export async function openPendingRefundChains(
  context: ScopedTenantContext,
  now: Date = new Date(),
  limit = OPEN_PENDING_CHAINS_BATCH,
  budgetMs = PAYOUT_SWEEP_BUDGET_MS,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const cursor = pendingChainCursor.get(tenantId);
  const candidates = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: paymentRefunds.id,
        createdAt: sql<string>`${paymentRefunds.createdAt}::text`,
      })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.status, "pending"),
          isNull(paymentRefunds.approvalChainId),
          sql`${paymentRefunds.amountIdr} >= (SELECT min(coalesce(${approvalPolicies.thresholdIdr}, 0)) FROM ${approvalPolicies} WHERE ${approvalPolicies.tenantId} = ${tenantId} AND ${approvalPolicies.actionType} = ${REFUND_ACTION_TYPE})`,
          cursor
            ? sql`(${paymentRefunds.createdAt}, ${paymentRefunds.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(paymentRefunds.createdAt), asc(paymentRefunds.id))
      .limit(limit),
  );
  // The cursor moves past each refund tried below. Only a short page that is
  // worked to its end wraps the next round back to the oldest; a round cut short
  // (budget, shutdown) resumes after the last refund it tried.
  // Plain read, then one short transaction per refund: the refund row is locked
  // only through lockRefundGraph (intent -> fund -> refund), the same order as
  // settle and payout, so the sweep never deadlocks with them and holds no lock
  // past one refund. The state is re-checked under that lock.
  let opened = 0;
  let stoppedEarly = false;
  const started = Date.now();
  for (const candidate of candidates) {
    if (shouldStop() || Date.now() - started >= budgetMs) {
      stoppedEarly = true;
      break;
    }
    pendingChainCursor.set(tenantId, {
      createdAt: candidate.createdAt,
      id: candidate.id,
    });
    try {
      const done = await withTenant(db, context, async (tx) => {
        await tx.execute(
          sql.raw(
            `SET LOCAL lock_timeout = '${OPEN_PENDING_CHAINS_LOCK_TIMEOUT_MS}ms'`,
          ),
        );
        const { refund } = await lockRefundGraph(tx, tenantId, candidate.id);
        if (refund.status !== "pending" || refund.approvalChainId !== null)
          return false;
        const next = await openRefundChainAtRequest(tx, context, refund, now);
        return next.approvalChainId !== null;
      });
      if (done) opened += 1;
    } catch (error) {
      logger.warn(
        { refundId: candidate.id, code: errorCodeOf(error) },
        "Pending refund approval chain could not be opened",
      );
    }
  }
  if (!stoppedEarly && candidates.length < limit)
    pendingChainCursor.delete(tenantId);
  return opened;
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
      // Four-eyes on a POS-filed refund covers every level (the inbox never
      // goes through decideRefund). Fail closed, never throw: the chain is
      // resolved, so a throw would leave it pending and the consumer retrying.
      if (await isPosRefundParty(tx, refund, row.decidedBy))
        return failRefund(tx, context, refund, {
          reason: "approver_unauthorized",
          action: "payment.refund_failed",
          actorId: null,
          note: "pos_refund_party",
          now,
        });
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
      if (
        supervisor &&
        !(await refundApprovalWithinLimit(
          tx,
          context,
          row.decidedBy,
          refund,
          now,
        ))
      )
        return failRefund(tx, context, refund, {
          reason: "approver_unauthorized",
          action: "payment.refund_failed",
          actorId: row.decidedBy,
          note: "approval_limit_exceeded",
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
/**
 * The 409 for a refund that failed `cap_exceeded` (already committed): the
 * POS-sale code when a captured POS tender's hold is what blocked it
 * (legend-riqu). Read after the decision, for the error only.
 */
async function capRefusal(
  context: ScopedTenantContext,
  refundId: string,
  fallback = "Refund exceeds available paid amount.",
): Promise<HttpError> {
  const refusal = await withTenant(db, context, async (tx) => {
    const [refund] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!refund || refund.unallocatedFundId !== null) return null;
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, refund.paymentIntentId),
        ),
      );
    if (!intent) return null;
    const { cap, reserved, posSaleInUse, qrSaleInUse } =
      await refundableBalance(tx, intent, { lockDeposit: false });
    const wanted = reserved + BigInt(refund.amountIdr);
    const left = cap > reserved ? cap - reserved : 0n;
    if (wanted <= cap) return null;
    if (posSaleInUse > 0n && wanted <= cap + posSaleInUse)
      return posSaleInUseRefused(left);
    // legend-xtzpb: a fired QR pay-first sale holds the money.
    return qrSaleInUse > 0n && wanted <= cap + posSaleInUse + qrSaleInUse
      ? qrSaleInUseRefused(left)
      : null;
  });
  return refusal ?? conflict(fallback);
}

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
      // Before any chain decision is recorded (the settle step runs after it).
      if (decision === "approved") {
        await assertNotPosRefundParty(tx, refund, actor);
        // legend-7uqbs: money the provider already refunded is never approved
        // for a second payout (a reject stays open to staff).
        await assertNotProviderRefunded(tx, refund.tenantId, refund);
      }
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
          if (
            decision === "approved" &&
            (await holdsPermission(
              tx,
              context,
              actor,
              SUPERVISOR_PERMISSION,
              refund.outletId,
              now,
            )) &&
            !(await refundApprovalWithinLimit(tx, context, actor, refund, now))
          )
            throw refundApprovalLimitRefused();

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
          if (chainId === null) {
            const opened = await openApprovalRequest(
              tx,
              context,
              refundApprovalInput(
                refund,
                // A system refund's chain belongs to the reserved system user.
                systemRequester
                  ? SYSTEM_APPROVAL_REQUESTER
                  : refund.requestedBy,
                now,
                REFUND_DEADLINE_MINUTES,
              ),
            );
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
                // A refund re-opened from quarantine lost its old chain and is
                // decided again by one approver: that decision needs MFA
                // (legend-tx8x). The throw rolls back the opened request, so the
                // refund stays pending with no chain row.
                if (!opts.mfaVerified) {
                  const { rows: reopened } = await tx.execute<{
                    one: number;
                  }>(
                    sql`SELECT 1 AS one FROM audit_logs
                        WHERE tenant_id = ${refund.tenantId}
                          AND created_at >= ${refund.createdAt.toISOString()}::timestamptz
                          AND event->>'objectId' = ${refund.id}::text
                          AND event->>'action' = 'payment.refund_quarantine_reopened'
                        LIMIT 1`,
                  );
                  if (reopened.length > 0)
                    throw new AccessError("MFA_REQUIRED");
                  // The marker may already be purged (audit_2y): fail closed.
                  if (
                    now.getTime() - refund.createdAt.getTime() >
                    REOPEN_AUDIT_RETENTION_DAYS * 86_400_000
                  )
                    throw new AccessError("MFA_REQUIRED");
                }
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
            await setRefundChain(tx, refund, opened.chainId, now);
            chainId = opened.chainId;
          }

          const rows = await chainRowsOf(tx, refund.tenantId, chainId);
          assertChainBound(rows, refund);
          // Legacy chains of a system refund were opened by the human who first
          // acted (they are the chain requester): never their own approver.
          if (systemRequester && rows[0]?.requestedBy === actor)
            throw new AccessError("APPROVER_IS_REQUESTER");
          const open = rows.find((row) => row.status === "pending");
          // The decision that would close the chain must leave at least one
          // supervisor (pos.refund.approve) among the approvers. Settling
          // would otherwise fail the refund after the chain is resolved, so an
          // approver without that authority is refused here (403) before any
          // decision is recorded: no failed row, no event, refund stays pending.
          if (
            decision === "approved" &&
            open !== undefined &&
            open.level === open.requiredLevels &&
            rows.filter((row) => row.status === "pending").length === 1
          ) {
            let supervisorPresent = await holdsPermission(
              tx,
              context,
              actor,
              SUPERVISOR_PERMISSION,
              refund.outletId,
              now,
            );
            for (const row of rows) {
              if (supervisorPresent) break;
              if (row.status !== "approved" || !row.decidedBy) continue;
              supervisorPresent = await holdsPermission(
                tx,
                context,
                row.decidedBy,
                SUPERVISOR_PERMISSION,
                refund.outletId,
                now,
              );
            }
            if (!supervisorPresent)
              throw new AccessError(
                "PERMISSION_DENIED",
                "Your account cannot perform this action.",
              );
          }
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
    throw await capRefusal(context, refundId);
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
      if (settled.failureReason === "cap_exceeded")
        throw await capRefusal(
          context,
          refundId,
          "Refund could not be approved.",
        );
      throw conflict("Refund could not be approved.");
    }
    // Our decision did not land (another approver took this level): the state
    // above is settled, but a still-pending refund is not a success for us.
    if (raced && settled.status === "pending")
      throw conflict("Approval level was already decided; refresh.");
    // Without a refund gateway nothing is claimed: the refund stays approved
    // and the sweep pays it once a gateway is installed.
    if (
      settled.status === "approved" &&
      (await refundGatewayInstalledFor(context, refundId))
    )
      await runRefundPayout(context, refundId);
  } else if (
    first.kind === "payout" &&
    (await refundGatewayInstalledFor(context, refundId))
  ) {
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
  | "provider_refunded"
  | "approver_unauthorized"
  | "approval_limit_exceeded"
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
    approver.toLowerCase() === refund.requestedBy.toLowerCase() ||
    (await isPosRefundParty(tx, refund, approver))
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
    if (
      !(await refundApprovalWithinLimit(
        tx,
        context,
        approver,
        refund,
        decidedAt,
        {
          historical: true,
          approvedBefore: decidedAt,
        },
      ))
    )
      return "approval_limit_exceeded";
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
    if (await isPosRefundParty(tx, refund, row.decidedBy))
      return "approver_unauthorized";
    const decidedAt = row.decidedAt ?? now;
    const supervisor = await holds(
      row.decidedBy,
      SUPERVISOR_PERMISSION,
      decidedAt,
    );
    if (supervisor) supervisorApproved = true;
    else if (!(await holds(row.decidedBy, "payment.reconcile", decidedAt)))
      return "approver_unauthorized";
    if (
      supervisor &&
      !(await refundApprovalWithinLimit(
        tx,
        context,
        row.decidedBy,
        refund,
        decidedAt,
        { historical: true, approvedBefore: refund.decidedAt ?? now },
      ))
    )
      return "approval_limit_exceeded";
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
    // The flag it replaces (e.g. PAYOUT_NOT_FOUND_MAYBE_SENT) stays on record.
    before: { status: refund.status, lastPayoutError: refund.lastPayoutError },
  });
  logger.error(
    { refundId: refund.id, defect },
    defect === "provider_refunded"
      ? "Refund payout quarantined: the provider already refunded this money to the payer; release the refund (settle-manually and re-open are refused)"
      : "Refund payout quarantined: approval failed re-validation; reconcile manually (after paying by hand, close it with settle-manually; never release or re-open it)",
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
      /** Provider of the payment intent: picks the refund port. */
      readonly provider: string;
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
  provider: "succeeded" | "failed" | "pending",
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

/**
 * A provider answer that a terminal refund cannot take. A refund finance paid
 * by hand (SETTLED_OUTSIDE_PROVIDER) that the provider also paid means the
 * customer was paid twice: a success on it is a conflict too.
 */
function contradicts(
  refund: Refund,
  provider: GatewayRefundLookup["status"],
): provider is "succeeded" | "failed" | "pending" {
  const { status } = refund;
  // Settled by hand: a provider decline is the expected (safe) answer; a
  // success or a payout the provider still holds means paying twice.
  if (
    status === "completed" &&
    refund.lastPayoutError === SETTLED_OUTSIDE_PROVIDER
  )
    return provider === "succeeded" || provider === "pending";
  return (
    (status === "failed" && provider === "succeeded") ||
    (status === "completed" && provider === "failed")
  );
}

/** A payout result never erases a quarantine flag (set by a sweep meanwhile). */
const keepQuarantine = (next: string | null) =>
  sql`CASE WHEN ${paymentRefunds.lastPayoutError} = ${PAYOUT_QUARANTINED} THEN ${PAYOUT_QUARANTINED} ELSE ${next}::text END`;

/**
 * An unknown outcome never erases a sticky flag already on the row: the
 * quarantine, a maybe-sent payout the provider did not find, or a provider
 * answer for another payment (legend-r7g2).
 */
const keepSticky = (next: string) =>
  sql`CASE WHEN ${paymentRefunds.lastPayoutError} IN (${PAYOUT_QUARANTINED}, ${PAYOUT_NOT_FOUND_MAYBE_SENT}, ${PAYOUT_IDENTITY_MISMATCH}) THEN ${paymentRefunds.lastPayoutError} ELSE ${next}::text END`;

/** Ids-only provider facts an unknown-outcome error may carry (legend-r7g2). */
function providerEvidenceOf(error: unknown): Record<string, unknown> | null {
  const evidence =
    typeof error === "object" && error !== null
      ? (error as { providerEvidence?: unknown }).providerEvidence
      : undefined;
  return typeof evidence === "object" &&
    evidence !== null &&
    !Array.isArray(evidence)
    ? (evidence as Record<string, unknown>)
    : null;
}

/**
 * Takes the right to send (legend-xd2q, legend-3usn8) with one atomic
 * conditional UPDATE: the claim is still ours, the refund still `approved`, and
 * the lease outlives the send deadline. The UPDATE row-locks, so it serialises
 * with `settleRefundManually` (which holds the row through `lockRefundGraph`):
 * if the settlement committed first, the status is no longer `approved` and no
 * row comes back; if this wins, the settlement refuses (REFUND_PAYOUT_IN_FLIGHT)
 * because the lease ends after the deadline and it needs the lease plus a
 * margin to be over. Returns the deadline the check validated (the send budget
 * is anchored to it, not to when a stalled worker resumes) or null when the
 * right is gone. A worker that lost it never POSTs; its attempt stays counted,
 * so later runs only look the refund up.
 */
async function takeSendRight(
  context: ScopedTenantContext,
  refund: Refund,
  token: string,
): Promise<number | null> {
  const deadline = Date.now() + PROVIDER_TIMEOUT_MS;
  const rows = await withTenant(db, context, (tx) =>
    tx
      .update(paymentRefunds)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(paymentRefunds.tenantId, refund.tenantId),
          eq(paymentRefunds.id, refund.id),
          eq(paymentRefunds.status, "approved"),
          eq(paymentRefunds.payoutClaimToken, token),
          gt(paymentRefunds.payoutClaimedUntil, new Date(deadline)),
          // legend-7uqbs: re-checked atomically with the right to send.
          sql`NOT ${refundBlockedByProviderRefundSql}`,
        ),
      )
      .returning({ id: paymentRefunds.id }),
  );
  return rows.length > 0 ? deadline : null;
}

/** False while the fail-closed default port stands in for `provider` (no
 * adapter). A provider without a refund API (Duitku) never has one: its refunds
 * stay `approved` and finance closes them with `settleRefundManually`. */
function refundGatewayInstalled(provider: string): boolean {
  return (
    paymentRefundGatewayFor(provider).provider !== UNCONFIGURED_REFUND_PROVIDER
  );
}

/** `refundGatewayInstalled` for the provider of the refunded payment. An
 * unknown refund is judged like the empty provider (so the claim reports it as
 * missing once a gateway exists). */
async function refundGatewayInstalledFor(
  context: ScopedTenantContext,
  refundId: string,
): Promise<boolean> {
  // Test shim: one port answers for every provider, so no lookup is needed.
  if (paymentRefundGatewayLegacyMode()) return refundGatewayInstalled("");
  const provider = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ provider: paymentIntents.provider })
      .from(paymentRefunds)
      .innerJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, paymentRefunds.tenantId),
          eq(paymentIntents.id, paymentRefunds.paymentIntentId),
        ),
      )
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    return row?.provider ?? "";
  });
  return refundGatewayInstalled(provider);
}

/** True when at least one refund adapter is registered. */
function anyRefundGatewayInstalled(): boolean {
  return registeredRefundProviders().some(
    (provider) => provider !== UNCONFIGURED_REFUND_PROVIDER,
  );
}

/** SQL: refunds whose payment ran through a provider that has a refund port. */
function refundPortInstalledSql(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
) {
  if (paymentRefundGatewayLegacyMode()) return sql`true`;
  const providers = registeredRefundProviders().filter(
    (provider) => provider !== UNCONFIGURED_REFUND_PROVIDER,
  );
  if (providers.length === 0) return sql`false`;
  return inArray(
    paymentRefunds.paymentIntentId,
    tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          inArray(paymentIntents.provider, [...providers]),
        ),
      ),
  );
}

/** The provider ref of the transaction a fund refund's stored evidence mapping
 * names, else null. Never the intent's own payment (another payment of the
 * intent could settle the lookup by mistake). */
async function fundEvidenceProviderRef(
  tx: Tx,
  refund: Refund,
  fundId: string,
): Promise<string | null> {
  const [fund] = await tx
    .select({ evidenceId: paymentUnallocatedFunds.evidenceId })
    .from(paymentUnallocatedFunds)
    .where(
      and(
        eq(paymentUnallocatedFunds.tenantId, refund.tenantId),
        eq(paymentUnallocatedFunds.id, fundId),
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
  return evidence?.providerRef ?? null;
}

/**
 * Asks the provider what happened to a refund, writing nothing (legend-980:
 * settle-manually and the settled-refund follow-up sweep). Same request as the
 * lookup of `runRefundPayout`. Throws when the provider cannot be asked or
 * does not answer in time: the caller treats that as unknown, never as safe.
 */
async function lookupRefundStatusReadOnly(
  context: ScopedTenantContext,
  refund: Refund,
): Promise<GatewayRefundLookup> {
  const source = await withTenant(db, context, async (tx) => {
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
    return {
      provider: intent.provider,
      integrationId: intent.gatewayIntegrationId,
      outletId: intent.outletId,
      paymentProviderRef: refund.unallocatedFundId
        ? await fundEvidenceProviderRef(tx, refund, refund.unallocatedFundId)
        : intent.providerRef,
    };
  });
  if (!refundGatewayInstalled(source.provider))
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Belum ada gateway refund yang aktif.",
    );
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  return withDeadline(
    signal,
    paymentRefundGatewayFor(source.provider).getRefundStatus({
      context,
      idempotencyKey: `refund:${refund.id}`,
      providerRef: refund.providerRef,
      paymentIntentId: refund.paymentIntentId,
      paymentProviderRef: source.paymentProviderRef,
      integrationId: source.integrationId,
      outletId: source.outletId,
      amountIdr: refund.amountIdr,
      signal,
    }),
  );
}

/**
 * Pays an `approved` refund out through the refund port. The claim lease (with a
 * fencing token) makes concurrent callers skip; the provider dedupes on
 * `refund:<id>`. Only a refund with no attempt, no poll and no provider ref is
 * ever sent (legend-xd2q tripwire): after an earlier attempt the provider is
 * only looked up, and a `not_found` answer flags PAYOUT_NOT_FOUND_MAYBE_SENT
 * instead of re-sending (a provider that forgot its key could pay twice). Ops
 * close such a refund with settle-manually once it is paid. A throw or timeout
 * is NOT a failure.
 */
export async function runRefundPayout(
  context: ScopedTenantContext,
  refundId: string,
  now: Date = new Date(),
): Promise<Refund> {
  // Before any claim or write: an attempt counted against no provider would
  // make a later first send look like a possible duplicate.
  if (!(await refundGatewayInstalledFor(context, refundId)))
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
        // legend-7uqbs: the provider already returned this money to the payer.
        // Held like a failed re-validation: never sent, an attempt that may
        // have reached the provider is only looked up; staff release it.
        const defect: ApprovalDefect | null = (await providerRefundedBlocks(
          tx,
          refund.tenantId,
          refund,
        ))
          ? "provider_refunded"
          : await approvalDefectOf(tx, context, refund, now);
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
      if (refund.unallocatedFundId && !send)
        paymentProviderRef = await fundEvidenceProviderRef(
          tx,
          refund,
          refund.unallocatedFundId,
        );
      if (refund.unallocatedFundId && send) {
        // The fund's own evidence is the transaction to refund; never the
        // intent's providerRef. A fund without one resolves only when the intent
        // has exactly one evidence row (the mapping is certain), else it holds.
        const [fund] = await tx
          .select({
            evidenceId: paymentUnallocatedFunds.evidenceId,
            amountIdr: paymentUnallocatedFunds.amountIdr,
          })
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
            amountIdr: paymentEvidence.amountIdr,
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
        // legend-knev: a refund never asks the provider for more than the
        // transaction it reverses brought in. A smaller evidence holds.
        const covers = (row: (typeof evidenceRows)[number] | undefined) =>
          !!row &&
          !!fund &&
          Number(row.amountIdr) >= Number(fund.amountIdr) &&
          Number(row.amountIdr) >= Number(refund.amountIdr);
        if (fund?.evidenceId)
          evidence = covers(evidenceRows[0]) ? evidenceRows[0] : undefined;
        else if (fund && evidenceRows.length === 1 && covers(evidenceRows[0])) {
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
        provider: intent.provider,
      };
    },
  );
  if (!claim.run) return claim.refund;

  const { refund } = claim;
  const idempotencyKey = `refund:${refund.id}`;
  const port = paymentRefundGatewayFor(claim.provider);
  let result = null as GatewayRefundLookup | null;
  let unknownCode: string | null = null;
  let unknownEvidence: Record<string, unknown> | null = null;
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
    // Tripwire (legend-xd2q): only a first attempt is sent. A refund an earlier
    // attempt may have sent is never POSTed again, even on `not_found`. A
    // quarantined refund is never sent.
    if (claim.send && !claim.lookupFirst) {
      const deadline = await takeSendRight(context, refund, claim.token);
      // The request provably never left: say so, so ops know a manual
      // settlement is safe once the provider lookup agrees.
      if (deadline === null) unknownCode = "PAYOUT_SEND_RIGHT_LOST";
      else {
        // legend-3usn8: the send budget ends at the deadline the DB check
        // validated. A worker that stalled after the check must not get a fresh
        // 30 s; the adapter's fetch aborts before sending once it has passed.
        // Clamped: a clock stepping back never lengthens the send budget.
        const remaining = Math.min(deadline - Date.now(), PROVIDER_TIMEOUT_MS);
        if (remaining <= 0) {
          unknownCode = "PAYOUT_SEND_WINDOW_MISSED";
        } else {
          const signal = AbortSignal.timeout(remaining);
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
              sendBy: deadline,
            }),
          );
        }
      }
    }
  } catch (error) {
    result = null;
    unknownCode = errorCodeOf(error);
    unknownEvidence = providerEvidenceOf(error);
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
      if (outcome !== null && contradicts(locked.refund, outcome.status))
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
    if (outcome === null) {
      // Unknown outcome: record its code, but keep a sticky flag.
      if (keepLease) {
        // A stale worker leaves the row alone, but a foreign answer is never
        // lost silently (legend-r7g2).
        if (unknownCode === PAYOUT_IDENTITY_MISMATCH)
          logger.error(
            { refundId: refund.id, providerEvidence: unknownEvidence },
            "Refund payout answer names another payment, amount or key (stale worker; lease taken over). Check the provider dashboard",
          );
        return locked.refund;
      }
      const [updated] = await tx
        .update(paymentRefunds)
        .set({
          lastPayoutError: keepSticky(unknownCode ?? "UNKNOWN"),
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
      if (!updated) return locked.refund;
      if (
        updated.lastPayoutError === PAYOUT_IDENTITY_MISMATCH &&
        locked.refund.lastPayoutError !== PAYOUT_IDENTITY_MISMATCH
      ) {
        await refundAudit(tx, context, {
          actorId: null,
          row: updated,
          action: "payment.refund_payout_identity_mismatch",
          now: recordedAt,
          reason: PAYOUT_IDENTITY_MISMATCH,
          before: { lastPayoutError: locked.refund.lastPayoutError },
          after: {
            amountIdr: updated.amountIdr,
            status: updated.status,
            lastPayoutError: updated.lastPayoutError,
            providerEvidence: unknownEvidence,
          },
        });
        logger.error(
          { refundId: updated.id, providerEvidence: unknownEvidence },
          "Refund payout answer names another payment, amount or key; it is never re-sent. Check the provider dashboard before any settle-manually",
        );
      }
      return updated;
    }
    if (outcome.status === "not_found") {
      // The provider has no record of a refund that may have been sent: never
      // re-send it (tripwire); ops reconcile it.
      if (keepLease) return locked.refund;
      const [updated] = await tx
        .update(paymentRefunds)
        .set({
          lastPayoutError: keepQuarantine(PAYOUT_NOT_FOUND_MAYBE_SENT),
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
      if (!updated) return locked.refund;
      if (
        updated.lastPayoutError === PAYOUT_NOT_FOUND_MAYBE_SENT &&
        locked.refund.lastPayoutError !== PAYOUT_NOT_FOUND_MAYBE_SENT
      ) {
        await refundAudit(tx, context, {
          actorId: null,
          row: updated,
          action: "payment.refund_payout_not_found",
          now: recordedAt,
          reason: PAYOUT_NOT_FOUND_MAYBE_SENT,
          before: { lastPayoutError: locked.refund.lastPayoutError },
          after: {
            amountIdr: updated.amountIdr,
            status: updated.status,
            lastPayoutError: updated.lastPayoutError,
          },
        });
        logger.error(
          { refundId: updated.id },
          "Refund payout not found at the provider after an earlier attempt; it is never re-sent. Check the provider; once paid by hand, close it with settle-manually (only a refund without a provider ref or poll)",
        );
      }
      return updated;
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

/** The `payment_refunds` columns for the failed-refund SQL fragments. */
const failedRefundColumns = {
  tenantId: sql`${paymentRefunds.tenantId}`,
  paymentIntentId: sql`${paymentRefunds.paymentIntentId}`,
  unallocatedFundId: sql`${paymentRefunds.unallocatedFundId}`,
  status: sql`${paymentRefunds.status}`,
};

const ESCALATION_PENDING_UNAPPROVED_HOURS = 24;
const ESCALATION_PROVIDER_PENDING_HOURS = 72;
const ESCALATION_PAYOUT_STALLED_HOURS = 24;

/**
 * Marks refunds that wait too long as escalated, once per reason, and tells
 * outlet managers and finance through the notification outbox. Case
 * `pending_unapproved`: `pending`, with or without an open approval chain
 * (legend-zi9o: a chain opened at request time can sit unattended until it
 * expires), aged from `created_at` (default 24 h). Case `provider_pending`: `approved` with the
 * provider still answering `pending`, aged from `decided_at` (default 72 h).
 * Case `payout_stalled`: `approved` with no provider polls whose payout is
 * stuck (with a gateway: `last_payout_error` is `MANUAL_RECONCILIATION`,
 * `PAYOUT_QUARANTINED`, `EVIDENCE_MAPPING_REQUIRED` or
 * `DOIT_REFUND_IDENTITY_MISMATCH`; without a gateway: any
 * such refund, since nothing will pay it), aged from `payout_stall_detected_at`
 * (default 24 h). Case `failed_holds_order` (SO-885): `failed`, not replaced by
 * a completed refund, on an intent of an awaiting_payment guest QR order that
 * it keeps held; escalated at once. That stall clock is owned here: it is stamped when a stall is
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
    // Per refund: one whose provider has no refund port counts as stalled.
    const gatewayInstalled = refundPortInstalledSql(tx, tenantId);
    // coalesce keeps NOT(stalled) two-valued when last_payout_error is NULL.
    const stalled = and(
      eq(paymentRefunds.status, "approved"),
      sql`${paymentRefunds.payoutPendingPolls} = 0`,
      sql`(NOT (${gatewayInstalled}) OR coalesce(${paymentRefunds.lastPayoutError}, '') IN (${sql.join(
        [
          MANUAL_RECONCILIATION,
          PAYOUT_QUARANTINED,
          EVIDENCE_MAPPING_REQUIRED,
          PAYOUT_IDENTITY_MISMATCH,
        ].map((value) => sql`${value}`),
        sql`, `,
      )}))`,
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
      {
        // SO-885 legend-05pjx: a failed refund that keeps an awaiting_payment
        // QR order held is alerted at once (no waiting threshold), once.
        reason: "failed_holds_order",
        hours: 0,
        age: sql`${paymentRefunds.updatedAt}`,
        stale: and(
          failedRefundHoldsOrderSql(failedRefundColumns),
          sql`${paymentRefunds.escalationReason} IS DISTINCT FROM 'failed_holds_order'`,
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
 * refunds once `budgetMs` is spent. First it opens the chain of pre-deploy
 * pending refunds (`openPendingRefundChains`), then it escalates refunds that wait too
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
    // At most half the sweep budget: payouts below keep the other half.
    await openPendingRefundChains(
      context,
      now,
      OPEN_PENDING_CHAINS_BATCH,
      Math.floor(budgetMs / 2),
      shouldStop,
    );
  } catch (error) {
    logger.warn(
      { tenantId: context.tenant.tenantId, code: errorCodeOf(error) },
      "Pending refund chain sweep failed",
    );
  }
  try {
    escalated = await escalateStaleRefunds(context, now);
  } catch {
    logger.warn(
      { tenantId: context.tenant.tenantId },
      "Refund escalation sweep failed",
    );
  }
  // No gateway: claim nothing and flag nothing (see runRefundPayout).
  if (!anyRefundGatewayInstalled())
    return { attempted: 0, exhausted: 0, escalated };
  const tenantId = context.tenant.tenantId;
  // Each payout may take up to a minute: advance the (possibly injected) clock
  // by the real elapsed time so a later row's lease is not born expired.
  const started = Date.now();
  // legend-980: refunds finance closed by hand are watched for a late provider
  // payout. Own small slice and time budget, run first: a busy payout sweep
  // below cannot starve it.
  try {
    await checkSettledRefundsAtProvider(
      context,
      now,
      Math.min(limit, SETTLED_WATCH_SLICE),
      Math.floor(budgetMs / 4),
      shouldStop,
    );
  } catch (error) {
    logger.warn(
      { tenantId, code: errorCodeOf(error) },
      "Settled refund provider check failed",
    );
  }
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
          // Providers without a refund port (Duitku) are settled by hand.
          refundPortInstalledSql(tx, tenantId),
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
          // A quarantine or a not-found maybe-sent payout keeps its own (more
          // specific) flag.
          sql`${paymentRefunds.lastPayoutError} IS DISTINCT FROM ${PAYOUT_QUARANTINED}`,
          sql`${paymentRefunds.lastPayoutError} IS DISTINCT FROM ${PAYOUT_NOT_FOUND_MAYBE_SENT}`,
          sql`${paymentRefunds.lastPayoutError} IS DISTINCT FROM ${PAYOUT_IDENTITY_MISMATCH}`,
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

/** How long after a manual settlement the provider is still asked about it. */
const SETTLED_WATCH_DAYS = 14;
/** Most settled refunds looked up per sweep (its own slice, see the sweep). */
const SETTLED_WATCH_SLICE = 10;

/**
 * legend-980 follow-up of settle-manually: a `completed` refund marked
 * SETTLED_OUTSIDE_PROVIDER that keeps a provider ref, or was polled or attempted
 * (so the provider may know it by its key `refund:<id>`), is looked up again (at
 * most once an hour, for 14 days) in case the provider pays it later. Read-only:
 * a provider `succeeded` or `pending` (`contradicts`) is recorded once per kind
 * through `recordProviderConflict` (audit and error log for ops, no payout, no
 * state change). After `succeeded` the refund is not looked up again; after
 * `pending` it still is, so a later `succeeded` is reported too. A lookup that
 * fails is retried on the next due round.
 */
async function checkSettledRefundsAtProvider(
  context: ScopedTenantContext,
  now: Date,
  limit: number,
  budgetMs: number,
  shouldStop: () => boolean,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const due = await withTenant(db, context, async (tx) =>
    tx
      .select({ id: paymentRefunds.id, outletId: paymentRefunds.outletId })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.status, "completed"),
          eq(paymentRefunds.lastPayoutError, SETTLED_OUTSIDE_PROVIDER),
          sql`(${paymentRefunds.providerRef} IS NOT NULL OR ${paymentRefunds.payoutPendingPolls} > 0 OR ${paymentRefunds.payoutAttempts} > 0)`,
          sql`${paymentRefunds.completedAt} + ${SETTLED_WATCH_DAYS} * interval '1 day' > ${now}`,
          refundPortInstalledSql(tx, tenantId),
          // The stamp of the last check (or of the settlement) is updated_at.
          sql`${paymentRefunds.updatedAt} + ${PAYOUT_BACKOFF_CAP_MINUTES} * interval '1 minute' <= ${now}`,
          // Ops were told of a payout already made: nothing worse is left to
          // find. A `pending` alert alone keeps the watch (it may succeed later).
          sql`NOT ${providerConflictSeenSql(tenantId, sql`${paymentRefunds.id}::text`, now, "succeeded")}`,
        ),
      )
      .orderBy(asc(paymentRefunds.updatedAt), asc(paymentRefunds.id))
      .limit(limit),
  );
  const started = Date.now();
  for (const row of due) {
    if (shouldStop() || Date.now() - started >= budgetMs) break;
    const scoped = outletContext(context.tenant, row.outletId);
    try {
      const [refund] = await withTenant(db, scoped, (tx) =>
        tx
          .select()
          .from(paymentRefunds)
          .where(
            and(
              eq(paymentRefunds.tenantId, tenantId),
              eq(paymentRefunds.id, row.id),
            ),
          ),
      );
      if (!refund) continue;
      let answer: GatewayRefundLookup | null = null;
      try {
        answer = await lookupRefundStatusReadOnly(scoped, refund);
      } catch (error) {
        logger.warn(
          { refundId: row.id, code: errorCodeOf(error) },
          "Settled refund provider lookup failed",
        );
      }
      const checkedAt = new Date(now.getTime() + (Date.now() - started));
      await withTenant(db, scoped, async (tx) => {
        const locked = await lockRefundGraph(tx, tenantId, row.id);
        const current = locked.refund;
        if (
          current.status !== "completed" ||
          current.lastPayoutError !== SETTLED_OUTSIDE_PROVIDER
        )
          return;
        const answered = answer?.status;
        // Judged under the row lock: a second worker that looked up the same
        // refund meanwhile has recorded its alert already (once per kind).
        const alreadyTold =
          answered === "pending" || answered === "succeeded"
            ? (
                await tx.execute<{ seen: boolean }>(
                  sql`SELECT ${providerConflictSeenSql(tenantId, sql`${row.id}::text`, now, answered)} AS seen`,
                )
              ).rows[0]?.seen === true
            : false;
        if (
          answered !== undefined &&
          !alreadyTold &&
          contradicts(current, answered)
        )
          await recordProviderConflict(
            tx,
            scoped,
            current,
            answered,
            checkedAt,
          );
        // Only the backoff stamp moves: no money or status column.
        await tx
          .update(paymentRefunds)
          .set({ updatedAt: checkedAt })
          .where(
            and(
              eq(paymentRefunds.tenantId, tenantId),
              eq(paymentRefunds.id, row.id),
            ),
          );
      });
    } catch {
      // Ids only: one broken refund must not stop the batch.
      logger.warn({ refundId: row.id }, "Settled refund check failed");
    }
  }
}

const quarantined = () =>
  new HttpError(
    409,
    "PAYOUT_QUARANTINED",
    "Refund approval failed re-validation; it cannot be paid out. Reconcile it manually; after paying by hand, close it with settle-manually (never release or re-open it).",
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
  if (!(await refundGatewayInstalledFor(context, params.refundId)))
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
 * Actor of an ops action on an approved refund (quarantine release/re-open,
 * manual settlement): payment.reconcile and pos.refund.approve at the refund's
 * outlet, never its requester, dashboard MFA when a role requires it.
 */
async function assertOpsActor(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  refund: Refund,
  opts: DecideOptions,
  now: Date,
): Promise<void> {
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
}

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
    await assertOpsActor(tx, context, actor, refund, opts, now);
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
        // legend-7uqbs: a re-opened refund would be approved and paid again.
        if (action === "reopen")
          await assertNotProviderRefunded(tx, refund.tenantId, refund);
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

/** How far ahead of the server clock a manual paidAt may be (clock skew). */
const SETTLEMENT_CLOCK_SKEW_MS = 5 * 60_000;
/** How long after a claim's lease ends a manual settlement still waits. */
const SETTLEMENT_STALL_MARGIN_MS = 10 * 60_000;

/**
 * Whether finance may settle by hand a stuck refund the provider still holds
 * (answer `pending`). Restrictive default: no, for both stuck flags (paying by
 * hand while the provider may still pay means paying twice). founder decision
 * legend-17ml. With true, only MANUAL_RECONCILIATION may settle while pending.
 */
export const ALLOW_MANUAL_SETTLE_WHILE_PROVIDER_PENDING = false;

/** What the provider said about a stuck refund just before it was settled by
 * hand; `answer` is null when the provider could not be asked. `snapshot` is
 * the row as it was at lookup time: a change before the settlement locks the
 * row makes the answer stale. */
type SettleLookup = {
  readonly providerRef: string | null;
  readonly answer: GatewayRefundLookup | null;
  readonly snapshot: {
    readonly payoutPendingPolls: number;
    readonly payoutAttempts: number;
    readonly updatedAt: Date;
  };
} | null;

/**
 * legend-980 M5: the provider may know the refund by its reference, by polls or,
 * with neither (the usual maybe-sent case), by an earlier attempt: it is asked
 * by its key `refund:<id>`.
 */
const hasProviderTrace = (refund: Refund) =>
  refund.providerRef !== null ||
  refund.payoutPendingPolls > 0 ||
  refund.payoutAttempts > 0;

/** Ops flagged the refund stuck at the provider (legend-17ml). */
const isStuckAtProvider = (refund: Refund) =>
  refund.lastPayoutError === MANUAL_RECONCILIATION ||
  refund.lastPayoutError === PAYOUT_NOT_FOUND_MAYBE_SENT;

/**
 * legend-980 L7: whether ops were already told of a provider conflict of this
 * kind (`pending` or `succeeded`) for the refund. Bounded by refund id and by
 * the watch window, so the audit table is never scanned for old rows.
 */
const providerConflictSeenSql = (
  tenantId: string,
  refundId: SQL,
  now: Date,
  kind: "pending" | "succeeded",
) =>
  sql`EXISTS (SELECT 1 FROM audit_logs
        WHERE audit_logs.tenant_id = ${tenantId}
          AND audit_logs.created_at > ${now}::timestamptz - ${SETTLED_WATCH_DAYS} * interval '1 day'
          AND audit_logs.event->>'objectId' = ${refundId}
          AND audit_logs.event->>'action' = 'payment.refund_provider_conflict'
          AND audit_logs.event->'maskedChanges'->'after'->>'providerCode' = ${kind})`;

/**
 * legend-980 (restrictive): a refund with any provider trace (reference, polls
 * or an earlier attempt), flagged stuck or not, is looked up before finance may
 * close it by hand, so a payout the provider already made is never paid a
 * second time. Skipped only when the refusal is certain without it (unflagged
 * with a reference or polls: REFUND_AT_PROVIDER). Runs only for
 * an authorised actor (same checks as the settlement) and outside the row lock.
 * The answer is judged under the lock by `assertProviderAllowsSettle`.
 */
async function lookupStuckRefundBeforeSettle(
  context: ScopedTenantContext,
  actor: string,
  refundId: string,
  opts: DecideOptions,
  now: Date,
): Promise<SettleLookup> {
  const refund = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!row) return null;
    await assertOpsActor(tx, context, actor, row, opts, now);
    if (!opts.mfaVerified) throw new AccessError("MFA_REQUIRED");
    return row;
  });
  if (
    !refund ||
    refund.status !== "approved" ||
    !hasProviderTrace(refund) ||
    // Unflagged with a provider ref or polls: refused as REFUND_AT_PROVIDER
    // under the lock, no lookup needed. Unflagged with only attempts (no ref,
    // no poll: an unknown payout outcome) is always looked up.
    (!isStuckAtProvider(refund) &&
      (refund.providerRef !== null || refund.payoutPendingPolls > 0))
  )
    return null;
  const snapshot = {
    payoutPendingPolls: refund.payoutPendingPolls,
    payoutAttempts: refund.payoutAttempts,
    updatedAt: refund.updatedAt,
  };
  try {
    return {
      providerRef: refund.providerRef,
      answer: await lookupRefundStatusReadOnly(context, refund),
      snapshot,
    };
  } catch (error) {
    logger.warn(
      { refundId, code: errorCodeOf(error) },
      "Provider lookup before settle-manually failed; settlement refused",
    );
    return { providerRef: refund.providerRef, answer: null, snapshot };
  }
}

/** legend-980: the provider's answer is missing or cannot be trusted; settling
 * by hand could pay money the provider already sent, so it stays refused. */
function providerRefundStatusUnknown(): HttpError {
  return new HttpError(
    409,
    "PROVIDER_REFUND_STATUS_UNKNOWN",
    "Status refund di penyedia pembayaran belum pasti. Hubungi penyedia pembayaran untuk memastikan refund, lalu coba lagi.",
  );
}

/**
 * The provider's answer decides whether finance may close the refund by hand:
 * succeeded -> refused (the poller or webhook completes it as provider-paid);
 * failed -> allowed; not found -> refused as unknown (a send may have left,
 * and a lookup by key can lag); pending -> refused (see
 * ALLOW_MANUAL_SETTLE_WHILE_PROVIDER_PENDING); no answer, or an answer for
 * another reference -> refused (409 PROVIDER_REFUND_STATUS_UNKNOWN); a row that changed since the lookup (polls,
 * attempts or updated_at) -> refused as stale, retry.
 */
function assertProviderAllowsSettle(
  refund: Refund,
  lookup: SettleLookup,
): void {
  if (
    lookup === null ||
    lookup.answer === null ||
    lookup.providerRef !== refund.providerRef
  )
    throw providerRefundStatusUnknown();
  const { snapshot } = lookup;
  if (
    snapshot.payoutPendingPolls !== refund.payoutPendingPolls ||
    snapshot.payoutAttempts !== refund.payoutAttempts ||
    snapshot.updatedAt.getTime() !== refund.updatedAt.getTime()
  )
    throw new HttpError(
      409,
      "REFUND_LOOKUP_STALE",
      "The refund changed while the provider was asked; try again.",
    );
  const { status } = lookup.answer;
  // legend-980: `not_found` is never believable. With a reference or polls the
  // provider did see the refund; with attempts only, a send may have left and
  // been accepted while the lookup by key still lags. No lasting "never sent"
  // marker exists, so the settlement stays refused.
  if (status === "not_found") throw providerRefundStatusUnknown();
  if (status === "succeeded")
    throw new HttpError(
      409,
      "REFUND_PROVIDER_PAID",
      "The provider already paid this refund; it completes as provider-paid.",
    );
  if (
    status === "pending" &&
    (!ALLOW_MANUAL_SETTLE_WHILE_PROVIDER_PENDING ||
      refund.lastPayoutError !== MANUAL_RECONCILIATION)
  )
    throw new HttpError(
      409,
      "REFUND_PROVIDER_PENDING",
      "The provider still holds this refund; wait for its answer.",
    );
}

/**
 * Closes an `approved` refund finance paid by hand (legend-xd2q): it ends
 * `completed` with no provider payout, ever, marked SETTLED_OUTSIDE_PROVIDER.
 * The payment moves to (partially) refunded, a fund is resolved by the actor
 * and `payment.refunded` is emitted, as on provider success. Only a refund the
 * provider never saw (no provider ref, no poll) whose lease is free, or (legend-
 * 17ml) one flagged MANUAL_RECONCILIATION or PAYOUT_NOT_FOUND_MAYBE_SENT, which
 * may hold a provider ref or polls and keeps the ref after settling; any
 * attempt count and payout flag (quarantine, MANUAL_RECONCILIATION,
 * PAYOUT_NOT_FOUND_MAYBE_SENT). The approval defect, if any, is recorded in
 * the audit row, not blocking: the money already left. With a provider ref,
 * polls or an earlier attempt the provider is looked up first (legend-980,
 * assertProviderAllowsSettle).
 *
 * Same actor and lock order as actOnQuarantine; the state checks run inside
 * the idempotent write, so a same-key replay returns the stored result.
 */
export async function settleRefundManually(
  context: ScopedTenantContext,
  actor: string,
  params: { refundId: string },
  input: contract.ManualRefundSettlementInput,
  key: string,
  opts: DecideOptions,
) {
  const now = new Date();
  const paidAt = new Date(input.paidAt);
  const note = input.note.trim();
  const evidence = {
    paidAt: paidAt.toISOString(),
    channel: input.channel,
    externalReference: input.externalReference,
    amountIdr: input.amountIdr,
  };
  // legend-980: a stuck refund with a provider trace is looked up first, outside
  // the row lock (a network call), by an authorised actor only.
  const lookup = await lookupStuckRefundBeforeSettle(
    context,
    actor,
    params.refundId,
    opts,
    now,
  );
  await withTenant(db, context, async (tx) => {
    const locked = await lockRefundGraph(
      tx,
      context.tenant.tenantId,
      params.refundId,
    );
    const { refund } = locked;
    await assertOpsActor(tx, context, actor, refund, opts, now);
    // Money already left by hand: a second factor always, whatever the role.
    if (!opts.mfaVerified) throw new AccessError("MFA_REQUIRED");
    return idempotentPaymentAdminWrite(
      tx,
      context,
      actor,
      key,
      "refund.settle_manually",
      { refundId: refund.id, ...evidence, note },
      async () => {
        if (refund.status !== "approved")
          throw new HttpError(
            409,
            "REFUND_NOT_SETTLEABLE",
            "Only an approved refund can be settled manually.",
          );
        // legend-7uqbs: paying it by hand would pay money the provider already
        // returned to the payer; release the refund instead.
        await assertNotProviderRefunded(tx, refund.tenantId, refund);
        // legend-17ml: a provider reference or poll count blocks settling unless
        // ops flagged the refund stuck (MANUAL_RECONCILIATION, or
        // PAYOUT_NOT_FOUND_MAYBE_SENT); any other error keeps the refusal.
        if (
          (refund.providerRef !== null || refund.payoutPendingPolls > 0) &&
          !isStuckAtProvider(refund)
        )
          throw new HttpError(
            409,
            "REFUND_AT_PROVIDER",
            "The provider has this refund; its provider lookup settles it.",
          );
        // legend-980 H1: any provider trace (ref, polls or an earlier attempt,
        // flagged stuck or not) is judged on the provider's answer.
        if (hasProviderTrace(refund))
          assertProviderAllowsSettle(refund, lookup);
        // A claim not yet cleared may belong to a stalled worker: wait out the
        // lease plus a margin (its send takes the right atomically, takeSendRight).
        if (
          refund.payoutClaimToken !== null &&
          refund.payoutClaimedUntil !== null &&
          refund.payoutClaimedUntil.getTime() + SETTLEMENT_STALL_MARGIN_MS >
            now.getTime()
        )
          throw new HttpError(
            409,
            "REFUND_PAYOUT_IN_FLIGHT",
            "A payout attempt is running; try again in a few minutes.",
          );
        if (input.amountIdr !== refund.amountIdr)
          throw new HttpError(
            409,
            "SETTLEMENT_AMOUNT_MISMATCH",
            "The paid amount must equal the refund amount.",
          );
        if (
          paidAt.getTime() < refund.createdAt.getTime() ||
          paidAt.getTime() > now.getTime() + SETTLEMENT_CLOCK_SKEW_MS
        )
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "paidAt must be between the refund request and now.",
          );
        const defect = await approvalDefectOf(tx, context, refund, now);
        // Keep the provider reference: a late webhook naming it must still find
        // this refund and be recorded as a conflict.
        await completeRefund(tx, context, locked, refund.providerRef, now, {
          actorId: actor,
          action: "payment.refund_settled_manually",
          reason: note,
          detail: { ...evidence, approvalDefect: defect },
          marker: SETTLED_OUTSIDE_PROVIDER,
        });
        return { settled: true };
      },
    );
  });
  return loadView(context, params.refundId, actor);
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
    .select({ id: paymentEvidence.id, amountIdr: paymentEvidence.amountIdr })
    .from(paymentEvidence)
    .where(
      and(
        eq(paymentEvidence.tenantId, tenantId),
        eq(paymentEvidence.paymentIntentId, refund.paymentIntentId),
        eq(paymentEvidence.id, evidenceId),
      ),
    );
  if (!evidence) throw conflict("Evidence does not belong to this payment.");
  // legend-knev: a fund maps only to a transaction that brought in at least
  // its amount; otherwise the provider would be asked to over-refund it.
  if (
    Number(fund.amountIdr) > Number(evidence.amountIdr) ||
    Number(refund.amountIdr) > Number(evidence.amountIdr)
  )
    throw conflict("Evidence is smaller than the fund.");
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
    // Settled by hand: any provider success means paying twice, whatever its
    // amount, so it is recorded before the amount check can refuse it.
    if (
      update.amountIdr !== undefined &&
      update.amountIdr !== refund.amountIdr &&
      !contradicts(refund, update.status)
    )
      throw conflict("Provider amount does not match the refund.");
    if (contradicts(refund, update.status)) {
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
    // Settled by hand and the provider declined its own payout: paid once.
    if (
      refund.status === "completed" &&
      refund.lastPayoutError === SETTLED_OUTSIDE_PROVIDER
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
