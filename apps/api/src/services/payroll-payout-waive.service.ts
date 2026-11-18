// Finance waives a `settle_skipped` cash handover (bead legend-5qqb9, P2).
//
// A cash payroll handover done while accounting was off ends as `settle_skipped`
// and keeps counting as a pending credit against GL 1102 (the cash left the
// till, nobody may spend it twice). Its catch-up journal is impossible without
// the run's payroll.locked journal, so finance may close it by hand: the kind
// flips `settle_skipped` -> `settle_waived` (terminal, migration 0690), with a
// reason and an audit row.
//
// Round 2: the waive posts a correcting journal in the SAME transaction, so the
// cash that left the till is really booked: Dr salary expense (the account of
// the `salary_expense` role, the one payroll.locked debits) / Cr the 1102 of the
// handover (`source_gl_account_id`), net each, key `payroll-payout-waive:<id>`,
// through the normal poster (period and entry-date rules apply). GL 1102 falls
// by the net and so does the reserve (the net stops counting as a pending
// credit), so the available cash is UNCHANGED. The journal needs accounting ON.
// The generic 1102 guard is NOT used (this credit is already in the reserve, it
// would count twice); instead GL 1102 must cover the net, so it never goes
// negative.
//
// Only for a cash batch whose run has NO locked journal and NO queued
// `payroll.locked` event. Otherwise the resolver (legend-vvzij) catches the
// skipped posting up by itself, and a waive would drop a credit that must be
// journaled (a bank handover is never waivable). Migration 0690 mirrors the
// cash condition in the guard trigger.
//
// Lock order matches `recordPostingSource`: run row, batch row
// (`loadBatchRunFirst`), the legal entity's cash/bank lock and the batch
// advisory lock (`lockBatchPayoutGl`), then the posting row, then the journal
// (its own entity lock is re-entrant). The entity lock is the one every 1102
// coverage check holds while it reads the reserve, so a waive never interleaves
// with a spend that counted the old reserve.

import { and, eq } from "drizzle-orm";
import {
  AccountingError,
  type JournalLineInput,
} from "@starter/shared/accounting";
import type { TenantId } from "@starter/shared/core";
import { accountMappings } from "../db/schema/accounting.ts";
import { payrollPayoutGlPostings } from "../db/schema/payroll-payout.ts";
import {
  glBalanceOf,
  payoutPostingNetIdr,
  pettyCashGlAccount,
} from "./accounting-petty-cash.service.ts";
import { postJournalInTransaction } from "./accounting-journal.service.ts";
import { payrollEntryDateOf } from "./payroll-gl-consumer.ts";
import type { Tx } from "./hris-access.ts";
import {
  glAccountPostable,
  accountingEnabled,
} from "./payroll-payout-setup.ts";
import {
  lockBatchPayoutGl,
  runHasLockedJournal,
  runLockPending,
} from "./payroll-payout-gl.service.ts";
import {
  loadBatchRunFirst,
  payoutGuardViolation,
  payoutRefuse,
  payoutScope,
  recordPayoutAudit,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

/** Postable GL account of the entity's `salary_expense` role (the one payroll.locked debits), or null. */
async function salaryExpenseAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ accountId: accountMappings.accountId })
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, legalEntityId),
        eq(accountMappings.role, "salary_expense"),
      ),
    )
    .limit(1);
  if (!row) return null;
  return (await glAccountPostable(tx, tenantId, legalEntityId, row.accountId))
    ? row.accountId
    : null;
}

export type WaiveSkippedPostingResult = {
  postingId: string;
  kind: "settle_waived";
  /** True when the posting was already waived: nothing changed, no new audit row. */
  alreadyWaived: boolean;
};

/**
 * Waives one `settle_skipped` posting. Any other kind than `settle_skipped` /
 * `settle_waived` answers 409; a posting that is already `settle_waived`
 * answers success without a second flip, journal or audit row. Accounting must
 * be ON now (409 PAYOUT_WAIVE_NOT_ALLOWED otherwise): the journal needs it.
 */
export async function waiveSkippedPosting(
  tx: Tx,
  actor: Actor,
  batchId: string,
  postingId: string,
  reason: string,
): Promise<WaiveSkippedPostingResult> {
  const tenantId = actor.tenantId as TenantId;
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  await lockBatchPayoutGl(tx, tenantId, batch);
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
  if (posting.kind === "settle_waived")
    return {
      postingId: posting.id,
      kind: "settle_waived",
      alreadyWaived: true,
    };
  if (posting.kind !== "settle_skipped")
    throw payoutRefuse(
      409,
      "PAYOUT_POSTING_NOT_SKIPPED",
      "Hanya posting yang dilewati karena akuntansi mati yang bisa dibebaskan.",
    );
  if (
    batch.channel !== "cash" ||
    (await runHasLockedJournal(tx, tenantId, batch.payrollRunId)) ||
    (await runLockPending(tx, tenantId, batch.payrollRunId))
  )
    throw payoutRefuse(
      409,
      "PAYOUT_WAIVE_NOT_ALLOWED",
      "Posting ini tidak bisa dibebaskan. Hanya batch tunai yang run-nya belum punya jurnal kunci gaji dan tidak sedang menunggunya yang boleh; selain itu jurnalnya dibuat otomatis.",
    );
  if (!(await accountingEnabled(tx, tenantId)))
    throw payoutRefuse(
      409,
      "PAYOUT_WAIVE_NOT_ALLOWED",
      "Posting ini tidak bisa dibebaskan selagi akuntansi mati: jurnal koreksinya butuh akuntansi. Nyalakan akuntansi dulu, lalu coba lagi.",
    );
  const netIdr = payoutPostingNetIdr(tenantId, posting);
  if (netIdr <= 0)
    throw payoutRefuse(
      409,
      "PAYOUT_WAIVE_NOT_ALLOWED",
      "Posting ini tidak punya nilai gaji tunai, tidak ada yang perlu dibebaskan.",
    );
  if (posting.sourceGlAccountId === null)
    throw payoutRefuse(
      409,
      "PAYOUT_SOURCE_ACCOUNT_MISSING",
      "Akun kas kecil (1102) serah terima ini tidak tercatat, jadi jurnal koreksinya tidak bisa dibuat. Hubungi tim teknis.",
    );
  // The credit must hit the entity's current petty cash account: that is the
  // account the reserve and every 1102 guard watch.
  if (
    posting.sourceGlAccountId !==
    (await pettyCashGlAccount(tx, tenantId, batch.legalEntityId))
  )
    throw payoutRefuse(
      409,
      "PAYOUT_WAIVE_NOT_ALLOWED",
      "Akun kas kecil (1102) serah terima ini bukan lagi akun kas kecil yang dipetakan, jadi jurnal koreksinya tidak bisa dibuat. Hubungi tim teknis.",
    );
  const expenseAccountId = await salaryExpenseAccount(
    tx,
    tenantId,
    batch.legalEntityId,
  );
  if (expenseAccountId === null)
    throw payoutRefuse(
      409,
      "PAYOUT_SALARY_EXPENSE_MAPPING_MISSING",
      "Akun beban gaji belum dipetakan atau tidak aktif. Atur pemetaan akun beban gaji (salary_expense) di pengaturan akuntansi, lalu coba lagi.",
    );
  // GL 1102 must cover the net so it never goes negative. Not the generic 1102
  // guard: this credit is already in the reserve (settle_skipped counts), the
  // guard would count it twice.
  const glIdr = await glBalanceOf(
    tx,
    tenantId,
    batch.legalEntityId,
    posting.sourceGlAccountId,
  );
  if (glIdr < netIdr)
    throw new AccountingError(
      "PETTY_CASH_GL_INSUFFICIENT",
      `Saldo kas kecil di pembukuan (Rp${glIdr.toLocaleString("id-ID")}) kurang dari gaji tunai yang dibebaskan (Rp${netIdr.toLocaleString("id-ID")}). Isi kas kecil dulu, lalu coba lagi.`,
      {
        glIdr,
        shortIdr: netIdr - glIdr,
        deltaIdr: -netIdr,
      },
    );
  const journal = await postJournalInTransaction(
    tx,
    payoutScope(actor.tenantId),
    {
      legalEntityId: batch.legalEntityId,
      outletId: null,
      entryDate: payrollEntryDateOf(new Date().toISOString()),
      sourceType: "payroll",
      sourceId: batch.payrollRunId,
      description: "Koreksi gaji tunai serah terima tanpa jurnal (dibebaskan)",
      lines: [
        {
          accountId: expenseAccountId,
          debitIdr: netIdr,
          creditIdr: 0,
          outletId: null,
          costCenter: null,
        },
        {
          accountId: posting.sourceGlAccountId,
          debitIdr: 0,
          creditIdr: netIdr,
          outletId: null,
          costCenter: null,
        },
      ] as JournalLineInput[],
      postedBy: null,
      idempotencyKey: `payroll-payout-waive:${posting.id}`,
    },
  );
  try {
    await tx
      .update(payrollPayoutGlPostings)
      .set({ kind: "settle_waived" })
      .where(
        and(
          eq(payrollPayoutGlPostings.tenantId, tenantId),
          eq(payrollPayoutGlPostings.id, posting.id),
          eq(payrollPayoutGlPostings.kind, "settle_skipped"),
        ),
      );
  } catch (error) {
    if (payoutGuardViolation(error) !== null)
      throw payoutRefuse(
        409,
        "PAYOUT_BATCH_STATE_CHANGED",
        "Status batch berubah saat diproses. Coba lagi.",
      );
    throw error;
  }
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.posting_waived",
    objectType: "payroll_disbursement_batch",
    objectId: batch.id,
    reason,
    before: { postingId: posting.id, kind: "settle_skipped" },
    after: {
      postingId: posting.id,
      kind: "settle_waived",
      settleNetIdr: netIdr,
      journalEntryId: journal.id,
    },
  });
  return { postingId: posting.id, kind: "settle_waived", alreadyWaived: false };
}
