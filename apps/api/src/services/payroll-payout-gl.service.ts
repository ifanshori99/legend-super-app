// Payroll payout -> GL (bead legend-658 card wnkep.5; design
// docs/design/payroll-disbursement.md 4.6, 6 R9/R10, 7.7-7.9, 8; tests
// apps/api/src/test/payroll-payout-gl.test.ts).
//
// Money rules held here (nobody is paid twice, the PT does not lose):
// - R10: the ledger is credited exactly once. Every `succeeded` item without a
//   posting is settled by `settleBatchPayouts` under the batch advisory lock:
//   one journal `payroll-payout:<item_set_hash>` (Dr salaries_payable / Cr the
//   source account) for the group, one posting row, and every item of the group
//   linked to it in the same transaction. The count of linked items must equal
//   the count selected, else the whole transaction rolls back. A replay finds
//   no unlinked item and posts nothing; the journal key and the unique
//   `journal_key` of the posting are the second and third guard.
// - R9: the bank fee is borne by the PT (Q15). It is its own journal
//   `payroll-payout-fee:<item_set_hash>` (Dr bank_charges / Cr the source
//   account), from the fee stored per item at export, for succeeded items only.
//   It never reduces the salary payable or anyone's net pay. The fee is posted
//   automatically (finance does not record it apart), so it is also posted
//   when the salary journal is skipped, as long as accounting is on.
// - A return (funds came back after success, 7.8) reverses the item's net
//   exactly once: `payroll-payout-return:<itemId>` (Dr source account / Cr
//   salaries_payable). It credits the account the batch's own settle journal
//   used, not the account the config points at today. The fee is not
//   refunded: the bank keeps it.
// - A run without a locked journal (accounting switched on after the lock) has
//   no payable to settle: the items are linked to a `settle_skipped` posting,
//   no salary journal is posted, and the settle never retries.
// - A run whose `payroll.locked` event still waits in the outbox (accounting
//   on, the lock journal not posted yet, legend-2aspe) is NOT skipped: the items
//   are linked to a `settle_pending` posting (no journal yet). The GL consumer
//   calls `resolvePendingSettles` right after it posts the locked journal: the
//   payout journal then posts under the same settle key (Cr source account
//   exactly the sealed net, clears 2103) and the posting becomes `settle`. A
//   replay finds no pending posting and adds nothing. The pending resolution
//   never depends on the accounting flag: money already left, so the consumer
//   still journals the lock of a run that has a pending settlement even if
//   accounting was switched off afterwards (`runHasPendingSettle`, legend-2aspe).
//   A pending or skipped CASH settlement stores the petty cash account mapped
//   at the handover (`source_gl_account_id`, legend-cnpap, legend-zlcsd; a
//   skipped one stores it even when not postable) and resolves to it, never to
//   a mapping changed later. A pending cash settlement with no postable mapping
//   refuses 409 PAYOUT_SOURCE_ACCOUNT_MISSING before anything is recorded.
//   The resolver never throws for a source it cannot use (none stored, not
//   postable, bank legacy batch without a frozen account and without a recorded
//   one): the posting is left as is, the consumer and the outbox are not held,
//   and `listPayoutRecovery` tells finance why (`postingSource`).
//   The bank fee of a pending or skipped settlement is journaled when it
//   resolves (the posting says `fee_posted = false` until then; same key, so
//   exactly once), from the frozen bank account; a missing bank charges mapping
//   leaves `fee_posted = false` for the recovery job (`recoverPayoutGlOfBatch`)
//   or `repostSkippedFees`, it never blocks a pending resolve.
//   A `settle_skipped` posting with a real net (money left while accounting was
//   off) is turned into `settle` the same way once the consumer has posted the
//   lock journal (legend-vvzij), so 2103 of that batch does not stay open. If
//   no source account can be resolved, it stays skipped.
// - The salaries payable account is the one the run's LOCK journal credited
//   (legend-wcd24, migration 0390), frozen on the posting
//   (`salaries_payable_account_id`). Settle, resolve of a pending settle and
//   return use it through the `salaries_payable` account override, never
//   today's mapping. Taken from the lock journal's account snapshot; not
//   provable (or not postable) keeps a settlement pending, and a settled legacy
//   posting whose account is uncertain is held (`payable_account_hold`): its
//   return is refused (409) and the list shows `payable_account_unknown`.
// - `payroll.paid` leaves the outbox once, when the run turned paid, with
//   `settledPerItem: true`: the GL consumer posts nothing for it.
//
// Lock order: the run row, then the batch row (`loadBatchRunFirst`), then the
// legal entity's cash/bank lock (`entityLock`, shared with the petty cash
// return, legend-3k9qg), then the batch advisory lock (`lockBatchPayoutGl`
// takes both, in that order). The caller's transaction is the unit: a throw rolls back
// every row and every journal. Amounts are sealed; nothing here logs one.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { AccountingError } from "@starter/shared/accounting";
import type { TenantId } from "@starter/shared/core";
import {
  payrollPaid,
  type PayrollRunId,
  type PayrollRunType,
} from "@starter/shared/hris/payroll";
import {
  accountMappings,
  journalEntries,
  journalLines,
} from "../db/schema/index.ts";
import { bankAccounts } from "../db/schema/accounting-cash-bank.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { payrollRuns } from "../db/schema/payroll.ts";
import {
  payrollDisbursementBatches,
  payrollDisbursementItems,
  payrollPayoutGlPostings,
  type PayoutPostingKind,
} from "../db/schema/payroll-payout.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  openPayrollValue,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import type { Tx } from "./hris-access.ts";
import { payrollEntryDateOf, payrollGlKeys } from "./payroll-gl-consumer.ts";
import { emitPayrollEvent } from "./payroll-events.ts";
import {
  loadBatchRunFirst,
  openItemAmount,
  openItemFee,
  payoutRefuse,
  payoutScope,
  type BatchRow,
  type ItemRow,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";
import { batchIsNotFrozenSql } from "./payroll-payout-freeze-sql.ts";
import {
  PAYOUT_BANK_CHARGES_MAPPING_MISSING,
  PAYOUT_SOURCE_ACCOUNT_MISSING,
  accountingEnabled,
  assertActiveBankGlAccount,
  activeSourceGlAccount,
  assertManualPayoutSetup,
  bankChargesMapped,
  frozenSourceGlAccount,
  glAccountPostable,
  settledSourceAccount,
} from "./payroll-payout-setup.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const payoutGlKeys = {
  settle: (hash: string) => `payroll-payout:${hash}`,
  fee: (hash: string) => `payroll-payout-fee:${hash}`,
  return: (itemId: string) => `payroll-payout-return:${itemId}`,
};

export type SettleResult = {
  /** The posting row of this call; null when nothing was waiting. */
  postingId: string | null;
  kind: PayoutPostingKind | null;
  /** Items linked to a posting by this call. */
  settled: number;
};

const itemSetHash = (itemIds: readonly string[]) =>
  createHash("sha256")
    .update([...itemIds].sort().join("\n"))
    .digest("hex");

/** Whole-rupiah amount of a sealed value; a tampered value throws. */
function safeAmount(read: () => number): number {
  const value = Number(read());
  if (!Number.isSafeInteger(value) || value < 0)
    throw payoutRefuse(
      422,
      "PAYROLL_BANK_ACCOUNT_UNREADABLE",
      "Data pembayaran tidak bisa dibaca, jurnal tidak diposting.",
    );
  return value;
}

/**
 * The GL account of the company bank account a manual file is paid from, as
 * the `bank` role override of the journal. Null for cash (the petty cash role).
 */
async function sourceBankOverride(
  tx: Tx,
  tenantId: TenantId,
  batch: Pick<BatchRow, "channel" | "legalEntityId" | "sourceBankAccountId">,
  options: { optional?: boolean; requireFrozen?: boolean } = {},
): Promise<Partial<Record<"bank", string>> | undefined | null> {
  if (batch.channel === "cash") return undefined;
  // A batch with a frozen account keeps it, whatever the config says now
  // (legend-hkh57); only a legacy batch without one follows the config.
  if (batch.sourceBankAccountId !== null) {
    const frozen = await frozenSourceGlAccount(
      tx,
      tenantId,
      batch.legalEntityId,
      batch.sourceBankAccountId,
      options.optional ? { optional: true } : undefined,
    );
    return frozen === null ? null : { bank: frozen };
  }
  // A late posting (fee re-post) of a batch with no frozen account never
  // follows today's config: the most restrictive rule is to refuse.
  if (options.requireFrozen)
    throw payoutRefuse(
      409,
      PAYOUT_SOURCE_ACCOUNT_MISSING.code,
      PAYOUT_SOURCE_ACCOUNT_MISSING.message,
    );
  // `optional`: the caller can go on without the account (answered with null).
  const glAccountId = await activeSourceGlAccount(
    tx,
    tenantId,
    batch.legalEntityId,
    options.optional ? { optional: true } : undefined,
  );
  return glAccountId === null ? null : { bank: glAccountId };
}

export async function runHasLockedJournal(
  tx: Tx,
  tenantId: TenantId,
  runId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, payrollGlKeys.locked(runId)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function journalKeyExists(
  tx: Tx,
  tenantId: TenantId,
  idempotencyKey: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * True when the fee journal of the posting moves exactly its fee on the right
 * accounts (897 F6): the same check the posting guard runs before it lets
 * `fee_posted` turn true. Run before every flip so a journal that fails it is
 * left for finance instead of answering a guard error.
 */
async function feeJournalOk(
  tx: Tx,
  tenantId: TenantId,
  postingId: string,
): Promise<boolean> {
  const result = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.payout_fee_journal_ok(${tenantId}::uuid, ${postingId}::uuid) AS ok`,
  );
  return result.rows[0]?.ok === true;
}

const PAYOUT_FEE_JOURNAL_MISMATCH = {
  code: "PAYOUT_FEE_JOURNAL_MISMATCH",
  message:
    "Jurnal biaya transfer batch ini tidak cocok dengan nominal atau akun yang seharusnya, jadi tidak ditandai selesai. Hubungi tim keuangan.",
} as const;

/**
 * True while the posting's fee is owed in the journal but its fee journal
 * exists and fails `feeJournalOk`: permanent, a human decides.
 */
async function feeJournalMismatched(
  tx: Tx,
  tenantId: TenantId,
  posting: FeePosting,
): Promise<boolean> {
  return (
    !posting.feePosted &&
    postingFeeIdr(posting, tenantId) > 0 &&
    (await journalKeyExists(
      tx,
      tenantId,
      payoutGlKeys.fee(posting.itemSetHash),
    )) &&
    !(await feeJournalOk(tx, tenantId, posting.id))
  );
}

/**
 * True while the run's `payroll.locked` event is still in the outbox (not
 * delivered): the lock happened, the GL consumer has not posted its journal
 * yet. A delivered event that left no journal (all-zero run, accounting off at
 * that time) is not pending.
 */
export async function runLockPending(
  tx: Tx,
  tenantId: TenantId,
  runId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: domainEventOutbox.id })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.aggregateId, runId),
        sql`${domainEventOutbox.status} <> 'delivered'`,
        sql`${domainEventOutbox.event}->>'name' = 'payroll.locked'`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * True while the run's locked journal is missing but its `payroll.locked` event
 * is still in the outbox, whatever the accounting switch says now. A journal
 * that cannot be posted now (overpaid second transfer) must wait for it: the
 * event may be posted later (accounting switched on again, or a pending
 * settlement), and a second transfer recorded meanwhile would never reach the
 * GL (legend-8vcsg). A delivered event that left no journal is not pending.
 */
export async function lockJournalPending(
  tx: Tx,
  tenantId: TenantId,
  runId: string,
): Promise<boolean> {
  return (
    !(await runHasLockedJournal(tx, tenantId, runId)) &&
    (await runLockPending(tx, tenantId, runId))
  );
}

/**
 * True when the run has at least one `settle_pending` payout posting: money
 * already left for a payable whose lock journal is not posted yet. The GL
 * consumer then journals `payroll.locked` even with accounting switched off
 * since (legend-2aspe); the flag only decides NEW payroll.
 */
export async function runHasPendingSettle(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: payrollPayoutGlPostings.id })
    .from(payrollPayoutGlPostings)
    .innerJoin(
      payrollDisbursementBatches,
      and(
        eq(
          payrollDisbursementBatches.tenantId,
          payrollPayoutGlPostings.tenantId,
        ),
        eq(payrollDisbursementBatches.id, payrollPayoutGlPostings.batchId),
      ),
    )
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.kind, "settle_pending"),
        eq(payrollDisbursementBatches.payrollRunId, runId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The GL account the `petty_cash` role maps to for the entity right now, or
 * null when there is none. A pending cash settlement stores it at the handover
 * (legend-cnpap).
 */
async function mappedPettyCashAccount(
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
        eq(accountMappings.role, "petty_cash"),
      ),
    )
    .limit(1);
  return row?.accountId ?? null;
}

/** GL account of the frozen source bank account of a non-cash batch, read WITHOUT the active filter (null: cash, no frozen account, or missing). */
async function frozenBatchGlAccount(
  tx: Tx,
  tenantId: TenantId,
  batch: Pick<BatchRow, "channel" | "legalEntityId" | "sourceBankAccountId">,
): Promise<string | null> {
  if (batch.channel === "cash" || batch.sourceBankAccountId === null)
    return null;
  const [row] = await tx
    .select({ glAccountId: bankAccounts.glAccountId })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.tenantId, tenantId),
        eq(bankAccounts.legalEntityId, batch.legalEntityId),
        eq(bankAccounts.id, batch.sourceBankAccountId),
      ),
    )
    .limit(1);
  return row?.glAccountId ?? null;
}

/**
 * F4: a settlement of a non-cash batch with a frozen bank account carries that
 * account's GL account as its source. A historical row without one is filled
 * (NULL -> frozen only; the guard refuses any other account).
 */
async function fillFrozenSource(
  tx: Tx,
  tenantId: TenantId,
  batch: Pick<BatchRow, "channel" | "legalEntityId" | "sourceBankAccountId">,
  posting: { id: string; sourceGlAccountId: string | null },
): Promise<void> {
  if (posting.sourceGlAccountId !== null) return;
  const frozen = await frozenBatchGlAccount(tx, tenantId, batch);
  if (frozen === null) return;
  await tx
    .update(payrollPayoutGlPostings)
    .set({ sourceGlAccountId: frozen })
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, posting.id),
        isNull(payrollPayoutGlPostings.sourceGlAccountId),
      ),
    );
}

type SettleSource =
  | { ok: true; overrides: Partial<Record<"bank" | "petty_cash", string>> }
  | { ok: false; reason: "source_account_unknown" | "source_account_inactive" };

/**
 * The account a pending/skipped settlement is credited to (legend-pfk3q,
 * legend-zlcsd). It is NEVER today's mapping or config: the money left from
 * the account known at the handover, so a later remap cannot move the credit.
 * Read-only; never throws for a configuration problem, it answers why.
 * - Cash: the petty cash account stored on the posting at the handover. None
 *   stored: `source_account_unknown`; stored but not postable now:
 *   `source_account_inactive` (it resolves once finance activates it).
 * - Bank with a frozen source bank account: that account's GL account, read
 *   WITHOUT the active filter (a bank account deactivated since the payout
 *   still holds the money trail); missing: unknown; not postable: inactive.
 * - Legacy bank without a frozen account: the account finance recorded on the
 *   posting (`recordPostingSource`); none: unknown; not postable: inactive.
 */
async function postingSource(
  tx: Tx,
  tenantId: TenantId,
  batch: Pick<BatchRow, "channel" | "legalEntityId" | "sourceBankAccountId">,
  posting: { sourceGlAccountId: string | null },
): Promise<SettleSource> {
  const frozenGl = await frozenBatchGlAccount(tx, tenantId, batch);
  const accountId =
    batch.channel !== "cash" && batch.sourceBankAccountId !== null
      ? frozenGl
      : posting.sourceGlAccountId;
  if (accountId === null)
    return { ok: false, reason: "source_account_unknown" };
  if (!(await glAccountPostable(tx, tenantId, batch.legalEntityId, accountId)))
    return { ok: false, reason: "source_account_inactive" };
  return {
    ok: true,
    overrides:
      batch.channel === "cash"
        ? { petty_cash: accountId }
        : { bank: accountId },
  };
}

/** Why the salaries payable account of a settlement cannot be used (yet). */
export type PayableAccountReason =
  "payable_account_unknown" | "payable_account_inactive";

type PayableAccount =
  | { ok: true; accountId: string }
  | { ok: false; reason: PayableAccountReason; accountId: string | null };

/**
 * The `salaries_payable` account the run's lock journal credited, or null when
 * it cannot be proven (legend-wcd24). The journal's own account snapshot
 * (written with the journal by the rule path) names the account; it is accepted
 * only when the journal has a credit line on it and no OTHER account is credited
 * the same amount, so the role cannot be confused with another liability. Never
 * today's mapping: a later remap does not move the payable.
 */
async function lockJournalPayableAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  runId: string,
): Promise<string | null> {
  const [entry] = await tx
    .select({
      id: journalEntries.id,
      snapshot: journalEntries.postingAccountSnapshot,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, payrollGlKeys.locked(runId)),
        eq(journalEntries.legalEntityId, legalEntityId),
        eq(journalEntries.sourceType, "payroll"),
      ),
    )
    .limit(1);
  const candidate = entry?.snapshot?.salaries_payable;
  if (
    entry === undefined ||
    typeof candidate !== "string" ||
    !UUID.test(candidate)
  )
    return null;
  const credits = await tx
    .select({
      accountId: journalLines.accountId,
      credit: journalLines.creditIdr,
    })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.entryId, entry.id),
        sql`${journalLines.creditIdr} > 0`,
      ),
    );
  let credited = 0;
  for (const line of credits)
    if (line.accountId === candidate) credited += Number(line.credit);
  if (credited <= 0) return null;
  if (
    credits.some(
      (line) =>
        line.accountId !== candidate && Number(line.credit) === credited,
    )
  )
    return null;
  return candidate;
}

/**
 * The salaries payable account a settlement of this run debits (legend-wcd24):
 * the one frozen on the posting, else the one the lock journal credited; never
 * today's mapping. `posting` is null for a settlement not recorded yet. Held
 * (`payable_account_hold`) or unprovable: unknown; found but not postable now:
 * inactive (it resolves once finance activates it). Read-only.
 */
async function payableAccountOf(
  tx: Tx,
  tenantId: TenantId,
  batch: Pick<BatchRow, "legalEntityId" | "payrollRunId">,
  posting: {
    salariesPayableAccountId: string | null;
    payableAccountHold: boolean;
  } | null,
): Promise<PayableAccount> {
  if (posting?.payableAccountHold)
    return { ok: false, reason: "payable_account_unknown", accountId: null };
  const accountId =
    posting?.salariesPayableAccountId ??
    (await lockJournalPayableAccount(
      tx,
      tenantId,
      batch.legalEntityId,
      batch.payrollRunId,
    ));
  if (accountId === null)
    return { ok: false, reason: "payable_account_unknown", accountId: null };
  if (!(await glAccountPostable(tx, tenantId, batch.legalEntityId, accountId)))
    return { ok: false, reason: "payable_account_inactive", accountId };
  return { ok: true, accountId };
}

/** Records the proven payable account on a posting, once (NULL -> account). */
async function freezePayableAccount(
  tx: Tx,
  tenantId: TenantId,
  postingId: string,
  accountId: string,
): Promise<void> {
  await tx
    .update(payrollPayoutGlPostings)
    .set({ salariesPayableAccountId: accountId })
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, postingId),
        isNull(payrollPayoutGlPostings.salariesPayableAccountId),
        eq(payrollPayoutGlPostings.payableAccountHold, false),
      ),
    );
}

/**
 * Pending/skipped settlement with a real net and an existing lock journal whose
 * payable account is not usable: its fee must not run ahead of the salary
 * journal it belongs to (the posting stays whole in the recovery list).
 */
async function settleBlockedByPayable(
  tx: Tx,
  tenantId: TenantId,
  batch: Pick<BatchRow, "legalEntityId" | "payrollRunId">,
  posting: FeePosting,
  hasLock: boolean,
): Promise<boolean> {
  if (
    !hasLock ||
    (posting.kind !== "settle_pending" && posting.kind !== "settle_skipped") ||
    openPostingTotal(posting, tenantId, "netIdr") === 0
  )
    return false;
  return !(await payableAccountOf(tx, tenantId, batch, posting)).ok;
}

/**
 * Settles every `succeeded` item of the batch that has no posting yet.
 * Idempotent and safe to call from confirm, cash handover, return and replay:
 * a second call (also a concurrent one, after it waited on the lock) finds
 * nothing to do.
 */
export async function settleBatchPayouts(
  tx: Tx,
  actor: Actor,
  batchId: string,
  now = new Date(),
): Promise<SettleResult> {
  const tenantId = actor.tenantId as TenantId;
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  await lockBatchPayoutGl(tx, tenantId, batch);
  // A pending settlement whose locked journal exists by now resolves first
  // (the consumer normally does it; this is the retry when it could not).
  await resolvePendingSettles(tx, tenantId, batch.payrollRunId, now, batch.id);
  const items = await tx
    .select()
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        eq(payrollDisbursementItems.status, "succeeded"),
        isNull(payrollDisbursementItems.glPostingId),
      ),
    )
    .orderBy(asc(payrollDisbursementItems.id))
    .for("update");
  if (items.length === 0) return { postingId: null, kind: null, settled: 0 };

  let netIdr = 0;
  let feeIdr = 0;
  for (const item of items) {
    netIdr += safeAmount(() => openItemAmount(item));
    // Cash has no bank fee; the manual file's fee was stored per item.
    if (item.channel === "manual_bank")
      feeIdr += safeAmount(() => openItemFee(item));
  }
  const hash = itemSetHash(items.map((item) => item.id));
  const journalKey = payoutGlKeys.settle(hash);
  const lockExists =
    netIdr > 0 && (await runHasLockedJournal(tx, tenantId, batch.payrollRunId));
  // The payable account is the one the LOCK journal credited, never today's
  // mapping (legend-wcd24). A lock journal whose account cannot be proven or is
  // not postable keeps the settlement pending: money already left, nothing is
  // guessed, finance sees it in the recovery list.
  const payable = lockExists
    ? await payableAccountOf(tx, tenantId, batch, null)
    : null;
  const journaled = payable?.ok === true;
  // Locked event still queued and accounting on, or accounting switched off
  // after an earlier batch of the same run went pending (the consumer then
  // posts the lock journal and resolves it): keep this settlement pending too
  // (legend-2aspe) instead of dropping it as `settle_skipped`, or its net stays
  // open on 2103.
  const accountingOn = await accountingEnabled(tx, tenantId);
  const pending =
    !journaled &&
    netIdr > 0 &&
    (lockExists ||
      ((await runLockPending(tx, tenantId, batch.payrollRunId)) &&
        (accountingOn ||
          (await runHasPendingSettle(tx, tenantId, batch.payrollRunId)))));
  const kind: PayoutPostingKind = journaled
    ? "settle"
    : pending
      ? "settle_pending"
      : "settle_skipped";

  // A pending CASH settlement remembers the petty cash account of this moment
  // (legend-cnpap): the lock consumer may run after finance remapped the role.
  // No mapping: refuse, nothing is recorded (same code as a missing bank).
  let pendingCashAccountId: string | null = null;
  if (kind === "settle_pending" && batch.channel === "cash") {
    pendingCashAccountId = await mappedPettyCashAccount(
      tx,
      tenantId,
      batch.legalEntityId,
    );
    if (
      pendingCashAccountId === null ||
      !(await glAccountPostable(
        tx,
        tenantId,
        batch.legalEntityId,
        pendingCashAccountId,
      ))
    )
      throw payoutRefuse(
        409,
        PAYOUT_SOURCE_ACCOUNT_MISSING.code,
        PAYOUT_SOURCE_ACCOUNT_MISSING.message,
      );
  }

  // A skipped CASH settlement remembers the identity of the petty cash account
  // of this moment, postable or not (never refuses; null when nothing is
  // mapped): if the lock journal comes later, the settle follows this account,
  // not a later remap, and waits while it is not postable (legend-zlcsd).
  if (kind === "settle_skipped" && batch.channel === "cash")
    pendingCashAccountId = await mappedPettyCashAccount(
      tx,
      tenantId,
      batch.legalEntityId,
    );

  // Fail closed on the source account BEFORE the journal branch (legend-ijhe3):
  // with accounting on, an unusable source is refused whether or not the run
  // has a locked journal, so it is never turned into `settle_skipped`. Nothing
  // is recorded; the confirmation can be sent again once the account is active.
  // The account actually used for a legacy batch without a frozen bank account
  // (null: none used); a frozen batch records its frozen GL account below.
  let unfrozenSource: string | null = null;
  if (!journaled && (accountingOn || pending))
    unfrozenSource =
      (await sourceBankOverride(tx, tenantId, batch))?.bank ?? null;

  // The fee is real money the PT paid, whether or not the salary journal
  // applies. A fee whose bank charges mapping or source account is missing is
  // never allowed to block a real payment confirmation (the money is gone): it
  // is skipped, the posting says `fee_posted = false`, and finance re-posts it
  // once the mapping is back (`repostSkippedFees`). With accounting off nothing
  // is journaled at all, so the posting says `fee_posted = false` too and the
  // recovery job journals the fee once accounting is on (legend-pfk3q).
  let feeJournaled = false;
  if (feeIdr > 0 && (journaled || (await accountingEnabled(tx, tenantId)))) {
    feeJournaled =
      (await bankChargesMapped(tx, tenantId, batch.legalEntityId)) &&
      (await sourceBankOverride(tx, tenantId, batch, { optional: true })) !==
        null;
    if (!feeJournaled)
      logger.warn(
        { tenantId, batchId: batch.id, reason: "fee_skipped_no_mapping" },
        "payout fee not posted: bank charges mapping or source account missing",
      );
  }
  // `fee_posted` is true only when no fee is owed or its journal exists, for
  // every kind: a pending or skipped settlement journals its fee when it
  // resolves (legend-1t65x, legend-pfk3q), never marked posted before.
  const feePosted = feeIdr === 0 || feeJournaled;
  if (journaled || feeJournaled) {
    const context = payoutScope(actor.tenantId);
    const entryDate = payrollEntryDateOf(now.toISOString());
    const accountOverrides =
      (await sourceBankOverride(tx, tenantId, batch)) ?? undefined;
    unfrozenSource = accountOverrides?.bank ?? unfrozenSource;
    if (payable?.ok)
      await postJournalFromRuleInTransaction(
        tx,
        context,
        {
          eventName: "payroll.paid",
          variant: batch.channel === "cash" ? "payout_cash" : "payout_bank",
          amounts: { netIdr },
          legalEntityId: batch.legalEntityId,
          outletId: null,
          entryDate,
          sourceId: batch.payrollRunId,
          postedBy: null,
          idempotencyKey: journalKey,
          accountOverrides: {
            ...accountOverrides,
            salaries_payable: payable.accountId,
          },
        },
        now,
      );
    if (feeJournaled)
      await postJournalFromRuleInTransaction(
        tx,
        context,
        {
          eventName: "payroll.paid",
          variant: "payout_fee",
          amounts: { feeIdr },
          legalEntityId: batch.legalEntityId,
          outletId: null,
          entryDate,
          sourceId: batch.payrollRunId,
          postedBy: null,
          idempotencyKey: payoutGlKeys.fee(hash),
          accountOverrides,
        },
        now,
      );
  }

  // F4: the posting carries the account the money left from: the petty cash
  // account for a cash batch, the frozen GL account of a bank batch with a
  // frozen account (the insert guard demands it), else the account used.
  const sourceGlAccountId =
    batch.channel === "cash"
      ? // A settled cash batch records the petty cash account its journal
        // credited (the commit check demands the posting names it).
        (pendingCashAccountId ??
        (kind === "settle"
          ? await mappedPettyCashAccount(tx, tenantId, batch.legalEntityId)
          : null))
      : batch.sourceBankAccountId !== null
        ? await frozenBatchGlAccount(tx, tenantId, batch)
        : unfrozenSource;
  const postingId = randomUUID();
  await tx.insert(payrollPayoutGlPostings).values({
    id: postingId,
    tenantId,
    batchId: batch.id,
    kind,
    itemSetHash: hash,
    journalKey,
    totalEncrypted: sealPayrollValue(
      JSON.stringify({ netIdr, feeIdr, itemCount: items.length }),
      {
        tenantId,
        table: "payroll_payout_gl_postings",
        rowId: postingId,
        field: "total",
      },
      PAYROLL_SEAL_KEY_VERSION,
    ),
    piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
    postedAt: now,
    feePosted,
    sourceGlAccountId,
    salariesPayableAccountId: payable?.accountId ?? null,
    settleNetIdr: netIdr,
    feeIdr,
  });
  const linked = await tx
    .update(payrollDisbursementItems)
    .set({ glPostingId: postingId })
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        inArray(
          payrollDisbursementItems.id,
          items.map((item) => item.id),
        ),
        eq(payrollDisbursementItems.status, "succeeded"),
        isNull(payrollDisbursementItems.glPostingId),
      ),
    )
    .returning({ id: payrollDisbursementItems.id });
  // The linked count must equal the selected count: a short link would leave
  // an item settled in the ledger that a later call settles again.
  if (linked.length !== items.length)
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE_CHANGED",
      "Status batch berubah saat diproses. Coba lagi.",
    );
  return { postingId, kind, settled: items.length };
}

/**
 * Also turns a `settle_skipped` posting with a net into `settle` (legend-vvzij)
 * and journals the fee a pending/skipped posting still owes (legend-1t65x).
 * Resolves every `settle_pending` posting of the run once its `payroll.locked`
 * journal exists (legend-2aspe): posts the payout journal under the posting's
 * own settle key (Cr the source account exactly the sealed net, Dr 2103), then
 * flips the posting to `settle`. Called by the GL consumer right after it posts
 * the locked journal, and by `settleBatchPayouts` as a retry. Idempotent: a
 * second call finds nothing pending; the journal key and the conditional flip
 * are the further guards. `onlyBatchId` limits it to one batch (the settle
 * holds that batch's lock only, so it never waits on another batch's lock). An item returned while pending gets its return
 * journal now, so the ledger still equals the money moved. The credit goes to
 * the account frozen at the handover (`postingSource`), never to today's
 * mapping. A posting whose configuration is not ready (no bank charges mapping
 * for a skipped fee, source account unknown or not postable) is left as is
 * with a warning: the resolver never throws for it, so the consumer and the
 * outbox are not held, and `listPayoutRecovery` shows it to finance.
 * `options.isolate` runs each posting in its own savepoint and contains an
 * HttpError or AccountingError of one posting (the recovery path).
 */
export async function resolvePendingSettles(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
  now = new Date(),
  onlyBatchId?: string,
  options: { isolate?: boolean } = {},
): Promise<{ resolved: number }> {
  // Run row first (920): same order as every payout path (run, batch, item,
  // advisory GL); the frozen check below then sees any dispute that committed
  // while this waited for the lock.
  await tx
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .for("update");
  if (!(await runHasLockedJournal(tx, tenantId, runId))) return { resolved: 0 };
  const batches = await tx
    .select()
    .from(payrollDisbursementBatches)
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, tenantId),
        eq(payrollDisbursementBatches.payrollRunId, runId),
        onlyBatchId === undefined
          ? undefined
          : eq(payrollDisbursementBatches.id, onlyBatchId),
      ),
    )
    .orderBy(asc(payrollDisbursementBatches.id));
  let resolved = 0;
  for (const batch of batches) {
    await lockBatchPayoutGl(tx, tenantId, batch);
    // A frozen batch sends no new money: its settle waits for the unfreeze
    // (the posting trigger of 0661 stays strict). The healthy siblings go on.
    if (await batchIsFrozen(tx, tenantId, batch.id)) {
      logger.warn(
        { tenantId, batchId: batch.id, reason: "batch_frozen" },
        "payout settlement held: batch is frozen",
      );
      continue;
    }
    const postings = await tx
      .select()
      .from(payrollPayoutGlPostings)
      .where(
        and(
          eq(payrollPayoutGlPostings.tenantId, tenantId),
          eq(payrollPayoutGlPostings.batchId, batch.id),
          inArray(payrollPayoutGlPostings.kind, [
            "settle_pending",
            "settle_skipped",
          ]),
        ),
      )
      .orderBy(asc(payrollPayoutGlPostings.id))
      .for("update");
    for (const posting of postings) {
      if (!options.isolate) {
        if (await resolveOnePosting(tx, tenantId, batch, posting, now))
          resolved += 1;
        continue;
      }
      try {
        const done = await tx.transaction((savepoint) =>
          resolveOnePosting(savepoint, tenantId, batch, posting, now),
        );
        if (done) resolved += 1;
      } catch (error) {
        // An AccountingError (e.g. a closed period) is as contained as an
        // HttpError: this posting waits, the others go on.
        if (!(error instanceof HttpError || error instanceof AccountingError))
          throw error;
        logger.warn(
          { tenantId, batchId: batch.id, reason: "resolve_posting_failed" },
          "payout settlement left for the next recovery run",
        );
      }
    }
  }
  return { resolved };
}

/** True when the batch is frozen (own dispute or a sibling's), read now. */
async function batchIsFrozen(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
): Promise<boolean> {
  const result = await tx.execute<{ ok: boolean }>(
    sql`SELECT ${batchIsNotFrozenSql(tenantId, sql`${batchId}::uuid`)} AS ok`,
  );
  return result.rows[0]?.ok === false;
}

/** Resolves one pending/skipped posting; false when it was left as is. */
async function resolveOnePosting(
  tx: Tx,
  tenantId: TenantId,
  batch: typeof payrollDisbursementBatches.$inferSelect,
  posting: typeof payrollPayoutGlPostings.$inferSelect,
  now: Date,
): Promise<boolean> {
  const context = payoutScope(tenantId);
  const entryDate = payrollEntryDateOf(now.toISOString());
  const netIdr = openPostingTotal(posting, tenantId, "netIdr");
  // A skipped posting with a real net: money left while accounting was off
  // and the lock journal came after (legend-vvzij). It becomes a normal
  // settle; with no resolvable source account it stays skipped and never
  // stalls the consumer.
  const wasSkipped = posting.kind === "settle_skipped";
  if (wasSkipped && netIdr === 0) return false;
  // A skipped posting that owes a bank fee turns into a settle only while
  // the fee can be journaled with it. No bank charges mapping: it stays
  // `settle_skipped`, `fee_posted` untouched, nothing is posted, and a later
  // resolve (consumer replay, settle, repost) does it all once the mapping
  // is back. The consumer never throws and the outbox is not held.
  if (
    wasSkipped &&
    openPostingTotal(posting, tenantId, "feeIdr") > 0 &&
    !(await journalKeyExists(
      tx,
      tenantId,
      payoutGlKeys.fee(posting.itemSetHash),
    )) &&
    !(await bankChargesMapped(tx, tenantId, batch.legalEntityId))
  ) {
    logger.warn(
      {
        tenantId,
        batchId: batch.id,
        reason: "skipped_settle_no_fee_mapping",
      },
      "payout skipped settlement left as is: bank charges mapping missing",
    );
    return false;
  }
  const source = await postingSource(tx, tenantId, batch, posting);
  if (!source.ok) {
    logger.warn(
      { tenantId, batchId: batch.id, reason: source.reason },
      "payout settlement left as is: source account not resolvable",
    );
    return false;
  }
  const accountOverrides = source.overrides;
  await fillFrozenSource(tx, tenantId, batch, posting);
  // The payable account frozen on the posting, else the one the lock journal
  // credited; never today's mapping (legend-wcd24). Not provable or not
  // postable: the posting is left as is and finance sees why.
  const payable = await payableAccountOf(tx, tenantId, batch, posting);
  if (!payable.ok) {
    logger.warn(
      { tenantId, batchId: batch.id, reason: payable.reason },
      "payout settlement left as is: salaries payable account not usable",
    );
    return false;
  }
  if (posting.salariesPayableAccountId === null)
    await freezePayableAccount(tx, tenantId, posting.id, payable.accountId);
  await postJournalFromRuleInTransaction(
    tx,
    context,
    {
      eventName: "payroll.paid",
      variant: batch.channel === "cash" ? "payout_cash" : "payout_bank",
      amounts: { netIdr },
      legalEntityId: batch.legalEntityId,
      outletId: null,
      entryDate,
      sourceId: batch.payrollRunId,
      postedBy: null,
      idempotencyKey: posting.journalKey,
      accountOverrides: {
        ...accountOverrides,
        salaries_payable: payable.accountId,
      },
    },
    now,
  );
  const flipped = await tx
    .update(payrollPayoutGlPostings)
    .set({ kind: "settle" })
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, posting.id),
        eq(payrollPayoutGlPostings.kind, posting.kind),
      ),
    )
    .returning({ id: payrollPayoutGlPostings.id });
  if (flipped.length !== 1)
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE_CHANGED",
      "Status batch berubah saat diproses. Coba lagi.",
    );
  // Items returned while the settlement was pending had no return journal
  // (nothing was booked to reverse): post it now, once (key = the item).
  const returned = await tx
    .select()
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.glPostingId, posting.id),
        eq(payrollDisbursementItems.status, "returned"),
      ),
    )
    .orderBy(asc(payrollDisbursementItems.id));
  for (const item of returned)
    await postPayoutReturn(
      tx,
      { tenantId, userId: "system" },
      batch,
      item,
      now,
    );
  // The bank fee the settle could not journal (pending: `fee_posted =
  // false`; skipped: accounting was off). Same key as the settle path, so
  // it posts exactly once; it never changes the net or 2103. A missing
  // bank charges mapping never blocks the resolve: `fee_posted` stays
  // false and finance re-posts it (`repostSkippedFees`).
  const feeIdr = openPostingTotal(posting, tenantId, "feeIdr");
  // F5: a posting from before 0397 has no plain fee amount: no fee is posted
  // and nothing flips; finance sees `fee_amount_unverified`.
  if (
    feeIdr > 0 &&
    posting.feeIdr !== null &&
    (!posting.feePosted || wasSkipped)
  ) {
    // A fee journal that already exists (earlier fee post or re-post) is
    // never posted again and never flips the flag back to false.
    const feeJournalExists = await journalKeyExists(
      tx,
      tenantId,
      payoutGlKeys.fee(posting.itemSetHash),
    );
    const feeMapped =
      feeJournalExists ||
      (await bankChargesMapped(tx, tenantId, batch.legalEntityId));
    if (feeJournalExists) {
      // Nothing to post.
    } else if (feeMapped)
      await postJournalFromRuleInTransaction(
        tx,
        context,
        {
          eventName: "payroll.paid",
          variant: "payout_fee",
          amounts: { feeIdr },
          legalEntityId: batch.legalEntityId,
          outletId: null,
          entryDate,
          sourceId: batch.payrollRunId,
          postedBy: null,
          idempotencyKey: payoutGlKeys.fee(posting.itemSetHash),
          accountOverrides,
        },
        now,
      );
    else
      logger.warn(
        { tenantId, batchId: batch.id, reason: "fee_skipped_no_mapping" },
        "payout fee not posted: bank charges mapping missing",
      );
    // Only false -> true: the posting guard refuses the other direction. A
    // fee journal that fails the amount/account check never flips the flag:
    // it stays owed for finance (`fee_journal_mismatch`).
    if (
      feeMapped &&
      !posting.feePosted &&
      !(await feeJournalOk(tx, tenantId, posting.id))
    )
      logger.warn(
        { tenantId, batchId: batch.id, reason: "fee_journal_mismatch" },
        "payout fee flag left false: fee journal does not match the posting",
      );
    else if (feeMapped && !posting.feePosted)
      await tx
        .update(payrollPayoutGlPostings)
        .set({ feePosted: true })
        .where(
          and(
            eq(payrollPayoutGlPostings.tenantId, tenantId),
            eq(payrollPayoutGlPostings.id, posting.id),
            eq(payrollPayoutGlPostings.feePosted, false),
          ),
        );
  }
  return true;
}

/**
 * Reverses the net of one returned item, once (key = the item). Posts nothing
 * when the item was settled without a journal (`settle_skipped`). The caller
 * has already moved the item to `returned` in the same transaction.
 */
export async function postPayoutReturn(
  tx: Tx,
  actor: Actor,
  batch: BatchRow,
  item: ItemRow,
  now = new Date(),
): Promise<void> {
  const tenantId = actor.tenantId as TenantId;
  if (item.glPostingId === null)
    throw payoutRefuse(
      409,
      "PAYOUT_ITEM_NOT_CONFIRMABLE",
      "Item ini belum dijurnal, jadi belum bisa dikembalikan.",
    );
  const [posting] = await tx
    .select({
      kind: payrollPayoutGlPostings.kind,
      journalKey: payrollPayoutGlPostings.journalKey,
      salariesPayableAccountId:
        payrollPayoutGlPostings.salariesPayableAccountId,
      payableAccountHold: payrollPayoutGlPostings.payableAccountHold,
    })
    .from(payrollPayoutGlPostings)
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, item.glPostingId),
      ),
    )
    .limit(1);
  if (!posting || posting.kind !== "settle") return;
  const netIdr = safeAmount(() => openItemAmount(item));
  if (netIdr === 0) return;
  // The return reopens the payable the settle paid off: the account frozen on
  // the posting, never today's mapping (legend-wcd24). A posting whose account
  // is uncertain (held for reconciliation) refuses, so no return is booked on a
  // guessed account; nothing is recorded and finance sees the posting listed.
  if (posting.payableAccountHold || posting.salariesPayableAccountId === null)
    throw payoutRefuse(
      409,
      "PAYOUT_PAYABLE_ACCOUNT_UNKNOWN",
      "Akun utang gaji batch ini belum pasti, jadi pengembalian belum bisa dijurnal. Minta finance merekonsiliasi dulu.",
    );
  const settledBank = await settledSourceAccount(
    tx,
    tenantId,
    batch.legalEntityId,
    posting.journalKey,
  );
  await postJournalFromRuleInTransaction(
    tx,
    payoutScope(actor.tenantId),
    {
      eventName: "payroll.paid",
      variant: "payout_return",
      amounts: { netIdr },
      legalEntityId: batch.legalEntityId,
      outletId: null,
      entryDate: payrollEntryDateOf(now.toISOString()),
      sourceId: batch.payrollRunId,
      postedBy: null,
      idempotencyKey: payoutGlKeys.return(item.id),
      accountOverrides: {
        bank: settledBank,
        salaries_payable: posting.salariesPayableAccountId,
      },
    },
    now,
  );
}

/**
 * `payroll.paid` for a run that just turned paid by its items. Carries
 * `settledPerItem: true`: the GL consumer posts nothing for it. `paidBy` is the
 * last approver of the batch (CTO 14 Nov); a system identity without a UUID
 * is sent as null.
 */
export async function emitPayoutRunPaid(
  tx: Tx,
  actor: Actor,
  batch: Pick<BatchRow, "approvedBy" | "payrollRunId">,
  now: Date,
): Promise<void> {
  const tenantId = actor.tenantId as TenantId;
  const [run] = await tx
    .select({
      id: payrollRuns.id,
      legalEntityId: payrollRuns.legalEntityId,
      runType: payrollRuns.runType,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
      payDate: payrollRuns.payDate,
      totals: payrollRuns.totals,
    })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.id, batch.payrollRunId),
      ),
    );
  // A locked run always carries its totals; without them there is nothing to
  // announce (and the consumer would post nothing anyway).
  if (!run || !run.totals) return;
  const paidBy = batch.approvedBy ?? actor.userId;
  await emitPayrollEvent(tx, payoutScope(actor.tenantId), payrollPaid, {
    aggregateId: run.id,
    actor: UUID.test(actor.userId)
      ? { type: "user", id: actor.userId }
      : { type: "system" },
    payload: {
      payrollRunId: run.id,
      legalEntityId: run.legalEntityId,
      runType: run.runType as PayrollRunType,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      payDate: run.payDate,
      netIdr: run.totals.netIdr,
      bankTransferIdr: run.totals.bankTransferIdr,
      cashIdr: run.totals.cashIdr,
      bankTransferFileId: null,
      paidBy: UUID.test(paidBy) ? paidBy : null,
      paidAt: now.toISOString(),
      settledPerItem: true,
    },
    now,
  });
}

export type RepostFeesResult = {
  /** Postings whose fee this call journaled. */
  reposted: number;
};

const postingTotalBinding = (tenantId: string, rowId: string) => ({
  tenantId,
  table: "payroll_payout_gl_postings" as const,
  rowId,
  field: "total" as const,
});

/** Stored whole-rupiah total (`netIdr` or `feeIdr`) of a posting; a tampered value throws. */
function openPostingTotal(
  posting: { id: string; totalEncrypted: Buffer; piiKeyVersion: number },
  tenantId: string,
  field: "netIdr" | "feeIdr",
): number {
  return safeAmount(() => {
    const total = JSON.parse(
      openPayrollValue(
        posting.totalEncrypted,
        postingTotalBinding(tenantId, posting.id),
        posting.piiKeyVersion,
      ),
    ) as Record<string, unknown>;
    return Number(total[field]);
  });
}

const postingFeeIdr = (
  posting: { id: string; totalEncrypted: Buffer; piiKeyVersion: number },
  tenantId: string,
): number => openPostingTotal(posting, tenantId, "feeIdr");

/**
 * Takes the locks that serialize every payout GL writer of a batch: the legal
 * entity's cash/bank lock FIRST (the one the petty cash return holds while it
 * reads GL 1102, legend-3k9qg), then the batch advisory lock. Every call site
 * goes through here, so the order is always entity lock, then batch lock, and
 * never the reverse. Cash settlements, fees and recoveries credit 1102, so a
 * return and a payout of one entity cannot interleave.
 */
export async function lockBatchPayoutGl(
  tx: Tx,
  tenantId: TenantId,
  batch: Pick<BatchRow, "id" | "legalEntityId">,
): Promise<void> {
  await entityLock(tx, tenantId, batch.legalEntityId);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`payroll-payout-gl:${tenantId}:${batch.id}`}))`,
  );
}

type FeePosting = typeof payrollPayoutGlPostings.$inferSelect;

/**
 * Journals the bank fee of ONE posting (Dr bank charges / Cr the source
 * account, key `payroll-payout-fee:<item_set_hash>`) and flips `fee_posted` to
 * true. Throws HttpError when the source account does not resolve; the caller
 * decides whether that is a 409 (finance endpoint) or a skip (recovery).
 */
async function postFeeOfPosting(
  tx: Tx,
  tenantId: TenantId,
  batch: BatchRow,
  posting: FeePosting,
  now: Date,
): Promise<void> {
  const context = payoutScope(tenantId);
  const entryDate = payrollEntryDateOf(now.toISOString());
  // F5: a historical NULL fee amount is never posted or flipped.
  if (posting.feeIdr === null) return;
  const feeIdr = postingFeeIdr(posting, tenantId);
  if (feeIdr > 0) {
    // F4: a frozen bank batch always credits its frozen GL account (never the
    // settle journal's), and the posting carries it as its source first.
    // Otherwise a settled group gives to the account its own salary journal
    // used; a group settled without a journal uses the recorded source.
    // Either way the account must still belong to an active bank account:
    // the settled one may have been deactivated since the settle.
    let accountOverrides: Partial<Record<"bank", string>> | undefined;
    if (batch.channel !== "cash" && batch.sourceBankAccountId !== null) {
      await fillFrozenSource(tx, tenantId, batch, posting);
      accountOverrides =
        (await sourceBankOverride(tx, tenantId, batch, {
          requireFrozen: true,
        })) ?? undefined;
    } else if (posting.kind === "settle") {
      const settledBank = await settledSourceAccount(
        tx,
        tenantId,
        batch.legalEntityId,
        posting.journalKey,
      );
      await assertActiveBankGlAccount(
        tx,
        tenantId,
        batch.legalEntityId,
        settledBank,
      );
      if (
        !(await glAccountPostable(
          tx,
          tenantId,
          batch.legalEntityId,
          settledBank,
        ))
      )
        throw payoutRefuse(
          409,
          PAYOUT_SOURCE_ACCOUNT_MISSING.code,
          PAYOUT_SOURCE_ACCOUNT_MISSING.message,
        );
      accountOverrides = { bank: settledBank };
    } else if (
      batch.channel !== "cash" &&
      batch.sourceBankAccountId === null &&
      posting.sourceGlAccountId !== null &&
      (await glAccountPostable(
        tx,
        tenantId,
        batch.legalEntityId,
        posting.sourceGlAccountId,
      ))
    )
      // A legacy batch without a frozen bank account: finance recorded the
      // account the money left from on the posting.
      accountOverrides = { bank: posting.sourceGlAccountId };
    else
      accountOverrides =
        (await sourceBankOverride(tx, tenantId, batch, {
          requireFrozen: true,
        })) ?? undefined;
    await postJournalFromRuleInTransaction(
      tx,
      context,
      {
        eventName: "payroll.paid",
        variant: "payout_fee",
        amounts: { feeIdr },
        legalEntityId: batch.legalEntityId,
        outletId: null,
        entryDate,
        sourceId: batch.payrollRunId,
        postedBy: null,
        idempotencyKey: payoutGlKeys.fee(posting.itemSetHash),
        accountOverrides,
      },
      now,
    );
  }
  // A historical row is already true and stays true (the guard trigger refuses
  // true -> false); only a false row is flipped.
  if (posting.feePosted) return;
  if (feeIdr > 0 && !(await feeJournalOk(tx, tenantId, posting.id)))
    throw payoutRefuse(
      409,
      PAYOUT_FEE_JOURNAL_MISMATCH.code,
      PAYOUT_FEE_JOURNAL_MISMATCH.message,
    );
  const flipped = await tx
    .update(payrollPayoutGlPostings)
    .set({ feePosted: true })
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.id, posting.id),
        eq(payrollPayoutGlPostings.feePosted, false),
      ),
    )
    .returning({ id: payrollPayoutGlPostings.id });
  if (flipped.length !== 1)
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE_CHANGED",
      "Status batch berubah saat diproses. Coba lagi.",
    );
}

async function unpostedFeePostings(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
): Promise<FeePosting[]> {
  const rows = await tx
    .select()
    .from(payrollPayoutGlPostings)
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.batchId, batchId),
        // A waived settlement (legend-5qqb9) is terminal: nothing is journaled.
        ne(payrollPayoutGlPostings.kind, "settle_waived"),
        // Only `fee_posted = false`. A historical `settle_skipped` row flagged
        // posted without a fee journal (legend-qq68t) is listed for finance
        // (`accounting_was_off`) but never journaled by the worker or by a
        // batch re-post: the opening balance may already hold its fee, so a
        // journal would double the expense. A per-posting action waits for the
        // founder's decision.
        eq(payrollPayoutGlPostings.feePosted, false),
      ),
    )
    .orderBy(asc(payrollPayoutGlPostings.id))
    .for("update");
  return rows;
}

/**
 * Journals the bank fee of every posting of the batch that skipped it
 * (`fee_posted = false`): Dr bank charges / Cr the source account, key
 * `payroll-payout-fee:<item_set_hash>`, then `fee_posted = true`. Exactly once:
 * the batch advisory lock serializes callers, a caller that waited finds no
 * posting left, and the journal key is the second guard. A mapping or source
 * account that is still missing answers 409 and posts nothing. A historical
 * `settle_skipped` row flagged posted without a fee journal (legend-qq68t) is
 * NOT journaled here: it stays visible in the list only.
 */
export async function repostSkippedFees(
  tx: Tx,
  actor: Actor,
  batchId: string,
  now = new Date(),
): Promise<RepostFeesResult> {
  const tenantId = actor.tenantId as TenantId;
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  await lockBatchPayoutGl(tx, tenantId, batch);
  // A pending settlement whose locked journal exists by now resolves first, so
  // the fee re-post never runs ahead of the salary journal it belongs to.
  await resolvePendingSettles(tx, tenantId, batch.payrollRunId, now, batch.id);
  const postings = await unpostedFeePostings(tx, tenantId, batch.id);
  if (postings.length === 0) return { reposted: 0 };
  // F5: a posting from before 0397 has no provable fee amount; nothing in the
  // batch is re-posted until finance decides.
  if (postings.some((posting) => posting.feeIdr === null))
    throw payoutRefuse(
      409,
      "PAYOUT_FEE_AMOUNT_UNVERIFIED",
      "Nominal biaya transfer batch ini dari data lama dan belum bisa dipastikan, jadi tidak dijurnal. Hubungi tim keuangan.",
    );

  if (!(await accountingEnabled(tx, tenantId)))
    throw payoutRefuse(
      409,
      "PAYOUT_ACCOUNTING_DISABLED",
      "Akuntansi belum aktif, jadi biaya transfer belum bisa dijurnal.",
    );
  if (!(await bankChargesMapped(tx, tenantId, batch.legalEntityId)))
    throw payoutRefuse(
      409,
      PAYOUT_BANK_CHARGES_MAPPING_MISSING.code,
      PAYOUT_BANK_CHARGES_MAPPING_MISSING.message,
    );
  await assertManualPayoutSetup(tx, tenantId, batch.legalEntityId);

  // A fee never runs ahead of the salary journal it belongs to: a settlement
  // whose payable account is not usable blocks the re-post (legend-wcd24).
  const hasLock = await runHasLockedJournal(tx, tenantId, batch.payrollRunId);
  for (const posting of postings)
    if (await settleBlockedByPayable(tx, tenantId, batch, posting, hasLock))
      throw payoutRefuse(
        409,
        "PAYOUT_PAYABLE_ACCOUNT_UNKNOWN",
        "Akun utang gaji batch ini belum pasti atau tidak aktif, jadi biaya transfer belum bisa dijurnal.",
      );

  let reposted = 0;
  for (const posting of postings) {
    await postFeeOfPosting(tx, tenantId, batch, posting, now);
    reposted += 1;
  }
  return { reposted };
}

/**
 * The soft form of `repostSkippedFees` for the recovery path: the same journal,
 * but a configuration that is not ready (accounting off, no bank charges
 * mapping, source account unusable) skips the posting instead of throwing. The
 * source account is the one frozen or recorded on the posting (or the one its
 * settle journal credited), never today's payout config. Each posting runs in
 * its own savepoint, so one failure (HttpError or AccountingError, e.g. a
 * closed period) leaves the others intact. A `settle_skipped` posting of a run
 * with no lock journal is never journaled here: no payable was ever booked and
 * the opening bank balance may already hold the fee, so only finance's manual
 * re-post decides (`accounting_was_off`).
 */
async function repostFeesSoft(
  tx: Tx,
  tenantId: TenantId,
  batch: BatchRow,
  now: Date,
): Promise<number> {
  const postings = await unpostedFeePostings(tx, tenantId, batch.id);
  if (postings.length === 0) return 0;
  if (
    !(await accountingEnabled(tx, tenantId)) ||
    !(await bankChargesMapped(tx, tenantId, batch.legalEntityId))
  )
    return 0;
  const hasLock = await runHasLockedJournal(tx, tenantId, batch.payrollRunId);
  let reposted = 0;
  for (const posting of postings) {
    if (posting.feeIdr === null) continue;
    if (posting.kind === "settle_skipped" && !hasLock) continue;
    // Never ahead of the salary journal: a settlement whose payable account is
    // not usable keeps its fee owed too (legend-wcd24).
    if (await settleBlockedByPayable(tx, tenantId, batch, posting, hasLock))
      continue;
    try {
      await tx.transaction((savepoint) =>
        postFeeOfPosting(savepoint, tenantId, batch, posting, now),
      );
      reposted += 1;
    } catch (error) {
      if (!(error instanceof HttpError || error instanceof AccountingError))
        throw error;
      logger.warn(
        { tenantId, batchId: batch.id, reason: "fee_recovery_not_ready" },
        "payout fee left for later: source account not usable",
      );
    }
  }
  return reposted;
}

export type RecoverPayoutGlResult = {
  /** Settlements turned into `settle` by this call. */
  resolved: number;
  /** Bank fees journaled by this call. */
  feesReposted: number;
};

/**
 * One idempotent recovery of the payout GL of a batch (legend-pfk3q): resolves
 * its pending/skipped settlements once their lock journal and source account
 * are there, then journals the fees that are still unposted. Unlike the
 * finance endpoints it NEVER throws for a configuration that is not ready (it
 * leaves the posting for the next run); a real failure of one posting is
 * contained in that posting's savepoint. Safe to run concurrently and again:
 * the batch advisory lock, the journal keys and the conditional flips each
 * guard against a second credit.
 */
export async function recoverPayoutGlOfBatch(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
  now = new Date(),
): Promise<RecoverPayoutGlResult> {
  const batch = await loadBatchRunFirst(tx, tenantId, batchId);
  await lockBatchPayoutGl(tx, tenantId, batch);
  const { resolved } = await resolvePendingSettles(
    tx,
    tenantId,
    batch.payrollRunId,
    now,
    batch.id,
    { isolate: true },
  );
  // A frozen batch posts no fee either; the recovery after the unfreeze does.
  if (await batchIsFrozen(tx, tenantId, batch.id))
    return { resolved, feesReposted: 0 };
  const feesReposted = await repostFeesSoft(tx, tenantId, batch, now);
  return { resolved, feesReposted };
}

export type PayoutRecoveryReason =
  | "bank_charges_missing"
  | "accounting_disabled"
  | "accounting_was_off"
  | "source_account_unknown"
  | "source_account_inactive"
  | "payable_account_unknown"
  | "payable_account_inactive"
  | "fee_journal_mismatch"
  | "fee_amount_unverified"
  | "awaiting_resolve";

export type PayoutRecoveryRow = {
  postingId: string;
  batchId: string;
  feeIdr: number;
  netIdr: number;
  kind: PayoutPostingKind;
  reason: PayoutRecoveryReason;
};

/** @deprecated Use `PayoutRecoveryRow`; kept for existing callers. */
export type SkippedFeeRow = PayoutRecoveryRow;

type RecoveryBatch = Pick<
  BatchRow,
  "payrollRunId" | "channel" | "legalEntityId" | "sourceBankAccountId"
>;

/**
 * True when the posting is a pending/skipped settlement with a real net whose
 * lock journal exists: only the resolver (or a missing prerequisite) stands
 * between it and `settle`.
 */
async function settleOwed(
  tx: Tx,
  tenantId: TenantId,
  batch: RecoveryBatch,
  posting: FeePosting,
): Promise<boolean> {
  return (
    (posting.kind === "settle_pending" || posting.kind === "settle_skipped") &&
    openPostingTotal(posting, tenantId, "netIdr") > 0 &&
    (await runHasLockedJournal(tx, tenantId, batch.payrollRunId))
  );
}

/**
 * Why a posting in the recovery list is still open. Read-only; computed when
 * read, never stored. Mirrors the order in which the resolver and the fee
 * re-post stop: the bank charges gate of a skipped settlement, the source
 * account, then the fee prerequisites.
 */
export async function payoutRecoveryReason(
  tx: Tx,
  tenantId: TenantId,
  batch: RecoveryBatch,
  posting: FeePosting,
): Promise<PayoutRecoveryReason> {
  // Settled but the payable account is uncertain (0390): finance reconciles.
  if (posting.payableAccountHold) return "payable_account_unknown";
  // F5: a historical posting without a plain fee amount never flips.
  if (
    posting.feeIdr === null &&
    !posting.feePosted &&
    postingFeeIdr(posting, tenantId) > 0
  )
    return "fee_amount_unverified";
  // The fee journal exists but fails the amount/account check: permanent.
  if (await feeJournalMismatched(tx, tenantId, posting))
    return "fee_journal_mismatch";
  const owed = await settleOwed(tx, tenantId, batch, posting);
  const feeIdr = postingFeeIdr(posting, tenantId);
  const feeOwed =
    feeIdr > 0 &&
    // A skipped settlement owes its fee journal even with `fee_posted = true`
    // (owed: the resolver journals it; not owed: historical data, legend-qq68t).
    (!posting.feePosted || posting.kind === "settle_skipped") &&
    !(await journalKeyExists(
      tx,
      tenantId,
      payoutGlKeys.fee(posting.itemSetHash),
    ));
  const chargesMissing =
    feeOwed && !(await bankChargesMapped(tx, tenantId, batch.legalEntityId));
  if (owed) {
    if (chargesMissing && posting.kind === "settle_skipped")
      return "bank_charges_missing";
    const source = await postingSource(tx, tenantId, batch, posting);
    if (!source.ok) return source.reason;
    const payable = await payableAccountOf(tx, tenantId, batch, posting);
    if (!payable.ok) return payable.reason;
    return chargesMissing ? "bank_charges_missing" : "awaiting_resolve";
  }
  if (feeOwed) {
    if (!(await accountingEnabled(tx, tenantId))) return "accounting_disabled";
    // A skipped settlement of a run with no lock journal: the recovery job
    // never journals its fee; finance decides by the manual re-post.
    if (posting.kind === "settle_skipped") return "accounting_was_off";
    if (chargesMissing) return "bank_charges_missing";
    const sourceReason = await feeSourceReason(tx, tenantId, batch, posting);
    if (sourceReason !== null) return sourceReason;
  }
  return "awaiting_resolve";
}

/**
 * Why the account a fee-only posting would credit is not usable (null: it is).
 * Mirrors `postFeeOfPosting`: a settled posting credits the account its own
 * journal used (an active bank account), any other the frozen or recorded one.
 */
async function feeSourceReason(
  tx: Tx,
  tenantId: TenantId,
  batch: RecoveryBatch,
  posting: FeePosting,
): Promise<"source_account_unknown" | "source_account_inactive" | null> {
  if (posting.kind === "settle") {
    let accountId: string;
    try {
      accountId = await settledSourceAccount(
        tx,
        tenantId,
        batch.legalEntityId,
        posting.journalKey,
      );
    } catch (error) {
      if (error instanceof HttpError) return "source_account_unknown";
      throw error;
    }
    try {
      await assertActiveBankGlAccount(
        tx,
        tenantId,
        batch.legalEntityId,
        accountId,
      );
    } catch (error) {
      if (error instanceof HttpError) return "source_account_inactive";
      throw error;
    }
    return (await glAccountPostable(
      tx,
      tenantId,
      batch.legalEntityId,
      accountId,
    ))
      ? null
      : "source_account_inactive";
  }
  const source = await postingSource(tx, tenantId, batch, posting);
  if (!source.ok) return source.reason;
  if (batch.channel !== "cash" && batch.sourceBankAccountId !== null) {
    // A frozen bank account also has to be active (`frozenSourceGlAccount`).
    const frozen = await frozenSourceGlAccount(
      tx,
      tenantId,
      batch.legalEntityId,
      batch.sourceBankAccountId,
      { optional: true },
    );
    if (frozen === null) return "source_account_inactive";
  }
  return null;
}

/** Most rows `listPayoutRecovery` answers, oldest first. */
const RECOVERY_LIST_LIMIT = 500;
/** SQL rows read per page while the recovery lists filter and count. */
const RECOVERY_PAGE_SIZE = 200;
/** Default and maximum rows of one `listPayoutRecoveryPage` page. */
const RECOVERY_PAGE_DEFAULT = 100;
const RECOVERY_PAGE_MAX = 200;

/**
 * Reasons only a human clears: no configuration change or event brings the
 * posting back by itself, so the automatic sweep never retries them.
 */
const PERMANENT_RECOVERY_REASONS: ReadonlySet<PayoutRecoveryReason> = new Set([
  "accounting_was_off",
  "source_account_unknown",
  "payable_account_unknown",
  "fee_amount_unverified",
]);

/** SQL: the fee journal of the posting does not exist (key `payroll-payout-fee:<hash>`). */
const feeJournalMissingSql = sql`NOT EXISTS (SELECT 1 FROM ${journalEntries} WHERE ${journalEntries.tenantId} = ${payrollPayoutGlPostings.tenantId} AND ${journalEntries.idempotencyKey} = ${payoutGlKeys.fee("")} || ${payrollPayoutGlPostings.itemSetHash})`;

/**
 * SQL pre-filter of the recovery list (postings joined to their batch): a fee
 * not journaled, a pending/skipped settlement whose lock journal exists, or a
 * historical `settle_skipped` row (`fee_posted = true` from before the flag was
 * strict) whose fee journal is missing (legend-qq68t). The exact test, which
 * needs the sealed amounts, is `openRecoveryReason`.
 */
function recoveryCandidateWhere(tenantId: TenantId) {
  return and(
    eq(payrollPayoutGlPostings.tenantId, tenantId),
    // A waived settlement (legend-5qqb9) is terminal: never open again.
    ne(payrollPayoutGlPostings.kind, "settle_waived"),
    or(
      eq(payrollPayoutGlPostings.feePosted, false),
      // Settled, but the payable account is uncertain (0390): reconciliation.
      eq(payrollPayoutGlPostings.payableAccountHold, true),
      // A pending/skipped settlement is only open once the run's lock
      // journal exists (its net is sealed, so the net > 0 test is in code).
      and(
        inArray(payrollPayoutGlPostings.kind, [
          "settle_pending",
          "settle_skipped",
        ]),
        sql`EXISTS (SELECT 1 FROM ${journalEntries} WHERE ${journalEntries.tenantId} = ${payrollPayoutGlPostings.tenantId} AND ${journalEntries.idempotencyKey} = ${payrollGlKeys.locked("")} || ${payrollDisbursementBatches.payrollRunId}::text)`,
      ),
      // Historical row: bank batches only. Cash has no bank fee, and without
      // this join every cash payment made while accounting was off would be
      // scanned forever. The fee is sealed, so SQL cannot see fee > 0: a bank
      // `settle_skipped` row with a zero fee is still scanned (known limit; the
      // exact test in `openRecoveryReason` drops it). No date cutoff.
      and(
        eq(payrollPayoutGlPostings.kind, "settle_skipped"),
        ne(payrollDisbursementBatches.channel, "cash"),
        feeJournalMissingSql,
      ),
    ),
  );
}

const recoveryBatchJoin = and(
  eq(payrollDisbursementBatches.tenantId, payrollPayoutGlPostings.tenantId),
  eq(payrollDisbursementBatches.id, payrollPayoutGlPostings.batchId),
);

const recoveryBatchColumns = {
  payrollRunId: payrollDisbursementBatches.payrollRunId,
  channel: payrollDisbursementBatches.channel,
  legalEntityId: payrollDisbursementBatches.legalEntityId,
  sourceBankAccountId: payrollDisbursementBatches.sourceBankAccountId,
};

/**
 * Why the posting is open, or null when it is not. A `fee_posted = true` row is
 * open only while a settlement is owed or, for a `settle_skipped` row with a
 * fee, while its fee journal does not exist (historical data; it is listed as
 * `accounting_was_off`; it is visible only, nothing journals it).
 */
async function openRecoveryReason(
  tx: Tx,
  tenantId: TenantId,
  posting: FeePosting,
  batch: RecoveryBatch,
): Promise<PayoutRecoveryReason | null> {
  if (
    !posting.payableAccountHold &&
    posting.feePosted &&
    !(await settleOwed(tx, tenantId, batch, posting)) &&
    !(await historicalFeeMissing(tx, tenantId, posting))
  )
    return null;
  return payoutRecoveryReason(tx, tenantId, batch, posting);
}

async function historicalFeeMissing(
  tx: Tx,
  tenantId: TenantId,
  posting: FeePosting,
): Promise<boolean> {
  return (
    posting.feePosted &&
    posting.kind === "settle_skipped" &&
    postingFeeIdr(posting, tenantId) > 0 &&
    !(await journalKeyExists(
      tx,
      tenantId,
      payoutGlKeys.fee(posting.itemSetHash),
    ))
  );
}

function recoveryRowOf(
  tenantId: TenantId,
  posting: FeePosting,
  reason: PayoutRecoveryReason,
): PayoutRecoveryRow {
  return {
    postingId: posting.id,
    batchId: posting.batchId,
    feeIdr: postingFeeIdr(posting, tenantId),
    netIdr: openPostingTotal(posting, tenantId, "netIdr"),
    kind: posting.kind,
    reason,
  };
}

export type ListPayoutRecoveryOptions = {
  /** Drop the rows that need a human (the sweep); default: every open row. */
  retryableOnly?: boolean;
  /** Stop after this many distinct batches (the sweep's tick cap). */
  maxBatches?: number;
};

/**
 * Postings finance still has to look at: a bank fee not journaled
 * (`fee_posted = false`), a pending/skipped settlement with a real net whose
 * lock journal exists but that is not a `settle` yet, or a historical
 * `settle_skipped` row without its fee journal.
 *
 * The reason is computed per row and `retryableOnly` drops permanent rows
 * BEFORE any limit: the SQL is paged, so the limit counts the rows (or batches)
 * that are answered, never rows that are skipped. This is the whole list kept
 * for internal use and older tests; the finance screen pages it with
 * `listPayoutRecoveryPage`.
 */
export async function listPayoutRecovery(
  tx: Tx,
  tenantId: string,
  options: ListPayoutRecoveryOptions = {},
): Promise<PayoutRecoveryRow[]> {
  const scoped = tenantId as TenantId;
  const out: PayoutRecoveryRow[] = [];
  const batchIds = new Set<string>();
  for (let offset = 0; ; offset += RECOVERY_PAGE_SIZE) {
    const rows = await tx
      .select({
        posting: payrollPayoutGlPostings,
        batch: recoveryBatchColumns,
      })
      .from(payrollPayoutGlPostings)
      .innerJoin(payrollDisbursementBatches, recoveryBatchJoin)
      .where(recoveryCandidateWhere(scoped))
      .orderBy(
        asc(payrollPayoutGlPostings.postedAt),
        asc(payrollPayoutGlPostings.id),
      )
      .limit(RECOVERY_PAGE_SIZE)
      .offset(offset);
    for (const { posting, batch } of rows) {
      const reason = await openRecoveryReason(tx, scoped, posting, batch);
      if (reason === null) continue;
      if (options.retryableOnly && PERMANENT_RECOVERY_REASONS.has(reason))
        continue;
      if (
        options.maxBatches !== undefined &&
        !batchIds.has(posting.batchId) &&
        batchIds.size >= options.maxBatches
      )
        continue;
      batchIds.add(posting.batchId);
      out.push(recoveryRowOf(scoped, posting, reason));
      if (out.length >= RECOVERY_LIST_LIMIT) return out;
    }
    if (rows.length < RECOVERY_PAGE_SIZE) return out;
  }
}

/**
 * True when some open posting of the batch waits for something that can still
 * change by itself (a reason the sweep may retry). Every posting of the batch
 * is looked at (paged, no cap) and the scan stops at the first retryable one.
 */
async function batchHasRetryableRow(
  tx: Tx,
  tenantId: TenantId,
  batchId: string,
): Promise<boolean> {
  for (let offset = 0; ; offset += RECOVERY_PAGE_SIZE) {
    const rows = await tx
      .select({
        posting: payrollPayoutGlPostings,
        batch: recoveryBatchColumns,
      })
      .from(payrollPayoutGlPostings)
      .innerJoin(payrollDisbursementBatches, recoveryBatchJoin)
      .where(
        and(
          recoveryCandidateWhere(tenantId),
          eq(payrollPayoutGlPostings.batchId, batchId),
        ),
      )
      .orderBy(
        asc(payrollPayoutGlPostings.postedAt),
        asc(payrollPayoutGlPostings.id),
      )
      .limit(RECOVERY_PAGE_SIZE)
      .offset(offset);
    for (const { posting, batch } of rows) {
      const reason = await openRecoveryReason(tx, tenantId, posting, batch);
      if (reason !== null && !PERMANENT_RECOVERY_REASONS.has(reason))
        return true;
    }
    if (rows.length < RECOVERY_PAGE_SIZE) return false;
  }
}

/**
 * The batches the recovery sweep may work on (legend-la22h): ids in ascending
 * order, strictly after `after`, that have an open posting AND at least one
 * posting with a retryable reason. Batches only a human clears are never
 * listed, so they do not use up the sweep's limit. The sweep selects BATCHES
 * (not postings) and rotates `after`, so a batch that stays blocked in front
 * cannot starve the ones behind it. SQL is paged by 200 batch ids. A frozen
 * batch is skipped (legend-l2zru).
 */
export async function listRecoveryBatchIds(
  tx: Tx,
  tenantId: string,
  options: { after: string | null; limit: number },
): Promise<string[]> {
  const scoped = tenantId as TenantId;
  const out: string[] = [];
  let cursor =
    options.after !== null && UUID.test(options.after) ? options.after : null;
  while (out.length < options.limit) {
    const page = await tx
      .selectDistinct({ batchId: payrollPayoutGlPostings.batchId })
      .from(payrollPayoutGlPostings)
      .innerJoin(payrollDisbursementBatches, recoveryBatchJoin)
      .where(
        and(
          recoveryCandidateWhere(scoped),
          cursor === null
            ? undefined
            : sql`${payrollPayoutGlPostings.batchId} > ${cursor}::uuid`,
          // A frozen batch (an open "not me" dispute on it or on a batch of
          // the same payslips, legend-l2zru) is for a person to clear: the
          // sweep neither retries nor lists it.
          batchIsNotFrozenSql(scoped, sql`${payrollPayoutGlPostings.batchId}`),
        ),
      )
      .orderBy(asc(payrollPayoutGlPostings.batchId))
      .limit(RECOVERY_PAGE_SIZE);
    for (const { batchId } of page) {
      cursor = batchId;
      if (!(await batchHasRetryableRow(tx, scoped, batchId))) continue;
      out.push(batchId);
      if (out.length >= options.limit) return out;
    }
    if (page.length < RECOVERY_PAGE_SIZE) return out;
  }
  return out;
}

const invalidRecoveryCursor = () =>
  payoutRefuse(422, "VALIDATION_ERROR", "Kursor tidak valid.");
const TIMESTAMPTZ_TEXT =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?)?$/;

/**
 * The pattern passes month 13 or day 32, which the `::timestamptz` cast would
 * refuse with a 500: check the date and time parts round-trip as a real date.
 */
function isRealTimestampText(text: string): boolean {
  const [, y, mo, d, h, mi, sec] =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text) ?? [];
  if (y === undefined) return false;
  const parts = [y, mo, d, h, mi, sec].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const probe = new Date(
    Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]),
  );
  if (
    probe.getUTCFullYear() !== parts[0] ||
    probe.getUTCMonth() !== parts[1] - 1 ||
    probe.getUTCDate() !== parts[2] ||
    probe.getUTCHours() !== parts[3] ||
    probe.getUTCMinutes() !== parts[4] ||
    probe.getUTCSeconds() !== parts[5]
  )
    return false;
  const zone = /([+-])(\d{2})(?::(\d{2}))?$/.exec(text.slice(19));
  return zone === null || (Number(zone[2]) <= 15 && Number(zone[3] ?? 0) < 60);
}

/** Opaque cursor of (posted_at text, id): the text keeps microseconds. */
function encodeRecoveryCursor(postedAt: string, id: string): string {
  return Buffer.from(JSON.stringify([postedAt, id]), "utf8").toString(
    "base64url",
  );
}

function decodeRecoveryCursor(
  cursor: string | undefined,
): { postedAt: string; id: string } | null {
  if (cursor === undefined || cursor === "") return null;
  let keys: unknown;
  try {
    keys = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidRecoveryCursor();
  }
  if (
    !Array.isArray(keys) ||
    keys.length !== 2 ||
    typeof keys[0] !== "string" ||
    typeof keys[1] !== "string" ||
    !TIMESTAMPTZ_TEXT.test(keys[0]) ||
    !UUID.test(keys[1]) ||
    !isRealTimestampText(keys[0])
  )
    throw invalidRecoveryCursor();
  return { postedAt: keys[0], id: keys[1] };
}

export type PayoutRecoveryPage = {
  rows: PayoutRecoveryRow[];
  /** Opaque cursor for the next page; null when this is the last one. */
  next: string | null;
};

/**
 * One page of the recovery list for finance (legend-i612a), oldest posting
 * first, keyset-paged on (posted_at, id) with an opaque cursor. `limit`
 * defaults to 100 and is capped at 200. No row is silently dropped: a page
 * that ends before the list does carries a `next` cursor, and the last page
 * has `next = null` (the cursor is only issued when one more open row exists).
 */
export async function listPayoutRecoveryPage(
  tx: Tx,
  tenantId: string,
  options: { after?: string; limit?: number } = {},
): Promise<PayoutRecoveryPage> {
  const scoped = tenantId as TenantId;
  const limit = Math.min(
    RECOVERY_PAGE_MAX,
    Math.max(1, Math.trunc(options.limit ?? RECOVERY_PAGE_DEFAULT)),
  );
  let cursor = decodeRecoveryCursor(options.after);
  const rows: PayoutRecoveryRow[] = [];
  let lastKey: { postedAt: string; id: string } | null = null;
  const postedAtText = sql<string>`${payrollPayoutGlPostings.postedAt}::text`;
  for (;;) {
    const page = await tx
      .select({
        posting: payrollPayoutGlPostings,
        batch: recoveryBatchColumns,
        postedAtText,
      })
      .from(payrollPayoutGlPostings)
      .innerJoin(payrollDisbursementBatches, recoveryBatchJoin)
      .where(
        and(
          recoveryCandidateWhere(scoped),
          cursor === null
            ? undefined
            : sql`(${payrollPayoutGlPostings.postedAt}, ${payrollPayoutGlPostings.id}) > (${cursor.postedAt}::timestamptz, ${cursor.id}::uuid)`,
        ),
      )
      .orderBy(
        asc(payrollPayoutGlPostings.postedAt),
        asc(payrollPayoutGlPostings.id),
      )
      .limit(RECOVERY_PAGE_SIZE);
    for (const { posting, batch, postedAtText: postedAt } of page) {
      cursor = { postedAt, id: posting.id };
      const reason = await openRecoveryReason(tx, scoped, posting, batch);
      if (reason === null) continue;
      if (rows.length >= limit)
        // One more open row exists: hand out the cursor of the last row kept.
        return {
          rows,
          next: lastKey
            ? encodeRecoveryCursor(lastKey.postedAt, lastKey.id)
            : null,
        };
      rows.push(recoveryRowOf(scoped, posting, reason));
      lastKey = cursor;
    }
    if (page.length < RECOVERY_PAGE_SIZE) return { rows, next: null };
  }
}

/** @deprecated Use `listPayoutRecovery`; the rows only gained fields. */
export const listSkippedFees = listPayoutRecovery;

// Part B (legend-qxkm6): `recordOverpaidItem` lives in its own file.
export * from "./payroll-payout-overpaid.service.ts";
