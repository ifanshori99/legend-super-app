// Finance resolves a payout GL posting that the system holds for them (beads
// legend-3xzop and legend-6qp12; sub-brief docs/briefs/sub-1184-payout-gl-holds.md).
//
// 1. `markFeeInOpeningBalance`: a `settle_skipped` posting whose bank fee is
//    listed as `accounting_was_off` may already sit in the opening balance, so
//    a fee journal could double the expense. Finance (a second person, never
//    the batch requester) marks the fee as already counted. NO journal is
//    written: the mark only stops every fee path from journaling that fee
//    (the GL service reads `fee_opening_balance_at`). The net/settle journal of
//    the same posting is untouched.
// 2. `releasePayableHold`: a settled posting held with `payable_account_hold`
//    (0390 backfill: payable account uncertain) is released by finance. The
//    release writes no journal; the posting re-enters the normal flow, which
//    uses the account frozen on the posting, never today's mapping. A row
//    without a frozen account is refused, and so is a row whose settle journal
//    is missing or debited another account than the frozen one (the 0390 test
//    that put it on hold), so a release can never open the door to a guessed
//    account.
//
// Both: one transaction, lock order run row, batch row (`loadBatchRunFirst`),
// the legal entity lock and batch advisory lock (`lockBatchPayoutGl`), then
// the posting row. The conditional UPDATE (null -> set, true -> false) is the
// second guard: of two concurrent calls exactly one flips the row. The time
// comes from the database clock. The audit note is the finance reason; no
// amount, name or account number is written.

import { and, eq, sql } from "drizzle-orm";
import type { TenantId, UserId } from "@starter/shared/core";
import { journalEntries, journalLines } from "../db/schema/accounting.ts";
import { payrollPayoutGlPostings } from "../db/schema/payroll-payout.ts";
import type { Tx } from "./hris-access.ts";
import {
  batchIsFrozen,
  lockBatchPayoutGl,
  payoutRecoveryReason,
} from "./payroll-payout-gl.service.ts";
import {
  batchFrozen,
  isPayoutUuid,
  loadBatchRunFirst,
  payoutRefuse,
  recordPayoutAudit,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

export type PayoutGlResolveResult = {
  postingId: string;
  /** ISO datetime stamped by the database clock. */
  resolvedAt: string;
};

const notFound = () =>
  payoutRefuse(
    404,
    "PAYOUT_GL_POSTING_NOT_FOUND",
    "Posting jurnal pembayaran gaji tidak ditemukan.",
  );

const alreadyResolved = () =>
  payoutRefuse(
    409,
    "PAYOUT_GL_ALREADY_RESOLVED",
    "Posting ini sudah diselesaikan.",
  );

/**
 * Locks run, batch, entity/batch GL and the posting (in that order) and
 * refuses the batch requester. A posting of another tenant, or a malformed id,
 * is 404 before any lock beyond the tenant-filtered read.
 */
async function lockPostingForResolve(tx: Tx, actor: Actor, postingId: string) {
  const tenantId = actor.tenantId as TenantId;
  if (!isPayoutUuid(postingId)) throw notFound();
  const [peek] = await tx
    .select({ batchId: payrollPayoutGlPostings.batchId })
    .from(payrollPayoutGlPostings)
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, postingId),
      ),
    )
    .limit(1);
  if (!peek) throw notFound();
  const batch = await loadBatchRunFirst(tx, actor.tenantId, peek.batchId);
  // The person who requested the batch never resolves its GL holds
  // (second-person rule): refused before any lock, update or audit row.
  if (batch.requestedBy === actor.userId)
    throw payoutRefuse(
      403,
      "PAYOUT_GL_SELF_APPROVAL",
      "Pembuat batch tidak boleh menyelesaikan posting jurnal batchnya sendiri.",
    );
  await lockBatchPayoutGl(tx, tenantId, batch);
  const [posting] = await tx
    .select()
    .from(payrollPayoutGlPostings)
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, postingId),
        eq(payrollPayoutGlPostings.batchId, batch.id),
      ),
    )
    .limit(1)
    .for("update");
  if (!posting) throw notFound();
  return { tenantId, batch, posting };
}

/**
 * Marks the bank fee of an `accounting_was_off` posting as already part of the
 * opening balance. No journal. 404 unknown posting; 403 requester; 409
 * `PAYOUT_GL_ALREADY_RESOLVED` when marked (also when a concurrent call won);
 * 409 `PAYOUT_GL_NOT_ACCOUNTING_WAS_OFF` when the live reason is anything else.
 */
export async function markFeeInOpeningBalance(
  tx: Tx,
  actor: Actor,
  postingId: string,
  note: string,
): Promise<PayoutGlResolveResult> {
  const { tenantId, batch, posting } = await lockPostingForResolve(
    tx,
    actor,
    postingId,
  );
  if (posting.feeOpeningBalanceAt !== null) throw alreadyResolved();
  const reason = await payoutRecoveryReason(tx, tenantId, batch, posting);
  if (reason !== "accounting_was_off")
    throw payoutRefuse(
      409,
      "PAYOUT_GL_NOT_ACCOUNTING_WAS_OFF",
      "Biaya bank posting ini tidak sedang menunggu keputusan saldo awal.",
    );
  // A 0428 trigger refuses any change to a frozen batch's postings; answer
  // the same 409 as the other payout steps instead of a raw guard error.
  if (await batchIsFrozen(tx, tenantId, batch.id)) throw batchFrozen();
  const [marked] = await tx
    .update(payrollPayoutGlPostings)
    .set({
      feeOpeningBalanceAt: sql`now()`,
      feeOpeningBalanceBy: actor.userId as UserId,
      feeOpeningBalanceNote: note,
    })
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, posting.id),
        sql`${payrollPayoutGlPostings.feeOpeningBalanceAt} IS NULL`,
      ),
    )
    .returning({ at: payrollPayoutGlPostings.feeOpeningBalanceAt });
  if (!marked?.at) throw alreadyResolved();
  await recordPayoutAudit(tx, actor, {
    action: "payroll.payout_gl_fee.opening_balance_marked",
    objectType: "payroll_payout_gl_posting",
    objectId: posting.id,
    reason: note,
    before: { postingId: posting.id, status: "accounting_was_off" },
    after: { postingId: posting.id, status: "opening_balance_marked" },
  });
  return { postingId: posting.id, resolvedAt: marked.at.toISOString() };
}

/**
 * Releases `payable_account_hold`, once, with a finance note. No journal. 409
 * `PAYOUT_GL_ALREADY_RESOLVED` when not held (or a concurrent call won); 409
 * `PAYOUT_PAYABLE_ACCOUNT_UNKNOWN` when no frozen account exists or the settle
 * journal is missing / does not debit exactly the frozen account; 409
 * `PAYOUT_BATCH_FROZEN` while the batch is frozen.
 */
export async function releasePayableHold(
  tx: Tx,
  actor: Actor,
  postingId: string,
  note: string,
): Promise<PayoutGlResolveResult> {
  const { tenantId, batch, posting } = await lockPostingForResolve(
    tx,
    actor,
    postingId,
  );
  if (!posting.payableAccountHold) throw alreadyResolved();
  // The posting guard requires the frozen account on every kind, and the
  // return path never falls back to today's mapping: no frozen account, no
  // release.
  const unproven = () =>
    payoutRefuse(
      409,
      "PAYOUT_PAYABLE_ACCOUNT_UNKNOWN",
      "Akun utang gaji posting ini belum terbukti, jadi penahanan belum bisa dilepas. Rekonsiliasi dulu.",
    );
  if (posting.salariesPayableAccountId === null) throw unproven();
  // Proof (mirrors the 0390 "proven" test and the 0504 guard): the settle
  // journal exists, debits the frozen account, and no debit line is on another
  // account. A row whose settle debited another account stays held.
  const debits = await tx
    .select({ accountId: journalLines.accountId })
    .from(journalEntries)
    .innerJoin(
      journalLines,
      and(
        eq(journalLines.tenantId, journalEntries.tenantId),
        eq(journalLines.entryId, journalEntries.id),
      ),
    )
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, posting.journalKey),
        sql`${journalLines.debitIdr} > 0`,
      ),
    );
  if (
    debits.length === 0 ||
    debits.some((d) => d.accountId !== posting.salariesPayableAccountId)
  )
    throw unproven();
  if (await batchIsFrozen(tx, tenantId, batch.id)) throw batchFrozen();
  const [released] = await tx
    .update(payrollPayoutGlPostings)
    .set({
      payableAccountHold: false,
      payableHoldReleasedAt: sql`now()`,
      payableHoldReleasedBy: actor.userId as UserId,
      payableHoldReleaseNote: note,
    })
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, posting.id),
        eq(payrollPayoutGlPostings.payableAccountHold, true),
      ),
    )
    .returning({ at: payrollPayoutGlPostings.payableHoldReleasedAt });
  if (!released?.at) throw alreadyResolved();
  await recordPayoutAudit(tx, actor, {
    action: "payroll.payout_gl_payable_hold.released",
    objectType: "payroll_payout_gl_posting",
    objectId: posting.id,
    reason: note,
    before: { postingId: posting.id, status: "payable_account_unknown" },
    after: { postingId: posting.id, status: "payable_hold_released" },
  });
  return { postingId: posting.id, resolvedAt: released.at.toISOString() };
}
