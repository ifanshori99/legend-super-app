// Accounting contract tests (WS-07, bead legend-5ob): balanced immutable
// journals and reversal (ACC-01), period close/reopen with approval and the
// close-vs-post version guard (ACC-02), statements and per-outlet drill-down
// (ACC-03), bank/gateway matching and cases with PIC (ACC-04), cash deposit
// alerts (ACC-05), posting rules, fixtures, events and endpoints. Loaded with
// plain Node ESM (type stripping, no resolve hook).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as acc from "../packages/shared/src/accounting/index.ts";
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
          eventName: "payment.paid",
        }),
      "POSTING_RULE_MISSING",
    );
    throwsCode(
      () =>
        acc.resolvePostingRule(acc.defaultPostingRules, {
          eventName: "stock.adjusted",
        }),
      "POSTING_RULE_MISSING",
    );
  });

  test("ACC-01 payroll rule matches PAYR-04 identity", () => {
    const rule = acc.resolvePostingRule(acc.defaultPostingRules, {
      eventName: "payroll_run.completed",
    });
    assert.deepEqual(acc.postingRuleAmountKeys(rule), [
      "employerBpjsIdr",
      "grossPayIdr",
      "netPayIdr",
      "pph21Idr",
      "totalBpjsIdr",
    ]);
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

  test("every WS-07 catalog event except distribution.completed has a payload contract", () => {
    const ws07 = eventCatalog
      .filter((entry) => entry.workstream === "WS-07")
      .map((entry) => entry.name);
    assert.deepEqual(
      Object.keys(acc.ACCOUNTING_EVENTS).sort(),
      ws07.filter((name) => name !== "distribution.completed").sort(),
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
