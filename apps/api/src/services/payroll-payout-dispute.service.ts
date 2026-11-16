// "Not me", batch freeze and unfreeze (legend-l2zru; design
// docs/briefs/918/design-l2zru.md). A person who finds a payout step in their
// name that they did not make disowns that approval-log row; the batch is then
// frozen (an open dispute with no unfreeze row) and every payout step on it is
// refused by the database (PAYOUT-79). An owner or finance person who took no
// part in the batch releases it with a written result of the bank check.
//
// Both writers are trusted SQL functions (`app.payout_approval_disown`,
// `app.payout_batch_unfreeze`, owner `legend_payout`) that spend a one-time
// grant bound to the sha256 of the reason, so a reason changed after the
// step-up is refused (PAYOUT-70). The grant is issued before any batch lock
// (the grantor connection would wait on our own `FOR UPDATE`).
//
// Trusted in-transaction writers: the caller wraps `withTenant`. No amount, name
// or account number leaves this file.

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { TenantId, UserId } from "@starter/shared/core";
import type { PayoutApprovalLogDto } from "@starter/shared/types";
import {
  payrollDisbursementBatches,
  payrollPayoutApprovalLog,
  payrollPayoutBatchDisputes,
  payrollPayoutBatchUnfreezes,
} from "../db/schema/payroll-payout.ts";
import { payrollRuns } from "../db/schema/payroll.ts";
import { AccountingError } from "@starter/shared/accounting";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import type { Tx } from "./hris-access.ts";
import {
  isPayoutUuid,
  payoutRefuse,
  payoutTrustedGrant,
  readBatch,
  recordPayoutAudit,
  type PayoutActor,
} from "./payroll-payout.service.ts";
import { batchIsNotFrozenSql } from "./payroll-payout-freeze-sql.ts";
import { recoverPayoutGlOfBatch } from "./payroll-payout-gl.service.ts";
import { settleRunAndAnnounce } from "./payroll-payout-manual.service.ts";

const logNotFound = () =>
  payoutRefuse(
    404,
    "PAYOUT_APPROVAL_LOG_NOT_FOUND",
    "Catatan persetujuan tidak ditemukan.",
  );

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

function messageHas(error: unknown, pattern: RegExp, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { message?: unknown; cause?: unknown };
  return (
    (typeof candidate.message === "string" &&
      pattern.test(candidate.message)) ||
    messageHas(candidate.cause, pattern, depth + 1)
  );
}

/** The refusal codes of the two trusted functions, as client errors. */
function disputeError(error: unknown): unknown {
  // PAYOUT-81: not the actor of that log row (or the row is gone).
  if (messageHas(error, /PAYOUT-81:/)) return logNotFound();
  // PAYOUT-82: nobody may unfreeze it (role, part in the batch, no open dispute).
  if (messageHas(error, /PAYOUT-82:/))
    return payoutRefuse(
      409,
      "PAYOUT_UNFREEZE_REFUSED",
      "Pembekuan batch ini tidak dapat dibuka oleh Anda, atau batch tidak sedang beku.",
    );
  return error;
}

/**
 * The page the receipt notification links to: one payout step of the caller.
 * Anyone else, a missing row or a malformed id answers 404 alike.
 */
export async function getPayoutApprovalLog(
  tx: Tx,
  actor: PayoutActor,
  logId: string,
): Promise<PayoutApprovalLogDto> {
  if (!isPayoutUuid(logId)) throw logNotFound();
  const tenantId = actor.tenantId as TenantId;
  const userId = actor.userId as UserId;
  const [log] = await tx
    .select({
      id: payrollPayoutApprovalLog.id,
      batchId: payrollPayoutApprovalLog.batchId,
      kind: payrollPayoutApprovalLog.kind,
      step: payrollPayoutApprovalLog.step,
      itemCount: payrollPayoutApprovalLog.itemCount,
      loggedAt: payrollPayoutApprovalLog.loggedAt,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
    })
    .from(payrollPayoutApprovalLog)
    .innerJoin(
      payrollDisbursementBatches,
      and(
        eq(
          payrollDisbursementBatches.tenantId,
          payrollPayoutApprovalLog.tenantId,
        ),
        eq(payrollDisbursementBatches.id, payrollPayoutApprovalLog.batchId),
      ),
    )
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payrollDisbursementBatches.tenantId),
        eq(payrollRuns.id, payrollDisbursementBatches.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payrollPayoutApprovalLog.tenantId, tenantId),
        eq(payrollPayoutApprovalLog.id, logId),
        eq(payrollPayoutApprovalLog.actor, userId),
      ),
    );
  if (!log) throw logNotFound();
  const [mine] = await tx
    .select({ id: payrollPayoutBatchDisputes.id })
    .from(payrollPayoutBatchDisputes)
    .where(
      and(
        eq(payrollPayoutBatchDisputes.tenantId, tenantId),
        eq(payrollPayoutBatchDisputes.logId, logId),
      ),
    )
    .limit(1);
  // Frozen as the whole system reads it: an open dispute on this batch or on a
  // batch of the same payslips (the retry batch).
  const open = await tx.execute(
    sql`SELECT 1 AS open WHERE ${batchIsNotFrozenSql(tenantId, sql`${log.batchId}::uuid`)}`,
  );
  return {
    id: log.id,
    batchId: log.batchId,
    kind: log.kind,
    step: log.step,
    itemCount: log.itemCount,
    period: `${log.periodStart} sampai ${log.periodEnd}`,
    loggedAt: log.loggedAt.toISOString(),
    disowned: mine !== undefined,
    batchFrozen: open.rows.length === 0,
  };
}

export type DisownResult = { disputeId: string; batchId: string };

/**
 * "Not me": freezes the batch of the caller's own approval-log row. Needs no
 * payroll permission (a revoked approver can still say it); the password
 * step-up and the grant are the proof. Repeating returns the same dispute id.
 * Allowed on a final or an already frozen batch.
 */
export async function disownPayoutApproval(
  tx: Tx,
  actor: PayoutActor,
  logId: string,
  input: { reason?: string },
): Promise<DisownResult> {
  if (!isPayoutUuid(logId)) throw logNotFound();
  const tenantId = actor.tenantId as TenantId;
  const userId = actor.userId as UserId;
  // Only the caller's own row is read, so another user's row answers 404 here
  // and no grant is spent on it (the grant and the function refuse it too).
  const [log] = await tx
    .select({
      id: payrollPayoutApprovalLog.id,
      batchId: payrollPayoutApprovalLog.batchId,
    })
    .from(payrollPayoutApprovalLog)
    .where(
      and(
        eq(payrollPayoutApprovalLog.tenantId, tenantId),
        eq(payrollPayoutApprovalLog.id, logId),
        eq(payrollPayoutApprovalLog.actor, userId),
      ),
    );
  if (!log) throw logNotFound();
  const reason = input.reason ?? null;
  // Before the batch lock: the grantor connection waits on a held FOR UPDATE.
  const grant = await payoutTrustedGrant(actor, {
    kind: "disown",
    step: "record",
    batchId: log.batchId,
    itemIds: [],
    evidenceKey: null,
    refId: log.id,
    targetId: null,
    detail: sha256Hex(reason ?? ""),
  });
  let disputeId: string;
  try {
    const result = await tx.execute(
      sql`SELECT app.payout_approval_disown(${log.id}::uuid, ${grant}, ${reason}::text) AS id`,
    );
    disputeId = String((result.rows[0] as { id: string }).id);
  } catch (error) {
    throw disputeError(error);
  }
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.batch_disowned",
    objectType: "payroll_disbursement_batch",
    objectId: log.batchId,
    reason,
    before: {},
    after: { outcome: "disowned" },
  });
  return { disputeId, batchId: log.batchId };
}

export type UnfreezeResult = { released: number };

/**
 * After a freeze ended (920): the batch and the batches that shared a payslip
 * with it (and are not frozen by another dispute) may have had their GL postings
 * and the run's `paid` turn held back while the dispute was open. Recover each
 * one in a savepoint (a posting that is not ready stays for the recovery job,
 * it never blocks the unfreeze), then try to turn the run paid. Lock order is
 * kept: the unfreeze SQL already holds the run row; batches go in id order.
 */
async function catchUpAfterUnfreeze(
  tx: Tx,
  actor: PayoutActor,
  batchId: string,
): Promise<void> {
  const tenantId = actor.tenantId;
  const result = await tx.execute(sql`
    SELECT DISTINCT b.id
      FROM payroll_disbursement_items mine
      JOIN payroll_disbursement_items sibling
        ON sibling.tenant_id = mine.tenant_id
       AND sibling.payslip_id = mine.payslip_id
      JOIN payroll_disbursement_batches b
        ON b.tenant_id = sibling.tenant_id AND b.id = sibling.batch_id
     WHERE mine.tenant_id = ${tenantId}::uuid AND mine.batch_id = ${batchId}::uuid
       AND ${batchIsNotFrozenSql(tenantId, sql`b.id`)}
     ORDER BY b.id`);
  // The query already holds the batch itself (it shares its own payslips) when
  // it is not frozen. Never add it by hand: a batch still frozen through the
  // dispute of a sibling must not reach `payout_run_settle` (PAYOUT-79 would
  // roll the whole unfreeze back and two mutual disputes could never be lifted).
  const ids = new Set((result.rows as { id: string }[]).map((r) => r.id));
  let announced = false;
  for (const id of [...ids].sort()) {
    try {
      await tx.transaction((savepoint) =>
        recoverPayoutGlOfBatch(savepoint, tenantId as TenantId, id),
      );
    } catch (error) {
      if (!(error instanceof HttpError || error instanceof AccountingError))
        throw error;
      logger.warn(
        { tenantId, batchId: id, reason: "unfreeze_recovery_not_ready" },
        "payout GL recovery after unfreeze left for later",
      );
    }
    if (announced) continue;
    const row = await readBatch(tx, tenantId, id);
    if (row.status === "completed" || row.status === "partially_failed")
      announced = await settleRunAndAnnounce(tx, actor, row, new Date());
  }
}

/**
 * Releases every open dispute of the batch. The reason (10 to 500 characters)
 * is the result of finance's check at the bank. The function refuses anyone
 * who took part in the batch (409 PAYOUT_UNFREEZE_REFUSED), except a person
 * withdrawing their own claim, and a batch with no open dispute.
 */
export async function unfreezeDisbursementBatch(
  tx: Tx,
  actor: PayoutActor,
  batchId: string,
  input: { reason: string },
): Promise<UnfreezeResult> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500)
    throw payoutRefuse(
      422,
      "PAYOUT_UNFREEZE_REASON_INVALID",
      "Hasil pemeriksaan wajib diisi (10 sampai 500 karakter).",
    );
  // 404 for a batch of another tenant or a malformed id, before any grant.
  const batch = await readBatch(tx, actor.tenantId, batchId);
  const grant = await payoutTrustedGrant(actor, {
    kind: "unfreeze",
    step: "approve",
    batchId: batch.id,
    itemIds: [],
    evidenceKey: null,
    refId: null,
    targetId: null,
    detail: sha256Hex(reason),
  });
  let released: number;
  try {
    const result = await tx.execute(
      sql`SELECT app.payout_batch_unfreeze(${batch.id}::uuid, ${grant}, ${reason}::text) AS n`,
    );
    released = Number((result.rows[0] as { n: number }).n);
  } catch (error) {
    throw disputeError(error);
  }
  // The SQL function reopens an approved batch whose main approval was disowned
  // ("not me"): same transaction, so before/after status are consistent.
  const after = await readBatch(tx, actor.tenantId, batch.id);
  if (batch.status === "approved" && after.status === "pending_approval") {
    const lifted = await tx
      .select({ id: payrollPayoutBatchUnfreezes.disputeId })
      .from(payrollPayoutBatchUnfreezes)
      .where(
        and(
          eq(payrollPayoutBatchUnfreezes.tenantId, actor.tenantId as TenantId),
          eq(payrollPayoutBatchUnfreezes.batchId, batch.id),
          sql`${payrollPayoutBatchUnfreezes.txid} = pg_catalog.txid_current()`,
        ),
      );
    for (const row of lifted) {
      await recordPayoutAudit(tx, actor, {
        action: "payroll.disbursement.batch_reopened",
        objectType: "payroll_disbursement_batch",
        objectId: batch.id,
        reason,
        before: { status: batch.status },
        after: {
          status: after.status,
          outcome: "main_approval_cancelled",
          disputeId: row.id,
        },
      });
    }
  }
  await catchUpAfterUnfreeze(tx, actor, batch.id);
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.batch_unfrozen",
    objectType: "payroll_disbursement_batch",
    objectId: batch.id,
    reason,
    before: { status: batch.status },
    after: { outcome: "unfrozen", resolved: released },
  });
  return { released };
}
