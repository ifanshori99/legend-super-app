// Payroll -> GL bridge (PRD v1.7 §3 D.30 "Jurnal Payroll", D.31, §3.19 Jurnal
// Otomatis; PAYR-04, PAYR-05; bead legend-4n3r). Wired in worker-main.ts next
// to the inventory GL consumer, on the cloud only (an edge node never posts the
// GL). The payroll events (`emitPayrollEvent`, payroll-events.ts) post their
// journals inside the outbox consumption transaction. Only tenants with the
// accounting module on are bridged; others are `ignored`. Paid and reversed
// follow the locked entry instead: once a run's journal exists they post even
// if the module was switched off since. An all-zero journal is `skipped`.
// `payroll.locked` follows a pending payout too: when the run already has a
// `settle_pending` payout posting (money left before this journal), it is posted
// and resolved even if the module was switched off since (legend-2aspe); the
// flag only decides NEW payroll, so with no pending settlement it is `ignored`.
//
// - `payroll.locked`: the run journal (`payroll.locked` rule) on the period
//   end, amounts from `payrollJournalAmounts(totals)`. When the entity's
//   service_charge mapping points to a revenue account, the
//   `service_charge_expense` variant is posted (`payrollLockedVariant`): the
//   service charge payout debits salary_expense, never revenue. Other types
//   (liability, or a legacy mapping saved before the type guard) debit the
//   mapped account, where the POS credited it. No service_charge mapping: the base rule, which then fails
//   ACCOUNT_MAPPING_MISSING when the service charge is above 0. After the journal
//   it resolves the run's `settle_pending` payout postings
//   (`resolvePendingSettles`, legend-2aspe).
// - `payroll.paid`: Dr salaries_payable net, Cr bank / petty_cash, on the
//   business date of the payment. With `settledPerItem: true` it posts nothing:
//   the payout settle (payroll-payout-gl.service.ts) journaled every item. Skipped when the run has no locked entry
//   (accounting switched on after the lock): the payable was never booked.
// - `payroll.reversed`: reverses the locked entry itself (ACC-01 path), so the
//   reversal mirrors what was really posted. The `payroll.reversed` rule built
//   from the payload totals is only a cross-check against that entry; it uses
//   the base `payroll.locked` rule because the variants share the amount keys.
// - `employee_loan.disbursed`: Dr employee_receivable, Cr petty_cash (`cash`)
//   or bank (`bank`) by the payload's `disbursedVia`; absent (events emitted
//   before legend-1coh) posts the base rule, petty cash.
// - `reimbursement.paid`: a payroll payout posts nothing (the run journal
//   carries it); a cash payout posts on the employee's legal entity.
//
// Petty cash lock (legend-3k9qg): the cash `payroll.paid`, the cash/unset loan and
// the cash reimbursement credit petty cash (1102), so they take the legal
// entity's cash/bank lock (`entityLock`) before posting, the lock the petty cash
// return holds while it reads GL 1102. `postJournalInTransaction` also takes it
// for any credit on the petty_cash account (re-entrant, so no double wait).
//
// Idempotency: every journal has a deterministic key
// (`payroll-gl:<kind>:<id>`), so a replayed event returns the entry already
// posted and posts nothing new.
//
// Errors: unlike the inventory bridge there is no savepoint and no blocked
// table. Every failure (closed period, missing mapping, a reversal whose totals
// disagree with the locked entry, an employee without a legal entity)
// propagates and rolls the consumption back, so the outbox retries and finally
// dead-letters the event (`replayOutbox` after the fix). That is safe only
// because the outbox delivers one aggregate's events in sequence order: a
// failing `payroll.locked` holds back the run's `paid` and `reversed`, which
// would otherwise skip for want of a locked entry.
//
// Dates: the plain Asia/Jakarta calendar date (cutoff 00:00, not the outlet
// trading-day cutoff), so a transfer at 01:00 on the 1st lands in the new
// month. The run journal is dated min(period end, lock date); a reversal is
// never dated before the entry it reverses.

import { and, eq } from "drizzle-orm";
import {
  type AccountType,
  defaultPostingRules,
  payrollJournalAmounts,
  payrollLockedVariant,
  resolvePostingRule,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  employeeLoanDisbursed,
  payrollLocked,
  payrollPaid,
  payrollReversed,
  reimbursementPaid,
} from "@starter/shared/hris/payroll";
import { isModuleEnabled } from "@starter/shared/platform";
import {
  accountMappings,
  chartOfAccounts,
  employees,
  journalEntries,
  journalLines,
  tenants,
} from "../db/schema/index.ts";
import { payrollRuns } from "../db/schema/payroll.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import {
  postJournalFromRuleInTransaction,
  reverseJournalInTransaction,
} from "./accounting-journal.service.ts";
import type { TenantTransaction } from "./accounting-shared.ts";

type Tx = TenantTransaction;

export type PayrollGlResult =
  | { status: "ignored" }
  /** Accounting on, but nothing to post (no locked entry, payroll payout). */
  | { status: "skipped" }
  | { status: "posted"; journalEntryId: string };

const REVERSAL_REASON = "Payroll dibatalkan (PAYR-05)";

export const payrollGlKeys = {
  locked: (runId: string) => `payroll-gl:locked:${runId}`,
  paid: (runId: string) => `payroll-gl:paid:${runId}`,
  reversed: (runId: string) => `payroll-gl:reversed:${runId}`,
  loan: (loanId: string) => `payroll-gl:loan:${loanId}`,
  reimbursement: (reimbursementId: string) =>
    `payroll-gl:reimbursement:${reimbursementId}`,
};

async function accountingEnabled(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<boolean> {
  const [row] = await tx
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  return isModuleEnabled(row?.featureFlags ?? null, "accounting");
}

function emittedWithAccountingOn(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { accountingOnAtEmit?: unknown }).accountingOnAtEmit === true
  );
}

function allZero(amounts: Readonly<Record<string, number>>): boolean {
  return Object.values(amounts).every((value) => value === 0);
}

/** Payroll is not outlet trade: the Asia/Jakarta calendar date (cutoff 00:00). */
const CALENDAR_CLOCK = Object.freeze({
  timeZone: DEFAULT_BUSINESS_DAY_CLOCK.timeZone,
  cutoff: "00:00",
});

function entryDateOf(instant: string) {
  return businessDateOf(instant, CALENDAR_CLOCK);
}

/** The Asia/Jakarta calendar date of an instant, for the payout journals. */
export const payrollEntryDateOf = entryDateOf;

const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

/** Type of the account the entity's service_charge role maps to, if any. */
async function serviceChargeAccountType(
  tx: Tx,
  context: ScopedTenantContext,
  legalEntityId: string,
): Promise<AccountType | null> {
  const [row] = await tx
    .select({ type: chartOfAccounts.type })
    .from(accountMappings)
    .innerJoin(
      chartOfAccounts,
      and(
        eq(chartOfAccounts.tenantId, accountMappings.tenantId),
        eq(chartOfAccounts.legalEntityId, accountMappings.legalEntityId),
        eq(chartOfAccounts.id, accountMappings.accountId),
      ),
    )
    .where(
      and(
        eq(accountMappings.tenantId, context.tenant.tenantId),
        eq(accountMappings.legalEntityId, legalEntityId),
        eq(accountMappings.role, "service_charge"),
      ),
    )
    .limit(1);
  return row?.type ?? null;
}

/** Sorted non-zero amounts of one side: what the entry's lines must carry. */
function sideAmounts(
  lines: readonly { side: "debit" | "credit"; amount: string }[],
  amounts: Readonly<Record<string, number>>,
  side: "debit" | "credit",
): number[] {
  return lines
    .filter((line) => line.side === side)
    .map((line) => amounts[line.amount] ?? 0)
    .filter((value) => value !== 0)
    .sort((a, b) => a - b);
}

async function entryByKey(
  tx: Tx,
  context: ScopedTenantContext,
  key: string,
): Promise<{ id: string; entryDate: string } | null> {
  const [row] = await tx
    .select({ id: journalEntries.id, entryDate: journalEntries.entryDate })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, context.tenant.tenantId),
        eq(journalEntries.idempotencyKey, key),
      ),
    )
    .limit(1);
  return row ? { id: row.id, entryDate: String(row.entryDate) } : null;
}

const lockedEntryOf = (tx: Tx, context: ScopedTenantContext, runId: string) =>
  entryByKey(tx, context, payrollGlKeys.locked(runId));

/** The reversal already posted against an entry, by whatever key. */
async function reversalOf(
  tx: Tx,
  context: ScopedTenantContext,
  entryId: string,
): Promise<{ id: string; idempotencyKey: string | null } | null> {
  const [row] = await tx
    .select({
      id: journalEntries.id,
      idempotencyKey: journalEntries.idempotencyKey,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, context.tenant.tenantId),
        eq(journalEntries.reversalOf, entryId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function entrySideAmounts(
  tx: Tx,
  context: ScopedTenantContext,
  entryId: string,
): Promise<{ debit: number[]; credit: number[] }> {
  const rows = await tx
    .select({ debit: journalLines.debitIdr, credit: journalLines.creditIdr })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.tenantId, context.tenant.tenantId),
        eq(journalLines.entryId, entryId),
      ),
    );
  const pick = (side: "debit" | "credit") =>
    rows
      .map((row) => Number(row[side]))
      .filter((value) => value !== 0)
      .sort((a, b) => a - b);
  return { debit: pick("debit"), credit: pick("credit") };
}

/**
 * Posts the GL journal of one payroll event (see the header). Returns
 * `ignored` for other events, foreign tenants and tenants without accounting.
 */
export async function deliverPayrollGlEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<PayrollGlResult> {
  if (event.tenantId !== context.tenant.tenantId) return { status: "ignored" };
  switch (event.name) {
    case payrollLocked.name:
    case payrollPaid.name:
    case payrollReversed.name:
    case employeeLoanDisbursed.name:
    case reimbursementPaid.name:
      break;
    default:
      return { status: "ignored" };
  }
  assertTrustedScopedContext(context);
  // Paid and reversed follow the locked entry, not the current flag: once the
  // run's payable is booked, switching accounting off later must not leave
  // 2103 open (paid) or the run journal standing (reversed). A locked event
  // follows a pending payout settlement the same way (legend-2aspe): the money
  // already left, so its journal is posted and the pending settle resolved.
  //
  // A cash kasbon or reimbursement paid while accounting was on carries
  // `accountingOnAtEmit`: the money left under accounting, so it is journaled
  // even if accounting was switched off before delivery, and its pending
  // credit never disappears without a journal (legend-kt8em).
  const followsLock =
    event.name === payrollPaid.name ||
    event.name === payrollReversed.name ||
    ((event.name === employeeLoanDisbursed.name ||
      event.name === reimbursementPaid.name) &&
      emittedWithAccountingOn(event.payload));
  if (!followsLock && !(await accountingEnabled(tx, context))) {
    if (event.name !== payrollLocked.name) return { status: "ignored" };
    // Loaded on demand: the payout GL service imports this module.
    const { runHasPendingSettle } =
      await import("./payroll-payout-gl.service.ts");
    const { payrollRunId } = payrollLocked.payloadSchema.parse(event.payload);
    // Run row first, like the settle path (legend-2aspe): a settle that read
    // "accounting on" just before the switch commits before this reads the
    // pending postings, so it cannot be left open after the event is ignored.
    await tx
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.tenantId, context.tenant.tenantId),
          eq(payrollRuns.id, payrollRunId),
        ),
      )
      .for("update");
    if (!(await runHasPendingSettle(tx, context.tenant.tenantId, payrollRunId)))
      return { status: "ignored" };
  }

  if (event.name === payrollLocked.name) {
    const payload = payrollLocked.payloadSchema.parse(event.payload);
    const amounts = payrollJournalAmounts(payload.totals);
    // An all-zero run has no journal (a journal needs two lines); paid and
    // reversed then find no locked entry and skip.
    if (allZero(amounts)) return { status: "skipped" };
    // Run row first (920): the lock journal and the pending settles it
    // resolves follow the same order as every payout path (run, batch, item,
    // advisory GL), so a dispute or unfreeze committing meanwhile is seen.
    await tx
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.tenantId, context.tenant.tenantId),
          eq(payrollRuns.id, payload.payrollRunId),
        ),
      )
      .for("update");
    // Entity lock before the journal (1053 order: run, entity, period and
    // journal): the posting inserts the month's period, and the payout
    // resolver below takes this lock per batch. Taking it after the period
    // insert closes a cycle with a petty cash return (legend-zfq7e). Re-entrant.
    await entityLock(tx, context.tenant.tenantId, payload.legalEntityId);
    const entry = await postJournalFromRuleInTransaction(
      tx,
      context,
      {
        eventName: payrollLocked.name,
        variant: payrollLockedVariant(
          amounts.serviceChargeIdr
            ? await serviceChargeAccountType(tx, context, payload.legalEntityId)
            : null,
        ),
        amounts,
        legalEntityId: payload.legalEntityId,
        outletId: null,
        entryDate: minDate(payload.periodEnd, entryDateOf(payload.lockedAt)),
        sourceId: payload.payrollRunId,
        postedBy: null,
        idempotencyKey: payrollGlKeys.locked(payload.payrollRunId),
      },
      now,
    );
    // Payouts settled before this journal existed wait as `settle_pending`
    // (legend-2aspe): post them now that the payable is booked. Loaded on
    // demand: the payout GL service imports this module.
    const { resolvePendingSettles } =
      await import("./payroll-payout-gl.service.ts");
    await resolvePendingSettles(
      tx,
      context.tenant.tenantId,
      payload.payrollRunId,
      now,
    );
    return { status: "posted", journalEntryId: entry.id };
  }

  if (event.name === payrollPaid.name) {
    const payload = payrollPaid.payloadSchema.parse(event.payload);
    // Settled per item (legend-658): each confirmed group of items posted its
    // own journal (Dr salaries_payable / Cr bank or petty cash, plus the fee).
    // A run-level journal on top would pay the payable twice (R10).
    if (payload.settledPerItem === true) return { status: "skipped" };
    if (!(await lockedEntryOf(tx, context, payload.payrollRunId)))
      return (await accountingEnabled(tx, context))
        ? { status: "skipped" }
        : { status: "ignored" };
    // Nothing paid out (net 0): no settlement journal.
    if (payload.netIdr === 0) return { status: "skipped" };
    // The cash part credits petty cash (1102): take the entity lock the petty
    // cash return reads GL 1102 under, before the journal (legend-3k9qg).
    if (payload.cashIdr > 0)
      await entityLock(tx, context.tenant.tenantId, payload.legalEntityId);
    const entry = await postJournalFromRuleInTransaction(
      tx,
      context,
      {
        eventName: payrollPaid.name,
        amounts: {
          netIdr: payload.netIdr,
          bankTransferIdr: payload.bankTransferIdr,
          cashIdr: payload.cashIdr,
        },
        legalEntityId: payload.legalEntityId,
        outletId: null,
        entryDate: entryDateOf(payload.paidAt),
        sourceId: payload.payrollRunId,
        postedBy: null,
        idempotencyKey: payrollGlKeys.paid(payload.payrollRunId),
      },
      now,
    );
    return { status: "posted", journalEntryId: entry.id };
  }

  if (event.name === payrollReversed.name) {
    const payload = payrollReversed.payloadSchema.parse(event.payload);
    const locked = await lockedEntryOf(tx, context, payload.payrollRunId);
    if (!locked)
      return (await accountingEnabled(tx, context))
        ? { status: "skipped" }
        : { status: "ignored" };
    // A paid run cannot be reversed (run state machine); reversing anyway
    // would leave 2103 with a debit of the net pay.
    if (await entryByKey(tx, context, payrollGlKeys.paid(payload.payrollRunId)))
      throw new Error(
        `payroll.reversed for run ${payload.payrollRunId}, which is already paid`,
      );
    // Reversed by hand already (ACC-01): nothing left to reverse. Our own key
    // falls through, and the idempotency key returns that reversal.
    const existing = await reversalOf(tx, context, locked.id);
    if (
      existing &&
      existing.idempotencyKey !== payrollGlKeys.reversed(payload.payrollRunId)
    )
      return { status: "skipped" };
    // Cross-check: the reversed totals must be the amounts that were posted,
    // line by line (sorted per side), not only the total. The base rule serves
    // every variant: they share the amount keys, so the sums agree.
    const rule = resolvePostingRule(defaultPostingRules, {
      eventName: payrollLocked.name,
    });
    const amounts: Record<string, number> = payrollJournalAmounts(
      payload.totals,
    );
    const posted = await entrySideAmounts(tx, context, locked.id);
    const expectedFor = (values: Readonly<Record<string, number>>) =>
      JSON.stringify({
        debit: sideAmounts(rule.lines, values, "debit"),
        credit: sideAmounts(rule.lines, values, "credit"),
      });
    // An entry locked before legend-75kr carries late + custom deductions as
    // one salary_expense credit; accept that shape too, so a run locked then
    // can still be reversed when its totals now split the custom part.
    const legacyAmounts = {
      ...amounts,
      lateDeductionsIdr:
        (amounts.lateDeductionsIdr ?? 0) + (amounts.customDeductionsIdr ?? 0),
      customDeductionsIdr: 0,
    };
    const postedShape = JSON.stringify(posted);
    if (
      expectedFor(amounts) !== postedShape &&
      expectedFor(legacyAmounts) !== postedShape
    )
      throw new Error(
        `payroll.reversed totals differ from the locked entry of run ${payload.payrollRunId}`,
      );
    const entry = await reverseJournalInTransaction(
      tx,
      context,
      locked.id,
      {
        entryDate: maxDate(entryDateOf(payload.reversedAt), locked.entryDate),
        reason: REVERSAL_REASON,
        idempotencyKey: payrollGlKeys.reversed(payload.payrollRunId),
        postedBy: null,
      },
      now,
    );
    return { status: "posted", journalEntryId: entry.id };
  }

  if (event.name === employeeLoanDisbursed.name) {
    const payload = employeeLoanDisbursed.payloadSchema.parse(event.payload);
    // Anything but a bank disbursement credits petty cash (1102): entity lock
    // first, as the petty cash return does (legend-3k9qg).
    if (payload.disbursedVia !== "bank")
      await entityLock(tx, context.tenant.tenantId, payload.legalEntityId);
    const entry = await postJournalFromRuleInTransaction(
      tx,
      context,
      {
        eventName: employeeLoanDisbursed.name,
        variant: payload.disbursedVia,
        amounts: { principalIdr: payload.principalIdr },
        legalEntityId: payload.legalEntityId,
        outletId: null,
        entryDate: entryDateOf(payload.disbursedAt),
        sourceId: payload.employeeLoanId,
        postedBy: null,
        idempotencyKey: payrollGlKeys.loan(payload.employeeLoanId),
      },
      now,
    );
    return { status: "posted", journalEntryId: entry.id };
  }

  const payload = reimbursementPaid.payloadSchema.parse(event.payload);
  // The run journal carries a payroll payout (reimbursement_expense).
  if (payload.payout === "payroll") return { status: "skipped" };
  const [employee] = await tx
    .select({ legalEntityId: employees.legalEntityId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, payload.employeeId),
      ),
    )
    .limit(1);
  if (!employee?.legalEntityId)
    throw new Error(
      `Employee ${payload.employeeId} of reimbursement ${payload.reimbursementId} has no legal entity`,
    );
  // A cash reimbursement credits petty cash (1102): entity lock first, as the
  // petty cash return does (legend-3k9qg).
  await entityLock(tx, context.tenant.tenantId, employee.legalEntityId);
  const entry = await postJournalFromRuleInTransaction(
    tx,
    context,
    {
      eventName: reimbursementPaid.name,
      variant: "cash",
      amounts: { amountIdr: payload.amountIdr },
      legalEntityId: employee.legalEntityId,
      outletId: null,
      entryDate: entryDateOf(payload.paidAt),
      sourceId: payload.reimbursementId,
      postedBy: null,
      idempotencyKey: payrollGlKeys.reimbursement(payload.reimbursementId),
    },
    now,
  );
  return { status: "posted", journalEntryId: entry.id };
}
