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

const alreadyProposed = () =>
  payoutRefuse(
    409,
    "PAYOUT_RECON_CLEAR_EXISTS",
    "Flag ini sudah punya usulan penutupan.",
  );

const tenantOf = (actor: PayoutActor) => actor.tenantId as TenantId;

function messageHas(error: unknown, pattern: RegExp, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { message?: unknown; cause?: unknown };
  return (
    (typeof candidate.message === "string" &&
      pattern.test(candidate.message)) ||
    messageHas(candidate.cause, pattern, depth + 1)
  );
}

function sqlStateOf(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== "object" || error === null)
    return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  return typeof candidate.code === "string"
    ? candidate.code
    : sqlStateOf(candidate.cause, depth + 1);
}

/** The refusal codes of the two trusted functions, as client errors. */
function clearanceError(error: unknown): unknown {
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
  if (messageHas(error, /PAYOUT-87:/))
    return payoutRefuse(
      409,
      "PAYOUT_RECON_CLEAR_STATE",
      "Penutupan flag ini sudah disetujui.",
    );
  // One clearance per flag: a second proposal (also a concurrent one) loses.
  if (sqlStateOf(error) === "23505") return alreadyProposed();
  return error;
}

/** Every flag of the tenant with the state of its clearance, newest first. */
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
    .leftJoin(
      payrollPayoutReconClearances,
      and(
        eq(
          payrollPayoutReconClearances.tenantId,
          payrollPayoutReconExceptions.tenantId,
        ),
        eq(
          payrollPayoutReconClearances.exceptionId,
          payrollPayoutReconExceptions.id,
        ),
      ),
    )
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
 * 404 for a flag of another tenant or a malformed id, before any grant; 409
 * when the flag already has a proposal.
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
    .leftJoin(
      payrollPayoutReconClearances,
      and(
        eq(
          payrollPayoutReconClearances.tenantId,
          payrollPayoutReconExceptions.tenantId,
        ),
        eq(
          payrollPayoutReconClearances.exceptionId,
          payrollPayoutReconExceptions.id,
        ),
      ),
    )
    .where(
      and(
        eq(payrollPayoutReconExceptions.tenantId, tenantOf(actor)),
        eq(payrollPayoutReconExceptions.id, flagId),
      ),
    )
    .limit(1);
  if (!flag) throw flagNotFound();
  if (flag.clearanceId !== null) throw alreadyProposed();
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
    throw clearanceError(error);
  }
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
 * already approved (409 PAYOUT_RECON_CLEAR_STATE); two concurrent approvals
 * leave exactly one winner.
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
    throw clearanceError(error);
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
