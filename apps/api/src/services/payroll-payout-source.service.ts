// Finance records the source account of a payout settlement that has none
// (bead legend-zlcsd; design docs/briefs/881-payout-gl-877-so-fix.md).
//
// A `settle_pending` / `settle_skipped` posting keeps the GL account the money
// left from. A cash handover without a petty cash mapping, or a legacy bank
// batch without a frozen bank account, has none, and the resolver never guesses
// one from today's mapping (that would credit an account the money did not
// leave). Finance names the account here, once: the posting row is opened only
// from null to a value (posting guard PAYOUT-30), and the settlement is then
// resolved in the same transaction (`recoverPayoutGlOfBatch`, idempotent), so
// the source is credited exactly once.
//
// Lock order: run row, batch row (`loadBatchRunFirst`), batch advisory lock,
// then the posting row. Nothing here logs an amount.

import { and, eq, isNull, sql } from "drizzle-orm";
import { AccountingError } from "@starter/shared/accounting";
import type { TenantId } from "@starter/shared/core";
import { logger } from "../lib/logger.ts";
import { chartOfAccounts } from "../db/schema/accounting.ts";
import { payrollPayoutGlPostings } from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import { recoverPayoutGlOfBatch } from "./payroll-payout-gl.service.ts";
import {
  PAYOUT_SOURCE_ACCOUNT_MISSING,
  assertActiveBankGlAccount,
  glAccountPostable,
} from "./payroll-payout-setup.ts";
import {
  loadBatchRunFirst,
  payoutRefuse,
  recordPayoutAudit,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

export type RecordPostingSourceResult = {
  postingId: string;
  /** Settlements this call turned into `settle`. */
  resolved: number;
  /** Bank fees this call journaled. */
  feesReposted: number;
};

/** The GL account is a cash or bank account (report group cash and equivalents). */
async function isCashOrBankAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  glAccountId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, legalEntityId),
        eq(chartOfAccounts.id, glAccountId),
        eq(chartOfAccounts.type, "asset"),
        eq(chartOfAccounts.reportGroup, "cash_and_equivalents"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Records the source GL account of a `settle_pending` / `settle_skipped`
 * posting that has none, then resolves the batch once. A posting that already
 * has a source answers 409 `PAYOUT_SOURCE_ALREADY_RECORDED` (the second call
 * never credits again); a bank batch with a frozen bank account answers 409
 * `PAYOUT_SOURCE_FROZEN` (its source is already fixed). The account must be
 * postable in the batch's legal entity; for a bank batch it must also belong to
 * an active bank account, for cash it must be a cash or bank account of the
 * chart (not any asset account).
 */
export async function recordPostingSource(
  tx: Tx,
  actor: Actor,
  batchId: string,
  postingId: string,
  glAccountId: string,
  now = new Date(),
): Promise<RecordPostingSourceResult> {
  const tenantId = actor.tenantId as TenantId;
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  // The requester never names the source of their own batch (legend-hblpg):
  // refused before any lock, source, journal or audit row is touched.
  if (batch.requestedBy === actor.userId)
    throw payoutRefuse(
      403,
      "PAYOUT_SOURCE_SELF_RECORD",
      "Pembuat batch tidak boleh mencatat sumber dana batchnya sendiri.",
    );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`payroll-payout-gl:${tenantId}:${batch.id}`}))`,
  );
  const [posting] = await tx
    .select()
    .from(payrollPayoutGlPostings)
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.batchId, batch.id),
        eq(payrollPayoutGlPostings.id, postingId),
      ),
    )
    .limit(1)
    .for("update");
  if (!posting)
    throw payoutRefuse(
      404,
      "PAYOUT_POSTING_NOT_FOUND",
      "Posting tidak ditemukan.",
    );
  if (posting.kind !== "settle_pending" && posting.kind !== "settle_skipped")
    throw payoutRefuse(
      409,
      "PAYOUT_POSTING_NOT_RECOVERABLE",
      "Posting ini sudah selesai dijurnal, sumber dananya tidak bisa dicatat.",
    );
  const isCash = batch.channel === "cash";
  if (!isCash && batch.sourceBankAccountId !== null)
    throw payoutRefuse(
      409,
      "PAYOUT_SOURCE_FROZEN",
      "Sumber dana batch ini sudah tercatat dari rekening banknya.",
    );
  if (posting.sourceGlAccountId !== null)
    throw payoutRefuse(
      409,
      "PAYOUT_SOURCE_ALREADY_RECORDED",
      "Sumber dana posting ini sudah dicatat.",
    );

  const usable =
    (await glAccountPostable(tx, tenantId, batch.legalEntityId, glAccountId)) &&
    (isCash
      ? await isCashOrBankAccount(
          tx,
          tenantId,
          batch.legalEntityId,
          glAccountId,
        )
      : true);
  if (!usable)
    throw payoutRefuse(
      409,
      PAYOUT_SOURCE_ACCOUNT_MISSING.code,
      PAYOUT_SOURCE_ACCOUNT_MISSING.message,
    );
  if (!isCash)
    await assertActiveBankGlAccount(
      tx,
      tenantId,
      batch.legalEntityId,
      glAccountId,
    );

  const recorded = await tx
    .update(payrollPayoutGlPostings)
    .set({ sourceGlAccountId: glAccountId })
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, posting.id),
        isNull(payrollPayoutGlPostings.sourceGlAccountId),
      ),
    )
    .returning({ id: payrollPayoutGlPostings.id });
  if (recorded.length !== 1)
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE_CHANGED",
      "Status batch berubah saat diproses. Coba lagi.",
    );
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.posting_source_recorded",
    objectType: "payroll_disbursement_batch",
    objectId: batch.id,
    before: { postingId: posting.id, sourceGlId: null },
    after: { postingId: posting.id, sourceGlId: glAccountId },
  });
  // The recorded source stays even when the resolve cannot post now (for
  // example a closed period): the savepoint keeps the update and the audit, and
  // the periodic recovery retries the settlement.
  try {
    const recovery = await tx.transaction((savepoint) =>
      recoverPayoutGlOfBatch(savepoint, tenantId, batch.id, now),
    );
    return {
      postingId: posting.id,
      resolved: recovery.resolved,
      feesReposted: recovery.feesReposted,
    };
  } catch (error) {
    if (!(error instanceof AccountingError)) throw error;
    logger.warn(
      { tenantId, batchId: batch.id, reason: "resolve_after_source_failed" },
      "payout source recorded, settlement left for the next recovery run",
    );
    return { postingId: posting.id, resolved: 0, feesReposted: 0 };
  }
}
