// Two-person clearance of a false reconciliation flag (legend-xbagc; brief
// docs/briefs/sub-990-payout-lanjutan.md, card A). The flag row in
// `payroll_payout_recon_exceptions` is insert-only and holds the payslip back
// from a new batch; only an approved clearance releases it. One finance person
// proposes with a written reason, a different one approves.
//
// Both writers are trusted SQL functions (`app.payout_recon_clear_propose`,
// `app.payout_recon_clear_approve`, owner `legend_payout`) that spend a
// one-time grant of kind `recon_clear` bound to the flag (propose) or the
// clearance (approve) and to the sha256 of the reason, so a reason changed after
// the step-up is refused. The grant is issued before the function locks any row
// (the grantor connection would wait on our own lock).
//
// A clearance is bound to the fingerprint of the flagged data (legend-hklnq,
// migration 0464). The flag's current fingerprint is the LIVE one
// (`app.payout_recon_flag_fingerprint`); only an approved clearance of that
// fingerprint releases the slip, so data changed after the approval holds the
// slip again at once (`reopened`), and approving a clearance whose data changed
// since the proposal is refused (PAYOUT-91).
//
// Trusted in-transaction writers: the caller wraps `withTenant`. No amount, name
// or account number leaves this file.

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import type { PayoutReconFlagDto } from "@starter/shared/types";
import {
  payrollDisbursementItems,
  payrollPayoutReconClearances,
  payrollPayoutReconExceptions,
} from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import {
  isPayoutUuid,
  payoutRefuse,
  payoutTrustedGrant,
  recordPayoutAudit,
  type PayoutActor,
} from "./payroll-payout.service.ts";

/** The list is the open work of finance: newest flags first, capped. */
const FLAG_LIST_LIMIT = 200;

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const flagNotFound = () =>
  payoutRefuse(
    404,
    "PAYOUT_RECON_FLAG_NOT_FOUND",
    "Flag rekonsiliasi tidak ditemukan.",
  );

const clearanceNotFound = () =>
  payoutRefuse(
    404,
    "PAYOUT_RECON_CLEARANCE_NOT_FOUND",
    "Usulan penutupan flag tidak ditemukan.",
  );

const alreadyApproved = () =>
  payoutRefuse(
    409,
    "PAYOUT_RECON_CLEAR_STATE",
    "Penutupan flag ini sudah disetujui.",
  );

const tenantOf = (actor: PayoutActor) => actor.tenantId as TenantId;

/** The flag's current fingerprint: the live one (migration 0464). */
const currentFlagSha = sql`app.payout_recon_flag_fingerprint(
  ${payrollPayoutReconExceptions.tenantId}, ${payrollPayoutReconExceptions.id})`;

/** The clearance of the flag's current fingerprint (at most one). */
const currentClearanceJoin = and(
  eq(
    payrollPayoutReconClearances.tenantId,
    payrollPayoutReconExceptions.tenantId,
  ),
  eq(payrollPayoutReconClearances.exceptionId, payrollPayoutReconExceptions.id),
  sql`${payrollPayoutReconClearances.flagSha256} = ${currentFlagSha}`,
);

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
 * The refusal codes of the two trusted functions, as client errors.
 * `notFound` answers PAYOUT-69 (the flag or clearance is gone or not in the
 * tenant). PAYOUT-70 (grant spent or not matching) is left to the router's
 * `payoutGuardErrorMapper` (409 PAYOUT_STEP_GRANT_INVALID).
 */
function clearanceError(error: unknown, notFound: () => unknown): unknown {
  if (messageHas(error, /PAYOUT-69:/)) return notFound();
  if (messageHas(error, /PAYOUT-42:/))
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
  if (messageHas(error, /PAYOUT-85:/))
    return payoutRefuse(
      422,
      "PAYOUT_RECON_CLEAR_REASON_INVALID",
      "Alasan penutupan flag wajib diisi (10 sampai 500 karakter).",
    );
  if (messageHas(error, /PAYOUT-86:/))
    return payoutRefuse(
      403,
      "PAYOUT_RECON_CLEAR_SELF_APPROVAL",
      "Pengusul penutupan flag tidak boleh menyetujuinya sendiri.",
    );
  if (messageHas(error, /PAYOUT-87:/)) return alreadyApproved();
  // 1057 (legend-qh11l): while the proof file cannot be read the clearance waits
  // for a successful read; a new proposal would not help.
  if (messageHas(error, /PAYOUT-91:.*could not be read/))
    return payoutRefuse(
      409,
      "PAYOUT_RECON_PROOF_UNREADABLE",
      "Bukti pembayaran belum dapat dibaca. Tunggu pemeriksaan berikutnya berhasil membacanya, lalu setujui lagi; usulan baru tidak diperlukan.",
    );
  if (messageHas(error, /PAYOUT-91:/))
    return payoutRefuse(
      409,
      "PAYOUT_RECON_FLAG_CHANGED",
      "Data yang ditandai berubah sejak penutupan flag diusulkan. Ajukan usulan penutupan baru.",
    );
  return error;
}

/**
 * Every flag of the tenant with the state of the clearance of its current
 * fingerprint, newest first. `reopened`: a clearance was approved for this flag
 * and none matches the live fingerprint (the flag holds the slip again).
 */
export async function listPayoutReconFlags(
  tx: Tx,
  actor: PayoutActor,
): Promise<PayoutReconFlagDto[]> {
  const rows = await tx
    .select({
      id: payrollPayoutReconExceptions.id,
      kind: payrollPayoutReconExceptions.kind,
      itemId: payrollPayoutReconExceptions.itemId,
      payslipId: payrollPayoutReconExceptions.payslipId,
      batchId: payrollDisbursementItems.batchId,
      reason: payrollPayoutReconExceptions.reason,
      flaggedAt: payrollPayoutReconExceptions.flaggedAt,
      clearanceId: payrollPayoutReconClearances.id,
      clearanceReason: payrollPayoutReconClearances.reason,
      proposedBy: payrollPayoutReconClearances.proposedBy,
      proposedAt: payrollPayoutReconClearances.proposedAt,
      approvedBy: payrollPayoutReconClearances.approvedBy,
      approvedAt: payrollPayoutReconClearances.approvedAt,
      reopened: sql<boolean>`(EXISTS (
        SELECT 1
          FROM payroll_payout_recon_clearances o
         WHERE o.tenant_id = ${payrollPayoutReconExceptions.tenantId}
           AND o.exception_id = ${payrollPayoutReconExceptions.id}
           AND o.approved_at IS NOT NULL
           AND o.flag_sha256 IS DISTINCT FROM ${currentFlagSha})
        AND ${payrollPayoutReconClearances.approvedAt} IS NULL)`,
    })
    .from(payrollPayoutReconExceptions)
    .innerJoin(
      payrollDisbursementItems,
      and(
        eq(
          payrollDisbursementItems.tenantId,
          payrollPayoutReconExceptions.tenantId,
        ),
        eq(payrollDisbursementItems.id, payrollPayoutReconExceptions.itemId),
      ),
    )
    .leftJoin(payrollPayoutReconClearances, currentClearanceJoin)
    .where(eq(payrollPayoutReconExceptions.tenantId, tenantOf(actor)))
    .orderBy(
      desc(payrollPayoutReconExceptions.flaggedAt),
      desc(payrollPayoutReconExceptions.id),
    )
    .limit(FLAG_LIST_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    itemId: row.itemId,
    payslipId: row.payslipId,
    batchId: row.batchId,
    reason: row.reason,
    flaggedAt: row.flaggedAt.toISOString(),
    reopened: row.reopened === true,
    clearance:
      row.clearanceId === null ||
      row.clearanceReason === null ||
      row.proposedBy === null ||
      row.proposedAt === null
        ? null
        : {
            id: row.clearanceId,
            status: row.approvedAt === null ? "proposed" : "approved",
            reason: row.clearanceReason,
            proposedBy: row.proposedBy,
            proposedAt: row.proposedAt.toISOString(),
            approvedBy: row.approvedBy,
            approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
          },
  }));
}

/**
 * Propose clearing one flag with a written reason (10 to 500 characters).
 * 404 for a flag of another tenant or a malformed id, before any grant. The
 * clearance is bound to the live fingerprint of the flagged data. A flag with
 * an open proposal of its current fingerprint answers that proposal's id again
 * (idempotent, the first reason stays, no second audit row); an approved one
 * is 409.
 */
export async function proposePayoutReconClearance(
  tx: Tx,
  actor: PayoutActor,
  flagId: string,
  input: { reason: string },
): Promise<{ clearanceId: string }> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500)
    throw payoutRefuse(
      422,
      "PAYOUT_RECON_CLEAR_REASON_INVALID",
      "Alasan penutupan flag wajib diisi (10 sampai 500 karakter).",
    );
  if (!isPayoutUuid(flagId)) throw flagNotFound();
  const [flag] = await tx
    .select({
      id: payrollPayoutReconExceptions.id,
      batchId: payrollDisbursementItems.batchId,
      clearanceId: payrollPayoutReconClearances.id,
      approvedAt: payrollPayoutReconClearances.approvedAt,
    })
    .from(payrollPayoutReconExceptions)
    .innerJoin(
      payrollDisbursementItems,
      and(
        eq(
          payrollDisbursementItems.tenantId,
          payrollPayoutReconExceptions.tenantId,
        ),
        eq(payrollDisbursementItems.id, payrollPayoutReconExceptions.itemId),
      ),
    )
    .leftJoin(payrollPayoutReconClearances, currentClearanceJoin)
    .where(
      and(
        eq(payrollPayoutReconExceptions.tenantId, tenantOf(actor)),
        eq(payrollPayoutReconExceptions.id, flagId),
      ),
    )
    .limit(1);
  if (!flag) throw flagNotFound();
  if (flag.approvedAt !== null) throw alreadyApproved();
  const grant = await payoutTrustedGrant(actor, {
    kind: "recon_clear",
    step: "propose",
    batchId: flag.batchId,
    itemIds: [],
    evidenceKey: null,
    refId: flag.id,
    targetId: null,
    detail: sha256Hex(reason),
  });
  let clearanceId: string;
  try {
    const result = await tx.execute(
      sql`SELECT app.payout_recon_clear_propose(${flag.id}::uuid, ${grant}, ${reason}::text) AS id`,
    );
    clearanceId = String((result.rows[0] as { id: string }).id);
  } catch (error) {
    throw clearanceError(error, flagNotFound);
  }
  // An open proposal came back unchanged: nothing new to audit.
  if (flag.clearanceId === clearanceId) return { clearanceId };
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.recon_clear_proposed",
    objectType: "payroll_payout_recon_clearance",
    objectId: clearanceId,
    reason,
    before: { status: "flagged" },
    after: { status: "proposed", outcome: "recon_clear_proposed" },
  });
  return { clearanceId };
}

/**
 * Approve a proposed clearance. The database refuses the proposer and the
 * proposer's session (403 PAYOUT_RECON_CLEAR_SELF_APPROVAL) and a clearance
 * already approved (409 PAYOUT_RECON_CLEAR_STATE), and a clearance whose
 * flagged data changed since the proposal (409 PAYOUT_RECON_FLAG_CHANGED);
 * two concurrent approvals leave exactly one winner.
 */
export async function approvePayoutReconClearance(
  tx: Tx,
  actor: PayoutActor,
  clearanceId: string,
): Promise<{ clearanceId: string }> {
  if (!isPayoutUuid(clearanceId)) throw clearanceNotFound();
  const [row] = await tx
    .select({
      id: payrollPayoutReconClearances.id,
      reason: payrollPayoutReconClearances.reason,
      approvedAt: payrollPayoutReconClearances.approvedAt,
      batchId: payrollDisbursementItems.batchId,
    })
    .from(payrollPayoutReconClearances)
    .innerJoin(
      payrollPayoutReconExceptions,
      and(
        eq(
          payrollPayoutReconExceptions.tenantId,
          payrollPayoutReconClearances.tenantId,
        ),
        eq(
          payrollPayoutReconExceptions.id,
          payrollPayoutReconClearances.exceptionId,
        ),
      ),
    )
    .innerJoin(
      payrollDisbursementItems,
      and(
        eq(
          payrollDisbursementItems.tenantId,
          payrollPayoutReconExceptions.tenantId,
        ),
        eq(payrollDisbursementItems.id, payrollPayoutReconExceptions.itemId),
      ),
    )
    .where(
      and(
        eq(payrollPayoutReconClearances.tenantId, tenantOf(actor)),
        eq(payrollPayoutReconClearances.id, clearanceId),
      ),
    )
    .limit(1);
  if (!row) throw clearanceNotFound();
  if (row.approvedAt !== null) throw alreadyApproved();
  const grant = await payoutTrustedGrant(actor, {
    kind: "recon_clear",
    step: "approve",
    batchId: row.batchId,
    itemIds: [],
    evidenceKey: null,
    refId: row.id,
    targetId: null,
    detail: sha256Hex(row.reason),
  });
  try {
    await tx.execute(
      sql`SELECT app.payout_recon_clear_approve(${row.id}::uuid, ${grant}) AS id`,
    );
  } catch (error) {
    throw clearanceError(error, clearanceNotFound);
  }
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.recon_clear_approved",
    objectType: "payroll_payout_recon_clearance",
    objectId: row.id,
    reason: row.reason,
    before: { status: "proposed" },
    after: { status: "approved", outcome: "recon_clear_approved" },
  });
  return { clearanceId: row.id };
}
