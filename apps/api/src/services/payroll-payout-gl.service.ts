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
//   A pending CASH settlement stores the petty cash account mapped at the
//   handover (`source_gl_account_id`, legend-cnpap) and resolves to it, not to
//   a mapping changed later; a missing cash mapping refuses 409
//   PAYOUT_SOURCE_ACCOUNT_MISSING before anything is recorded. A legacy pending
//   cash posting without the frozen account fails closed (409): it never
//   credits cash from today's mapping.
//   The bank fee of a pending settlement is journaled when it resolves (the
//   posting says `fee_posted = false` until then; same key, so exactly once),
//   from the frozen bank account; a missing bank charges mapping leaves
//   `fee_posted = false` for `repostSkippedFees`, it never blocks the resolve.
//   A `settle_skipped` posting with a real net (money left while accounting was
//   off) is turned into `settle` the same way once the consumer has posted the
//   lock journal (legend-vvzij), so 2103 of that batch does not stay open. If
//   no source account can be resolved without a throw, it stays skipped.
// - `payroll.paid` leaves the outbox once, when the run turned paid, with
//   `settledPerItem: true`: the GL consumer posts nothing for it.
//
// Lock order: the run row, then the batch row (`loadBatchRunFirst`), then the
// batch advisory lock. The caller's transaction is the unit: a throw rolls back
// every row and every journal. Amounts are sealed; nothing here logs one.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import {
  payrollPaid,
  type PayrollRunId,
  type PayrollRunType,
} from "@starter/shared/hris/payroll";
import { accountMappings, journalEntries } from "../db/schema/index.ts";
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

async function runHasLockedJournal(
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
 * True while the run's `payroll.locked` event is still in the outbox (not
 * delivered): the lock happened, the GL consumer has not posted its journal
 * yet. A delivered event that left no journal (all-zero run, accounting off at
 * that time) is not pending.
 */
async function runLockPending(
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
 * True while the run's locked journal is missing but will come: accounting is
 * on and `payroll.locked` is still in the outbox. A journal that cannot be
 * posted now (overpaid second transfer) must wait for it, or its net never
 * reaches the GL.
 */
export async function lockJournalPending(
  tx: Tx,
  tenantId: TenantId,
  runId: string,
): Promise<boolean> {
  return (
    !(await runHasLockedJournal(tx, tenantId, runId)) &&
    (await accountingEnabled(tx, tenantId)) &&
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

/**
 * The account override of a pending settlement. Bank: the GL account of the
 * bank account frozen on the batch, read WITHOUT the active filter. The money
 * left from that account, so a company bank account deactivated since then must
 * not strand the settlement. A batch without a frozen account follows the config
 * (it has nothing else). Cash: the petty cash account stored on the posting at
 * the handover (legend-cnpap); a posting without one never follows today's
 * mapping (fail closed). Throws 409 when nothing resolves, so the consumer
 * retries instead of leaving 2103 open for good.
 */
async function pendingSettleOverride(
  tx: Tx,
  tenantId: TenantId,
  batch: Pick<BatchRow, "channel" | "legalEntityId" | "sourceBankAccountId">,
  posting: { sourceGlAccountId: string | null },
): Promise<Partial<Record<"bank" | "petty_cash", string>> | undefined> {
  if (batch.channel === "cash") {
    // A pending cash posting never falls back to today's mapping: the money
    // left from the account frozen at the handover, so without it fail closed.
    if (posting.sourceGlAccountId === null)
      throw payoutRefuse(
        409,
        PAYOUT_SOURCE_ACCOUNT_MISSING.code,
        PAYOUT_SOURCE_ACCOUNT_MISSING.message,
      );
    return { petty_cash: posting.sourceGlAccountId };
  }
  if (batch.sourceBankAccountId !== null) {
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
    if (row) return { bank: row.glAccountId };
    throw payoutRefuse(
      409,
      PAYOUT_SOURCE_ACCOUNT_MISSING.code,
      PAYOUT_SOURCE_ACCOUNT_MISSING.message,
    );
  }
  const legacy = await sourceBankOverride(tx, tenantId, batch, {
    optional: true,
  });
  if (legacy === null) {
    // The consumer retries and then dead-letters this lock event: say why, so
    // finance can fix the source account and replay it.
    logger.error(
      { tenantId, runBatchSource: "pending-settle-source-missing" },
      "payout pending settlement cannot resolve its source account",
    );
    throw payoutRefuse(
      409,
      PAYOUT_SOURCE_ACCOUNT_MISSING.code,
      PAYOUT_SOURCE_ACCOUNT_MISSING.message,
    );
  }
  return legacy;
}

/**
 * The account override of a `settle_skipped` posting that is being turned into
 * a settle (legend-vvzij). Never throws for a missing account: the consumer
 * must not stall, so it returns undefined and the posting stays skipped. Bank:
 * the frozen batch account like a pending settle, only if its GL account is
 * postable. Cash: the account stored on the posting when it was skipped, else
 * (older rows) the petty cash mapping of the moment; only if postable.
 */
async function skippedSettleOverride(
  tx: Tx,
  tenantId: TenantId,
  batch: Pick<BatchRow, "channel" | "legalEntityId" | "sourceBankAccountId">,
  posting: { sourceGlAccountId: string | null },
): Promise<Partial<Record<"bank" | "petty_cash", string>> | undefined> {
  if (batch.channel === "cash") {
    const accountId =
      posting.sourceGlAccountId ??
      (await mappedPettyCashAccount(tx, tenantId, batch.legalEntityId));
    if (
      accountId === null ||
      !(await glAccountPostable(tx, tenantId, batch.legalEntityId, accountId))
    )
      return undefined;
    return { petty_cash: accountId };
  }
  let override: Partial<Record<"bank" | "petty_cash", string>> | undefined;
  try {
    override = await pendingSettleOverride(tx, tenantId, batch, posting);
  } catch (error) {
    if (error instanceof HttpError) return undefined;
    throw error;
  }
  // A frozen bank GL account that is not postable now would make the journal
  // fail (ACCOUNT_INACTIVE) and stall the consumer: stay skipped instead.
  if (
    override?.bank !== undefined &&
    !(await glAccountPostable(tx, tenantId, batch.legalEntityId, override.bank))
  )
    return undefined;
  return override;
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
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`payroll-payout-gl:${tenantId}:${batch.id}`}))`,
  );
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
  const journaled =
    netIdr > 0 && (await runHasLockedJournal(tx, tenantId, batch.payrollRunId));
  // Locked event still queued and accounting on, or accounting switched off
  // after an earlier batch of the same run went pending (the consumer then
  // posts the lock journal and resolves it): keep this settlement pending too
  // (legend-2aspe) instead of dropping it as `settle_skipped`, or its net stays
  // open on 2103.
  const accountingOn = await accountingEnabled(tx, tenantId);
  const pending =
    !journaled &&
    netIdr > 0 &&
    (await runLockPending(tx, tenantId, batch.payrollRunId)) &&
    (accountingOn ||
      (await runHasPendingSettle(tx, tenantId, batch.payrollRunId)));
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

  // A skipped CASH settlement remembers the petty cash account of this moment
  // when it is usable (best effort, never refuses): if the lock journal comes
  // later, the settle follows this account, not a later remap.
  if (kind === "settle_skipped" && batch.channel === "cash") {
    const mapped = await mappedPettyCashAccount(
      tx,
      tenantId,
      batch.legalEntityId,
    );
    pendingCashAccountId =
      mapped !== null &&
      (await glAccountPostable(tx, tenantId, batch.legalEntityId, mapped))
        ? mapped
        : null;
  }

  // Fail closed on the source account BEFORE the journal branch (legend-ijhe3):
  // with accounting on, an unusable source is refused whether or not the run
  // has a locked journal, so it is never turned into `settle_skipped`. Nothing
  // is recorded; the confirmation can be sent again once the account is active.
  if (!journaled && (accountingOn || pending))
    await sourceBankOverride(tx, tenantId, batch);

  // The fee is real money the PT paid, whether or not the salary journal
  // applies. A fee whose bank charges mapping or source account is missing is
  // never allowed to block a real payment confirmation (the money is gone): it
  // is skipped, the posting says `fee_posted = false`, and finance re-posts it
  // once the mapping is back (`repostSkippedFees`). With accounting off nothing
  // is journaled at all, so there is nothing to re-post.
  let feeJournaled = false;
  let feePosted = true;
  if (feeIdr > 0 && (journaled || (await accountingEnabled(tx, tenantId)))) {
    feeJournaled =
      (await bankChargesMapped(tx, tenantId, batch.legalEntityId)) &&
      (await sourceBankOverride(tx, tenantId, batch, { optional: true })) !==
        null;
    feePosted = feeJournaled;
    if (!feeJournaled)
      logger.warn(
        { tenantId, batchId: batch.id, reason: "fee_skipped_no_mapping" },
        "payout fee not posted: bank charges mapping or source account missing",
      );
  }
  // A pending settlement journals its fee when it resolves (also with
  // accounting switched off since): the money left, so the fee must not be
  // marked posted here (legend-1t65x).
  if (kind === "settle_pending" && feeIdr > 0 && !feeJournaled)
    feePosted = false;
  if (journaled || feeJournaled) {
    const context = payoutScope(actor.tenantId);
    const entryDate = payrollEntryDateOf(now.toISOString());
    const accountOverrides =
      (await sourceBankOverride(tx, tenantId, batch)) ?? undefined;
    if (journaled)
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
          accountOverrides,
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
    sourceGlAccountId: pendingCashAccountId,
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
 * the batch's frozen source account even if it was deactivated since; when no
 * account resolves at all it throws, so the consumer retries and the outbox
 * fails loudly instead of leaving the posting pending forever.
 */
export async function resolvePendingSettles(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
  now = new Date(),
  onlyBatchId?: string,
): Promise<{ resolved: number }> {
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
  const context = payoutScope(tenantId);
  const entryDate = payrollEntryDateOf(now.toISOString());
  let resolved = 0;
  for (const batch of batches) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`payroll-payout-gl:${tenantId}:${batch.id}`}))`,
    );
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
      const netIdr = openPostingTotal(posting, tenantId, "netIdr");
      // A skipped posting with a real net: money left while accounting was off
      // and the lock journal came after (legend-vvzij). It becomes a normal
      // settle; with no resolvable source account it stays skipped and never
      // stalls the consumer.
      const wasSkipped = posting.kind === "settle_skipped";
      if (wasSkipped && netIdr === 0) continue;
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
        continue;
      }
      const accountOverrides = wasSkipped
        ? await skippedSettleOverride(tx, tenantId, batch, posting)
        : await pendingSettleOverride(tx, tenantId, batch, posting);
      if (accountOverrides === undefined) {
        logger.warn(
          { tenantId, batchId: batch.id, reason: "skipped_settle_no_source" },
          "payout skipped settlement left as is: source account not resolvable",
        );
        continue;
      }
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
          accountOverrides,
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
      if (feeIdr > 0 && (!posting.feePosted || wasSkipped)) {
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
        // Only false -> true: the posting guard refuses the other direction, so
        // a skipped posting (flag true from the start) whose fee cannot be
        // journaled keeps its flag and the resolve still goes through.
        if (feeMapped && !posting.feePosted)
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
      resolved += 1;
    }
  }
  return { resolved };
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
      accountOverrides: { bank: settledBank },
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
 * Journals the bank fee of every posting of the batch that skipped it
 * (`fee_posted = false`): Dr bank charges / Cr the source account, key
 * `payroll-payout-fee:<item_set_hash>`, then `fee_posted = true`. Exactly once:
 * the batch advisory lock serializes callers, a caller that waited finds no
 * posting left, and the journal key is the second guard. A mapping or source
 * account that is still missing answers 409 and posts nothing.
 */
export async function repostSkippedFees(
  tx: Tx,
  actor: Actor,
  batchId: string,
  now = new Date(),
): Promise<RepostFeesResult> {
  const tenantId = actor.tenantId as TenantId;
  const batch = await loadBatchRunFirst(tx, actor.tenantId, batchId);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`payroll-payout-gl:${tenantId}:${batch.id}`}))`,
  );
  // A pending settlement whose locked journal exists by now resolves first, so
  // the fee re-post never runs ahead of the salary journal it belongs to.
  await resolvePendingSettles(tx, tenantId, batch.payrollRunId, now, batch.id);
  const postings = await tx
    .select()
    .from(payrollPayoutGlPostings)
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        eq(payrollPayoutGlPostings.batchId, batch.id),
        eq(payrollPayoutGlPostings.feePosted, false),
      ),
    )
    .orderBy(asc(payrollPayoutGlPostings.id))
    .for("update");
  if (postings.length === 0) return { reposted: 0 };

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

  const context = payoutScope(actor.tenantId);
  const entryDate = payrollEntryDateOf(now.toISOString());
  let reposted = 0;
  for (const posting of postings) {
    const feeIdr = postingFeeIdr(posting, tenantId);
    if (feeIdr > 0) {
      // A settled group gives to the account its own salary journal used; a
      // group settled without a journal uses the configured source account.
      // Either way the account must still belong to an active bank account:
      // the settled one may have been deactivated since the settle.
      let accountOverrides: Partial<Record<"bank", string>> | undefined;
      if (posting.kind === "settle") {
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
        accountOverrides = { bank: settledBank };
      } else
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
    reposted += 1;
  }
  return { reposted };
}

export type SkippedFeeRow = {
  postingId: string;
  batchId: string;
  feeIdr: number;
};

/** Postings whose bank fee is still waiting to be journaled (finance list). */
export async function listSkippedFees(
  tx: Tx,
  tenantId: string,
): Promise<SkippedFeeRow[]> {
  const rows = await tx
    .select()
    .from(payrollPayoutGlPostings)
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId as TenantId),
        eq(payrollPayoutGlPostings.feePosted, false),
      ),
    )
    .orderBy(
      asc(payrollPayoutGlPostings.postedAt),
      asc(payrollPayoutGlPostings.id),
    );
  return rows.map((row) => ({
    postingId: row.id,
    batchId: row.batchId,
    feeIdr: postingFeeIdr(row, tenantId),
  }));
}

// Part B (legend-qxkm6): `recordOverpaidItem` lives in its own file.
export * from "./payroll-payout-overpaid.service.ts";
