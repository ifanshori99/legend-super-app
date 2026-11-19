// Two-person release of a hold of a payout reconciliation flag that could not be
// written (legend-6o7pc; brief docs/briefs/sub-1192-payout-hold-release.md). When the
// nightly reconciliation cannot write a flag, `app.payout_recon_hold_unwritten`
// (migration 0709) holds the slip with a row in `payroll_payout_recon_unwritten_holds`.
// A locked-evidence flag is not written again on another day, so the hold could stay
// for ever. Now one finance person proposes to release it with a written reason and a
// different one approves; the hold row stays and an approved release stops it holding.
//
// Allowed only while no flag took the hold over and the latest recon evidence of its
// operation is clean after the hold (`app.payout_recon_hold_status`); when in doubt the
// slip stays held (409 PAYOUT_RECON_HOLD_TAKEN_OVER / PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN).
//
// Both writers are trusted SQL functions (`app.payout_recon_hold_release_propose`,
// `app.payout_recon_hold_release_approve`, owner `legend_payout`) that spend a one-time
// password grant of kind `hold_release` bound to the hold (propose) or the release
// (approve) and to the sha256 of the reason. The grant is issued before the function
// locks any row. The approval checks the state again under the lock of the operation.
//
// Trusted in-transaction writers: the caller wraps `withTenant`. No amount, name or
// account number leaves this file.

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import type { PayoutReconHoldDto } from "@starter/shared/types";
import {
  payrollDisbursementItems,
  payrollPayoutReconHoldReleases,
  payrollPayoutReconUnwrittenHolds,
} from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import {
  isPayoutUuid,
  payoutRefuse,
  payoutTrustedGrant,
  recordPayoutAudit,
  type PayoutActor,
} from "./payroll-payout.service.ts";

/** The list is the open work of finance: newest holds first, capped. */
const HOLD_LIST_LIMIT = 200;

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const holdNotFound = () =>
  payoutRefuse(
    404,
    "PAYOUT_RECON_HOLD_NOT_FOUND",
    "Hold rekonsiliasi tidak ditemukan.",
  );

const releaseNotFound = () =>
  payoutRefuse(
    404,
    "PAYOUT_RECON_HOLD_RELEASE_NOT_FOUND",
    "Usulan pelepasan hold tidak ditemukan.",
  );

const alreadyReleased = () =>
  payoutRefuse(
    409,
    "PAYOUT_RECON_CLEAR_STATE",
    "Pelepasan hold ini sudah disetujui.",
  );

const takenOver = () =>
  payoutRefuse(
    409,
    "PAYOUT_RECON_HOLD_TAKEN_OVER",
    "Hold ini sudah diambil alih flag rekonsiliasi. Flag itu dan penutupannya yang menentukan.",
  );

const evidenceNotClean = () =>
  payoutRefuse(
    409,
    "PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN",
    "Bukti rekonsiliasi belum bersih, jadi hold tetap ditahan.",
  );

const tenantOf = (actor: PayoutActor) => actor.tenantId as TenantId;

/** `released` | `taken_over` | `clean` | `unclean` (migration 0712). */
const holdStatus = sql<string>`app.payout_recon_hold_status(
  ${payrollPayoutReconUnwrittenHolds.tenantId}, ${payrollPayoutReconUnwrittenHolds.id})`;

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
 * The refusal codes of the two trusted functions, as client errors. `notFound`
 * answers PAYOUT-69. PAYOUT-70 (grant spent or not matching) is left to the
 * router's `payoutGuardErrorMapper` (409 PAYOUT_STEP_GRANT_INVALID).
 */
function releaseError(error: unknown, notFound: () => unknown): unknown {
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
      "Alasan pelepasan hold wajib diisi (10 sampai 500 karakter).",
    );
  if (messageHas(error, /PAYOUT-86:/))
    return payoutRefuse(
      403,
      "PAYOUT_RECON_CLEAR_SELF_APPROVAL",
      "Pengusul pelepasan hold tidak boleh menyetujuinya sendiri.",
    );
  if (messageHas(error, /PAYOUT-87:/)) return alreadyReleased();
  if (messageHas(error, /PAYOUT-96:/)) return takenOver();
  if (messageHas(error, /PAYOUT-97:/)) return evidenceNotClean();
  return error;
}

/**
 * Every hold of the tenant with its state, newest first. `takenOver`: a later flag
 * took the hold over (the flag and its clearance decide). `releasable`: the latest
 * recon evidence of the operation is clean after the hold, so a release can be
 * proposed. A released hold is neither.
 */
export async function listPayoutReconHolds(
  tx: Tx,
  actor: PayoutActor,
): Promise<PayoutReconHoldDto[]> {
  const rows = await tx
    .select({
      id: payrollPayoutReconUnwrittenHolds.id,
      kind: payrollPayoutReconUnwrittenHolds.kind,
      itemId: payrollPayoutReconUnwrittenHolds.itemId,
      payslipId: payrollPayoutReconUnwrittenHolds.payslipId,
      batchId: payrollDisbursementItems.batchId,
      reason: payrollPayoutReconUnwrittenHolds.reason,
      heldAt: payrollPayoutReconUnwrittenHolds.createdAt,
      status: holdStatus,
      releaseId: payrollPayoutReconHoldReleases.id,
      releaseReason: payrollPayoutReconHoldReleases.reason,
      proposedBy: payrollPayoutReconHoldReleases.proposedBy,
      proposedAt: payrollPayoutReconHoldReleases.proposedAt,
      approvedBy: payrollPayoutReconHoldReleases.approvedBy,
      approvedAt: payrollPayoutReconHoldReleases.approvedAt,
    })
    .from(payrollPayoutReconUnwrittenHolds)
    .innerJoin(
      payrollDisbursementItems,
      and(
        eq(
          payrollDisbursementItems.tenantId,
          payrollPayoutReconUnwrittenHolds.tenantId,
        ),
        eq(
          payrollDisbursementItems.id,
          payrollPayoutReconUnwrittenHolds.itemId,
        ),
      ),
    )
    .leftJoin(
      payrollPayoutReconHoldReleases,
      and(
        eq(
          payrollPayoutReconHoldReleases.tenantId,
          payrollPayoutReconUnwrittenHolds.tenantId,
        ),
        eq(
          payrollPayoutReconHoldReleases.holdId,
          payrollPayoutReconUnwrittenHolds.id,
        ),
      ),
    )
    .where(eq(payrollPayoutReconUnwrittenHolds.tenantId, tenantOf(actor)))
    .orderBy(
      desc(payrollPayoutReconUnwrittenHolds.createdAt),
      desc(payrollPayoutReconUnwrittenHolds.id),
    )
    .limit(HOLD_LIST_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    itemId: row.itemId,
    payslipId: row.payslipId,
    batchId: row.batchId,
    reason: row.reason,
    heldAt: row.heldAt.toISOString(),
    takenOver: row.status === "taken_over",
    releasable: row.status === "clean",
    release:
      row.releaseId === null ||
      row.releaseReason === null ||
      row.proposedBy === null ||
      row.proposedAt === null
        ? null
        : {
            id: row.releaseId,
            status: row.approvedAt === null ? "proposed" : "approved",
            reason: row.releaseReason,
            proposedBy: row.proposedBy,
            proposedAt: row.proposedAt.toISOString(),
            approvedBy: row.approvedBy,
            approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
          },
  }));
}

/**
 * Propose releasing one hold with a written reason (10 to 500 characters). 404 for a
 * hold of another tenant or a malformed id, before any grant. A hold that a flag took
 * over is 409 PAYOUT_RECON_HOLD_TAKEN_OVER, one whose evidence is not clean after the
 * hold is 409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN, one already released is 409. A hold
 * with an open proposal answers that proposal's id again (idempotent, the first reason
 * stays, no second audit row).
 */
export async function proposePayoutReconHoldRelease(
  tx: Tx,
  actor: PayoutActor,
  holdId: string,
  input: { reason: string },
): Promise<{ releaseId: string }> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500)
    throw payoutRefuse(
      422,
      "PAYOUT_RECON_CLEAR_REASON_INVALID",
      "Alasan pelepasan hold wajib diisi (10 sampai 500 karakter).",
    );
  if (!isPayoutUuid(holdId)) throw holdNotFound();
  const [hold] = await tx
    .select({
      id: payrollPayoutReconUnwrittenHolds.id,
      batchId: payrollDisbursementItems.batchId,
      status: holdStatus,
      releaseId: payrollPayoutReconHoldReleases.id,
      approvedAt: payrollPayoutReconHoldReleases.approvedAt,
    })
    .from(payrollPayoutReconUnwrittenHolds)
    .innerJoin(
      payrollDisbursementItems,
      and(
        eq(
          payrollDisbursementItems.tenantId,
          payrollPayoutReconUnwrittenHolds.tenantId,
        ),
        eq(
          payrollDisbursementItems.id,
          payrollPayoutReconUnwrittenHolds.itemId,
        ),
      ),
    )
    .leftJoin(
      payrollPayoutReconHoldReleases,
      and(
        eq(
          payrollPayoutReconHoldReleases.tenantId,
          payrollPayoutReconUnwrittenHolds.tenantId,
        ),
        eq(
          payrollPayoutReconHoldReleases.holdId,
          payrollPayoutReconUnwrittenHolds.id,
        ),
      ),
    )
    .where(
      and(
        eq(payrollPayoutReconUnwrittenHolds.tenantId, tenantOf(actor)),
        eq(payrollPayoutReconUnwrittenHolds.id, holdId),
      ),
    )
    .limit(1);
  if (!hold) throw holdNotFound();
  if (hold.approvedAt !== null || hold.status === "released")
    throw alreadyReleased();
  // Read before the grant so a refused hold does not spend one; the function checks
  // the same again.
  if (hold.status === "taken_over") throw takenOver();
  if (hold.status !== "clean") throw evidenceNotClean();
  const grant = await payoutTrustedGrant(actor, {
    kind: "hold_release",
    step: "propose",
    batchId: hold.batchId,
    itemIds: [],
    evidenceKey: null,
    refId: hold.id,
    targetId: null,
    detail: sha256Hex(reason),
  });
  let releaseId: string;
  try {
    const result = await tx.execute(
      sql`SELECT app.payout_recon_hold_release_propose(${hold.id}::uuid, ${grant}, ${reason}::text) AS id`,
    );
    releaseId = String((result.rows[0] as { id: string }).id);
  } catch (error) {
    throw releaseError(error, holdNotFound);
  }
  // An open proposal came back unchanged (an earlier one, or a concurrent one that
  // won the insert): nothing new to audit. The row is ours only when the grant this
  // transaction spent is the one it was proposed under.
  const mine = await tx.execute(
    sql`SELECT EXISTS (
          SELECT 1
            FROM payroll_payout_recon_hold_releases r
            JOIN payroll_payout_grants g
              ON g.tenant_id = r.tenant_id AND g.id = r.proposed_grant_id
           WHERE r.tenant_id = ${actor.tenantId}::uuid AND r.id = ${releaseId}::uuid
             AND g.consumed_txid = pg_catalog.txid_current()) AS created`,
  );
  if ((mine.rows[0] as { created?: unknown } | undefined)?.created !== true)
    return { releaseId };
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.recon_hold_release_proposed",
    objectType: "payroll_payout_recon_hold_release",
    objectId: releaseId,
    reason,
    before: { status: "held" },
    after: {
      status: "proposed",
      outcome: "recon_hold_release_proposed",
      holdId: hold.id,
    },
  });
  return { releaseId };
}

/**
 * Approve a proposed release. The database refuses the proposer and the proposer's
 * session (403 PAYOUT_RECON_CLEAR_SELF_APPROVAL), a release already approved (409
 * PAYOUT_RECON_CLEAR_STATE), a hold a flag took over (409 PAYOUT_RECON_HOLD_TAKEN_OVER)
 * and evidence that is not clean (409 PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN), the last
 * two under the lock of the operation; two concurrent approvals leave one winner.
 */
export async function approvePayoutReconHoldRelease(
  tx: Tx,
  actor: PayoutActor,
  releaseId: string,
): Promise<{ releaseId: string }> {
  if (!isPayoutUuid(releaseId)) throw releaseNotFound();
  const [row] = await tx
    .select({
      id: payrollPayoutReconHoldReleases.id,
      holdId: payrollPayoutReconHoldReleases.holdId,
      reason: payrollPayoutReconHoldReleases.reason,
      approvedAt: payrollPayoutReconHoldReleases.approvedAt,
      batchId: payrollDisbursementItems.batchId,
    })
    .from(payrollPayoutReconHoldReleases)
    .innerJoin(
      payrollPayoutReconUnwrittenHolds,
      and(
        eq(
          payrollPayoutReconUnwrittenHolds.tenantId,
          payrollPayoutReconHoldReleases.tenantId,
        ),
        eq(
          payrollPayoutReconUnwrittenHolds.id,
          payrollPayoutReconHoldReleases.holdId,
        ),
      ),
    )
    .innerJoin(
      payrollDisbursementItems,
      and(
        eq(
          payrollDisbursementItems.tenantId,
          payrollPayoutReconUnwrittenHolds.tenantId,
        ),
        eq(
          payrollDisbursementItems.id,
          payrollPayoutReconUnwrittenHolds.itemId,
        ),
      ),
    )
    .where(
      and(
        eq(payrollPayoutReconHoldReleases.tenantId, tenantOf(actor)),
        eq(payrollPayoutReconHoldReleases.id, releaseId),
      ),
    )
    .limit(1);
  if (!row) throw releaseNotFound();
  if (row.approvedAt !== null) throw alreadyReleased();
  const grant = await payoutTrustedGrant(actor, {
    kind: "hold_release",
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
      sql`SELECT app.payout_recon_hold_release_approve(${row.id}::uuid, ${grant}) AS id`,
    );
  } catch (error) {
    throw releaseError(error, releaseNotFound);
  }
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.recon_hold_release_approved",
    objectType: "payroll_payout_recon_hold_release",
    objectId: row.id,
    reason: row.reason,
    before: { status: "proposed" },
    after: {
      status: "approved",
      outcome: "recon_hold_release_approved",
      holdId: row.holdId,
    },
  });
  return { releaseId: row.id };
}
