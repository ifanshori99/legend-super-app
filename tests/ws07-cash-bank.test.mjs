// Cash & bank (bead legend-53q; PRD v1.7 §3.19 "Kas & Bank [P0]" and
// "Rekonsiliasi Gateway [P0]"; ACC-04 "rekonsiliasi bank dan gateway mencapai
// ≥ 99% kecocokan otomatis; setiap selisih menjadi kasus dengan PIC", ACC-05
// "setiap setoran kas tercatat dan dicocokkan dengan mutasi; kas yang belum
// disetor melewati batas hari memicu peringatan"). Runs with the root
// node:test suite, no database: it loads the shared accounting contract, the
// feature's pure helpers and its mock handlers with Node type stripping. The
// screens are exercised in e2e/legend-53q.mock.spec.ts.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  AUTO_MATCH_TARGET_BP,
  autoMatchRateBp,
  cafeLegendAccountingFixtures as fixtures,
  findStatementMatch,
  maskAccountNumber,
  parseBankCsvAmount,
  parseBankCsvDate,
  statementLineDedupeKey,
  transitionReconciliationCase,
  undepositedCashAlerts,
} from "../packages/shared/src/accounting/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
// Registers every handler of the feature and exposes the sample ids.
import { CASH_BANK_MOCK_IDS } from "../apps/web/src/features/ws07-cash-bank/mock.ts";
import * as cash from "../apps/web/src/features/ws07-cash-bank/lib.ts";

const entity = fixtures.legalEntity.id;
const outlet = fixtures.outletId;
const account = fixtures.bankAccount;
const bankGl = account.glAccountId;
const period = { from: "2026-11-01", to: "2026-11-30" };
const linesPath = `/api/accounting/bank-accounts/${account.id}/statement-lines`;
const importPath = `/api/accounting/bank-accounts/${account.id}/statement-imports`;

const ref = (type, id) => ({ type, id });
const line = (matchStatus) => ({ matchStatus });

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
/** Asserts `fn` throws a contract error with `code` and returns that error. */
function throwsWithCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code);
    return error;
  }
  return assert.fail("expected the call to throw");
}

afterEach(resetMocks);

// ---- ACC-04: auto-match target, suggestions and cases ----------------------

describe("ACC-04: matching target and suggestions", () => {
  test("ACC-04: the auto-match target is 99% and the rate counts only lines that need a match", () => {
    assert.equal(AUTO_MATCH_TARGET_BP, 9_900);
    assert.equal(cash.autoMatchTargetReached(9_900), true);
    assert.equal(cash.autoMatchTargetReached(9_899), false);
    assert.equal(cash.autoMatchTargetReached(10_000), true);
    assert.equal(cash.autoMatchTargetPercent(), "99,00%");
    assert.equal(cash.formatBasisPoints(9_900), "99,00%");
    assert.equal(cash.formatBasisPoints(9_899), "98,99%");

    const auto = (count) =>
      Array.from({ length: count }, () => line("auto_matched"));
    const unmatched = (count) =>
      Array.from({ length: count }, () => line("unmatched"));
    assert.equal(autoMatchRateBp([...auto(99), ...unmatched(1)]), 9_900);
    assert.equal(autoMatchRateBp([...auto(98), ...unmatched(2)]), 9_800);
    assert.equal(autoMatchRateBp([...auto(2), ...unmatched(1)]), 6_666);
    assert.equal(autoMatchRateBp([]), 10_000);
    // Excluded lines are out of the denominator (they need no match).
    assert.equal(autoMatchRateBp([...auto(1), line("excluded")]), 10_000);
    assert.equal(
      autoMatchRateBp([
        line("auto_matched"),
        ...unmatched(2),
        line("excluded"),
      ]),
      3_333,
    );
  });

  test("ACC-04: findStatementMatch suggests one candidate and never guesses between two", () => {
    const first = {
      ref: ref("journal_entry", fixtures.entries.internet.id),
      amountIdr: 100_000,
      date: "2026-11-02",
    };
    const second = {
      ref: ref("cash_deposit", fixtures.cashDeposits[0].id),
      amountIdr: 100_000,
      date: "2026-11-03",
    };
    const otherAmount = {
      ref: ref("journal_entry", fixtures.entries.wrongInternet.id),
      amountIdr: 250_000,
      date: "2026-11-02",
    };
    const policy = fixtures.matchingPolicy;
    assert.equal(policy.dateToleranceDays, 2);
    // The screens read the tenant's window from GET finance-policy; the
    // matcher itself always takes the policy as an argument.
    assert.equal("MATCHING_POLICY" in cash, false);

    assert.deepEqual(
      findStatementMatch(
        { amountIdr: 100_000, postedOn: "2026-11-02" },
        [first],
        policy,
      ),
      { kind: "auto", ref: first.ref },
    );
    const ambiguous = findStatementMatch(
      { amountIdr: 100_000, postedOn: "2026-11-02" },
      [first, second],
      policy,
    );
    assert.equal(ambiguous.kind, "ambiguous");
    assert.deepEqual(ambiguous.refs, [first.ref, second.ref]);
    assert.equal(
      findStatementMatch(
        { amountIdr: 100_000, postedOn: "2026-11-06" },
        [first, second],
        policy,
      ).kind,
      "none",
    );
    assert.deepEqual(
      cash.suggestMatch(
        { amountIdr: 250_000, postedOn: "2026-11-03" },
        [otherAmount],
        policy,
      ),
      { kind: "auto", ref: otherAmount.ref },
    );
    assert.equal(
      cash.suggestMatch(
        { amountIdr: 999, postedOn: "2026-11-03" },
        [otherAmount],
        policy,
      ).kind,
      "none",
    );
  });

  test("ACC-04: candidates come from bank journals and deposits, skipping occupied documents", () => {
    assert.equal(
      cash.journalBankAmount(fixtures.entries.gatewaySettlement, bankGl),
      273_075,
    );
    assert.equal(
      cash.journalBankAmount(fixtures.entries.electricityOctober, bankGl),
      -2_350_000,
    );
    // A cash sale posts to cash on hand (1101), not to the bank account.
    assert.equal(
      cash.journalBankAmount(fixtures.entries.cashSale, bankGl),
      null,
    );

    const candidates = cash.matchCandidates(
      fixtures.journals,
      fixtures.cashDeposits,
      account.id,
      bankGl,
      new Set(),
    );
    // A journal is offered as `journal_entry`; the workspace labels the
    // settlement by the journal's source when it renders the match.
    const gateway = candidates.find(
      (row) => row.ref.id === fixtures.entries.gatewaySettlement.id,
    );
    assert.deepEqual(gateway, {
      ref: ref("journal_entry", fixtures.entries.gatewaySettlement.id),
      amountIdr: 273_075,
      date: "2026-11-02",
    });
    const deposit = candidates.find(
      (row) => row.ref.id === fixtures.cashDeposits[0].id,
    );
    assert.deepEqual(deposit, {
      ref: ref("cash_deposit", fixtures.cashDeposits[0].id),
      amountIdr: 137_500,
      date: "2026-11-02",
    });
    assert.ok(
      !candidates.some((row) => row.ref.id === fixtures.entries.cashSale.id),
    );

    const occupied = new Set([
      cash.candidateKey(ref("cash_deposit", fixtures.cashDeposits[0].id)),
    ]);
    const free = cash.matchCandidates(
      fixtures.journals,
      fixtures.cashDeposits,
      account.id,
      bankGl,
      occupied,
    );
    assert.ok(!free.some((row) => row.ref.id === fixtures.cashDeposits[0].id));
    assert.ok(
      free.some((row) => row.ref.id === fixtures.entries.gatewaySettlement.id),
    );

    const used = cash.occupiedRefs(fixtures.statementLines);
    assert.equal(used.size, 3);
    assert.ok(
      used.has(
        cash.candidateKey(
          ref(
            "gateway_settlement",
            fixtures.entries.gatewaySettlement.sourceId,
          ),
        ),
      ),
    );
    const withoutFirst = cash.occupiedRefs(
      fixtures.statementLines,
      fixtures.statementLines[0].id,
    );
    assert.equal(withoutFirst.size, 2);
    assert.ok(
      !withoutFirst.has(
        cash.candidateKey(
          ref(
            "gateway_settlement",
            fixtures.entries.gatewaySettlement.sourceId,
          ),
        ),
      ),
    );
    assert.equal(
      cash.candidateKey(ref("journal_entry", "abc")),
      "journal_entry:abc",
    );
  });

  test("ACC-04: importing a CSV auto-matches a statement line and the summary reports the rate", async () => {
    const csv = [
      "Tanggal;Keterangan;Referensi;Debit;Kredit",
      '01/11/2026;TRANSFER LISTRIK OKTOBER;TRF-OKT-1;"2.350.000,00";',
    ].join("\n");
    const mapping = cash.detectMapping(csv);
    assert.equal(mapping.amount.kind, "debit_credit");

    const created = await post(importPath, {
      fileName: "mutasi-uji.csv",
      csv,
      mapping,
      idempotencyKey: "import-acc04-1",
    });
    assert.equal(created.data.lineCount, 1);
    assert.equal(created.data.duplicateCount, 0);
    assert.equal(created.data.autoMatchedCount, 1);
    assert.equal(created.data.postedFrom, "2026-11-01");

    const replay = await post(importPath, {
      fileName: "mutasi-uji.csv",
      csv,
      mapping,
      idempotencyKey: "import-acc04-1",
    });
    assert.equal(replay.data.id, created.data.id);

    const lines = await get(linesPath, { ...period, limit: 50 });
    assert.equal(lines.data.length, 7);
    const imported = lines.data.find(
      (row) => row.description === "TRANSFER LISTRIK OKTOBER",
    );
    assert.equal(imported.matchStatus, "auto_matched");
    assert.deepEqual(imported.matchedRefs, [
      ref("journal_entry", fixtures.entries.electricityOctober.id),
    ]);

    const summary = await get(
      `/api/accounting/bank-accounts/${account.id}/reconciliation-summary`,
      period,
    );
    assert.equal(summary.data.lineCount, 7);
    assert.equal(summary.data.autoMatchedCount, 3);
    assert.equal(summary.data.manuallyMatchedCount, 1);
    assert.equal(summary.data.unmatchedCount, 2);
    assert.equal(summary.data.inCaseCount, 1);
    assert.equal(summary.data.excludedCount, 0);
    assert.equal(summary.data.autoMatchRateBp, 4_285);
    assert.equal(
      cash.autoMatchTargetReached(summary.data.autoMatchRateBp),
      false,
    );
  });

  test("ACC-04: an unmatched line becomes a reconciliation case with a PIC and resolving it releases the line", async () => {
    const lineId = CASH_BANK_MOCK_IDS.unmatchedFee;
    const created = await post("/api/accounting/reconciliation-cases", {
      legalEntityId: entity,
      outletId: null,
      type: "bank_statement",
      differenceIdr: -23_500,
      ownerId: fixtures.users.finance,
      refs: [ref("bank_statement_line", lineId)],
      idempotencyKey: "open-case-test-0001",
    });
    assert.equal(created.data.status, "open");
    assert.equal(created.data.ownerId, fixtures.users.finance);
    assert.equal(created.data.differenceIdr, -23_500);
    assert.deepEqual(created.data.refs, [ref("bank_statement_line", lineId)]);
    assert.match(created.data.dueAt, /^\d{4}-\d{2}-\d{2}T/);

    const detail = await get(
      `/api/accounting/reconciliation-cases/${created.data.id}`,
    );
    assert.equal(detail.data.id, created.data.id);

    const afterOpen = await get(linesPath, { ...period, limit: 50 });
    const inCase = afterOpen.data.find((row) => row.id === lineId);
    assert.equal(inCase.matchStatus, "in_case");
    assert.equal(inCase.reconciliationCaseId, created.data.id);

    const started = await post(
      `/api/accounting/reconciliation-cases/${created.data.id}/actions`,
      { type: "start" },
    );
    assert.equal(started.data.status, "in_progress");

    const resolved = await post(
      `/api/accounting/reconciliation-cases/${created.data.id}/actions`,
      {
        type: "resolve",
        note: "Biaya admin bank diakui sebagai beban.",
      },
    );
    assert.equal(resolved.data.status, "resolved");
    assert.equal(resolved.data.resolvedBy, fixtures.users.finance);
    assert.equal(
      resolved.data.resolutionNote,
      "Biaya admin bank diakui sebagai beban.",
    );

    const afterResolve = await get(linesPath, { ...period, limit: 50 });
    const released = afterResolve.data.find((row) => row.id === lineId);
    assert.equal(released.matchStatus, "unmatched");
    assert.equal(released.reconciliationCaseId, null);

    // A line that is already matched cannot become a case.
    const matchedLine = fixtures.statementLines[0];
    const refused = await failure(
      post("/api/accounting/reconciliation-cases", {
        legalEntityId: entity,
        outletId: null,
        type: "bank_statement",
        differenceIdr: matchedLine.amountIdr,
        ownerId: fixtures.users.finance,
        refs: [ref("bank_statement_line", matchedLine.id)],
        idempotencyKey: "open-case-test-0002",
      }),
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.code, "INVALID_TRANSITION");
  });

  test("ACC-04: a manual match stores the chosen document and unmatch releases the line", async () => {
    const csv = [
      "Tanggal;Keterangan;Referensi;Debit;Kredit",
      '10/11/2026;TRANSFER UJI MANUAL;TRF-UJI-2;;"137.500,00"',
    ].join("\n");
    const mapping = cash.detectMapping(csv);
    await post(importPath, {
      fileName: "mutasi-manual.csv",
      csv,
      mapping,
      idempotencyKey: "import-acc04-2",
    });
    const before = await get(linesPath, { ...period, limit: 50 });
    const imported = before.data.find(
      (row) => row.description === "TRANSFER UJI MANUAL",
    );
    assert.equal(imported.matchStatus, "unmatched");
    assert.equal(imported.amountIdr, 137_500);

    const wrong = await failure(
      post(`/api/accounting/statement-lines/${imported.id}/match`, {
        refs: [ref("journal_entry", fixtures.entries.internet.id)],
      }),
    );
    assert.equal(wrong.status, 422);
    assert.equal(wrong.code, "MATCH_AMOUNT_MISMATCH");

    const matched = await post(
      `/api/accounting/statement-lines/${imported.id}/match`,
      {
        refs: [ref("journal_entry", fixtures.entries.cashDepositEntry.id)],
      },
    );
    assert.equal(matched.data.matchStatus, "manually_matched");
    assert.deepEqual(matched.data.matchedRefs, [
      ref("journal_entry", fixtures.entries.cashDepositEntry.id),
    ]);

    const unmatched = await post(
      `/api/accounting/statement-lines/${imported.id}/unmatch`,
      { idempotencyKey: "unmatch-acc04-1" },
    );
    assert.equal(unmatched.data.matchStatus, "unmatched");
    assert.deepEqual(unmatched.data.matchedRefs, []);
    const replay = await post(
      `/api/accounting/statement-lines/${imported.id}/unmatch`,
      { idempotencyKey: "unmatch-acc04-1" },
    );
    assert.equal(replay.data.id, imported.id);
  });
});

// ---- ACC-05: cash deposits and undeposited cash ---------------------------

describe("finance policy", () => {
  test("GET finance-policy serves the default tenant policy in mock mode", async () => {
    const response = await get("/api/accounting/finance-policy");
    assert.deepEqual(response.data.matchingPolicy, { dateToleranceDays: 2 });
    assert.deepEqual(response.data.cashDepositPolicy, {
      maxDaysUndeposited: 2,
    });
  });
});

describe("ACC-05: deposits and undeposited cash", () => {
  test("ACC-05: cash undeposited beyond the tenant day limit raises an alert per business date", async () => {
    const policy = fixtures.cashDepositPolicy;
    assert.equal(policy.maxDaysUndeposited, 2);

    // Deposits settle the oldest collected cash first (FIFO per outlet).
    const collections = [
      { outletId: outlet, businessDate: "2026-11-01", cashIdr: 100 },
      { outletId: outlet, businessDate: "2026-11-02", cashIdr: 100 },
    ];
    assert.deepEqual(
      undepositedCashAlerts(
        collections,
        [{ outletId: outlet, amountIdr: 150 }],
        "2026-11-10",
        policy,
      ),
      [
        {
          outletId: outlet,
          businessDate: "2026-11-02",
          undepositedIdr: 50,
          daysOutstanding: 8,
        },
      ],
    );

    // At the limit itself (2 days) there is no alert yet.
    assert.deepEqual(
      undepositedCashAlerts(
        fixtures.cashCollections,
        fixtures.cashDeposits,
        "2026-11-04",
        policy,
      ),
      [],
    );
    assert.deepEqual(
      undepositedCashAlerts(
        fixtures.cashCollections,
        fixtures.cashDeposits,
        "2026-11-05",
        policy,
      ),
      [
        {
          outletId: outlet,
          businessDate: "2026-11-02",
          undepositedIdr: 412_000,
          daysOutstanding: 3,
        },
      ],
    );
    assert.deepEqual(
      undepositedCashAlerts(
        fixtures.cashCollections,
        fixtures.cashDeposits,
        "2026-11-06",
        policy,
      ).map((row) => [
        row.businessDate,
        row.undepositedIdr,
        row.daysOutstanding,
      ]),
      [
        ["2026-11-02", 412_000, 4],
        ["2026-11-03", 386_500, 3],
      ],
    );

    // The mock seeds the 30 October cash without a deposit (ACC-05 warning).
    const mockAlerts = await get("/api/accounting/cash-deposits/alerts", {
      legalEntityId: entity,
      asOf: "2026-11-05",
    });
    assert.equal(mockAlerts.data.length, 3);
    const oldest = mockAlerts.data.find(
      (row) => row.businessDate === "2026-10-30",
    );
    assert.equal(oldest.undepositedIdr, 362_500);
    assert.equal(oldest.daysOutstanding, 6);
    assert.equal(cash.totalUndeposited(mockAlerts.data), 912_000);
  });

  test("ACC-05: a cash deposit is recorded and matched with the one statement line of the same amount", async () => {
    const body = {
      outletId: outlet,
      bankAccountId: account.id,
      amountIdr: 250_000,
      coversFrom: "2026-11-03",
      coversTo: "2026-11-03",
      depositedAt: "2026-11-03T03:30:00.000Z",
      slipReference: "SLIP-UJI-1",
      idempotencyKey: "deposit-acc05-1",
    };
    const created = await post("/api/accounting/cash-deposits", body);
    assert.equal(created.data.status, "matched");
    assert.equal(
      created.data.bankStatementLineId,
      CASH_BANK_MOCK_IDS.depositCandidate,
    );
    assert.equal(created.data.amountIdr, 250_000);
    assert.equal(created.data.journalEntryId, null);
    assert.equal(created.data.slipReference, "SLIP-UJI-1");

    const replay = await post("/api/accounting/cash-deposits", body);
    assert.equal(replay.data.id, created.data.id);

    const lines = await get(linesPath, { ...period, limit: 50 });
    const proof = lines.data.find(
      (row) => row.id === CASH_BANK_MOCK_IDS.depositCandidate,
    );
    assert.equal(proof.matchStatus, "auto_matched");
    assert.deepEqual(proof.matchedRefs, [ref("cash_deposit", created.data.id)]);

    const deposits = await get("/api/accounting/cash-deposits", {
      legalEntityId: entity,
      from: period.from,
      to: period.to,
      limit: 50,
    });
    assert.equal(deposits.data.length, 2);
    assert.ok(deposits.data.some((row) => row.id === created.data.id));

    // No statement line of that amount: the deposit stays recorded, not matched.
    const recorded = await post("/api/accounting/cash-deposits", {
      ...body,
      amountIdr: 111_111,
      slipReference: "SLIP-UJI-2",
      idempotencyKey: "deposit-acc05-2",
    });
    assert.equal(recorded.data.status, "recorded");
    assert.equal(recorded.data.bankStatementLineId, null);
  });
});

// ---- CSV import helpers ----------------------------------------------------

describe("CSV import helpers", () => {
  test("CSV: rows, delimiter and column count handle quotes, escaped quotes, CRLF and tabs", () => {
    const rows = cash.parseCsvRows(
      'Tanggal,Keterangan\r\n"01/11/2026","Setoran ""tunai"", BDG-01"\r\n\r\n',
      ",",
    );
    assert.deepEqual(rows, [
      ["Tanggal", "Keterangan"],
      ["01/11/2026", 'Setoran "tunai", BDG-01'],
    ]);
    assert.deepEqual(cash.parseCsvRows("a\tb\n1\t2", "\t"), [
      ["a", "b"],
      ["1", "2"],
    ]);
    assert.deepEqual(cash.parseCsvRows("", ","), []);

    assert.equal(cash.detectDelimiter("a;b;c\n1;2;3"), ";");
    assert.equal(cash.detectDelimiter("a\tb\tc"), "\t");
    assert.equal(cash.detectDelimiter("a,b,c"), ",");
    assert.equal(cash.detectDelimiter("single"), ",");
    assert.equal(cash.csvColumnCount("a,b\n1,2,3", ","), 3);
    assert.equal(cash.csvColumnCount("", ","), 0);
  });

  test("CSV: detectMapping reads headers, signed amounts and debit/credit exports", () => {
    const debitCredit = cash.detectMapping(
      'Tanggal,Keterangan,Referensi,Debit,Kredit\n01/11/2026,Setoran,SLIP-1,,"250.000,00"\n',
    );
    assert.equal(debitCredit.hasHeader, true);
    assert.equal(debitCredit.delimiter, ",");
    assert.equal(debitCredit.dateColumn, 0);
    assert.equal(debitCredit.descriptionColumn, 1);
    assert.equal(debitCredit.referenceColumn, 2);
    assert.deepEqual(debitCredit.amount, {
      kind: "debit_credit",
      debitColumn: 3,
      creditColumn: 4,
    });
    assert.equal(debitCredit.dateFormat, "DD/MM/YYYY");
    assert.equal(debitCredit.decimalSeparator, ",");

    const signed = cash.detectMapping(
      "Date,Description,Amount\n2026-11-03,BIAYA,-15000.00\n",
    );
    assert.equal(signed.hasHeader, true);
    assert.equal(signed.dateFormat, "YYYY-MM-DD");
    assert.deepEqual(signed.amount, { kind: "signed", column: 2 });
    assert.equal(signed.decimalSeparator, ".");
    assert.equal(signed.referenceColumn, null);

    const noHeader = cash.detectMapping(
      "01/11/2026,Setoran kas,250000\n02/11/2026,BIAYA,-15000\n",
    );
    assert.equal(noHeader.hasHeader, false);
    assert.equal(noHeader.dateColumn, 0);
    assert.equal(noHeader.descriptionColumn, 1);
    assert.deepEqual(noHeader.amount, { kind: "signed", column: 2 });
    assert.equal(noHeader.referenceColumn, null);

    assert.deepEqual(cash.defaultCsvMapping(), {
      hasHeader: true,
      delimiter: ",",
      dateColumn: 0,
      dateFormat: "DD/MM/YYYY",
      descriptionColumn: 1,
      amount: { kind: "signed", column: 2 },
      decimalSeparator: ",",
      referenceColumn: null,
    });
  });

  test("CSV: buildImportPreview marks ready, duplicate and every row error", () => {
    const mapping = cash.defaultCsvMapping();
    const csv = [
      "Tanggal,Keterangan,Nominal",
      "01/11/2026,Setoran kas,250000",
      "02/11/2026,BIAYA ADM,-15000",
      "02/11/2026,BIAYA ADM,-15000",
    ].join("\n");
    const preview = cash.buildImportPreview(csv, mapping);
    assert.equal(preview.readyCount, 3);
    assert.equal(preview.duplicateCount, 0);
    assert.equal(preview.errorCount, 0);
    assert.deepEqual(
      preview.rows.map((row) => row.amountIdr),
      [250_000, -15_000, -15_000],
    );
    assert.equal(preview.rows[0].rowNumber, 2);
    assert.equal(preview.rows[0].postedOn, "2026-11-01");
    // Two identical fees on one day are two real rows (occurrence).
    assert.notEqual(preview.rows[1].dedupeKey, preview.rows[2].dedupeKey);

    const duplicate = cash.buildImportPreview(csv, mapping, [
      preview.rows[0].dedupeKey,
    ]);
    assert.equal(duplicate.duplicateCount, 1);
    assert.equal(duplicate.rows[0].status, "duplicate");
    assert.equal(duplicate.rows[1].status, "ready");

    const errors = cash.buildImportPreview(
      [
        "Tanggal,Keterangan,Nominal",
        "31/02/2026,Bad date,250000",
        "01/11/2026,,250000",
        "01/11/2026,Zero,0",
        "01/11/2026,Unreadable,abc",
        "01/11/2026,Short",
      ].join("\n"),
      mapping,
    );
    assert.equal(errors.errorCount, 5);
    assert.deepEqual(
      errors.rows.map((row) => row.errorCode),
      ["date", "description", "amount", "amount", "columns"],
    );
    assert.ok(errors.rows.every((row) => row.status === "error"));

    const debitCreditMapping = {
      ...mapping,
      amount: { kind: "debit_credit", debitColumn: 2, creditColumn: 3 },
    };
    const debitCredit = cash.buildImportPreview(
      [
        "Tanggal,Keterangan,Debit,Kredit",
        "01/11/2026,Keduanya,1000,2000",
        "01/11/2026,Kosong,,",
        "01/11/2026,Keluar,15000,",
        "01/11/2026,Masuk,,25000",
      ].join("\n"),
      debitCreditMapping,
    );
    assert.deepEqual(
      debitCredit.rows.map((row) => row.errorCode),
      ["debit_credit", "amount", null, null],
    );
    assert.deepEqual(
      debitCredit.rows.slice(2).map((row) => row.amountIdr),
      [-15_000, 25_000],
    );
    assert.equal(debitCredit.readyCount, 2);

    const reference = cash.buildImportPreview(
      `Tanggal,Keterangan,Nominal,Referensi\n01/11/2026,Ref panjang,250000,${"R".repeat(101)}`,
      { ...mapping, referenceColumn: 3 },
    );
    assert.equal(reference.rows[0].errorCode, "reference");
    const referenceOk = cash.buildImportPreview(
      "Tanggal,Keterangan,Nominal,Referensi\n01/11/2026,Ref pendek,250000,REF-1",
      { ...mapping, referenceColumn: 3 },
    );
    assert.equal(referenceOk.rows[0].externalRef, "REF-1");
    assert.equal(referenceOk.rows[0].status, "ready");

    assert.equal(cash.MAX_IMPORT_CSV_CHARS, 90_000);
    assert.equal(cash.CSV_COLUMN_LIMIT, 50);
    assert.deepEqual(cash.IMPORT_ROW_ERROR_KEYS, {
      columns: "accounting.cash.import.preview.errorColumns",
      date: "accounting.cash.import.preview.errorDate",
      amount: "accounting.cash.import.preview.errorAmount",
      debit_credit: "accounting.cash.import.preview.errorDebitCredit",
      description: "accounting.cash.import.preview.errorDescription",
      reference: "accounting.cash.import.preview.errorReference",
      dedupe_key: "accounting.cash.import.preview.errorDedupeKey",
    });
  });

  test("CSV: preview refuses a row whose dedupe key passes the server limit", () => {
    const mapping = cash.defaultCsvMapping();
    assert.equal(cash.MAX_DEDUPE_KEY_LENGTH, 400);
    // "ß".toUpperCase() is "SS": 250 characters become 500 in the key.
    const long = cash.buildImportPreview(
      [
        "Tanggal,Keterangan,Nominal",
        `01/11/2026,${"ß".repeat(250)},250000`,
        "01/11/2026,Setoran kas,250000",
      ].join("\n"),
      mapping,
    );
    assert.equal(long.rows[0].status, "error");
    assert.equal(long.rows[0].errorCode, "dedupe_key");
    assert.equal(long.rows[1].status, "ready");
    assert.equal(long.readyCount, 1);
    assert.equal(long.errorCount, 1);
  });

  test("open case: one idempotency key per dialog session", () => {
    let n = 0;
    const session = cash.createIdempotencyKeySession(() => `key-${(n += 1)}`);
    const first = session.current();
    // A resend from the same dialog (failed or slow first attempt) reuses it.
    assert.equal(session.current(), first);
    // Success or close ends the session; the next dialog gets a new key.
    session.reset();
    assert.notEqual(session.current(), first);
    // The default factory mints real, distinct ULIDs.
    const real = cash.createIdempotencyKeySession();
    const a = real.current();
    assert.equal(real.current(), a);
    real.reset();
    assert.notEqual(real.current(), a);
  });

  test("open case: a changed request gets its own key; going back reuses the first", () => {
    let n = 0;
    const session = cash.createIdempotencyKeySession(() => `key-${(n += 1)}`);
    const ownerA = session.current(JSON.stringify({ ownerId: "a" }));
    assert.equal(session.current(JSON.stringify({ ownerId: "a" })), ownerA);
    // Another PIC after a failed submit: the server would refuse the old key
    // for a different body, so the new body gets a new key.
    const ownerB = session.current(JSON.stringify({ ownerId: "b" }));
    assert.notEqual(ownerB, ownerA);
    // Back to the first PIC (its request may have reached the server): reuse.
    assert.equal(session.current(JSON.stringify({ ownerId: "a" })), ownerA);
    session.reset();
    assert.notEqual(session.current(JSON.stringify({ ownerId: "a" })), ownerA);
  });

  test("CSV: the contract parsers refuse impossible dates and fractional rupiah", () => {
    assert.equal(parseBankCsvAmount("1.250.000,00", ","), 1_250_000);
    assert.equal(parseBankCsvAmount("Rp 15.000", ","), 15_000);
    assert.equal(parseBankCsvAmount("(15.000,00)", ","), -15_000);
    assert.equal(parseBankCsvAmount("-15.000,00", ","), -15_000);
    assert.equal(parseBankCsvAmount("15,000.00", "."), 15_000);
    for (const [text, separator] of [
      ["15.000,50", ","],
      ["abc", ","],
      ["", ","],
    ]) {
      throwsWithCode(
        () => parseBankCsvAmount(text, separator),
        "STATEMENT_VALUE_INVALID",
      );
    }

    assert.equal(parseBankCsvDate("03/11/2026", "DD/MM/YYYY"), "2026-11-03");
    assert.equal(parseBankCsvDate("03-11-2026", "DD-MM-YYYY"), "2026-11-03");
    assert.equal(parseBankCsvDate("2026-11-03", "YYYY-MM-DD"), "2026-11-03");
    throwsWithCode(
      () => parseBankCsvDate("31/02/2026", "DD/MM/YYYY"),
      "STATEMENT_VALUE_INVALID",
    );
  });

  test("CSV: parseBankCsvAmount grammar table (valid and ambiguous input)", () => {
    // [text, separator, whole rupiah]
    const valid = [
      ["1.234.567,00", ",", 1_234_567],
      ["1234567,0", ",", 1_234_567],
      ["(1.234,00)", ",", -1_234],
      ["Rp 1.000", ",", 1_000],
      ["-0,00", ",", 0],
      ["1.234,00", ",", 1_234],
      ["1,234,567.00", ".", 1_234_567],
      ["1.234", ",", 1_234],
      ["( 1.000 )", ",", -1_000],
      ["-Rp 1.000", ",", -1_000],
      ["Rp -1.000", ",", -1_000],
      ["rp1.000", ",", 1_000],
    ];
    for (const [text, separator, expected] of valid) {
      assert.equal(parseBankCsvAmount(text, separator), expected, text);
    }
    // Misplaced groups, 3+ decimals, non-zero fraction, mixed separators,
    // dangling or leading separator, empty.
    const invalid = [
      ["1.2.3", ","],
      ["12.34.567", ","],
      ["12..3", ","],
      ["1.234,567", ","],
      ["1.234,000", ","],
      ["1.234,50", ","],
      ["1234567,5", ","],
      ["1,234,56", ","],
      ["1,234.56", ","],
      ["1,", ","],
      [",5", ","],
      ["", ","],
      // "1.234" with "." is a 3-digit fraction, never thousands.
      ["1.234", "."],
      // Double sign, spaces or "Rp" inside the number (misread columns).
      ["(-1.000)", ","],
      ["-(1.000)", ","],
      ["--1.000", ","],
      ["12 34", ","],
      ["1 2 3", ","],
      ["100 200", ","],
      ["1Rp000", ","],
      ["1.000 Rp", ","],
    ];
    for (const [text, separator] of invalid) {
      throwsWithCode(
        () => parseBankCsvAmount(text, separator),
        "STATEMENT_VALUE_INVALID",
      );
    }
  });

  test("CSV: statementLineDedupeKey normalizes the description and keeps occurrences apart", () => {
    const base = {
      postedOn: "2026-11-02",
      amountIdr: 15_000,
      description: "Biaya  adm",
      externalRef: null,
      occurrence: 1,
    };
    const key = statementLineDedupeKey(base);
    assert.equal(
      key,
      statementLineDedupeKey({ ...base, description: "BIAYA ADM" }),
    );
    assert.notEqual(key, statementLineDedupeKey({ ...base, occurrence: 2 }));
    assert.notEqual(
      key,
      statementLineDedupeKey({ ...base, externalRef: "REF-1" }),
    );
    assert.equal(key, "2026-11-02|15000|BIAYA ADM||1");
  });
});

// ---- Display helpers -------------------------------------------------------

describe("display helpers", () => {
  test("dates: business date, month range and display formats", () => {
    assert.equal(
      cash.businessDateToday(
        new Date("2026-11-03T10:00:00.000Z"),
        "Asia/Jakarta",
      ),
      "2026-11-03",
    );
    assert.equal(
      cash.businessDateToday(
        new Date("2026-11-03T18:00:00.000Z"),
        "Asia/Jakarta",
      ),
      "2026-11-04",
    );
    assert.equal(cash.DEFAULT_OUTLET_TIME_ZONE, "Asia/Jakarta");
    assert.deepEqual(cash.monthRange("2026-11-03"), {
      from: "2026-11-01",
      to: "2026-11-30",
    });
    assert.deepEqual(cash.monthRange("2024-02-10"), {
      from: "2024-02-01",
      to: "2024-02-29",
    });
    assert.equal(cash.formatBusinessDate("2026-11-03"), "3 Nov 2026");
    assert.equal(
      cash.formatDateTime("2026-11-03T03:00:00.000Z"),
      "3 Nov 2026, 10.00",
    );
    assert.equal(
      cash.shortId("b1000000-0000-4000-8000-000000000001"),
      "b1000000",
    );
  });

  test("totals: undeposited cash, open cases, pending lines and deposit totals", () => {
    assert.equal(
      cash.totalUndeposited([
        { undepositedIdr: 1_000 },
        { undepositedIdr: 250 },
      ]),
      1_250,
    );
    const cases = [
      { status: "open", differenceIdr: -15_000 },
      { status: "in_progress", differenceIdr: 5_000 },
      { status: "resolved", differenceIdr: 999 },
      { status: "written_off", differenceIdr: 111 },
    ];
    assert.deepEqual(
      cash.openCases(cases).map((row) => row.status),
      ["open", "in_progress"],
    );
    assert.equal(cash.totalOpenDifference(cases), 20_000);
    assert.equal(
      cash.totalOpenDifference(fixtures.reconciliationCases),
      15_000,
    );
    assert.equal(
      cash.pendingMatchCount({ unmatchedCount: 2, inCaseCount: 1 }),
      3,
    );
    assert.equal(
      cash.totalDeposits([{ amountIdr: 137_500 }, { amountIdr: 250_000 }]),
      387_500,
    );
  });

  test("settlement rows split gross, each fee and the net received in the bank", () => {
    const rows = cash.settlementRows(
      fixtures.journals,
      fixtures.statementLines,
      bankGl,
    );
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.journalEntryId, fixtures.entries.gatewaySettlement.id);
    assert.equal(row.settlementId, fixtures.entries.gatewaySettlement.sourceId);
    assert.equal(row.grossIdr, 275_000);
    assert.equal(row.netIdr, 273_075);
    assert.equal(row.feeLines.length, 1);
    assert.equal(row.feeLines[0].amountIdr, 1_925);
    assert.equal(row.statementLine?.id, fixtures.statementLines[0].id);
    assert.equal(row.matchedAmountIdr, 273_075);
    assert.equal(row.varianceIdr, 0);
  });

  test("gateway settlement recon mock returns the same gross, fee and net as settlementRows", async () => {
    const result = await get("/api/accounting/gateway-settlement-recon", {
      legalEntityId: entity,
      bankAccountId: account.id,
      ...period,
    });
    assert.equal(result.data.truncated, false);
    assert.equal(result.data.rows.length, 1);
    const [row] = result.data.rows;
    assert.equal(row.journalId, fixtures.entries.gatewaySettlement.id);
    assert.equal(row.settlementId, fixtures.entries.gatewaySettlement.sourceId);
    assert.equal(row.grossIdr, 275_000);
    assert.equal(row.netIdr, 273_075);
    assert.equal(row.feeIdr, 1_925);
    assert.equal(row.fees.length, 1);
    assert.equal(row.statementLineId, fixtures.statementLines[0].id);
    assert.equal(row.matchedAmountIdr, 273_075);
    assert.equal(row.varianceIdr, 0);
  });

  test("case actions and catalog keys follow the contract state machine", () => {
    assert.deepEqual(cash.reconciliationCaseActions("open"), [
      "start",
      "reassign",
      "resolve",
    ]);
    assert.deepEqual(cash.reconciliationCaseActions("in_progress"), [
      "reassign",
      "resolve",
    ]);
    assert.deepEqual(cash.reconciliationCaseActions("resolved"), []);
    assert.deepEqual(cash.reconciliationCaseActions("written_off"), []);

    assert.equal(
      transitionReconciliationCase(
        { status: "open" },
        { type: "start", actorId: fixtures.users.finance },
      ),
      "in_progress",
    );
    assert.equal(
      transitionReconciliationCase(
        { status: "open" },
        {
          type: "resolve",
          actorId: fixtures.users.finance,
          note: "Selesai",
        },
      ),
      "resolved",
    );
    assert.throws(
      () =>
        transitionReconciliationCase(
          { status: "resolved" },
          { type: "start", actorId: fixtures.users.finance },
        ),
      (error) => error.code === "INVALID_TRANSITION",
    );

    assert.deepEqual(cash.MATCH_STATUS_KEYS, {
      unmatched: "accounting.cash.match.status.unmatched",
      auto_matched: "accounting.cash.match.status.auto_matched",
      manually_matched: "accounting.cash.match.status.manually_matched",
      in_case: "accounting.cash.match.status.in_case",
      excluded: "accounting.cash.match.status.excluded",
    });
    assert.deepEqual(cash.MATCH_STATUS_TONES, {
      unmatched: "warning",
      auto_matched: "success",
      manually_matched: "info",
      in_case: "warning",
      excluded: "neutral",
    });
    assert.deepEqual(cash.DEPOSIT_STATUS_KEYS, {
      recorded: "accounting.cash.deposits.status.recorded",
      matched: "accounting.cash.deposits.status.matched",
      discrepancy: "accounting.cash.deposits.status.discrepancy",
    });
    assert.deepEqual(cash.DEPOSIT_STATUS_TONES, {
      recorded: "info",
      matched: "success",
      discrepancy: "danger",
    });
    assert.deepEqual(cash.CASE_STATUS_KEYS, {
      open: "accounting.cash.recon.status.open",
      in_progress: "accounting.cash.recon.status.in_progress",
      resolved: "accounting.cash.recon.status.resolved",
      written_off: "accounting.cash.recon.status.written_off",
    });
    assert.deepEqual(cash.CASE_STATUS_TONES, {
      open: "warning",
      in_progress: "info",
      resolved: "success",
      written_off: "neutral",
    });
    assert.deepEqual(cash.CASE_TYPE_KEYS, {
      bank_statement: "accounting.cash.recon.type.bank_statement",
      gateway_settlement: "accounting.cash.recon.type.gateway_settlement",
      edc_settlement: "accounting.cash.recon.type.edc_settlement",
      cash_deposit: "accounting.cash.recon.type.cash_deposit",
    });
    assert.deepEqual(cash.REF_TYPE_KEYS, {
      journal_entry: "accounting.cash.match.ref.journal_entry",
      cash_deposit: "accounting.cash.match.ref.cash_deposit",
      gateway_settlement: "accounting.cash.match.ref.gateway_settlement",
      edc_settlement: "accounting.cash.match.ref.edc_settlement",
      supplier_payment: "accounting.cash.match.ref.supplier_payment",
      bank_statement_line: "accounting.cash.match.ref.bank_statement_line",
    });
  });

  test("contract refusals map to the sentence shown next to the action", () => {
    assert.equal(
      cash.matchErrorKey("STATEMENT_LINE_ALREADY_MATCHED"),
      "accounting.cash.match.error.alreadyMatched",
    );
    assert.equal(
      cash.matchErrorKey("CONFLICT"),
      "accounting.cash.match.error.alreadyMatched",
    );
    assert.equal(
      cash.importErrorKey("CONFLICT"),
      "accounting.cash.import.error.conflict",
    );
    assert.equal(
      cash.importErrorKey("SOMETHING_ELSE"),
      "accounting.cash.import.failed",
    );
    assert.equal(cash.isStatementValueInvalid("STATEMENT_VALUE_INVALID"), true);
    assert.equal(cash.isStatementValueInvalid("CONFLICT"), false);
    assert.equal(
      cash.matchErrorKey("MATCH_AMOUNT_MISMATCH"),
      "accounting.cash.match.error.amountMismatch",
    );
    assert.equal(
      cash.matchErrorKey("INVALID_TRANSITION"),
      "accounting.cash.match.error.invalid",
    );
    assert.equal(
      cash.matchErrorKey("NOT_FOUND"),
      "accounting.cash.match.error.notFound",
    );
    assert.equal(
      cash.matchErrorKey("SOMETHING_ELSE"),
      "accounting.cash.match.error.failed",
    );
    assert.equal(
      cash.caseErrorKey("INVALID_TRANSITION"),
      "accounting.cash.recon.drawer.invalidTransition",
    );
    assert.equal(
      cash.caseErrorKey("NOT_FOUND"),
      "accounting.cash.recon.drawer.error",
    );
    assert.equal(
      cash.caseErrorKey("SOMETHING_ELSE"),
      "accounting.cash.recon.drawer.failed",
    );
  });

  test("bank accounts list masks the number and sorts by bank", async () => {
    assert.equal(maskAccountNumber("1234567890"), "****7890");
    assert.throws(() => maskAccountNumber("12ab"), RangeError);

    const accounts = await get(
      `/api/accounting/legal-entities/${entity}/bank-accounts`,
    );
    assert.equal(accounts.data.length, 2);
    assert.deepEqual(
      accounts.data.map((row) => row.bank),
      ["BCA", "Mandiri"],
    );
    assert.equal(accounts.data[0].id, account.id);
    assert.equal(accounts.data[0].accountNumberMasked, "****4821");
  });
});

// ---- legend-4961: cash in/out, transfers and petty cash --------------------

describe("legend-4961: cash in/out, transfers and petty cash (mock)", () => {
  const entriesPath = "/api/accounting/cash-bank/entries";
  const fundsPath = "/api/accounting/petty-cash/funds";
  const pettyEntriesPath = "/api/accounting/petty-cash/entries";
  const movementsPath = "/api/accounting/petty-cash/movements";
  const second = CASH_BANK_MOCK_IDS.secondBankAccount;
  const today = cash.businessDateToday();
  const range = cash.monthRange(today);
  const counter = fixtures.accounts.find((row) => row.type === "revenue");

  const transfer = (overrides = {}) => ({
    kind: "transfer",
    legalEntityId: entity,
    fromBankAccountId: account.id,
    toBankAccountId: second,
    amountIdr: 750_000,
    entryDate: today,
    description: "Pindah dana",
    reference: null,
    idempotencyKey: "k-transfer-0001",
    ...overrides,
  });
  const listEntries = () =>
    get(entriesPath, { legalEntityId: entity, ...range, limit: 50 });
  const outletFund = async () =>
    (await get(fundsPath, { legalEntityId: entity })).data.find(
      (fund) => fund.outletId === outlet,
    );
  const movement = (kind, amountIdr, idempotencyKey) => ({
    kind,
    outletId: outlet,
    bankAccountId: account.id,
    amountIdr,
    description: "Uji kas kecil",
    idempotencyKey,
  });

  test("a transfer is recorded once: the same key replays, another body is refused", async () => {
    const before = (await listEntries()).data.length;
    const first = await post(entriesPath, transfer());
    const again = await post(entriesPath, transfer());
    assert.equal(again.data.id, first.data.id);
    assert.equal(first.data.kind, "transfer");
    assert.equal(first.data.counterAccountId, null);
    assert.equal((await listEntries()).data.length, before + 1);
    const reused = await failure(
      post(entriesPath, transfer({ amountIdr: 750_001 })),
    );
    assert.equal(reused.status, 409);
    assert.equal(reused.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal((await listEntries()).data.length, before + 1);
  });

  test("a transfer needs two different accounts and a counter account is never cash or bank", async () => {
    const same = await failure(
      post(entriesPath, transfer({ toBankAccountId: account.id })),
    );
    assert.ok(same.status >= 400 && same.status < 500);
    const cashCounter = fixtures.accounts.find(
      (row) => row.reportGroup === "cash_and_equivalents" && row.id !== bankGl,
    );
    const refused = await failure(
      post(entriesPath, {
        kind: "cash_out",
        legalEntityId: entity,
        bankAccountId: account.id,
        counterAccountId: cashCounter.id,
        amountIdr: 10_000,
        entryDate: today,
        description: "Salah akun",
        reference: null,
        idempotencyKey: "k-cashout-0001",
      }),
    );
    assert.equal(refused.code, "CASH_BANK_COUNTER_ACCOUNT_INVALID");
    assert.deepEqual(
      cash
        .counterAccountChoices(fixtures.accounts)
        .filter((row) => row.reportGroup === "cash_and_equivalents"),
      [],
    );
  });

  test("cash in names a counter account and cannot be dated in the future", async () => {
    const created = await post(entriesPath, {
      kind: "cash_in",
      legalEntityId: entity,
      bankAccountId: account.id,
      counterAccountId: counter.id,
      amountIdr: 125_000,
      entryDate: today,
      description: "Uang masuk",
      reference: "REF-1",
      idempotencyKey: "k-cashin-0001",
    });
    assert.equal(created.data.counterAccountId, counter.id);
    assert.equal(created.data.toBankAccountId, null);
    const future = await failure(
      post(entriesPath, {
        kind: "cash_in",
        legalEntityId: entity,
        bankAccountId: account.id,
        counterAccountId: counter.id,
        amountIdr: 125_000,
        entryDate: "2099-01-01",
        description: "Masa depan",
        reference: null,
        idempotencyKey: "k-cashin-0002",
      }),
    );
    assert.equal(future.status, 422);
  });

  test("petty cash never goes below zero and a refused return leaves balance and ledger untouched", async () => {
    const fund = await outletFund();
    const ledgerBefore = (
      await get(pettyEntriesPath, { outletId: outlet, ...range, limit: 50 })
    ).data.length;
    const refused = await failure(
      post(
        movementsPath,
        movement("return", fund.balanceIdr + 1, "k-return-0001"),
      ),
    );
    assert.equal(refused.status, 422);
    assert.equal(refused.code, "PETTY_CASH_INSUFFICIENT");
    assert.equal((await outletFund()).balanceIdr, fund.balanceIdr);
    assert.equal(
      (await get(pettyEntriesPath, { outletId: outlet, ...range, limit: 50 }))
        .data.length,
      ledgerBefore,
    );
    assert.equal(cash.pettyReturnExceedsBalance("return", 101, 100), true);
    assert.equal(cash.pettyReturnExceedsBalance("return", 100, 100), false);
    assert.equal(cash.pettyReturnExceedsBalance("topup", 101, 100), false);
  });

  test("petty cash balance equals top-ups minus returns minus purchases, and a resend replays", async () => {
    const start = (await outletFund()).balanceIdr;
    const topup = await post(
      movementsPath,
      movement("topup", 300_000, "k-topup-0001"),
    );
    const replay = await post(
      movementsPath,
      movement("topup", 300_000, "k-topup-0001"),
    );
    assert.equal(replay.data.id, topup.data.id);
    await post(movementsPath, movement("return", 100_000, "k-return-0002"));
    const fund = await outletFund();
    assert.equal(fund.balanceIdr, start + 300_000 - 100_000);
    const ledger = (
      await get(pettyEntriesPath, { outletId: outlet, ...range, limit: 50 })
    ).data;
    const signed = ledger.reduce(
      (sum, row) =>
        sum + (row.kind === "topup" ? row.amountIdr : -row.amountIdr),
      0,
    );
    assert.equal(fund.balanceIdr, signed);
    assert.equal(
      ledger.find((row) => row.id === topup.data.id).balanceAfterIdr,
      start + 300_000,
    );
    const reused = await failure(
      post(movementsPath, movement("topup", 300_001, "k-topup-0001")),
    );
    assert.equal(reused.code, "IDEMPOTENCY_KEY_REUSED");
  });

  test("a parked petty cash journal posts once on retry and a posted entry comes back as it is", async () => {
    const ledger = (
      await get(pettyEntriesPath, { outletId: outlet, ...range, limit: 50 })
    ).data;
    const parked = ledger.find((row) => row.journalStatus === "parked");
    assert.equal(parked.parkCode, "ACCOUNT_MAPPING_MISSING");
    assert.equal(parked.journalEntryId, null);
    const retryPath = `${pettyEntriesPath}/${parked.id}/post`;
    const posted = await post(retryPath, {});
    assert.equal(posted.data.journalStatus, "posted");
    assert.notEqual(posted.data.journalEntryId, null);
    const again = await post(retryPath, {});
    assert.equal(again.data.journalEntryId, posted.data.journalEntryId);
    const missing = await failure(
      post(`${pettyEntriesPath}/b9999999-0000-4000-8000-000000000000/post`, {}),
    );
    assert.equal(missing.status, 404);
  });
  test("refused money requests map to a sentence, unknown codes fall back to the server text", () => {
    assert.equal(
      cash.moneyErrorKey("PETTY_CASH_INSUFFICIENT"),
      "accounting.cash.moneyError.insufficient",
    );
    assert.equal(
      cash.moneyErrorKey("CASH_BANK_COUNTER_ACCOUNT_INVALID"),
      "accounting.cash.moneyError.counterInvalid",
    );
    assert.equal(
      cash.moneyErrorKey("IDEMPOTENCY_KEY_REUSED"),
      "accounting.cash.moneyError.keyReused",
    );
    assert.equal(
      cash.moneyErrorKey("ACCOUNT_MAPPING_MISSING"),
      "accounting.cash.moneyError.mappingMissing",
    );
    assert.equal(
      cash.moneyErrorKey("PERIOD_CLOSED"),
      "accounting.cash.moneyError.periodClosed",
    );
    assert.equal(
      cash.moneyErrorKey("CASH_OUT_CHAIN_OPEN"),
      "accounting.cash.moneyError.chainOpen",
    );
    assert.equal(
      cash.moneyErrorKey("CASH_OUT_CHAIN_MISSING"),
      "accounting.cash.moneyError.chainMissing",
    );
    assert.equal(cash.moneyErrorKey("SOMETHING_ELSE"), null);
    assert.equal(cash.formatMonthLabel("2026-11-13"), "November 2026");
  });
});
