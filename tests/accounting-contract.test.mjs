// Accounting contract tests (WS-07, bead legend-5ob): balanced immutable
// journals and reversal (ACC-01), period close/reopen with approval and the
// close-vs-post version guard (ACC-02), statements and per-outlet drill-down
// (ACC-03), bank/gateway matching and cases with PIC (ACC-04), cash deposit
// alerts (ACC-05), posting rules, fixtures, events and endpoints; profit share
// and dividends (bead legend-cq2, SH-03/SH-04, PRD §3.37, §4 P, §6 I). Loaded
// with plain Node ESM (type stripping, no resolve hook).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as acc from "../packages/shared/src/accounting/index.ts";
import {
  allocateIdr,
  applyBasisPoints,
} from "../packages/shared/src/core/index.ts";
import { eventCatalog } from "../packages/shared/src/events/catalog.ts";

const fx = acc.cafeLegendAccountingFixtures;
const code = (c) => fx.accountByCode(c).id;
const throwsCode = (fn, expected) =>
  assert.throws(fn, (error) => {
    assert.equal(
      error.code,
      expected,
      `expected ${expected}, got ${error.code}: ${error.message}`,
    );
    return true;
  });
const line = (accountCode, debitIdr, creditIdr, outletId = null) => ({
  accountId: code(accountCode),
  debitIdr,
  creditIdr,
  outletId,
  costCenter: null,
});
const period = (p) => fx.fiscalPeriods.find((row) => row.period === p);
const { finance, owner, generalManager } = fx.users;
const NOW = "2026-12-03T02:00:00.000Z";

describe("ACC-01 balanced, final journals corrected by reversal", () => {
  test("ACC-01 balanced journal passes, totals reported", () => {
    const result = acc.checkJournalBalance([
      line("6106", 100, 0),
      line("1103", 0, 100),
    ]);
    assert.deepEqual(result, {
      balanced: true,
      totalDebitIdr: 100,
      totalCreditIdr: 100,
      issues: [],
    });
    assert.equal(
      acc.assertJournalBalanced([line("6106", 100, 0), line("1103", 0, 100)]),
      100,
    );
  });

  test("ACC-01 unbalanced journal is rejected (JOURNAL_UNBALANCED)", () => {
    throwsCode(
      () =>
        acc.assertJournalBalanced([line("6106", 100, 0), line("1103", 0, 99)]),
      "JOURNAL_UNBALANCED",
    );
    throwsCode(
      () => acc.assertJournalBalanced([line("6106", 0, 0)]),
      "JOURNAL_LINE_INVALID",
    );
    throwsCode(
      () => acc.assertJournalBalanced([line("6106", 100, 0)]),
      "JOURNAL_UNBALANCED",
    );
  });

  test("ACC-01 a line fills debit xor credit, whole non-negative rupiah", () => {
    throwsCode(
      () =>
        acc.assertJournalBalanced([line("6106", 100, 100), line("1103", 0, 0)]),
      "JOURNAL_LINE_INVALID",
    );
    throwsCode(
      () =>
        acc.assertJournalBalanced([
          line("6106", -100, 0),
          line("1103", 0, -100),
        ]),
      "JOURNAL_LINE_INVALID",
    );
    throwsCode(
      () =>
        acc.assertJournalBalanced([line("6106", 0.5, 0), line("1103", 0, 0.5)]),
      "JOURNAL_LINE_INVALID",
    );
    assert.equal(
      acc.journalLineInputSchema.safeParse(line("6106", 5, 5)).success,
      false,
    );
  });

  test("ACC-01 journal entry schema refuses an unbalanced posted entry", () => {
    const entry = structuredClone(fx.entries.internet);
    entry.lines[0].debitIdr += 1;
    assert.equal(acc.journalEntrySchema.safeParse(entry).success, false);
  });

  test("ACC-01 every fixture journal parses and balances", () => {
    for (const entry of fx.journals) {
      acc.journalEntrySchema.parse(entry);
      assert.ok(
        acc.checkJournalBalance(entry.lines).balanced,
        entry.description,
      );
    }
  });

  test("ACC-01 reversal mirrors every line so the pair nets to zero", () => {
    const original = fx.entries.wrongInternet;
    const reversal = fx.journals.find(
      (entry) => entry.reversalOf === original.id,
    );
    assert.ok(reversal);
    assert.equal(reversal.sourceType, "reversal");
    const net = new Map();
    for (const l of [...original.lines, ...reversal.lines])
      net.set(
        l.accountId,
        (net.get(l.accountId) ?? 0) + l.debitIdr - l.creditIdr,
      );
    assert.ok([...net.values()].every((value) => value === 0));
    assert.deepEqual(
      acc.buildReversalLines(fx.entries.internet, null),
      acc.reverseLines(
        fx.entries.internet.lines.map((l) => ({
          accountId: l.accountId,
          debitIdr: l.debitIdr,
          creditIdr: l.creditIdr,
          outletId: l.outletId,
          costCenter: l.costCenter,
        })),
      ),
    );
  });

  test("ACC-01 a journal is reversed once; a reversal is never reversed", () => {
    const original = fx.entries.wrongInternet;
    const reversal = fx.journals.find(
      (entry) => entry.reversalOf === original.id,
    );
    throwsCode(
      () => acc.buildReversalLines(original, reversal.id),
      "JOURNAL_ALREADY_REVERSED",
    );
    throwsCode(
      () => acc.buildReversalLines(reversal, null),
      "JOURNAL_NOT_REVERSIBLE",
    );
    assert.equal(
      acc.journalEntrySchema.safeParse({ ...reversal, sourceType: "manual" })
        .success,
      false,
    );
  });

  test("ACC-01 posted journals cannot be edited or deleted (JOURNAL_IMMUTABLE)", () => {
    const posted = fx.manualJournals.find((row) => row.status === "posted");
    for (const type of ["edit", "cancel", "submit", "approve"])
      throwsCode(
        () => acc.transitionManualJournal(posted, { type, actorId: owner }),
        "JOURNAL_IMMUTABLE",
      );
    throwsCode(() => acc.rejectPostedJournalMutation(), "JOURNAL_IMMUTABLE");
  });

  test("ACC-01 manual journal needs approval by someone other than the requester (AUTH-06)", () => {
    const pending = fx.manualJournals.find(
      (row) => row.status === "pending_approval",
    );
    throwsCode(
      () =>
        acc.transitionManualJournal(pending, {
          type: "approve",
          actorId: pending.requestedBy,
        }),
      "APPROVER_IS_REQUESTER",
    );
    assert.equal(
      acc.transitionManualJournal(pending, { type: "approve", actorId: owner }),
      "posted",
    );
    assert.equal(
      acc.transitionManualJournal(pending, {
        type: "reject",
        actorId: owner,
        reason: "Belum ada kontrak",
      }),
      "rejected",
    );
    assert.equal(
      acc.transitionManualJournal(pending, {
        type: "withdraw",
        actorId: finance,
      }),
      "draft",
    );
    throwsCode(
      () =>
        acc.transitionManualJournal(pending, {
          type: "withdraw",
          actorId: owner,
        }),
      "INVALID_TRANSITION",
    );
    const draft = fx.manualJournals.find((row) => row.status === "draft");
    assert.equal(
      acc.transitionManualJournal(draft, { type: "submit", actorId: finance }),
      "pending_approval",
    );
    assert.equal(
      acc.transitionManualJournal(draft, { type: "cancel", actorId: finance }),
      "cancelled",
    );
    throwsCode(
      () =>
        acc.transitionManualJournal(draft, { type: "approve", actorId: owner }),
      "INVALID_TRANSITION",
    );
    assert.equal(
      acc.manualJournalSchema.safeParse({
        ...pending,
        status: "posted",
        decidedBy: finance,
        decidedAt: NOW,
        postedEntryId: fx.entries.internet.id,
      }).success,
      false,
    );
  });

  test("ACC-01 manual journal input must balance before it is even stored", () => {
    const input = {
      legalEntityId: fx.legalEntity.id,
      outletId: null,
      entryDate: "2026-11-30",
      kind: "general",
      description: "Tes",
      lines: [line("6106", 100, 0), line("1103", 0, 90)],
      idempotencyKey: "mj-test-0001",
    };
    assert.equal(
      acc.createManualJournalInputSchema.safeParse(input).success,
      false,
    );
    input.lines[1].creditIdr = 100;
    assert.equal(
      acc.createManualJournalInputSchema.safeParse(input).success,
      true,
    );
    assert.equal(
      acc.createManualJournalInputSchema.safeParse({
        ...input,
        tenantId: fx.tenantId,
      }).success,
      false,
    );
  });

  test("ACC-01 recurring template: approved once by another person, dates clamp to month end", () => {
    const template = fx.recurringJournals[0];
    throwsCode(
      () =>
        acc.transitionRecurringJournal(
          { status: "pending_approval", requestedBy: finance },
          { type: "approve", actorId: finance },
        ),
      "APPROVER_IS_REQUESTER",
    );
    assert.equal(
      acc.transitionRecurringJournal(
        { status: "pending_approval", requestedBy: finance },
        { type: "approve", actorId: generalManager },
      ),
      "active",
    );
    throwsCode(
      () =>
        acc.transitionRecurringJournal(template, {
          type: "edit",
          actorId: finance,
        }),
      "INVALID_TRANSITION",
    );
    assert.equal(acc.recurringOccurrenceDate("2027-02", 31), "2027-02-28");
    assert.equal(acc.recurringOccurrenceDate("2028-02", 31), "2028-02-29");
    assert.deepEqual(acc.recurringPeriodsDue(template, "2027-02"), [
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    assert.deepEqual(
      acc.recurringPeriodsDue({ ...template, status: "paused" }, "2027-02"),
      [],
    );
  });
});

describe("ACC-02 closed periods reject postings unless reopened with approval", () => {
  test("ACC-02 posting into a closed period fails with PERIOD_CLOSED", () => {
    throwsCode(
      () => acc.assertPostingAllowed(period("2026-10"), "2026-10-31"),
      "PERIOD_CLOSED",
    );
    acc.assertPostingAllowed(period("2026-11"), "2026-11-30");
    throwsCode(
      () => acc.assertPostingAllowed(period("2026-11"), "2026-10-31"),
      "PERIOD_MISMATCH",
    );
  });

  test("ACC-02 a month closes only after it ends and after earlier months", () => {
    const nov = period("2026-11");
    const periods = fx.fiscalPeriods;
    throwsCode(
      () =>
        acc.decidePeriodClose({
          period: nov,
          entityPeriods: periods,
          today: "2026-11-30",
          actorId: finance,
          now: NOW,
        }),
      "PERIOD_NOT_ENDED",
    );
    const closed = acc.decidePeriodClose({
      period: nov,
      entityPeriods: periods,
      today: "2026-12-01",
      actorId: finance,
      now: NOW,
    });
    assert.equal(closed.status, "closed");
    assert.equal(closed.version, nov.version + 1);
    acc.fiscalPeriodSchema.parse(closed);
    throwsCode(
      () =>
        acc.decidePeriodClose({
          period: closed,
          entityPeriods: periods,
          today: "2026-12-01",
          actorId: finance,
          now: NOW,
        }),
      "PERIOD_ALREADY_CLOSED",
    );
    const dec = {
      ...nov,
      id: "f1000000-0000-4000-8000-000000000009",
      period: "2026-12",
    };
    throwsCode(
      () =>
        acc.decidePeriodClose({
          period: dec,
          entityPeriods: [...periods, dec],
          today: "2027-01-02",
          actorId: finance,
          now: NOW,
        }),
      "PERIOD_CLOSE_OUT_OF_ORDER",
    );
  });

  test("ACC-02 reopen needs a reason and a closed period", () => {
    throwsCode(
      () => acc.assertReopenRequestable(period("2026-10"), "   "),
      "REOPEN_REASON_REQUIRED",
    );
    throwsCode(
      () => acc.assertReopenRequestable(period("2026-11"), "Koreksi"),
      "PERIOD_ALREADY_OPEN",
    );
    acc.assertReopenRequestable(period("2026-10"), "Koreksi tagihan");
    assert.equal(
      acc.requestPeriodReopenInputSchema.safeParse({ reason: "  " }).success,
      false,
    );
  });

  test("ACC-02 reopen approved by a different person reopens, then posting is allowed", () => {
    const oct = period("2026-10");
    const request = {
      status: "pending",
      requestedBy: finance,
      reason: "Faktur supplier terlambat",
      fiscalPeriodId: oct.id,
    };
    throwsCode(
      () =>
        acc.decidePeriodReopen({
          request,
          period: oct,
          entityPeriods: fx.fiscalPeriods,
          decision: "approve",
          actorId: finance,
          now: NOW,
        }),
      "APPROVER_IS_REQUESTER",
    );
    // Separation of duties: whoever closed the period cannot approve its reopen.
    throwsCode(
      () =>
        acc.decidePeriodReopen({
          request,
          period: { ...oct, closedBy: generalManager },
          entityPeriods: fx.fiscalPeriods,
          decision: "approve",
          actorId: generalManager,
          now: NOW,
        }),
      "APPROVER_IS_CLOSER",
    );
    const result = acc.decidePeriodReopen({
      request,
      period: oct,
      entityPeriods: fx.fiscalPeriods,
      decision: "approve",
      actorId: owner,
      now: NOW,
    });
    assert.equal(result.requestStatus, "approved");
    assert.equal(result.period.status, "open");
    assert.equal(result.period.version, oct.version + 1);
    assert.equal(result.period.reopenedReason, "Faktur supplier terlambat");
    acc.fiscalPeriodSchema.parse(result.period);
    acc.assertPostingAllowed(result.period, "2026-10-15");
  });

  test("ACC-02 rejected reopen leaves the period closed", () => {
    const oct = period("2026-10");
    const request = {
      status: "pending",
      requestedBy: finance,
      reason: "Koreksi",
      fiscalPeriodId: oct.id,
    };
    const result = acc.decidePeriodReopen({
      request,
      period: oct,
      entityPeriods: fx.fiscalPeriods,
      decision: "reject",
      actorId: owner,
      now: NOW,
    });
    assert.deepEqual(result, { requestStatus: "rejected", period: null });
    throwsCode(
      () => acc.assertPostingAllowed(oct, "2026-10-15"),
      "PERIOD_CLOSED",
    );
    throwsCode(
      () =>
        acc.decidePeriodReopen({
          request: { ...request, status: "approved" },
          period: oct,
          entityPeriods: fx.fiscalPeriods,
          decision: "approve",
          actorId: owner,
          now: NOW,
        }),
      "INVALID_TRANSITION",
    );
  });

  test("ACC-02 only the latest closed period can be reopened", () => {
    const sep = period("2026-09");
    const request = {
      status: "pending",
      requestedBy: finance,
      reason: "Koreksi",
      fiscalPeriodId: sep.id,
    };
    throwsCode(
      () =>
        acc.decidePeriodReopen({
          request,
          period: sep,
          entityPeriods: fx.fiscalPeriods,
          decision: "approve",
          actorId: owner,
          now: NOW,
        }),
      "PERIOD_REOPEN_OUT_OF_ORDER",
    );
  });

  test("ACC-02 close-vs-post: a post validated against an older version fails PERIOD_CHANGED", () => {
    const nov = period("2026-11");
    acc.assertPeriodVersion(nov, nov.version);
    const closed = acc.decidePeriodClose({
      period: nov,
      entityPeriods: fx.fiscalPeriods,
      today: "2026-12-01",
      actorId: finance,
      now: NOW,
    });
    throwsCode(
      () => acc.assertPeriodVersion(closed, nov.version),
      "PERIOD_CHANGED",
    );
    throwsCode(
      () => acc.assertPostingAllowed(closed, "2026-11-30"),
      "PERIOD_CLOSED",
    );
  });

  test("ACC-02 period and reopen request schemas enforce their invariants", () => {
    assert.equal(
      acc.fiscalPeriodSchema.safeParse({
        ...period("2026-11"),
        status: "closed",
      }).success,
      false,
    );
    const request = fx.periodReopenRequests[0];
    assert.equal(
      acc.periodReopenRequestSchema.safeParse({
        ...request,
        decidedBy: request.requestedBy,
      }).success,
      false,
    );
    acc.periodCloseSnapshotSchema.parse(fx.octoberSnapshot);
    const broken = structuredClone(fx.octoberSnapshot);
    broken.balances[0].debitIdr += 1;
    assert.equal(
      acc.periodCloseSnapshotSchema.safeParse(broken).success,
      false,
    );
  });

  test("ACC-02 tax report is finalised only for a closed period", () => {
    throwsCode(
      () =>
        acc.transitionTaxReport(
          { status: "draft" },
          "finalize",
          period("2026-11"),
        ),
      "PERIOD_NOT_CLOSED",
    );
    assert.equal(
      acc.transitionTaxReport(
        { status: "draft" },
        "finalize",
        period("2026-10"),
      ),
      "final",
    );
    throwsCode(
      () =>
        acc.transitionTaxReport(
          { status: "draft" },
          "export",
          period("2026-10"),
        ),
      "INVALID_TRANSITION",
    );
  });
});

describe("ACC-03 statements derive from journal lines down to the source", () => {
  test("ACC-03 trial balance and balance sheet balance", () => {
    const { trialBalance, balanceSheet } = fx.statements;
    assert.equal(trialBalance.totalDebitIdr, trialBalance.totalCreditIdr);
    assert.equal(
      balanceSheet.totalAssetsIdr,
      balanceSheet.totalLiabilitiesIdr + balanceSheet.totalEquityIdr,
    );
  });

  test("ACC-03 November P&L follows the posted lines", () => {
    const pl = fx.statements.profitAndLossNovember;
    const total = (group) =>
      pl.sections.find((s) => s.group === group).totalIdr;
    assert.equal(total("revenue"), 375_000);
    assert.equal(total("cogs"), 41_250);
    assert.equal(total("operating_expense"), 1_925 + 1_520_000);
    assert.equal(pl.netProfitIdr, 375_000 - 41_250 - 1_925 - 1_520_000);
    assert.equal(
      acc.profitAndLossSchema.safeParse({
        ...pl,
        netProfitIdr: pl.netProfitIdr + 1,
      }).success,
      false,
    );
  });

  test("ACC-03 P&L per outlet only counts lines tagged with that outlet", () => {
    const other = "9e4b7c21-5d6f-4a8b-b3c0-1f2e3d4c5b6a";
    const pl = acc.buildProfitAndLoss(fx.accounts, fx.ledgerLines, {
      legalEntityId: fx.legalEntity.id,
      from: "2026-10-01",
      to: "2026-10-31",
      outletId: fx.outletId,
    });
    assert.equal(pl.netProfitIdr, -2_350_000);
    const empty = acc.buildProfitAndLoss(fx.accounts, fx.ledgerLines, {
      legalEntityId: fx.legalEntity.id,
      from: "2026-10-01",
      to: "2026-10-31",
      outletId: other,
    });
    assert.equal(empty.netProfitIdr, 0);
  });

  test("ACC-03 every P&L row drills down to journal lines whose entries name a source", () => {
    for (const row of fx.statements.profitAndLossNovember.sections.flatMap(
      (s) => s.rows,
    )) {
      const entries = fx.journals.filter(
        (entry) =>
          entry.entryDate >= "2026-11-01" &&
          entry.lines.some((l) => l.accountId === row.accountId),
      );
      assert.ok(entries.length > 0, row.name);
      for (const entry of entries)
        assert.ok(
          entry.sourceType === "reversal" ||
            entry.sourceType === "opening_balance" ||
            entry.sourceId !== null,
        );
    }
    acc.drillDownQuerySchema.parse({
      legalEntityId: fx.legalEntity.id,
      accountId: code("4101"),
      from: "2026-11-01",
      to: "2026-11-30",
    });
  });

  test("ACC-03 cash flow and equity fixtures roll forward", () => {
    const cf = fx.statements.cashFlowNovember;
    assert.equal(cf.openingCashIdr + cf.netChangeIdr, cf.closingCashIdr);
    const cash = (asOf) =>
      fx.statements.balanceSheet &&
      acc
        .buildBalanceSheet(fx.accounts, fx.ledgerLines, {
          legalEntityId: fx.legalEntity.id,
          asOf,
        })
        .sections.find((s) => s.group === "cash_and_equivalents").totalIdr;
    assert.equal(cash("2026-10-31"), cf.openingCashIdr);
    assert.equal(cash("2026-11-30"), cf.closingCashIdr);
    acc.equityChangesSchema.parse(fx.statements.equityChangesOctober);
  });
});

describe("ACC-04 bank and gateway reconciliation", () => {
  const policy = { dateToleranceDays: 2 };
  const ref = (n) => ({
    type: "journal_entry",
    id: `e1000000-0000-4000-8000-00000000000${n}`,
  });

  test("ACC-04 one candidate with equal amount inside the window auto-matches", () => {
    const outcome = acc.findStatementMatch(
      { amountIdr: 273_075, postedOn: "2026-11-02" },
      [
        { ref: ref(1), amountIdr: 273_075, date: "2026-11-01" },
        { ref: ref(2), amountIdr: 273_000, date: "2026-11-02" },
      ],
      policy,
    );
    assert.deepEqual(outcome, { kind: "auto", ref: ref(1) });
  });

  test("ACC-04 several candidates are never guessed; none stays unmatched", () => {
    const candidates = [
      { ref: ref(1), amountIdr: 50_000, date: "2026-11-02" },
      { ref: ref(2), amountIdr: 50_000, date: "2026-11-03" },
    ];
    assert.equal(
      acc.findStatementMatch(
        { amountIdr: 50_000, postedOn: "2026-11-02" },
        candidates,
        policy,
      ).kind,
      "ambiguous",
    );
    assert.equal(
      acc.findStatementMatch(
        { amountIdr: 50_000, postedOn: "2026-11-09" },
        candidates,
        policy,
      ).kind,
      "none",
    );
  });

  test("ACC-04 manual match must add up exactly and only once", () => {
    acc.assertManualMatch({ amountIdr: -1_520_000, matchStatus: "unmatched" }, [
      { amountIdr: -1_000_000 },
      { amountIdr: -520_000 },
    ]);
    throwsCode(
      () =>
        acc.assertManualMatch(
          { amountIdr: -1_520_000, matchStatus: "unmatched" },
          [{ amountIdr: -1_500_000 }],
        ),
      "MATCH_AMOUNT_MISMATCH",
    );
    throwsCode(
      () =>
        acc.assertManualMatch({ amountIdr: 10, matchStatus: "auto_matched" }, [
          { amountIdr: 10 },
        ]),
      "STATEMENT_LINE_ALREADY_MATCHED",
    );
  });

  test("ACC-04 auto-match rate is floored and compared to the 99% target", () => {
    assert.equal(acc.autoMatchRateBp(fx.statementLines), 5_000);
    const lines = [
      ...Array(199).fill({ matchStatus: "auto_matched" }),
      { matchStatus: "in_case" },
      { matchStatus: "excluded" },
    ];
    assert.equal(acc.autoMatchRateBp(lines), 9_950);
    assert.ok(acc.autoMatchRateBp(lines) >= acc.AUTO_MATCH_TARGET_BP);
    assert.equal(acc.autoMatchRateBp([]), 10_000);
  });

  test("ACC-04 every difference is a case with a PIC; closing needs a note, write-off a journal", () => {
    const open = fx.reconciliationCases[0];
    assert.equal(
      acc.reconciliationCaseSchema.safeParse({ ...open, ownerId: null })
        .success,
      false,
    );
    assert.equal(
      acc.reconciliationCaseSchema.safeParse({ ...open, differenceIdr: 0 })
        .success,
      false,
    );
    assert.equal(
      acc.transitionReconciliationCase(open, {
        type: "start",
        actorId: finance,
      }),
      "in_progress",
    );
    assert.equal(
      acc.transitionReconciliationCase(open, {
        type: "resolve",
        actorId: finance,
        note: "Biaya admin bank",
      }),
      "resolved",
    );
    throwsCode(
      () =>
        acc.transitionReconciliationCase(open, {
          type: "resolve",
          actorId: finance,
          note: " ",
        }),
      "INVALID_TRANSITION",
    );
    throwsCode(
      () =>
        acc.transitionReconciliationCase(
          { status: "resolved" },
          { type: "start", actorId: finance },
        ),
      "INVALID_TRANSITION",
    );
    assert.equal(
      acc.reconciliationCaseSchema.safeParse({
        ...open,
        status: "written_off",
        resolvedBy: finance,
        resolvedAt: NOW,
        resolutionNote: "x",
      }).success,
      false,
    );
  });

  test("ACC-04 bank CSV values are read exactly or refused", () => {
    assert.equal(acc.parseBankCsvAmount("1.250.000,00", ","), 1_250_000);
    assert.equal(acc.parseBankCsvAmount("-15,000.00", "."), -15_000);
    assert.equal(acc.parseBankCsvAmount("(15.000)", ","), -15_000);
    throwsCode(
      () => acc.parseBankCsvAmount("1.250,50", ","),
      "STATEMENT_VALUE_INVALID",
    );
    throwsCode(
      () => acc.parseBankCsvAmount("abc", ","),
      "STATEMENT_VALUE_INVALID",
    );
    assert.equal(
      acc.parseBankCsvDate("02/11/2026", "DD/MM/YYYY"),
      "2026-11-02",
    );
    assert.equal(
      acc.parseBankCsvDate("2026-11-02", "YYYY-MM-DD"),
      "2026-11-02",
    );
    throwsCode(
      () => acc.parseBankCsvDate("31/02/2026", "DD/MM/YYYY"),
      "STATEMENT_VALUE_INVALID",
    );
  });

  test("ACC-04 statement import dedupe key is stable and counts identical rows", () => {
    const row = {
      postedOn: "2026-11-04",
      amountIdr: -15_000,
      description: " biaya  adm ",
      externalRef: null,
    };
    const first = acc.statementLineDedupeKey({ ...row, occurrence: 1 });
    assert.equal(
      first,
      acc.statementLineDedupeKey({
        ...row,
        description: "BIAYA ADM",
        occurrence: 1,
      }),
    );
    assert.notEqual(
      first,
      acc.statementLineDedupeKey({ ...row, occurrence: 2 }),
    );
    assert.equal(acc.maskAccountNumber("0123454821"), "****4821");
  });
});

describe("legend-pxcs finance policy contract (ACC-04 tolerance, ACC-05 batas hari)", () => {
  const body = (maxDaysUndeposited, dateToleranceDays, caseDueDays = 7) => ({
    cashDepositPolicy: { maxDaysUndeposited },
    matchingPolicy: { dateToleranceDays },
    reconciliationPolicy: { caseDueDays },
  });

  test("defaults are 2 days / 2 days / 7 case days and satisfy the strict policy schema", () => {
    assert.deepEqual(acc.DEFAULT_FINANCE_POLICY, body(2, 2));
    assert.deepEqual(
      acc.financePolicySchema.parse(acc.DEFAULT_FINANCE_POLICY),
      body(2, 2),
    );
  });

  test("bounds reuse the banking limits: 0..30 undeposited days, 0..14 tolerance days, 1..60 case due days", () => {
    const ok = (value) => acc.putFinancePolicyInputSchema.safeParse(value);
    assert.equal(ok(body(0, 0)).success, true);
    assert.equal(ok(body(30, 14)).success, true);
    assert.equal(ok(body(2, 2, 1)).success, true);
    assert.equal(ok(body(2, 2, 60)).success, true);
    for (const bad of [
      body(31, 2),
      body(-1, 2),
      body(2, 15),
      body(2, -1),
      body(2, 2, 0),
      body(2, 2, 61),
    ])
      assert.equal(ok(bad).success, false);
    assert.equal(ok(body(1.5, 2)).success, false);
    assert.equal(ok(body("2", 2)).success, false);
    assert.equal(ok(body(2, 2, 1.5)).success, false);
  });

  test("the body is strict: no tenantId (TEN-02), no foreign or missing sections", () => {
    const ok = (value) => acc.putFinancePolicyInputSchema.safeParse(value);
    assert.equal(
      ok({ ...body(2, 2), tenantId: fx.users.owner.id }).success,
      false,
    );
    assert.equal(
      ok({
        cashDepositPolicy: { maxDaysUndeposited: 2, extra: 1 },
        matchingPolicy: { dateToleranceDays: 2 },
        reconciliationPolicy: { caseDueDays: 7 },
      }).success,
      false,
    );
    assert.equal(
      ok({ cashDepositPolicy: { maxDaysUndeposited: 2 } }).success,
      false,
    );
    assert.equal(
      ok({ matchingPolicy: { dateToleranceDays: 2 } }).success,
      false,
    );
    assert.equal(
      ok({ reconciliationPolicy: { caseDueDays: 7 } }).success,
      false,
    );
    assert.equal(ok({}).success, false);
  });

  test("endpoints: GET/PUT /api/accounting/finance-policy, registered once, PUT body is the policy", () => {
    assert.equal(acc.getFinancePolicy.method, "GET");
    assert.equal(acc.putFinancePolicy.method, "PUT");
    assert.equal(acc.getFinancePolicy.path, "/api/accounting/finance-policy");
    assert.equal(acc.putFinancePolicy.path, "/api/accounting/finance-policy");
    const registered = Object.values(acc.accountingEndpoints);
    assert.ok(registered.includes(acc.getFinancePolicy));
    assert.ok(registered.includes(acc.putFinancePolicy));
    assert.equal(acc.getFinancePolicy.body, undefined);
    assert.deepEqual(
      acc.putFinancePolicy.response.parse({ data: body(5, 3) }),
      { data: body(5, 3) },
    );
  });

  test("ACC-05 the saved limit drives the alert: the policy's cashDepositPolicy plugs into undepositedCashAlerts", () => {
    const run = (policy) =>
      acc.undepositedCashAlerts(
        fx.cashCollections,
        fx.cashDeposits,
        fx.asOf,
        policy.cashDepositPolicy,
      );
    assert.equal(run(body(2, 2)).length, 1);
    assert.deepEqual(run(body(5, 2)), []);
  });
});

describe("ACC-05 cash deposits are matched and overdue cash raises alerts", () => {
  test("ACC-05 undeposited cash older than the tenant limit raises an alert (FIFO)", () => {
    const alerts = acc.undepositedCashAlerts(
      fx.cashCollections,
      fx.cashDeposits,
      fx.asOf,
      fx.cashDepositPolicy,
    );
    assert.deepEqual(alerts, [
      {
        outletId: fx.outletId,
        businessDate: "2026-11-02",
        undepositedIdr: 412_000,
        daysOutstanding: 3,
      },
    ]);
    const partial = acc.undepositedCashAlerts(
      fx.cashCollections,
      [...fx.cashDeposits, { outletId: fx.outletId, amountIdr: 400_000 }],
      fx.asOf,
      fx.cashDepositPolicy,
    );
    assert.equal(partial[0].undepositedIdr, 12_000);
    assert.deepEqual(
      acc.undepositedCashAlerts(fx.cashCollections, fx.cashDeposits, fx.asOf, {
        maxDaysUndeposited: 5,
      }),
      [],
    );
  });

  test("ACC-05 a matched deposit points at its statement line; amounts are positive", () => {
    const deposit = fx.cashDeposits[0];
    const line = fx.statementLines.find(
      (l) => l.id === deposit.bankStatementLineId,
    );
    assert.equal(line.amountIdr, deposit.amountIdr);
    assert.equal(
      acc.cashDepositSchema.safeParse({ ...deposit, bankStatementLineId: null })
        .success,
      false,
    );
    assert.equal(
      acc.cashDepositSchema.safeParse({ ...deposit, amountIdr: 0 }).success,
      false,
    );
  });
});

describe("Posting rules (§3.19 Jurnal Otomatis)", () => {
  const map = acc.accountMapFor(fx.accountMappings, fx.legalEntity.id);
  const sale = acc.resolvePostingRule(acc.defaultPostingRules, {
    eventName: "order.paid",
  });
  const saleAmounts = {
    paidCashIdr: 137_500,
    paidGatewayIntentIdr: 0,
    paidDepositIdr: 0,
    paidGatewayIdr: 0,
    paidEdcIdr: 0,
    paidPointsIdr: 0,
    discountIdr: 0,
    grossSalesIdr: 125_000,
    serviceChargeIdr: 0,
    pbjtIdr: 12_500,
    roundingIdr: 0,
  };

  test("ACC-01 rule-built journals balance, drop zero lines and carry the outlet", () => {
    const lines = acc.buildJournalLinesFromRule(sale, saleAmounts, map, {
      outletId: fx.outletId,
    });
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.outletId === fx.outletId));
  });

  test("ACC-01 negative amounts book on the other side (rounding, shift difference)", () => {
    const lines = acc.buildJournalLinesFromRule(
      sale,
      { ...saleAmounts, paidCashIdr: 137_400, roundingIdr: -100 },
      map,
      { outletId: null },
    );
    const rounding = lines.find((l) => l.accountId === code("7101"));
    assert.deepEqual([rounding.debitIdr, rounding.creditIdr], [100, 0]);
    const shift = acc.resolvePostingRule(acc.defaultPostingRules, {
      eventName: "cashier_shift.closed",
    });
    const short = acc.buildJournalLinesFromRule(
      shift,
      { differenceIdr: -20_000 },
      map,
      { outletId: null },
    );
    assert.deepEqual(
      short.find((l) => l.accountId === code("6108")),
      line("6108", 20_000, 0),
    );
  });

  test("ACC-01 rules fail closed: unbalanced amounts, unknown keys, missing mapping or rule", () => {
    throwsCode(
      () =>
        acc.buildJournalLinesFromRule(
          sale,
          { ...saleAmounts, pbjtIdr: 12_000 },
          map,
          { outletId: null },
        ),
      "JOURNAL_UNBALANCED",
    );
    throwsCode(
      () =>
        acc.buildJournalLinesFromRule(
          sale,
          { ...saleAmounts, tipIdr: 5_000 },
          map,
          { outletId: null },
        ),
      "POSTING_AMOUNTS_MISMATCH",
    );
    const missing = { ...saleAmounts };
    delete missing.pbjtIdr;
    throwsCode(
      () =>
        acc.buildJournalLinesFromRule(sale, missing, map, { outletId: null }),
      "POSTING_AMOUNTS_MISMATCH",
    );
    const partialMap = new Map(
      [...map].filter(([role]) => role !== "tax_payable_pbjt"),
    );
    throwsCode(
      () =>
        acc.buildJournalLinesFromRule(sale, saleAmounts, partialMap, {
          outletId: null,
        }),
      "ACCOUNT_MAPPING_MISSING",
    );
    throwsCode(
      () =>
        acc.resolvePostingRule(acc.defaultPostingRules, {
          eventName: "stock.adjusted",
        }),
      "POSTING_RULE_MISSING",
    );
  });

  test("ACC-01 payroll rules are fed by payrollJournalAmounts and balance", () => {
    const keys = [
      "bpjsCompanyIdr",
      "bpjsTotalIdr",
      "customDeductionsIdr",
      "lateDeductionsIdr",
      "loanRepaymentIdr",
      "netIdr",
      "pph21EmployerAllowanceRefundIdr",
      "pph21EmployerBorneIdr",
      "pph21EmployerBorneRefundIdr",
      "pph21Idr",
      "pph21ReceivableCollectedIdr",
      "pph21ReceivableIdr",
      "reimbursementIdr",
      "salaryExpenseIdr",
      "serviceChargeIdr",
    ];
    for (const eventName of ["payroll.locked", "payroll.reversed"]) {
      const rule = acc.resolvePostingRule(acc.defaultPostingRules, {
        eventName,
      });
      assert.deepEqual(acc.postingRuleAmountKeys(rule), keys);
    }
    throwsCode(
      () =>
        acc.resolvePostingRule(acc.defaultPostingRules, {
          eventName: "payroll_run.completed",
        }),
      "POSTING_RULE_MISSING",
    );
    const amounts = acc.payrollJournalAmounts({
      employeeCount: 1,
      grossIdr: 42_000_000,
      deductionsIdr: 1_470_000,
      netIdr: 40_530_000,
      bpjsEmployeeIdr: 840_000,
      bpjsCompanyIdr: 2_184_000,
      pph21Idr: 630_000,
      pph21WithheldIdr: 630_000,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      pph21EmployerRefundIdr: 0,
      pph21EmployerAllowanceRefundIdr: 0,
      loanRepaymentIdr: 0,
      pph21ReceivableIdr: 0,
      pph21ReceivableCollectedIdr: 0,
      otherDeductionsIdr: 0,
      serviceChargeIdr: 0,
      reimbursementIdr: 0,
      bankTransferIdr: 40_530_000,
      cashIdr: 0,
    });
    assert.deepEqual(Object.keys(amounts).sort(), keys);
    for (const eventName of ["payroll.locked", "payroll.reversed"]) {
      const lines = acc.buildJournalLinesFromRule(
        acc.resolvePostingRule(acc.defaultPostingRules, { eventName }),
        amounts,
        map,
        { outletId: null },
      );
      assert.equal(
        lines.reduce((sum, l) => sum + l.debitIdr, 0),
        lines.reduce((sum, l) => sum + l.creditIdr, 0),
      );
    }
  });

  test("every default rule has a unique key, catalogued event and fully mapped roles", () => {
    const keys = acc.defaultPostingRules.map((rule) => rule.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const rule of acc.defaultPostingRules) {
      acc.postingRuleSchema.parse(rule);
      for (const l of rule.lines)
        assert.ok(map.has(l.role), `${rule.key}: ${l.role}`);
    }
    assert.equal(
      acc.postingRuleSchema.safeParse({
        ...sale,
        eventName: "order.teleported",
        key: "order.teleported",
      }).success,
      false,
    );
  });
});

describe("Auto-journal receipt-first rules and late adjustment", () => {
  const map = acc.accountMapFor(fx.accountMappings, fx.legalEntity.id);
  const linesFor = (eventName, amounts) => {
    const rule = acc.resolvePostingRule(acc.defaultPostingRules, { eventName });
    return acc.buildJournalLinesFromRule(rule, amounts, map, {
      outletId: null,
    });
  };
  const sum = (lines, accountCode, side) =>
    lines
      .filter((l) => l.accountId === code(accountCode))
      .reduce((total, l) => total + l[side], 0);

  test("payment.paid receives into customer_deposit; payment.refunded pays it out of gateway_clearing", () => {
    const received = linesFor("payment.paid", {
      receivedIdr: 275_000,
      depositIdr: 275_000,
      guestFeeIdr: 0,
    });
    assert.equal(sum(received, "1202", "debitIdr"), 275_000);
    assert.equal(sum(received, "2107", "creditIdr"), 275_000);
    const paidOut = linesFor("payment.refunded", { amountIdr: 50_000 });
    assert.equal(sum(paidOut, "2107", "debitIdr"), 50_000);
    assert.equal(sum(paidOut, "1202", "creditIdr"), 50_000);
    assert.equal(
      acc.resolvePostingRule(acc.defaultPostingRules, {
        eventName: "payment.paid",
      }).sourceType,
      "customer_deposit",
    );
  });

  test("payment.funds_unallocated receives into customer_deposit like payment.paid", () => {
    const received = linesFor("payment.funds_unallocated", {
      receivedIdr: 125_000,
      depositIdr: 125_000,
      guestFeeIdr: 0,
    });
    assert.equal(sum(received, "1202", "debitIdr"), 125_000);
    assert.equal(sum(received, "2107", "creditIdr"), 125_000);
    assert.equal(received.length, 2);
    assert.equal(
      acc.resolvePostingRule(acc.defaultPostingRules, {
        eventName: "payment.funds_unallocated",
      }).sourceType,
      "customer_deposit",
    );
  });

  test("order.paid draws intent-backed gateway and applied DP from customer_deposit", () => {
    const lines = linesFor("order.paid", {
      paidCashIdr: 0,
      paidGatewayIntentIdr: 100_000,
      paidDepositIdr: 37_500,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      discountIdr: 0,
      grossSalesIdr: 125_000,
      serviceChargeIdr: 0,
      pbjtIdr: 12_500,
      roundingIdr: 0,
    });
    assert.equal(sum(lines, "2107", "debitIdr"), 137_500);
    assert.equal(sum(lines, "1202", "debitIdr"), 0);
  });

  test("order.refunded gateway part is owed in customer_deposit", () => {
    const lines = linesFor("order.refunded", {
      grossSalesIdr: 50_000,
      serviceChargeIdr: 0,
      pbjtIdr: 5_000,
      discountIdr: 0,
      refundCashIdr: 0,
      refundGatewayIdr: 55_000,
      refundGatewayClearingIdr: 0,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
    });
    assert.equal(sum(lines, "2107", "creditIdr"), 55_000);
    assert.equal(sum(lines, "1202", "creditIdr"), 0);
  });

  test("reservation.cancelled and reservation.no_show move a forfeited DP to income", () => {
    for (const eventName of ["reservation.cancelled", "reservation.no_show"]) {
      const lines = linesFor(eventName, {
        forfeitedIdr: 200_000,
        forfeitedGatewayIdr: 0,
      });
      assert.equal(sum(lines, "2107", "debitIdr"), 200_000);
      assert.equal(sum(lines, "7103", "creditIdr"), 200_000);
      assert.equal(lines.length, 2);
      // A DP paid before the cutover never reached customer_deposit: it is
      // forfeited out of gateway_clearing.
      const early = linesFor(eventName, {
        forfeitedIdr: 0,
        forfeitedGatewayIdr: 150_000,
      });
      assert.equal(sum(early, "1202", "debitIdr"), 150_000);
      assert.equal(sum(early, "2107", "debitIdr"), 0);
      assert.equal(sum(early, "7103", "creditIdr"), 150_000);
      assert.equal(early.length, 2);
      assert.deepEqual(
        acc.postingRuleAmountKeys(
          acc.resolvePostingRule(acc.defaultPostingRules, { eventName }),
        ),
        ["forfeitedGatewayIdr", "forfeitedIdr"],
      );
    }
  });

  test("resolveAutoJournalDate keeps an open date and rolls a closed one to the next open period", () => {
    assert.deepEqual(acc.resolveAutoJournalDate("2026-11-05", null), {
      entryDate: "2026-11-05",
      lateAdjustmentFrom: null,
    });
    assert.deepEqual(acc.resolveAutoJournalDate("2026-11-05", "2026-10"), {
      entryDate: "2026-11-05",
      lateAdjustmentFrom: null,
    });
    assert.deepEqual(acc.resolveAutoJournalDate("2026-10-31", "2026-10"), {
      entryDate: "2026-11-01",
      lateAdjustmentFrom: "2026-10-31",
    });
    assert.deepEqual(acc.resolveAutoJournalDate("2026-08-15", "2026-10"), {
      entryDate: "2026-11-01",
      lateAdjustmentFrom: "2026-08-15",
    });
    assert.deepEqual(acc.resolveAutoJournalDate("2026-12-20", "2026-12"), {
      entryDate: "2027-01-01",
      lateAdjustmentFrom: "2026-12-20",
    });
    assert.throws(() => acc.resolveAutoJournalDate("2026-13-01", null));
  });
});

describe("Chart of accounts per legal entity", () => {
  test("standard F&B template is a valid tree; every posting role mapped once to a leaf of the right type", () => {
    assert.deepEqual(acc.chartOfAccountsIssues(fx.accounts), []);
    assert.deepEqual(
      acc.accountMappingIssues(fx.accountMappings, fx.accounts),
      [],
    );
    const roles = fx.accountMappings.map((m) => m.role).sort();
    assert.deepEqual(roles, Object.keys(acc.POSTING_ACCOUNT_ROLES).sort());
  });

  test("structural errors are reported: duplicate code, cycle, cross-entity parent", () => {
    const [a, b] = fx.accounts.filter((x) => x.parentId !== null);
    assert.ok(
      acc
        .chartOfAccountsIssues([
          ...fx.accounts,
          { ...a, id: "ac000000-0000-4000-8000-0000000000ff" },
        ])
        .some((i) => i.includes("Duplicate")),
    );
    const cyclic = fx.accounts.map((x) =>
      x.id === a.parentId ? { ...x, parentId: a.id } : x,
    );
    assert.ok(
      acc.chartOfAccountsIssues(cyclic).some((i) => i.includes("cycle")),
    );
    assert.equal(
      acc.accountSchema.safeParse({ ...b, reportGroup: "cogs" }).success,
      b.type === "expense",
    );
  });

  test("ACC-01 only active leaf accounts of the entry's entity are postable", () => {
    acc.assertAccountPostable(code("6106"), fx.legalEntity.id, fx.accounts);
    throwsCode(
      () =>
        acc.assertAccountPostable(code("6100"), fx.legalEntity.id, fx.accounts),
      "ACCOUNT_NOT_POSTABLE",
    );
    throwsCode(
      () =>
        acc.assertAccountPostable(
          code("6106"),
          "5e1a7c30-4b2d-4e8f-9a61-000000000000",
          fx.accounts,
        ),
      "ACCOUNT_ENTITY_MISMATCH",
    );
    const inactive = fx.accounts.map((x) =>
      x.code === "6106" ? { ...x, isActive: false } : x,
    );
    throwsCode(
      () =>
        acc.assertAccountPostable(code("6106"), fx.legalEntity.id, inactive),
      "ACCOUNT_INACTIVE",
    );
  });
});

describe("AP/AR aging, fixed assets, budgets, tax", () => {
  test("aging buckets follow tenant limits and sum exactly", () => {
    assert.deepEqual(acc.agingBucketLabels([30, 60, 90]), [
      "current",
      "1-30",
      "31-60",
      "61-90",
      ">90",
    ]);
    assert.equal(acc.agingBucketIndex("2026-11-10", fx.asOf, [30, 60, 90]), 0);
    assert.equal(acc.agingBucketIndex("2026-10-15", fx.asOf, [30, 60, 90]), 1);
    assert.equal(acc.agingBucketIndex("2026-08-31", fx.asOf, [30, 60, 90]), 3);
    assert.equal(acc.agingBucketIndex("2026-01-01", fx.asOf, [30, 60, 90]), 4);
    const report = acc.buildAgingReport(
      fx.openItems,
      "payable",
      fx.asOf,
      fx.agingBucketLimits,
    );
    assert.deepEqual(
      report.bucketTotals,
      [1_275_000, 4_850_000, 0, 2_600_000, 0],
    );
    assert.equal(report.totalIdr, 8_725_000);
    assert.equal(
      acc.buildAgingReport(
        fx.openItems,
        "receivable",
        fx.asOf,
        fx.agingBucketLimits,
      ).totalIdr,
      6_500_000,
    );
  });

  test("straight-line schedule is whole rupiah and sums to the depreciable base", () => {
    const asset = {
      costIdr: 10_000_000,
      residualValueIdr: 1,
      usefulLifeMonths: 7,
      depreciationStartPeriod: "2026-11",
    };
    const schedule = acc.straightLineSchedule(asset);
    assert.equal(schedule.length, 7);
    assert.equal(
      schedule.reduce((sum, row) => sum + row.amountIdr, 0),
      9_999_999,
    );
    assert.deepEqual(
      [schedule[0].period, schedule[6].period],
      ["2026-11", "2027-05"],
    );
    const espresso = fx.fixedAssets[0];
    assert.equal(acc.depreciationForPeriod(espresso, "2026-11"), 1_500_000);
    assert.equal(acc.depreciationForPeriod(espresso, "2026-09"), 0);
    assert.equal(
      acc.disposalResultIdr(espresso, 90_000_000),
      90_000_000 - (96_000_000 - 1_500_000),
    );
    throwsCode(
      () => acc.disposalResultIdr({ ...espresso, status: "disposed" }, 0),
      "ASSET_ALREADY_DISPOSED",
    );
    assert.equal(
      acc.depreciationRunSchema.safeParse({
        ...fx.depreciationRuns[0],
        amountIdr: 1,
      }).success,
      false,
    );
  });

  test("budget variance in bp rounds half_up; zero budget has no percentage", () => {
    assert.deepEqual(acc.budgetVariance(2_500_000, 1_520_000), {
      varianceIdr: -980_000,
      varianceBp: -3_920,
    });
    assert.deepEqual(acc.budgetVariance(3, 4), {
      varianceIdr: 1,
      varianceBp: 3_333,
    });
    assert.deepEqual(acc.budgetVariance(0, 4), {
      varianceIdr: 4,
      varianceBp: null,
    });
    assert.equal(
      acc.upsertBudgetsInputSchema.safeParse({
        legalEntityId: fx.legalEntity.id,
        rows: [fx.budgets[0], fx.budgets[0]].map((b) => ({
          outletId: b.outletId,
          accountId: b.accountId,
          period: b.period,
          amountIdr: b.amountIdr,
        })),
      }).success,
      false,
    );
  });

  test("PPN applies only to a PKP legal entity", () => {
    throwsCode(
      () => acc.assertTaxTypeApplicable("ppn", fx.legalEntity),
      "TAX_REPORT_NOT_APPLICABLE",
    );
    acc.assertTaxTypeApplicable("ppn", { isPkp: true });
    acc.assertTaxTypeApplicable("pbjt", fx.legalEntity);
    assert.equal(
      acc.taxReportSchema.safeParse({ ...fx.taxReports[0], amountIdr: 1 })
        .success,
      false,
    );
  });
});

describe("Fixtures, events and endpoints", () => {
  test("ACC-01 ACC-02 Cafe Legend fixtures parse against their schemas", () => {
    acc.chartOfAccountsSchema.parse(fx.accounts);
    fx.accountMappings.forEach((row) => acc.accountMappingSchema.parse(row));
    fx.fiscalPeriods.forEach((row) => acc.fiscalPeriodSchema.parse(row));
    fx.periodReopenRequests.forEach((row) =>
      acc.periodReopenRequestSchema.parse(row),
    );
    fx.manualJournals.forEach((row) => acc.manualJournalSchema.parse(row));
    fx.recurringJournals.forEach((row) =>
      acc.recurringJournalSchema.parse(row),
    );
    acc.bankAccountSchema.parse(fx.bankAccount);
    acc.bankStatementImportSchema.parse(fx.statementImport);
    fx.statementLines.forEach((row) => acc.bankStatementLineSchema.parse(row));
    fx.cashDeposits.forEach((row) => acc.cashDepositSchema.parse(row));
    fx.cashCollections.forEach((row) => acc.cashCollectionSchema.parse(row));
    fx.reconciliationCases.forEach((row) =>
      acc.reconciliationCaseSchema.parse(row),
    );
    fx.openItems.forEach((row) => acc.openItemSchema.parse(row));
    fx.fixedAssets.forEach((row) => acc.fixedAssetSchema.parse(row));
    fx.depreciationRuns.forEach((row) => acc.depreciationRunSchema.parse(row));
    fx.budgets.forEach((row) => acc.budgetSchema.parse(row));
    fx.taxReports.forEach((row) => acc.taxReportSchema.parse(row));
    acc.trialBalanceSchema.parse(fx.statements.trialBalance);
    acc.balanceSheetSchema.parse(fx.statements.balanceSheet);
    acc.cashDepositPolicySchema.parse(fx.cashDepositPolicy);
    acc.matchingPolicySchema.parse(fx.matchingPolicy);
    acc.reconciliationPolicySchema.parse(fx.reconciliationPolicy);
    acc.agingBucketLimitsSchema.parse(fx.agingBucketLimits);
    assert.ok(fx.journals.every((entry) => entry.tenantId === fx.tenantId));
  });

  test("every WS-07 catalog event except distribution.* has a payload contract", () => {
    const ws07 = eventCatalog
      .filter((entry) => entry.workstream === "WS-07")
      .map((entry) => entry.name);
    assert.deepEqual(
      Object.keys(acc.ACCOUNTING_EVENTS).sort(),
      ws07.filter((name) => !name.startsWith("distribution.")).sort(),
    );
  });

  test("ACC-01 journal.posted envelope validates end to end", () => {
    const entry = fx.entries.cashSale;
    const envelope = {
      id: "01JBQ9C0000000000000000001",
      tenantId: fx.tenantId,
      outletId: fx.outletId,
      name: "journal.posted",
      version: 1,
      aggregateType: "journal",
      aggregateId: entry.id,
      sequence: 1,
      occurredAt: entry.postedAt,
      actor: { type: "system" },
      idempotencyKey: `journal-posted-${entry.id}`,
      payloadSchemaRef: "journal.posted.v1",
      payload: {
        journalEntryId: entry.id,
        legalEntityId: entry.legalEntityId,
        outletId: entry.outletId,
        fiscalPeriodId: entry.fiscalPeriodId,
        entryDate: entry.entryDate,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        reversalOf: null,
        totalIdr: 137_500,
        lineCount: entry.lines.length,
      },
    };
    acc.journalPostedEvent.envelopeSchema.parse(envelope);
    assert.equal(
      acc.journalPostedEvent.envelopeSchema.safeParse({
        ...envelope,
        payload: { ...envelope.payload, extra: 1 },
      }).success,
      false,
    );
  });

  test("endpoints are unique, under /api/accounting, and bodies refuse tenantId (TEN-02)", () => {
    const endpoints = Object.values(acc.accountingEndpoints);
    const ids = endpoints.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const endpoint of endpoints) {
      assert.ok(endpoint.path.startsWith("/api/accounting/"), endpoint.id);
      if (endpoint.body && endpoint.body.shape)
        assert.ok(!("tenantId" in endpoint.body.shape), endpoint.id);
    }
    const parsed = acc.createCashDeposit.body.safeParse({
      outletId: fx.outletId,
      bankAccountId: fx.bankAccount.id,
      amountIdr: 412_000,
      coversFrom: "2026-11-02",
      coversTo: "2026-11-02",
      depositedAt: "2026-11-05T03:00:00.000Z",
      slipReference: null,
      idempotencyKey: "deposit-0002",
      tenantId: fx.tenantId,
    });
    assert.equal(parsed.success, false);
    acc.listJournals.query.parse({
      legalEntityId: fx.legalEntity.id,
      from: "2026-11-01",
      to: "2026-11-30",
      limit: "50",
    });
  });
});

// ---- Profit share & dividends (WS-07, bead legend-cq2; SH-03, SH-04) -------

const pf = fx.profitShare;
const legalEntityEntity = pf.entities.find(
  (row) => row.type === "legal_entity",
);
const version = (profitEntityId, n) =>
  pf.versions.find(
    (row) => row.profitEntityId === profitEntityId && row.version === n,
  );
const [raka, dewi] = pf.shareholders;
const runs = Object.values(pf.runs);

describe("SH-03 versioned shares sum to 100% and need approval", () => {
  test("SH-03 a version sums to exactly 10,000 bp before submit", () => {
    const draft = version(legalEntityEntity.id, 3);
    assert.equal(acc.shareAllocationTotalBp(draft.allocations), 9_500);
    throwsCode(
      () => acc.assertShareAllocationsSum(draft.allocations),
      "SHARE_ALLOCATION_NOT_EXACT_100",
    );
    throwsCode(
      () =>
        acc.transitionShareAllocationVersion(draft, {
          type: "submit",
          actorId: finance,
        }),
      "SHARE_ALLOCATION_NOT_EXACT_100",
    );
    const current = version(legalEntityEntity.id, 2);
    assert.equal(acc.assertShareAllocationsSum(current.allocations), 10_000);
    throwsCode(
      () =>
        acc.assertShareAllocationsSum([
          ...current.allocations,
          { shareBp: 500 },
        ]),
      "SHARE_ALLOCATION_NOT_EXACT_100",
    );
    // A pending or approved version that is not 100% does not parse at all.
    assert.equal(
      acc.shareAllocationVersionSchema.safeParse({
        ...draft,
        status: "pending_approval",
      }).success,
      false,
    );
  });

  test("SH-03 approval needs a different actor and complete shares", () => {
    const current = version(legalEntityEntity.id, 2);
    const submitted = {
      ...current,
      status: "pending_approval",
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
    };
    throwsCode(
      () =>
        acc.transitionShareAllocationVersion(submitted, {
          type: "approve",
          actorId: current.requestedBy,
          now: NOW,
        }),
      "APPROVER_IS_REQUESTER",
    );
    assert.deepEqual(
      acc.transitionShareAllocationVersion(submitted, {
        type: "approve",
        actorId: owner,
        now: NOW,
      }),
      {
        status: "approved",
        decidedBy: owner,
        decidedAt: NOW,
        decisionNote: null,
      },
    );
    throwsCode(
      () =>
        acc.transitionShareAllocationVersion(submitted, {
          type: "reject",
          actorId: owner,
          now: NOW,
          reason: " ",
        }),
      "INVALID_TRANSITION",
    );
    const rejected = acc.transitionShareAllocationVersion(submitted, {
      type: "reject",
      actorId: owner,
      now: NOW,
      reason: "Porsi belum sesuai kesepakatan.",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.decisionNote, "Porsi belum sesuai kesepakatan.");
    throwsCode(
      () =>
        acc.transitionShareAllocationVersion(current, {
          type: "submit",
          actorId: owner,
        }),
      "INVALID_TRANSITION",
    );
  });

  test("SH-03 only an approved, effective version can be used", () => {
    const effective = acc.effectiveShareAllocationVersion(
      pf.versions,
      legalEntityEntity.id,
      "2026-08-01",
    );
    assert.equal(effective.version, 2);
    assert.equal(
      acc.effectiveShareAllocationVersion(
        pf.versions,
        legalEntityEntity.id,
        "2025-12-31",
      ),
      null,
    );
    throwsCode(
      () => acc.assertShareVersionUsable(null),
      "SHARE_VERSION_NOT_EFFECTIVE",
    );
    throwsCode(
      () => acc.assertShareVersionUsable(version(legalEntityEntity.id, 3)),
      "SHARE_VERSION_NOT_APPROVED",
    );
    acc.assertShareVersionUsable(effective);
    const current = version(legalEntityEntity.id, 2);
    throwsCode(
      () => acc.assertShareVersionEffective(current, "2026-06-30"),
      "SHARE_VERSION_NOT_EFFECTIVE",
    );
    acc.assertShareVersionEffective(current, "2026-07-01");
    throwsCode(
      () => acc.assertShareVersionEffective(null, "2026-07-01"),
      "SHARE_VERSION_NOT_EFFECTIVE",
    );
    throwsCode(
      () => acc.assertEffectiveFromAdvances("2026-07-01", "2026-07-01"),
      "SHARE_VERSION_EFFECTIVE_DATE_ORDER",
    );
    acc.assertEffectiveFromAdvances("2026-07-01", "2026-10-01");
    assert.equal(
      acc.latestShareAllocationVersion(pf.versions, legalEntityEntity.id),
      3,
    );
    throwsCode(
      () =>
        acc.assertUniqueShareholders([
          { shareholderId: raka.id },
          { shareholderId: raka.id },
        ]),
      "SHARE_ALLOCATION_DUPLICATE",
    );
  });
});

describe("SH-04 approved distributions freeze and corrections use adjustments", () => {
  const sep = pf.runs.september;
  const oct = pf.runs.october;
  const adjustment = pf.runs.adjustment;

  test("SH-04 an adjustment keeps the corrected run's entity, version and split", () => {
    acc.assertAdjustmentMatchesTarget(sep, adjustment);
    throwsCode(
      () =>
        acc.assertAdjustmentMatchesTarget(sep, {
          ...adjustment,
          shareVersion: adjustment.shareVersion + 1,
        }),
      "ADJUSTMENT_TARGET_INVALID",
    );
    throwsCode(
      () =>
        acc.assertAdjustmentMatchesTarget(sep, {
          ...adjustment,
          lines: adjustment.lines.slice(1),
        }),
      "ADJUSTMENT_TARGET_INVALID",
    );
  });

  test("§3.37 the remainder tie-break does not depend on allocation row order", () => {
    const base = {
      profitEntityId: sep.profitEntityId,
      fiscalPeriodId: sep.fiscalPeriodId,
      period: sep.period,
      periodStatus: "closed",
      periodNetProfitIdr: 1_000_001,
      policy: { ...legalEntityEntity.policy, reserveBp: 0 },
      allocations: [
        { shareholderId: sep.lines[0].shareholderId, shareBp: 5_000 },
        { shareholderId: sep.lines[1].shareholderId, shareBp: 5_000 },
      ],
    };
    const forward = acc.calculateDistribution(base);
    const reversed = acc.calculateDistribution({
      ...base,
      allocations: [...base.allocations].reverse(),
    });
    assert.deepEqual(forward.lines, reversed.lines);
    assert.equal(forward.totalGrossIdr, 1_000_001);
    // A share too small for a whole rupiah is a domain error, not a parse error.
    throwsCode(
      () => acc.calculateDistribution({ ...base, periodNetProfitIdr: 1 }),
      "NOTHING_TO_DISTRIBUTE",
    );
  });

  test("§3.37 the dividend journal credits bank with net and tax payable with the withholding", () => {
    const map = acc.accountMapFor(fx.accountMappings, fx.legalEntity.id);
    const rule = acc.resolvePostingRule(acc.defaultPostingRules, {
      eventName: "distribution.completed",
    });
    assert.ok(sep.totalTaxWithheldIdr > 0);
    const lines = acc.buildJournalLinesFromRule(
      rule,
      {
        distributedIdr: sep.totalGrossIdr,
        paidNetIdr: sep.totalNetIdr,
        taxWithheldIdr: sep.totalTaxWithheldIdr,
      },
      map,
      { outletId: null },
    );
    assert.equal(lines.length, 3);
    const credits = lines
      .filter((l) => l.creditIdr > 0)
      .map((l) => l.creditIdr);
    assert.deepEqual(
      credits.sort((a, b) => a - b),
      [sep.totalTaxWithheldIdr, sep.totalNetIdr].sort((a, b) => a - b),
    );
    // The completed event refuses a split that does not add up.
    assert.equal(
      acc.distributionCompletedEvent.payloadSchema.safeParse({
        distributionRunId: sep.id,
        profitEntityId: sep.profitEntityId,
        fiscalPeriodId: sep.fiscalPeriodId,
        period: sep.period,
        type: sep.type,
        distributedIdr: sep.totalGrossIdr,
        taxWithheldIdr: sep.totalTaxWithheldIdr,
        paidNetIdr: sep.totalGrossIdr,
        shareholderCount: sep.lines.length,
        journalEntryId: null,
        completedAt: sep.paidAt,
      }).success,
      false,
    );
  });

  test("SH-04 a regular distribution runs from a closed period only", () => {
    const input = {
      profitEntityId: legalEntityEntity.id,
      fiscalPeriodId: period("2026-11").id,
      period: "2026-11",
      periodStatus: "open",
      periodNetProfitIdr: 120_000_000,
      policy: legalEntityEntity.policy,
      allocations: version(legalEntityEntity.id, 2).allocations,
    };
    throwsCode(() => acc.calculateDistribution(input), "PERIOD_NOT_CLOSED");
    throwsCode(
      () =>
        acc.calculateDistribution({
          ...input,
          fiscalPeriodId: period("2026-09").id,
          period: "2026-09",
          periodStatus: "closed",
          periodNetProfitIdr: 0,
        }),
      "NOTHING_TO_DISTRIBUTE",
    );
  });

  test("SH-04 shares, reserve and withholding split exactly with an explicit remainder rule", () => {
    const weights = version(legalEntityEntity.id, 2).allocations.map(
      (row) => row.shareBp,
    );
    const calc = acc.calculateDistribution({
      profitEntityId: legalEntityEntity.id,
      fiscalPeriodId: period("2026-09").id,
      period: "2026-09",
      periodStatus: "closed",
      periodNetProfitIdr: 100_000_001,
      policy: { ...legalEntityEntity.policy, reserveBp: 0 },
      allocations: version(legalEntityEntity.id, 2).allocations,
    });
    assert.equal(calc.reserveIdr, 0);
    assert.equal(calc.distributableIdr, 100_000_001);
    assert.equal(calc.totalGrossIdr, 100_000_001);
    assert.deepEqual(
      calc.lines.map((row) => row.grossIdr),
      allocateIdr(100_000_001, weights),
    );
    for (const row of calc.lines) {
      assert.equal(
        row.taxWithheldIdr,
        applyBasisPoints(row.grossIdr, 1_000, "half_up"),
      );
      assert.equal(row.netIdr, row.grossIdr - row.taxWithheldIdr);
    }
    assert.equal(
      calc.totalNetIdr,
      calc.totalGrossIdr - calc.totalTaxWithheldIdr,
    );
    assert.equal(acc.DISTRIBUTION_ROUNDING.allocation, "largest_remainder");
    acc.distributionCalculationSchema.parse(calc);
  });

  test("SH-04 approved and paid runs are frozen; the correction is an adjustment", () => {
    throwsCode(
      () => acc.assertDistributionEditable(sep),
      "DISTRIBUTION_IMMUTABLE",
    );
    throwsCode(
      () => acc.assertDistributionEditable(oct),
      "DISTRIBUTION_IMMUTABLE",
    );
    acc.assertDistributionEditable(adjustment);
    acc.assertAdjustmentTarget(sep);
    acc.assertAdjustmentTarget(oct);
    throwsCode(
      () => acc.assertAdjustmentTarget(adjustment),
      "ADJUSTMENT_TARGET_INVALID",
    );
    throwsCode(
      () => acc.assertAdjustmentTarget(null),
      "ADJUSTMENT_TARGET_INVALID",
    );
    assert.equal(adjustment.type, "adjustment");
    assert.equal(adjustment.adjustsRunId, sep.id);
    assert.equal(adjustment.shareVersion, sep.shareVersion);
    assert.ok(adjustment.totalGrossIdr < 0);
    assert.equal(adjustment.basis, "approved_run_adjustment");
    assert.equal(adjustment.reversalJournalEntryId, null);
    assert.notEqual(adjustment.id, sep.id);
    assert.equal(sep.status, "paid");
  });

  test("SH-04 payments move approved to paid without changing amounts", () => {
    const money = (run) => ({
      gross: run.totalGrossIdr,
      tax: run.totalTaxWithheldIdr,
      net: run.totalNetIdr,
      distributable: run.distributableIdr,
      reserve: run.reserveIdr,
    });
    const before = money(oct);
    const pending = oct.lines.filter((row) => row.paymentStatus === "pending");
    let run = acc.transitionDistributionRun(oct, {
      type: "record_payment",
      actorId: finance,
      lineId: pending[0].id,
      paymentRef: "TRF/TEST-1",
      paidAt: "2026-11-05T09:00:00.000Z",
    });
    assert.equal(run.status, "approved");
    run = acc.transitionDistributionRun(run, {
      type: "record_payment",
      actorId: finance,
      lineId: pending[1].id,
      paymentRef: "TRF/TEST-2",
      paidAt: "2026-11-05T10:00:00.000Z",
    });
    assert.equal(run.status, "paid");
    assert.equal(run.paidAt, "2026-11-05T10:00:00.000Z");
    assert.deepEqual(money(run), before);
    const paidLine = oct.lines.find((row) => row.paymentStatus === "paid");
    throwsCode(
      () =>
        acc.transitionDistributionRun(oct, {
          type: "record_payment",
          actorId: finance,
          lineId: paidLine.id,
          paymentRef: "TRF/DUP",
          paidAt: NOW,
        }),
      "DISTRIBUTION_LINE_ALREADY_PAID",
    );
    throwsCode(
      () =>
        acc.transitionDistributionRun(adjustment, {
          type: "record_payment",
          actorId: finance,
          lineId: adjustment.lines[0].id,
          paymentRef: "TRF/DRAFT",
          paidAt: NOW,
        }),
      "INVALID_TRANSITION",
    );
    const withStatement = acc.attachDistributionStatement(
      run,
      pending[1].id,
      "shareholder/2026-10/test-statement.pdf",
    );
    assert.equal(
      withStatement.lines.find((row) => row.id === pending[1].id)
        .statementFileKey,
      "shareholder/2026-10/test-statement.pdf",
    );
    assert.deepEqual(money(withStatement), before);
    throwsCode(
      () =>
        acc.attachDistributionStatement(
          adjustment,
          adjustment.lines[0].id,
          "shareholder/x.pdf",
        ),
      "INVALID_TRANSITION",
    );
  });

  test("SH-04 the run schema refuses self-approval and unapproved payments", () => {
    assert.equal(
      acc.distributionRunSchema.safeParse({
        ...oct,
        approvedBy: oct.requestedBy,
      }).success,
      false,
    );
    assert.equal(
      acc.distributionRunSchema.safeParse({ ...oct, status: "draft" }).success,
      false,
    );
    assert.equal(
      acc.distributionRunSchema.safeParse({ ...oct, status: "paid" }).success,
      false,
    );
    assert.equal(
      acc.distributionRunSchema.safeParse({
        ...sep,
        totalNetIdr: sep.totalNetIdr + 1,
      }).success,
      false,
    );
  });

  test("SH-04 one regular run per closed period; adjustments are separate", () => {
    throwsCode(
      () =>
        acc.assertNoDuplicateRegularRun(runs, {
          profitEntityId: legalEntityEntity.id,
          fiscalPeriodId: sep.fiscalPeriodId,
        }),
      "DISTRIBUTION_ALREADY_EXISTS",
    );
    acc.assertNoDuplicateRegularRun(runs, {
      profitEntityId: legalEntityEntity.id,
      fiscalPeriodId: sep.fiscalPeriodId,
      ignoreRunId: sep.id,
    });
    acc.assertNoDuplicateRegularRun([adjustment], {
      profitEntityId: legalEntityEntity.id,
      fiscalPeriodId: adjustment.fiscalPeriodId,
    });
  });

  test("SH-04 statements are per shareholder, official, and estimates are labelled", () => {
    const line = sep.lines.find((row) => row.shareholderId === dewi.id);
    const statement = acc.buildDistributionStatement({
      run: sep,
      line,
      shareholder: dewi,
      profitEntity: legalEntityEntity,
    });
    assert.equal(statement.basis, "closed_period");
    assert.equal(statement.shareholderId, dewi.id);
    assert.equal(statement.netIdr, line.netIdr);
    assert.ok(!("lines" in statement));
    throwsCode(
      () =>
        acc.buildDistributionStatement({
          run: sep,
          line,
          shareholder: raka,
          profitEntity: legalEntityEntity,
        }),
      "INVALID_TRANSITION",
    );
    const estimate = acc.buildProfitShareEstimate({
      profitEntity: legalEntityEntity,
      period: "2026-11",
      shareBp: 2_500,
      estimatedNetProfitIdr: 120_000_000,
      asOf: NOW,
    });
    assert.equal(estimate.label, "estimate");
    assert.equal(estimate.estimatedShareIdr, 30_000_000);
    const mine = pf.myProfitShare;
    assert.equal(mine.shareholderId, dewi.id);
    assert.ok(
      mine.distributionHistory.every((row) => row.shareholderId === dewi.id),
    );
    assert.ok(mine.estimates.every((row) => row.label === "estimate"));
    assert.deepEqual(
      mine.holdings.map((row) => row.shareBp).sort((a, b) => a - b),
      [2_500, 4_000],
    );
    acc.myProfitShareSchema.parse(mine);
  });
});

describe("Profit-share fixtures, events and endpoints", () => {
  test("SH-03 SH-04 Cafe Legend profit-share fixtures parse against their schemas", () => {
    pf.shareholders.forEach((row) => acc.shareholderSchema.parse(row));
    pf.entities.forEach((row) => acc.profitEntitySchema.parse(row));
    pf.versions.forEach((row) => acc.shareAllocationVersionSchema.parse(row));
    runs.forEach((row) => acc.distributionRunSchema.parse(row));
    pf.documents.forEach((row) => acc.shareholderDocumentSchema.parse(row));
    pf.statements.forEach((row) => acc.distributionStatementSchema.parse(row));
    acc.myProfitShareSchema.parse(pf.myProfitShare);
    assert.equal(pf.runs.september.status, "paid");
    assert.equal(pf.runs.october.status, "approved");
    assert.equal(pf.runs.adjustment.status, "draft");
    assert.deepEqual(
      pf.runs.september.lines.map((row) => row.paymentStatus),
      ["paid", "paid", "paid", "paid"],
    );
    assert.ok(
      pf.versions
        .filter((row) => row.status === "approved")
        .every((row) => acc.shareAllocationTotalBp(row.allocations) === 10_000),
    );
    assert.equal(
      acc.shareAllocationTotalBp(
        pf.versions.find((row) => row.status === "draft").allocations,
      ),
      9_500,
    );
  });

  test("SH-01 shareholder documents only reach shareholders when published", () => {
    const [monthly, minutes, unpublished] = pf.documents;
    acc.assertDocumentVisibleToShareholders(monthly);
    throwsCode(
      () => acc.assertDocumentVisibleToShareholders(minutes),
      "PERMISSION_DENIED",
    );
    throwsCode(
      () => acc.assertDocumentVisibleToShareholders(unpublished),
      "PERMISSION_DENIED",
    );
  });

  test("SH-03 SH-04 every distribution.* catalog event has a payload contract", () => {
    const distributionEvents = eventCatalog
      .filter((entry) => entry.workstream === "WS-07")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("distribution."));
    assert.deepEqual(
      Object.keys(acc.PROFIT_SHARE_EVENTS).sort(),
      distributionEvents.sort(),
    );
  });

  test("SH-04 distribution.approved and distribution.paid envelopes validate end to end", () => {
    const run = pf.runs.october;
    const base = {
      id: "01JBQ9C0000000000000000002",
      tenantId: fx.tenantId,
      outletId: null,
      name: "distribution.approved",
      version: 1,
      aggregateType: "distribution",
      aggregateId: run.id,
      sequence: 1,
      occurredAt: run.approvedAt,
      actor: { type: "user", id: owner },
      idempotencyKey: `distribution-approved-${run.id}`,
      payloadSchemaRef: "distribution.approved.v1",
      payload: {
        distributionRunId: run.id,
        profitEntityId: run.profitEntityId,
        fiscalPeriodId: run.fiscalPeriodId,
        period: run.period,
        type: run.type,
        shareVersion: run.shareVersion,
        totalGrossIdr: run.totalGrossIdr,
        totalTaxWithheldIdr: run.totalTaxWithheldIdr,
        totalNetIdr: run.totalNetIdr,
        shareholderCount: run.lines.length,
        approvedBy: run.approvedBy,
        approvedAt: run.approvedAt,
      },
    };
    acc.distributionApprovedEvent.envelopeSchema.parse(base);
    assert.equal(
      acc.distributionApprovedEvent.envelopeSchema.safeParse({
        ...base,
        payload: { ...base.payload, extra: 1 },
      }).success,
      false,
    );
    const line = run.lines.find((row) => row.paymentStatus === "paid");
    acc.distributionPaidEvent.envelopeSchema.parse({
      ...base,
      name: "distribution.paid",
      idempotencyKey: `distribution-paid-${line.id}`,
      payloadSchemaRef: "distribution.paid.v1",
      payload: {
        distributionRunId: run.id,
        distributionLineId: line.id,
        profitEntityId: run.profitEntityId,
        shareholderId: line.shareholderId,
        grossIdr: line.grossIdr,
        taxWithheldIdr: line.taxWithheldIdr,
        netIdr: line.netIdr,
        paymentRef: line.paymentRef,
        paidAt: line.paidAt,
      },
    });
    acc.distributionCompletedEvent.envelopeSchema.parse({
      ...base,
      name: "distribution.completed",
      idempotencyKey: `distribution-completed-${pf.runs.september.id}`,
      payloadSchemaRef: "distribution.completed.v1",
      payload: {
        distributionRunId: pf.runs.september.id,
        profitEntityId: pf.runs.september.profitEntityId,
        fiscalPeriodId: pf.runs.september.fiscalPeriodId,
        period: pf.runs.september.period,
        type: pf.runs.september.type,
        distributedIdr: pf.runs.september.totalGrossIdr,
        taxWithheldIdr: pf.runs.september.totalTaxWithheldIdr,
        paidNetIdr: pf.runs.september.totalNetIdr,
        shareholderCount: pf.runs.september.lines.length,
        journalEntryId: null,
        completedAt: pf.runs.september.paidAt,
      },
    });
  });

  test("SH-03 SH-04 profit-share endpoints are unique and refuse tenantId (TEN-02)", () => {
    const endpoints = Object.values(acc.profitShareEndpoints);
    const ids = endpoints.map((endpoint) => endpoint.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(endpoints.length, 24);
    for (const endpoint of endpoints) {
      assert.ok(endpoint.path.startsWith("/api/accounting/"), endpoint.id);
      if (endpoint.body && endpoint.body.shape)
        assert.ok(!("tenantId" in endpoint.body.shape), endpoint.id);
    }
    assert.equal(
      acc.createShareholder.body.safeParse({
        name: "Test",
        type: "person",
        userId: null,
        npwp: null,
        payoutAccount: null,
        tenantId: fx.tenantId,
      }).success,
      false,
    );
    acc.createShareAllocationVersion.body.parse({
      effectiveFrom: "2027-01-01",
      allocations: [{ shareholderId: raka.id, shareBp: 5_000 }],
      idempotencyKey: "share-version-0003",
    });
    assert.equal(
      acc.createDistributionRun.body.safeParse({
        fiscalPeriodId: period("2026-09").id,
        idempotencyKey: "distribution-0001",
        totalGrossIdr: 1,
      }).success,
      false,
    );
  });
});

test("ACC-01 invalid and overflowing journal amounts fail closed without throwing", () => {
  const invalid = acc.checkJournalBalance([
    { debitIdr: Infinity, creditIdr: 0 },
    { debitIdr: 0, creditIdr: 1 },
  ]);
  assert.equal(invalid.balanced, false);
  const max = Number.MAX_SAFE_INTEGER;
  const overflow = acc.checkJournalBalance([
    { debitIdr: max, creditIdr: 0 },
    { debitIdr: 1, creditIdr: 0 },
    { debitIdr: 0, creditIdr: max },
    { debitIdr: 0, creditIdr: 1 },
  ]);
  assert.equal(overflow.balanced, false);
});

test("SH-03 a later allocation removing a shareholder removes the current holding", () => {
  const old = version(legalEntityEntity.id, 1);
  const removed = {
    ...old,
    version: 99,
    effectiveFrom: "2026-12-01",
    allocations: old.allocations.filter((row) => row.shareholderId !== dewi.id),
  };
  const result = acc.buildMyProfitShare({
    shareholder: dewi,
    entities: [legalEntityEntity],
    versions: [old, removed],
    statements: [],
    estimates: [],
    asOf: "2026-12-15",
  });
  assert.equal(result.holdings.length, 0);
});
