// WS-07 financial statements and period close (bead legend-rx0h; PRD v1.7
// §3.19 "Laporan Keuangan" and "Tutup Periode"; ACC-02 "Transaksi di periode
// yang sudah ditutup ditolak kecuali periode dibuka ulang dengan approval",
// ACC-03 "Laba rugi per outlet dan per badan usaha dapat diturunkan sampai ke
// transaksi sumber").
//
// Runs with the root node:test suite, no database: it loads the shared
// accounting contract, the feature's pure helpers and its mock handlers with
// Node type stripping. The screens themselves run in
// e2e/legend-rx0h.mock.spec.ts.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import * as control from "../apps/web/src/lib/mock/control.ts";
import { createAttemptKeyTracker } from "../apps/web/src/features/ws05-payment-admin/attempt-key.ts";
import * as i18n from "../packages/shared/src/i18n/index.ts";
// Registers this feature's statement and period handlers.
import "../apps/web/src/features/ws07-statements/mock.ts";
import * as statements from "../apps/web/src/features/ws07-statements/lib.ts";
import * as accounting from "../packages/shared/src/accounting/index.ts";
import { cafeLegendAccountingFixtures as fixtures } from "../packages/shared/src/accounting/fixtures.ts";

const entity = fixtures.legalEntity.id;
const outlet = fixtures.outletId;
const finance = fixtures.users.finance;
const owner = fixtures.users.owner;
const october = fixtures.fiscalPeriods.find((row) => row.period === "2026-10");
const september = fixtures.fiscalPeriods.find(
  (row) => row.period === "2026-09",
);
const november = fixtures.fiscalPeriods.find((row) => row.period === "2026-11");
const range = { from: "2026-11-01", to: "2026-11-30" };
const periodPath = (period) => `/api/accounting/fiscal-periods/${period.id}`;
/** Deterministic valid ULID for idempotency keys (26 Crockford chars). */
const ulid = (n) => `01JBQ9A2B3C4D5E6F7G8H9${String(n).padStart(6, "0")}`;

function accountingError(code) {
  return (error) =>
    error instanceof accounting.AccountingError && error.code === code;
}

async function get(path, query) {
  return dispatchMock({ method: "GET", path, query });
}
async function post(path, body) {
  return dispatchMock({ method: "POST", path, body });
}
function failure(promise) {
  return promise.then(
    () => assert.fail("expected the call to fail"),
    (error) => error,
  );
}

afterEach(resetMocks);

// ---- ACC-02: closed periods, close and reopen -----------------------------

describe("ACC-02 period close", () => {
  test("ACC-02: a closed period refuses posting until an approved reopen", () => {
    // The October period of the fixtures is closed (and was reopened once).
    assert.throws(
      () => accounting.assertPostingAllowed(october, "2026-10-15"),
      accountingError("PERIOD_CLOSED"),
    );

    const decision = accounting.decidePeriodReopen({
      request: {
        ...fixtures.periodReopenRequests[0],
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
      },
      period: october,
      entityPeriods: fixtures.fiscalPeriods,
      decision: "approve",
      actorId: owner,
      now: "2026-11-05T01:00:00.000Z",
    });
    assert.equal(decision.requestStatus, "approved");
    assert.equal(decision.period.status, "open");
    assert.equal(decision.period.version, october.version + 1);
    // Posting is allowed again only after the approval.
    assert.doesNotThrow(() =>
      accounting.assertPostingAllowed(decision.period, "2026-10-15"),
    );

    // November has not ended, so the close is refused with the contract code.
    const readiness = statements.closeReadiness({
      period: november,
      entityPeriods: fixtures.fiscalPeriods,
      today: fixtures.asOf,
      draftCount: 0,
      pendingCount: 0,
      trialBalanceBalanced: true,
    });
    assert.equal(readiness.ready, false);
    assert.deepEqual(
      readiness.blockers.map((blocker) => blocker.code),
      ["PERIOD_NOT_ENDED"],
    );

    // Once the month ended, unposted journals are the checklist blockers.
    const unposted = statements.closeReadiness({
      period: november,
      entityPeriods: fixtures.fiscalPeriods,
      today: "2026-12-02",
      draftCount: 1,
      pendingCount: 2,
      trialBalanceBalanced: false,
    });
    assert.deepEqual(
      unposted.blockers.map((blocker) => blocker.code),
      ["DRAFT_JOURNALS", "PENDING_JOURNALS", "TRIAL_BALANCE_UNBALANCED"],
    );
  });

  test("ACC-02: a reopen request needs a reason and a different approver", () => {
    assert.equal(statements.reopenReasonIssue(""), "required");
    assert.equal(statements.reopenReasonIssue("   "), "required");
    assert.equal(statements.reopenReasonIssue("pendek"), "too_short");
    assert.equal(
      statements.reopenReasonIssue("Tagihan listrik Oktober belum dicatat."),
      null,
    );

    assert.throws(
      () => accounting.assertReopenRequestable(october, "   "),
      accountingError("REOPEN_REASON_REQUIRED"),
    );
    assert.throws(
      () => accounting.assertReopenRequestable(november, "Koreksi kecil"),
      accountingError("PERIOD_ALREADY_OPEN"),
    );

    const pending = {
      ...fixtures.periodReopenRequests[0],
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      requestedBy: finance,
    };
    assert.throws(
      () =>
        accounting.decidePeriodReopen({
          request: pending,
          period: october,
          entityPeriods: fixtures.fiscalPeriods,
          decision: "approve",
          actorId: finance,
          now: "2026-11-05T01:00:00.000Z",
        }),
      (error) => error.code === "APPROVER_IS_REQUESTER",
    );

    const approved = accounting.decidePeriodReopen({
      request: pending,
      period: october,
      entityPeriods: fixtures.fiscalPeriods,
      decision: "approve",
      actorId: owner,
      now: "2026-11-05T01:00:00.000Z",
    });
    assert.equal(approved.requestStatus, "approved");
  });

  test("ACC-02: the mock closes with a snapshot and refuses a stale version", async () => {
    // A stale read cannot close a period that changed underneath it.
    const stale = await failure(
      post(`${periodPath(october)}/close`, {
        expectedVersion: october.version - 1,
        idempotencyKey: ulid(1),
      }),
    );
    assert.equal(stale.code, "PERIOD_CHANGED");

    // A reopen without a reason never becomes a request.
    const noReason = await failure(
      post(`${periodPath(october)}/reopen-requests`, { reason: "" }),
    );
    assert.equal(noReason.code, "VALIDATION_ERROR");

    const request = await post(`${periodPath(october)}/reopen-requests`, {
      reason: "Tagihan listrik Oktober belum dicatat.",
    });
    assert.equal(request.data.status, "pending");
    assert.equal(request.data.requestedBy, finance);

    const approved = await post(
      `/api/accounting/period-reopen-requests/${request.data.id}/approve`,
      { note: null },
    );
    assert.equal(approved.data.request.status, "approved");
    assert.equal(approved.data.request.decidedBy, owner);
    assert.equal(approved.data.period.status, "open");

    const closed = await post(`${periodPath(october)}/close`, {
      expectedVersion: approved.data.period.version,
      idempotencyKey: ulid(2),
    });
    assert.equal(closed.data.status, "closed");
    assert.equal(closed.data.version, approved.data.period.version + 1);
    assert.equal(closed.data.closedBy, finance);

    const snapshot = await get(`${periodPath(october)}/snapshot`);
    assert.equal(snapshot.data.version, closed.data.version);
    assert.ok(snapshot.data.balances.length > 0);
  });

  test("ACC-02: the mock rejects an approval by the requester", async () => {
    const request = await post(`${periodPath(october)}/reopen-requests`, {
      reason: "Tagihan listrik Oktober belum dicatat.",
    });
    // Requests created by the mock are the finance user's; the owner approves.
    const openPeriod = await failure(
      post(`${periodPath(november)}/reopen-requests`, {
        reason: "Belum ada koreksi",
      }),
    );
    assert.equal(openPeriod.code, "PERIOD_ALREADY_OPEN");

    const rejected = await post(
      `/api/accounting/period-reopen-requests/${request.data.id}/reject`,
      { reason: "Snapshot tutup buku sudah benar." },
    );
    assert.equal(rejected.data.status, "rejected");
    assert.equal(rejected.data.decidedBy, owner);
    assert.equal(
      rejected.data.decisionNote,
      "Snapshot tutup buku sudah benar.",
    );
  });
});

// ---- ACC-03: drill-down and per-outlet P&L --------------------------------

describe("ACC-03 drill-down", () => {
  test("ACC-03: a statement row drill-down query follows the statement range and outlet", () => {
    const accountId = fixtures.accountByCode("4101").id;

    const pnl = statements.drillDownQueryFor(
      "profitAndLoss",
      entity,
      { ...range, outletId: outlet },
      accountId,
    );
    assert.deepEqual(pnl, {
      legalEntityId: entity,
      accountId,
      from: range.from,
      to: range.to,
      outletId: outlet,
    });

    // A balance sheet row is cumulative up to the as-of date.
    const balanceSheet = statements.drillDownQueryFor(
      "balanceSheet",
      entity,
      range,
      accountId,
    );
    assert.equal(balanceSheet.from, statements.LEDGER_START_DATE);
    assert.equal(balanceSheet.to, range.to);
    assert.equal("outletId" in balanceSheet, false);

    // The equity closing balance is cumulative too; the multi-entity cell
    // drills the range with the column's own legal entity.
    const equity = statements.drillDownQueryFor(
      "equityChanges",
      entity,
      range,
      accountId,
    );
    assert.equal(equity.from, statements.LEDGER_START_DATE);
    const multi = statements.drillDownQueryFor(
      "multiEntity",
      entity,
      range,
      accountId,
    );
    assert.deepEqual(multi, {
      legalEntityId: entity,
      accountId,
      from: range.from,
      to: range.to,
    });
  });

  test("ACC-03: the per-outlet P&L query filters the report by outlet", () => {
    const query = statements.statementQueryFor("profitAndLoss", entity, {
      ...range,
      outletId: outlet,
    });
    assert.deepEqual(query, {
      legalEntityId: entity,
      from: range.from,
      to: range.to,
      outletId: outlet,
    });

    const built = accounting.buildProfitAndLoss(
      fixtures.accounts,
      fixtures.ledgerLines,
      query,
    );
    assert.equal(built.outletId, outlet);
    assert.equal(
      built.netProfitIdr,
      fixtures.statements.profitAndLossBandungNovember.netProfitIdr,
    );

    // Without an outlet the payload is the entity-wide P&L.
    const all = statements.statementQueryFor("profitAndLoss", entity, range);
    assert.equal("outletId" in all, false);
    const wholeEntity = accounting.buildProfitAndLoss(
      fixtures.accounts,
      fixtures.ledgerLines,
      all,
    );
    assert.equal(wholeEntity.outletId, null);
    assert.equal(
      wholeEntity.netProfitIdr,
      fixtures.statements.profitAndLossNovember.netProfitIdr,
    );
  });

  test("ACC-03: the drill-down endpoint lists the journal lines behind a revenue row", async () => {
    const revenue = fixtures.statements.profitAndLossNovember.sections.find(
      (section) => section.group === "revenue",
    ).rows[0];
    const page = await get("/api/accounting/statements/drill-down", {
      legalEntityId: entity,
      accountId: revenue.accountId,
      from: range.from,
      to: range.to,
      limit: 20,
    });
    assert.ok(page.data.length > 0);
    for (const line of page.data)
      assert.equal(
        line.accountId,
        undefined,
        "the contract row has no accountId",
      );
    // Revenue is credit-normal: the lines' net credit equals the row amount.
    const net = page.data.reduce(
      (total, line) => total + line.debitIdr - line.creditIdr,
      0,
    );
    assert.equal(net, -revenue.amountIdr);
    // Every line links back to a posted journal.
    const journalIds = new Set(fixtures.journals.map((entry) => entry.id));
    for (const line of page.data)
      assert.ok(journalIds.has(line.journalEntryId));
  });
});

// ---- Query mapping and row shaping ---------------------------------------

describe("statement query mapping", () => {
  test("each statement type maps to its own endpoint query", () => {
    assert.deepEqual(
      statements.statementQueryFor("balanceSheet", entity, range),
      { legalEntityId: entity, asOf: range.to },
    );
    assert.deepEqual(statements.statementQueryFor("cashFlow", entity, range), {
      legalEntityId: entity,
      from: range.from,
      to: range.to,
    });
    assert.deepEqual(
      statements.statementQueryFor("equityChanges", entity, range),
      { legalEntityId: entity, from: range.from, to: range.to },
    );
    assert.deepEqual(
      statements.statementQueryFor("multiEntity", entity, range),
      { from: range.from, to: range.to },
    );
    // The P&L grows an outlet field only when one is chosen.
    assert.deepEqual(
      statements.statementQueryFor("profitAndLoss", entity, range),
      {
        legalEntityId: entity,
        from: range.from,
        to: range.to,
      },
    );
    assert.deepEqual(
      statements.statementQueryFor("profitAndLoss", entity, {
        ...range,
        outletId: outlet,
      }),
      {
        legalEntityId: entity,
        from: range.from,
        to: range.to,
        outletId: outlet,
      },
    );
  });
});

describe("statement rows", () => {
  test("sections keep their headers, subtotals and indentation", () => {
    const pl = fixtures.statements.profitAndLossNovember;
    const rows = statements.profitAndLossRows(pl);
    const revenueIndex = rows.findIndex(
      (row) => row.kind === "section" && row.group === "revenue",
    );
    assert.ok(revenueIndex >= 0);
    const firstAccount = rows[revenueIndex + 1];
    assert.equal(firstAccount.kind, "account");
    assert.equal(firstAccount.depth, 1);
    assert.equal(firstAccount.code, "4101");
    const revenueSubtotal = rows[revenueIndex + 2];
    assert.equal(revenueSubtotal.kind, "subtotal");
    assert.equal(revenueSubtotal.totalIdr, 375_000);

    const netProfit = rows.at(-1);
    assert.equal(netProfit.kind, "summary");
    assert.equal(netProfit.labelKey, "accounting.report.pl.netProfit");
    assert.equal(netProfit.amountIdr, pl.netProfitIdr);
    assert.equal(statements.hasAccountRows(rows), true);

    // An all-zero statement has no account row and therefore no table.
    const empty = statements.profitAndLossRows({
      ...pl,
      sections: pl.sections.map((section) => ({
        ...section,
        rows: [],
        totalIdr: 0,
      })),
    });
    assert.equal(statements.hasAccountRows(empty), false);
  });

  test("the balance sheet places current earnings and its three totals", () => {
    const bs = fixtures.statements.balanceSheet;
    const rows = statements.balanceSheetRows(bs);
    assert.ok(
      rows.some(
        (row) =>
          row.kind === "note" &&
          row.labelKey === "accounting.report.bs.currentEarnings" &&
          row.amountIdr === bs.currentEarningsIdr,
      ),
    );
    const totals = Object.fromEntries(
      rows
        .filter((row) => row.kind === "summary")
        .map((row) => [row.labelKey, row.amountIdr]),
    );
    assert.equal(totals["accounting.report.bs.totalAssets"], bs.totalAssetsIdr);
    assert.equal(
      totals["accounting.report.bs.totalLiabilities"],
      bs.totalLiabilitiesIdr,
    );
    assert.equal(totals["accounting.report.bs.totalEquity"], bs.totalEquityIdr);
  });

  test("multi-entity rows align accounts and keep the server combined profit", () => {
    const pl = fixtures.statements.profitAndLossNovember;
    const second = accounting.profitAndLossSchema.parse({
      ...pl,
      legalEntityId: "5e1a7c30-4b2d-4e8f-9a61-3c7d2b8e0f15",
    });
    const report = accounting.multiEntityProfitAndLossSchema.parse({
      from: pl.from,
      to: pl.to,
      basis: pl.basis,
      periodKeys: pl.periodKeys,
      entities: [pl, second],
      combinedNetProfitIdr: pl.netProfitIdr + second.netProfitIdr,
    });
    const rows = statements.multiEntityRows(report);
    const revenue = rows.find(
      (row) => row.kind === "account" && row.code === "4101",
    );
    assert.deepEqual(revenue.amounts, [375_000, 375_000]);
    assert.equal(
      revenue.accountIds[0],
      pl.sections.find((section) => section.group === "revenue").rows[0]
        .accountId,
    );
    const subtotal = rows.find(
      (row) => row.kind === "subtotal" && row.group === "revenue",
    );
    assert.deepEqual(subtotal.amounts, [375_000, 375_000]);
    const net = rows.at(-1);
    assert.equal(net.kind, "summary");
    assert.equal(net.labelKey, "accounting.report.pl.netProfit");
    assert.equal(net.combinedIdr, report.combinedNetProfitIdr);
    assert.equal(statements.hasMultiEntityAccountRows(rows), true);
  });

  test("cash flow keeps activity subtotals and the cash roll-forward", () => {
    const cf = fixtures.statements.cashFlowNovember;
    const rows = statements.cashFlowRows(cf);
    const operating = rows.find(
      (row) => row.kind === "section" && row.activity === "operating",
    );
    assert.ok(operating);
    const subtotal = rows.find(
      (row) => row.kind === "subtotal" && row.activity === "operating",
    );
    assert.equal(subtotal.totalIdr, -1_109_425);
    const closing = rows.at(-1);
    assert.equal(closing.kind, "summary");
    assert.equal(closing.labelKey, "accounting.report.cf.closingCash");
    assert.equal(closing.amountIdr, cf.closingCashIdr);
    assert.equal(statements.isEmptyCashFlow(cf), false);
  });
});

describe("period helpers", () => {
  test("closed periods in a range drive the snapshot note", () => {
    const closed = statements.closedPeriodsInRange(
      fixtures.fiscalPeriods,
      "2026-09-15",
      "2026-11-15",
    );
    assert.deepEqual(
      closed.map((period) => period.period),
      ["2026-09", "2026-10"],
    );
    assert.deepEqual(
      statements.closedPeriodsInRange(
        fixtures.fiscalPeriods,
        "2026-11-30",
        "2026-11-30",
      ),
      [],
    );
    assert.deepEqual(
      statements
        .closedPeriodsInRange(
          fixtures.fiscalPeriods,
          "2026-10-01",
          "2026-10-31",
        )
        .map((period) => period.period),
      ["2026-10"],
    );
  });

  test("the summary counts open/closed periods and finds the next close", () => {
    assert.equal(statements.openPeriodCount(fixtures.fiscalPeriods), 1);
    assert.equal(statements.closedPeriodCount(fixtures.fiscalPeriods), 2);
    // On 5 Nov the current month has not ended.
    assert.equal(
      statements.nextPeriodToClose(fixtures.fiscalPeriods, fixtures.asOf),
      null,
    );
    assert.equal(
      statements.nextPeriodToClose(fixtures.fiscalPeriods, "2026-12-02").period,
      "2026-11",
    );
    assert.equal(
      statements.latestClosedPeriod(fixtures.fiscalPeriods).period,
      "2026-10",
    );
    // Only the latest closed period can be reopened (no stale snapshot).
    assert.equal(
      statements.isReopenable(october, fixtures.fiscalPeriods),
      true,
    );
    assert.equal(
      statements.isReopenable(september, fixtures.fiscalPeriods),
      false,
    );
    assert.equal(
      statements.isReopenable(november, fixtures.fiscalPeriods),
      false,
    );
  });

  test("manual journals of the period become the checklist blockers", () => {
    const counts = statements.blockingJournalCounts(
      fixtures.manualJournals,
      "2026-11",
    );
    assert.deepEqual(counts, { draft: 1, pending: 1 });
    assert.deepEqual(
      statements.blockingJournalCounts(fixtures.manualJournals, "2026-10"),
      { draft: 0, pending: 0 },
    );
  });
});

// ---- Card 1263: close over incomplete production batches --------------------

describe("card 1263 close override", () => {
  const blockedSources = [
    { sourceId: "SRC-A", errorCode: "PRODUCTION_INCOMPLETE" },
    { sourceId: "SRC-B", errorCode: "PRODUCTION_INCOMPLETE" },
  ];

  test("the reason is judged trimmed, 20 to 1000 characters", () => {
    assert.equal(statements.overrideReasonIssue(""), "required");
    assert.equal(statements.overrideReasonIssue("   \n "), "required");
    assert.equal(
      statements.overrideReasonIssue("terlalu singkat"),
      "too_short",
    );
    // Padding does not count toward the minimum.
    assert.equal(
      statements.overrideReasonIssue(`  ${"a".repeat(19)}  `),
      "too_short",
    );
    assert.equal(statements.overrideReasonIssue(`  ${"a".repeat(20)}  `), null);
    assert.equal(statements.overrideReasonIssue("a".repeat(1000)), null);
    assert.equal(statements.overrideReasonIssue("a".repeat(1001)), "too_long");
    // Same limits as the contract the API enforces.
    const body = (reason) =>
      accounting.closeFiscalPeriodOverrideInputSchema.safeParse({
        expectedVersion: 1,
        idempotencyKey: "attempt-key-1",
        reason,
        sourceIds: ["SRC-A"],
      }).success;
    for (const reason of ["a".repeat(19), "a".repeat(20), "a".repeat(1001)])
      assert.equal(
        body(reason),
        statements.overrideReasonIssue(reason) === null,
        String(reason.length),
      );
  });

  test("the override is only offered to a holder of both permissions", () => {
    assert.equal(
      statements.canOverridePeriodClose([
        "accounting.period.close",
        "accounting.period.close_override",
      ]),
      true,
    );
    assert.equal(
      statements.canOverridePeriodClose(["accounting.period.close"]),
      false,
    );
    assert.equal(
      statements.canOverridePeriodClose(["accounting.period.close_override"]),
      false,
    );
    assert.equal(statements.canOverridePeriodClose([]), false);

    const overridable = { overridable: true, sources: blockedSources };
    assert.equal(statements.overrideMode(overridable, true), "allowed");
    assert.equal(statements.overrideMode(overridable, false), "no_permission");
    assert.equal(
      statements.overrideMode({ ...overridable, overridable: false }, true),
      "fix_first",
    );
    // A list emptied meanwhile: close again the normal way.
    assert.equal(
      statements.overrideMode({ overridable: false, sources: [] }, true),
      "empty",
    );
    assert.equal(
      statements.overrideMode({ overridable: true, sources: [] }, true),
      "empty",
    );
  });

  test("sourceIds are exactly the shown sources, in the shown order", () => {
    assert.deepEqual(
      statements.overrideSourceIds({ sources: blockedSources }),
      ["SRC-A", "SRC-B"],
    );
    assert.deepEqual(statements.overrideSourceIds({ sources: [] }), []);
  });

  test("the idempotency key survives a retry and changes with the request", () => {
    let created = 0;
    const tracker = createAttemptKeyTracker(() => `override-key-${++created}`);
    const base = {
      fiscalPeriodId: november.id,
      expectedVersion: november.version,
      reason: "Batch menunggu bahan yang belum tercatat.",
      sourceIds: ["SRC-A", "SRC-B"],
    };
    const payload = (patch = {}) =>
      statements.overrideAttemptPayload({ ...base, ...patch });
    const first = tracker.keyFor(payload());
    // A retry (same inputs, trailing whitespace aside) reuses the key.
    assert.equal(tracker.keyFor(payload()), first);
    assert.equal(
      tracker.keyFor(payload({ reason: `${base.reason}  ` })),
      first,
    );
    // A changed reason or source list is a new request.
    const reasonKey = tracker.keyFor(
      payload({ reason: "Alasan lain yang cukup panjang." }),
    );
    assert.notEqual(reasonKey, first);
    const sourcesKey = tracker.keyFor(payload({ sourceIds: ["SRC-A"] }));
    assert.notEqual(sourcesKey, reasonKey);
    assert.notEqual(
      tracker.keyFor(payload({ expectedVersion: november.version + 1 })),
      sourcesKey,
    );
    // A settled attempt starts over.
    const before = tracker.keyFor(payload());
    tracker.settle();
    assert.notEqual(tracker.keyFor(payload()), before);
  });

  test("every refusal and source label resolves to catalog text", () => {
    const t = i18n.createTranslator();
    const keys = [
      statements.blockerSourceKey("production_order"),
      statements.blockerSourceKey("stock_count"),
      statements.blockerSourceKey("something_new"),
      statements.blockerReasonKey("PRODUCTION_INCOMPLETE"),
      statements.blockerReasonKey("ACCOUNT_MAPPING_MISSING"),
      statements.blockerReasonKey("SOMETHING_NEW"),
    ];
    for (const code of [
      "PERIOD_OVERRIDE_SOURCES_CHANGED",
      "PERIOD_INVENTORY_GL_BLOCKED",
      "PERIOD_CHANGED",
      "MFA_REQUIRED",
      "FORBIDDEN",
    ])
      keys.push(statements.closeOverrideErrorKey(code));
    for (const key of keys) {
      assert.ok(i18n.isMessageKey(key), String(key));
      assert.notEqual(t(key), key);
    }
    assert.equal(statements.closeOverrideErrorKey("SOMETHING_NEW"), null);
    assert.equal(
      statements.closeOverrideNeedsRefetch("PERIOD_OVERRIDE_SOURCES_CHANGED"),
      true,
    );
    assert.equal(statements.closeOverrideNeedsRefetch("MFA_REQUIRED"), false);
  });

  test("mock: a refused close lists the batches and the override closes over them", async () => {
    control.setScenario("period-close-blocked");
    const refused = await failure(
      post(`${periodPath(november)}/close`, {
        expectedVersion: november.version,
        idempotencyKey: ulid(10),
      }),
    );
    assert.equal(refused.status, 422);
    assert.equal(refused.code, "PERIOD_INVENTORY_GL_BLOCKED");

    const list = await get(`${periodPath(november)}/close-blockers`);
    assert.equal(list.data.overridable, true);
    assert.equal(list.data.count, list.data.sources.length);
    assert.ok(list.data.sources.length >= 2);
    const ids = statements.overrideSourceIds(list.data);
    const reason = "Batch menunggu bahan yang belum tercatat.";
    const body = (patch = {}) => ({
      expectedVersion: november.version,
      idempotencyKey: ulid(11),
      reason,
      sourceIds: ids,
      ...patch,
    });

    // A source list that is not exactly the parked one is refused.
    const partial = await failure(
      post(`${periodPath(november)}/close-override`, {
        ...body(),
        sourceIds: ids.slice(1),
      }),
    );
    assert.equal(partial.status, 409);
    assert.equal(partial.code, "PERIOD_OVERRIDE_SOURCES_CHANGED");
    const stale = await failure(
      post(`${periodPath(november)}/close-override`, {
        ...body(),
        expectedVersion: november.version - 1 || 2,
      }),
    );
    assert.equal(stale.code, "PERIOD_CHANGED");
    const short = await failure(
      post(
        `${periodPath(november)}/close-override`,
        body({ reason: "singkat" }),
      ),
    );
    assert.equal(short.code, "VALIDATION_ERROR");

    const closed = await post(`${periodPath(november)}/close-override`, body());
    assert.equal(closed.data.status, "closed");
    // The same attempt replays to the same period instead of failing.
    const replay = await post(`${periodPath(november)}/close-override`, body());
    assert.equal(replay.data.id, closed.data.id);
    assert.equal(replay.data.version, closed.data.version);
  });

  test("mock: another kind of blocker is not overridable", async () => {
    control.setScenario("period-close-blocked-other");
    const list = await get(`${periodPath(november)}/close-blockers`);
    assert.equal(list.data.overridable, false);
    assert.equal(statements.overrideMode(list.data, true), "fix_first");
    const refused = await failure(
      post(`${periodPath(november)}/close-override`, {
        expectedVersion: november.version,
        idempotencyKey: ulid(12),
        reason: "Batch menunggu bahan yang belum tercatat.",
        sourceIds: statements.overrideSourceIds(list.data),
      }),
    );
    assert.equal(refused.code, "PERIOD_INVENTORY_GL_BLOCKED");
  });

  test("mock: a list cleared after the refusal lets the next close through", async () => {
    control.setScenario("period-close-blocked-cleared");
    const closeBody = (key) => ({
      expectedVersion: november.version,
      idempotencyKey: ulid(key),
    });
    const refused = await failure(
      post(`${periodPath(november)}/close`, closeBody(13)),
    );
    assert.equal(refused.code, "PERIOD_INVENTORY_GL_BLOCKED");
    const list = await get(`${periodPath(november)}/close-blockers`);
    assert.equal(statements.overrideMode(list.data, true), "empty");
    const closed = await post(`${periodPath(november)}/close`, closeBody(14));
    assert.equal(closed.data.status, "closed");
  });
});
