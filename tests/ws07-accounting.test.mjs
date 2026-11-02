// WS-07 accounting back office data layer (bead legend-mzg; PRD v1.7 §3.19
// "Chart of Accounts", "Jurnal Otomatis", "Jurnal Manual & Berulang";
// ACC-01 "Setiap jurnal selalu seimbang; jurnal final tidak dapat dihapus dan
// koreksi dilakukan melalui jurnal pembalik", ACC-03 "Laba rugi per outlet dan
// per badan usaha dapat diturunkan sampai ke transaksi sumber").
//
// Runs with the root node:test suite, no database: it loads the shared
// accounting contract, the web app's mock runtime, the feature's mock handlers
// and its pure helpers with Node type stripping. The screens themselves are
// exercised in e2e/legend-mzg.mock.spec.ts.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
// Registers every handler of the feature.
import "../apps/web/src/features/ws07-accounting/mock.ts";
import * as accounting from "../apps/web/src/features/ws07-accounting/lib.ts";
import { cafeLegendAccountingFixtures as fixtures } from "../packages/shared/src/accounting/fixtures.ts";

const entity = fixtures.legalEntity.id;
const account = (code) => fixtures.accountByCode(code).id;
/** Deterministic valid ULID for idempotency keys (26 Crockford chars). */
const ulid = (n) => `01JBQ9A2B3C4D5E6F7G8H9${String(n).padStart(6, "0")}`;
const line = (code, debitIdr, creditIdr = 0) => ({
  accountId: account(code),
  debitIdr,
  creditIdr,
  outletId: null,
  costCenter: null,
});

async function get(path, query) {
  return dispatchMock({ method: "GET", path, query });
}
async function post(path, body) {
  return dispatchMock({ method: "POST", path, body });
}
async function patch(path, body) {
  return dispatchMock({ method: "PATCH", path, body });
}
function failure(promise) {
  return promise.then(
    () => assert.fail("expected the call to fail"),
    (error) => error,
  );
}

const journalsPath = "/api/accounting/journals";
const manualPath = "/api/accounting/manual-journals";
const recurringPath = "/api/accounting/recurring-journals";
const accountsPath = `/api/accounting/legal-entities/${entity}/accounts`;

afterEach(resetMocks);

// ---- ACC-01: balance and the line editor ---------------------------------

describe("ACC-01 balanced entries", () => {
  test("ACC-01: the line editor accepts only one side per row and whole rupiah", () => {
    const balanced = accounting.evaluateManualDraft([
      { accountId: account("6109"), debit: "1.520.000", credit: "" },
      { accountId: account("1103"), debit: "", credit: "1520000" },
    ]);
    assert.equal(balanced.balanced, true);
    assert.equal(balanced.debitIdr, 1_520_000);
    assert.equal(balanced.creditIdr, 1_520_000);
    assert.equal(balanced.lines.length, 2);

    const bothSides = accounting.evaluateManualDraft([
      { accountId: account("6109"), debit: "1000", credit: "1000" },
      { accountId: account("1103"), debit: "", credit: "1000" },
    ]);
    assert.equal(bothSides.balanced, false);
    assert.equal(bothSides.lineIssues[0], "side");

    const noAccount = accounting.evaluateManualDraft([
      { accountId: "", debit: "1000", credit: "" },
      { accountId: account("1103"), debit: "", credit: "1000" },
    ]);
    assert.equal(noAccount.lineIssues[0], "account");

    const fractional = accounting.evaluateManualDraft([
      { accountId: account("6109"), debit: "1000,50", credit: "" },
      { accountId: account("1103"), debit: "", credit: "1000" },
    ]);
    assert.equal(fractional.lineIssues[0], "amount");

    const singleRow = accounting.evaluateManualDraft([
      { accountId: account("6109"), debit: "1000", credit: "" },
      { accountId: "", debit: "", credit: "" },
    ]);
    assert.equal(singleRow.balanced, false);
    assert.equal(singleRow.filled, 1);

    assert.equal(accounting.parseRupiahInput("1.520.000"), 1_520_000);
    assert.equal(accounting.parseRupiahInput(""), 0);
    assert.equal(accounting.parseRupiahInput("12,5"), null);
  });

  test("ACC-01: an unbalanced manual journal is rejected before it is stored", async () => {
    const error = await failure(
      post(manualPath, {
        legalEntityId: entity,
        outletId: null,
        entryDate: "2026-11-02",
        kind: "general",
        description: "Tidak seimbang",
        lines: [line("6109", 1000), line("1103", 0, 500)],
        idempotencyKey: ulid(90),
      }),
    );
    assert.equal(error.status, 400);
    assert.equal(error.code, "VALIDATION_ERROR");
  });

  test("ACC-01: approval posts a balanced entry; the draft alone posts nothing", async () => {
    const created = await post(manualPath, {
      legalEntityId: entity,
      outletId: null,
      entryDate: "2026-11-02",
      kind: "adjustment",
      description: "Uji akrual beban pemasaran",
      lines: [line("6109", 250_000), line("1103", 0, 250_000)],
      idempotencyKey: ulid(1),
    });
    assert.equal(created.data.status, "draft");
    assert.equal(created.data.postedEntryId, null);

    const submitted = await post(`${manualPath}/${created.data.id}/submit`, {
      idempotencyKey: ulid(2),
    });
    assert.equal(submitted.data.status, "pending_approval");
    assert.equal(submitted.data.postedEntryId, null);

    const approved = await post(`${manualPath}/${created.data.id}/approve`, {
      idempotencyKey: ulid(3),
    });
    assert.equal(approved.data.status, "posted");
    assert.ok(approved.data.postedEntryId);
    // AUTH-06: the approver is recorded and differs from the requester.
    assert.equal(approved.data.decidedBy, fixtures.users.owner);
    assert.notEqual(approved.data.decidedBy, approved.data.requestedBy);

    const entry = await get(`${journalsPath}/${approved.data.postedEntryId}`);
    const balance = accounting.entryBalance(entry.data.entry.lines);
    assert.equal(balance.balanced, true);
    assert.equal(entry.data.entry.sourceType, "manual");
    assert.equal(entry.data.entry.sourceId, created.data.id);

    // Same idempotency key: the retry replays, it posts nothing more.
    const replay = await post(`${manualPath}/${created.data.id}/approve`, {
      idempotencyKey: ulid(3),
    });
    assert.equal(replay.data.postedEntryId, approved.data.postedEntryId);

    // A posted journal is final: the contract refuses any further transition.
    const again = await failure(
      post(`${manualPath}/${created.data.id}/approve`, {
        idempotencyKey: ulid(4),
      }),
    );
    assert.equal(again.status, 409);
    assert.equal(again.code, "JOURNAL_IMMUTABLE");
  });

  test("ACC-01: a reversal mirrors every line and is the only correction path", async () => {
    const original = fixtures.entries.cashSale;
    const reversal = await post(`${journalsPath}/${original.id}/reversal`, {
      entryDate: "2026-11-04",
      reason: "Nominal salah ketik",
      idempotencyKey: ulid(5),
    });
    assert.equal(reversal.data.sourceType, "reversal");
    assert.equal(reversal.data.reversalOf, original.id);
    assert.equal(reversal.data.lines.length, original.lines.length);
    for (const [index, lineRow] of reversal.data.lines.entries()) {
      assert.equal(lineRow.debitIdr, original.lines[index].creditIdr);
      assert.equal(lineRow.creditIdr, original.lines[index].debitIdr);
    }
    assert.equal(accounting.entryBalance(reversal.data.lines).balanced, true);

    const originalAfter = await get(`${journalsPath}/${original.id}`);
    assert.equal(originalAfter.data.reversedBy, reversal.data.id);
    // The posted entry itself is untouched (final, ACC-01).
    assert.deepEqual(originalAfter.data.entry, original);

    const twice = await failure(
      post(`${journalsPath}/${original.id}/reversal`, {
        entryDate: "2026-11-04",
        reason: "Ulang",
        idempotencyKey: ulid(6),
      }),
    );
    assert.equal(twice.code, "JOURNAL_ALREADY_REVERSED");

    const reversalOfReversal = await failure(
      post(`${journalsPath}/${reversal.data.id}/reversal`, {
        entryDate: "2026-11-04",
        reason: "Salah",
        idempotencyKey: ulid(7),
      }),
    );
    assert.equal(reversalOfReversal.code, "JOURNAL_NOT_REVERSIBLE");
  });

  test("ACC-01/ACC-02: posting into a closed period is refused", async () => {
    const october = fixtures.entries.electricityOctober;
    const error = await failure(
      post(`${journalsPath}/${october.id}/reversal`, {
        entryDate: "2026-10-30",
        reason: "Koreksi di periode tertutup",
        idempotencyKey: ulid(8),
      }),
    );
    assert.equal(error.status, 409);
    assert.equal(error.code, "PERIOD_CLOSED");
  });
});

// ---- ACC-03: drill-down to the source ------------------------------------

describe("ACC-03 drill-down to the source transaction", () => {
  test("ACC-03: a journal exposes its source document for drilling down", async () => {
    const entryId = fixtures.entries.internet.id;
    const journal = await get(`${journalsPath}/${entryId}`);
    const entry = journal.data.entry;
    assert.equal(entry.sourceType, "manual");
    assert.equal(entry.sourceId, fixtures.manualJournals[0].id);

    const source = accounting.journalSourceInfo(entry);
    assert.deepEqual(source.link, {
      screen: "manualJournal",
      id: entry.sourceId,
    });
    assert.equal(source.reference, entry.sourceId);
    assert.equal(source.labelKey, "accounting.source.manual");

    // The linked screen resolves: the source request is reachable.
    const manual = await get(`${manualPath}/${source.link.id}`);
    assert.equal(manual.data.id, entry.sourceId);
    assert.equal(manual.data.postedEntryId, entryId);
  });

  test("ACC-03: an automatic sale keeps the reference and says where it opens", () => {
    const entry = fixtures.entries.cashSale;
    const source = accounting.journalSourceInfo(entry);
    assert.equal(source.reference, entry.sourceId);
    assert.equal(source.link, null);
    assert.equal(source.labelKey, "accounting.source.sale");
  });

  test("ACC-03: the list filters by period, source and account, and pages", async () => {
    const first = await get(journalsPath, {
      legalEntityId: entity,
      from: "2026-11-01",
      to: "2026-11-30",
      limit: 2,
    });
    assert.equal(first.data.length, 2);
    assert.ok(first.meta.nextCursor);
    for (const row of first.data)
      assert.ok(row.entryDate >= "2026-11-01" && row.entryDate <= "2026-11-30");

    const second = await get(journalsPath, {
      legalEntityId: entity,
      from: "2026-11-01",
      to: "2026-11-30",
      limit: 2,
      cursor: first.meta.nextCursor,
    });
    const firstIds = new Set(first.data.map((row) => row.id));
    for (const row of second.data) assert.equal(firstIds.has(row.id), false);

    const sales = await get(journalsPath, {
      legalEntityId: entity,
      from: "2026-11-01",
      to: "2026-11-30",
      limit: 20,
      sourceType: "sale",
    });
    assert.ok(sales.data.length >= 1);
    for (const row of sales.data) assert.equal(row.sourceType, "sale");

    const internetLines = await get(journalsPath, {
      legalEntityId: entity,
      from: "2026-11-01",
      to: "2026-11-30",
      limit: 20,
      accountId: account("6106"),
    });
    assert.ok(internetLines.data.length >= 1);
  });
});

// ---- Chart of accounts ----------------------------------------------------

describe("chart of accounts per legal entity", () => {
  test("header accounts group, leaf accounts post", async () => {
    const response = await get(accountsPath);
    const accounts = response.data;
    assert.ok(accounts.length > 40);
    const rows = accounting.accountTreeRows(accounts);
    assert.equal(rows[0].depth, 0);
    assert.equal(rows[0].isHeader, true);
    const children = rows.filter((row) => row.depth === 1);
    assert.ok(children.length > 0);
    const postable = accounting.postableAccounts(accounts);
    assert.ok(
      postable.every(
        (row) => !rows.find((r) => r.account.id === row.id)?.isHeader,
      ),
    );
  });

  test("codes are unique per entity and the type locks after creation", async () => {
    const duplicate = await failure(
      post(accountsPath, {
        code: "1101",
        name: "Kas Outlet Duplikat",
        type: "asset",
        reportGroup: "cash_and_equivalents",
        parentId: account("1100"),
      }),
    );
    assert.equal(duplicate.code, "ACCOUNT_CODE_TAKEN");

    const created = await post(accountsPath, {
      code: "6199",
      name: "Beban Uji",
      type: "expense",
      reportGroup: "operating_expense",
      parentId: account("6100"),
    });
    assert.equal(created.data.code, "6199");
    assert.equal(created.data.isActive, true);

    const updated = await patch(`/api/accounting/accounts/${created.data.id}`, {
      isActive: false,
    });
    assert.equal(updated.data.isActive, false);
    // The update contract has no `type`: history cannot move sections.
    assert.equal("type" in updated.data, true);
    assert.equal(updated.data.type, "expense");
  });

  test("?mock=empty shows the empty chart, not a fabricated one", async () => {
    setScenario("empty");
    const response = await get(accountsPath);
    assert.deepEqual(response.data, []);
  });
});

// ---- Manual journals: workflow -------------------------------------------

describe("manual journal approval workflow", () => {
  test("a rejection needs a reason, records the approver and returns to the requester", async () => {
    const created = await post(manualPath, {
      legalEntityId: entity,
      outletId: null,
      entryDate: "2026-11-02",
      kind: "general",
      description: "Uji penolakan",
      lines: [line("6109", 10_000), line("1103", 0, 10_000)],
      idempotencyKey: ulid(10),
    });
    await post(`${manualPath}/${created.data.id}/submit`, {
      idempotencyKey: ulid(11),
    });

    const noReason = await failure(
      post(`${manualPath}/${created.data.id}/reject`, { reason: "" }),
    );
    assert.equal(noReason.status, 400);

    const rejected = await post(`${manualPath}/${created.data.id}/reject`, {
      reason: "Lampiran tagihan belum ada.",
    });
    assert.equal(rejected.data.status, "rejected");
    assert.equal(rejected.data.rejectionReason, "Lampiran tagihan belum ada.");
    assert.equal(rejected.data.decidedBy, fixtures.users.owner);

    // A rejected request can be edited back into a draft, then cancelled.
    const edited = await patch(`${manualPath}/${created.data.id}`, {
      description: "Uji penolakan (revisi)",
    });
    assert.equal(edited.data.status, "draft");
    assert.equal(edited.data.rejectionReason, null);

    const cancelled = await post(`${manualPath}/${created.data.id}/cancel`, {
      idempotencyKey: ulid(12),
    });
    assert.equal(cancelled.data.status, "cancelled");
  });

  test("?mock=empty lists nothing and detail 404s", async () => {
    setScenario("empty");
    const page = await get(manualPath, {
      legalEntityId: entity,
      limit: 20,
    });
    assert.deepEqual(page.data, []);
    const missing = await failure(
      get(`${manualPath}/${fixtures.manualJournals[0].id}`),
    );
    assert.equal(missing.status, 404);
  });
});

// ---- Recurring journals ---------------------------------------------------

describe("recurring journal templates", () => {
  test("submit → approve activates; pause, resume and end follow the contract", async () => {
    const created = await post(recurringPath, {
      legalEntityId: entity,
      outletId: null,
      description: "Uji templat sewa",
      lines: [line("6105", 1_000_000), line("2101", 0, 1_000_000)],
      dayOfMonth: 15,
      startPeriod: "2027-01",
      endPeriod: null,
      idempotencyKey: ulid(20),
    });
    assert.equal(created.data.status, "draft");
    assert.equal(created.data.frequency, "monthly");

    const submitted = await post(
      `${recurringPath}/${created.data.id}/transition`,
      { type: "submit" },
    );
    assert.equal(submitted.data.status, "pending_approval");

    const approved = await post(
      `${recurringPath}/${created.data.id}/transition`,
      { type: "approve" },
    );
    assert.equal(approved.data.status, "active");
    assert.equal(approved.data.approvedBy, fixtures.users.owner);
    assert.notEqual(approved.data.approvedBy, approved.data.requestedBy);

    const paused = await post(
      `${recurringPath}/${created.data.id}/transition`,
      { type: "pause" },
    );
    assert.equal(paused.data.status, "paused");
    const resumed = await post(
      `${recurringPath}/${created.data.id}/transition`,
      { type: "resume" },
    );
    assert.equal(resumed.data.status, "active");
    const ended = await post(`${recurringPath}/${created.data.id}/transition`, {
      type: "end",
    });
    assert.equal(ended.data.status, "ended");

    const invalid = await failure(
      post(`${recurringPath}/${created.data.id}/transition`, {
        type: "submit",
      }),
    );
    assert.equal(invalid.code, "INVALID_TRANSITION");
  });

  test("the template list serves the fixtures and honours ?mock=empty", async () => {
    const normal = await get(recurringPath, { legalEntityId: entity });
    assert.ok(normal.data.length >= 1);
    setScenario("empty");
    const empty = await get(recurringPath, { legalEntityId: entity });
    assert.deepEqual(empty.data, []);
  });
});
