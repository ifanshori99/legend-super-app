// Two-person withdrawal of an open return claim (legend-snwnn; brief
// docs/briefs/1005/design.md). A return claim is `open` after the first person
// recorded the bank return; if that record was wrong, one finance person
// proposes to withdraw it with a written reason and a different one approves.
// A `consumed` claim (items already `returned`, journal posted) is terminal and
// cannot be withdrawn. The approval empties the return columns of the items
// (they stay `succeeded`) and marks the claim `withdrawn`; nothing is paid
// again and no journal changes. The proof of a withdrawn claim stays burned.
//
// Both writers are trusted SQL functions (`app.payout_return_withdraw_propose`,
// `app.payout_return_withdraw_approve`, owner `legend_payout`) that spend a
// one-time grant of kind `return_withdraw` bound to the claim (propose) or the
// withdrawal (approve) and to the sha256 of the reason, so a reason changed
// after the step-up is refused. The grant is issued before the function locks
// any row (the grantor connection would wait on our own lock).
//
// Trusted in-transaction writers: the caller wraps `withTenant`. No amount, name
// or account number leaves this file. The tables are read with plain SQL: their
// columns come from migration 0615.

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import type { PayoutReturnClaimDto } from "@starter/shared/types";
import type { Tx } from "./hris-access.ts";
import {
  isPayoutUuid,
  payoutRefuse,
  payoutTrustedGrant,
  recordPayoutAudit,
  type PayoutActor,
} from "./payroll-payout.service.ts";

/** The list is the work of one batch: newest claims first, capped. */
const CLAIM_LIST_LIMIT = 200;

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const claimNotFound = () =>
  payoutRefuse(
    404,
    "PAYOUT_RETURN_CLAIM_NOT_FOUND",
    "Klaim pengembalian tidak ditemukan.",
  );

const withdrawalNotFound = () =>
  payoutRefuse(
    404,
    "PAYOUT_RETURN_WITHDRAWAL_NOT_FOUND",
    "Usulan penarikan klaim tidak ditemukan.",
  );

const claimNotWithdrawable = () =>
  payoutRefuse(
    409,
    "PAYOUT_RETURN_WITHDRAW_REFUSED",
    "Klaim pengembalian ini tidak dapat ditarik (sudah dikonfirmasi, berubah, atau sudah ditarik).",
  );

const alreadyApproved = () =>
  payoutRefuse(
    409,
    "PAYOUT_RETURN_WITHDRAW_STATE",
    "Penarikan klaim ini sudah disetujui.",
  );

const reasonInvalid = () =>
  payoutRefuse(
    422,
    "PAYOUT_RETURN_WITHDRAW_REASON_INVALID",
    "Alasan penarikan klaim wajib diisi (10 sampai 500 karakter).",
  );

const tenantOf = (actor: PayoutActor) => actor.tenantId as TenantId;

const isoOf = (value: unknown): string => new Date(String(value)).toISOString();

function messageHas(error: unknown, pattern: RegExp, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { message?: unknown; cause?: unknown };
  return (
    (typeof candidate.message === "string" &&
      pattern.test(candidate.message)) ||
    messageHas(candidate.cause, pattern, depth + 1)
  );
}

/**
 * The refusal codes of the grant issue and the two trusted functions, as client
 * errors. `notFound` answers PAYOUT-69 (the claim or withdrawal is gone or not
 * in the tenant). PAYOUT-70 (grant spent or not matching) is left to the
 * router's `payoutGuardErrorMapper`.
 */
function withdrawError(error: unknown, notFound: () => unknown): unknown {
  if (messageHas(error, /PAYOUT-69:/)) return notFound();
  if (messageHas(error, /PAYOUT-42:/))
    return payoutRefuse(
      403,
      "PAYOUT_ACTOR_REFUSED",
      "Anda tidak berhak menjalankan langkah pembayaran ini.",
    );
  // PAYOUT-64 has several causes (batch requester, first step not attested):
  // the generic message names none of them wrongly.
  if (messageHas(error, /PAYOUT-64:/))
    return payoutRefuse(
      403,
      "PAYOUT_ACTOR_REFUSED",
      "Anda tidak berhak menjalankan langkah pembayaran ini.",
    );
  if (messageHas(error, /PAYOUT-72:/))
    return payoutRefuse(
      422,
      "PAYOUT_GRANT_REFUSED",
      "Izin langkah pembayaran tidak dapat diterbitkan untuk data ini.",
    );
  if (messageHas(error, /PAYOUT-92:/)) return reasonInvalid();
  if (messageHas(error, /PAYOUT-93:/)) return claimNotWithdrawable();
  if (messageHas(error, /PAYOUT-94:/))
    return payoutRefuse(
      403,
      "PAYOUT_RETURN_WITHDRAW_SELF_APPROVAL",
      "Pengusul penarikan klaim tidak boleh menyetujuinya sendiri.",
    );
  if (messageHas(error, /PAYOUT-95:/)) return alreadyApproved();
  return error;
}

/**
 * Every return claim of one batch with its open withdrawal proposal, newest
 * first. 404 for a batch of another tenant or a malformed id.
 */
export async function listPayoutReturnClaims(
  tx: Tx,
  actor: PayoutActor,
  batchId: string,
): Promise<PayoutReturnClaimDto[]> {
  if (!isPayoutUuid(batchId))
    throw payoutRefuse(
      404,
      "PAYOUT_BATCH_NOT_FOUND",
      "Batch pembayaran tidak ditemukan.",
    );
  const batch = await tx.execute(
    sql`SELECT 1 AS found FROM payroll_disbursement_batches
         WHERE tenant_id = ${tenantOf(actor)}::uuid AND id = ${batchId}::uuid`,
  );
  if (batch.rows.length === 0)
    throw payoutRefuse(
      404,
      "PAYOUT_BATCH_NOT_FOUND",
      "Batch pembayaran tidak ditemukan.",
    );
  const result = await tx.execute(
    sql`SELECT c.id, c.status, c.bank_ref, c.created_by, c.created_at,
               (SELECT count(*)::int
                  FROM payroll_disbursement_items i
                 WHERE i.tenant_id = c.tenant_id
                   AND i.return_claim_id = c.id) AS item_count,
               w.id AS withdrawal_id, w.reason AS withdrawal_reason,
               w.proposed_by, w.proposed_at
          FROM payroll_payout_return_claims c
          LEFT JOIN payroll_payout_return_withdrawals w
            ON w.tenant_id = c.tenant_id
           AND w.claim_id = c.id
           AND w.approved_at IS NULL
         WHERE c.tenant_id = ${tenantOf(actor)}::uuid
           AND c.batch_id = ${batchId}::uuid
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT ${CLAIM_LIST_LIMIT}`,
  );
  return (
    result.rows as Array<{
      id: string;
      status: PayoutReturnClaimDto["status"];
      bank_ref: string | null;
      created_by: string;
      created_at: unknown;
      item_count: number;
      withdrawal_id: string | null;
      withdrawal_reason: string | null;
      proposed_by: string | null;
      proposed_at: unknown;
    }>
  ).map((row) => ({
    id: row.id,
    status: row.status,
    bankRef: row.bank_ref,
    itemCount: Number(row.item_count),
    createdBy: row.created_by,
    createdAt: isoOf(row.created_at),
    withdrawal:
      row.withdrawal_id === null ||
      row.withdrawal_reason === null ||
      row.proposed_by === null ||
      row.proposed_at === null
        ? null
        : {
            id: row.withdrawal_id,
            reason: row.withdrawal_reason,
            proposedBy: row.proposed_by,
            proposedAt: isoOf(row.proposed_at),
          },
  }));
}

/**
 * Propose withdrawing one open claim with a written reason (10 to 500
 * characters). 404 for a claim of another tenant or a malformed id, before any
 * grant; 409 for a claim that is not `open`. A claim with an open proposal
 * answers that proposal's id again (idempotent, the first reason stays, no
 * second audit row).
 */
export async function proposePayoutReturnWithdraw(
  tx: Tx,
  actor: PayoutActor,
  claimId: string,
  input: { reason: string },
): Promise<{ withdrawalId: string }> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500) throw reasonInvalid();
  if (!isPayoutUuid(claimId)) throw claimNotFound();
  const found = await tx.execute(
    sql`SELECT c.id, c.batch_id, c.status, w.id AS withdrawal_id
          FROM payroll_payout_return_claims c
          LEFT JOIN payroll_payout_return_withdrawals w
            ON w.tenant_id = c.tenant_id
           AND w.claim_id = c.id
           AND w.approved_at IS NULL
         WHERE c.tenant_id = ${tenantOf(actor)}::uuid
           AND c.id = ${claimId}::uuid
         LIMIT 1`,
  );
  const claim = found.rows[0] as
    | {
        id: string;
        batch_id: string;
        status: string;
        withdrawal_id: string | null;
      }
    | undefined;
  if (!claim) throw claimNotFound();
  if (claim.status !== "open") throw claimNotWithdrawable();
  let grant: string;
  try {
    grant = await payoutTrustedGrant(actor, {
      kind: "return_withdraw",
      step: "propose",
      batchId: claim.batch_id,
      itemIds: [],
      evidenceKey: null,
      refId: claim.id,
      targetId: null,
      detail: sha256Hex(reason),
    });
  } catch (error) {
    throw withdrawError(error, claimNotFound);
  }
  let withdrawalId: string;
  try {
    const result = await tx.execute(
      sql`SELECT app.payout_return_withdraw_propose(${claim.id}::uuid, ${grant}, ${reason}::text) AS id`,
    );
    withdrawalId = String((result.rows[0] as { id: string }).id);
  } catch (error) {
    throw withdrawError(error, claimNotFound);
  }
  // An open proposal came back unchanged: nothing new to audit.
  if (claim.withdrawal_id === withdrawalId) return { withdrawalId };
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.return_withdraw_proposed",
    objectType: "payroll_payout_return_withdrawal",
    objectId: withdrawalId,
    reason,
    before: { status: "open" },
    after: { status: "proposed", outcome: "return_withdraw_proposed" },
  });
  return { withdrawalId };
}

/**
 * Approve a proposed withdrawal. The database refuses the proposer and the
 * proposer's session (403 PAYOUT_RETURN_WITHDRAW_SELF_APPROVAL), a withdrawal
 * already approved (409 PAYOUT_RETURN_WITHDRAW_STATE) and a claim or item that
 * changed since the proposal (409 PAYOUT_RETURN_WITHDRAW_REFUSED); two
 * concurrent approvals leave exactly one winner. Answers how many items were
 * restored to their state before the claim.
 */
export async function approvePayoutReturnWithdraw(
  tx: Tx,
  actor: PayoutActor,
  withdrawalId: string,
): Promise<{ withdrawalId: string; restoredItems: number }> {
  if (!isPayoutUuid(withdrawalId)) throw withdrawalNotFound();
  const found = await tx.execute(
    sql`SELECT w.id, w.reason, w.approved_at, c.batch_id
          FROM payroll_payout_return_withdrawals w
          JOIN payroll_payout_return_claims c
            ON c.tenant_id = w.tenant_id AND c.id = w.claim_id
         WHERE w.tenant_id = ${tenantOf(actor)}::uuid
           AND w.id = ${withdrawalId}::uuid
         LIMIT 1`,
  );
  const row = found.rows[0] as
    | { id: string; reason: string; approved_at: unknown; batch_id: string }
    | undefined;
  if (!row) throw withdrawalNotFound();
  if (row.approved_at !== null) throw alreadyApproved();
  let grant: string;
  try {
    grant = await payoutTrustedGrant(actor, {
      kind: "return_withdraw",
      step: "approve",
      batchId: row.batch_id,
      itemIds: [],
      evidenceKey: null,
      refId: row.id,
      targetId: null,
      detail: sha256Hex(row.reason),
    });
  } catch (error) {
    throw withdrawError(error, withdrawalNotFound);
  }
  let restoredItems: number;
  try {
    const result = await tx.execute(
      sql`SELECT app.payout_return_withdraw_approve(${row.id}::uuid, ${grant}) AS restored`,
    );
    restoredItems = Number((result.rows[0] as { restored: number }).restored);
  } catch (error) {
    throw withdrawError(error, withdrawalNotFound);
  }
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.return_withdraw_approved",
    objectType: "payroll_payout_return_withdrawal",
    objectId: row.id,
    reason: row.reason,
    before: { status: "proposed" },
    after: {
      status: "approved",
      itemCount: restoredItems,
      outcome: "return_withdraw_approved",
    },
  });
  return { withdrawalId: row.id, restoredItems };
}
