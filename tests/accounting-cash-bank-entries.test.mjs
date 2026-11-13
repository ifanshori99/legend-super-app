// Pure contract tests for Kas & Bank entries and petty cash (bead legend-4961,
// WS-07, PRD v1.7 §3.19 Kas & Bank, docs/briefs/ws-cash-bank-design.md
// "Kontrak di packages/shared/src/accounting"). No database.
//
// Location note: the brief names packages/shared/src/accounting/
// cash-bank-entries.test.ts, but nothing runs `*.test.ts` outside apps/api
// (vitest include is `src/**/*.test.ts` of the api app; shared has no runner).
// Root node:test suites (`tests/*.test.mjs`, plain Node ESM) are how every other
// shared contract is tested, so this file lives here and runs with
// `LEGEND_TEST_FILES="tests/accounting-cash-bank-entries.test.mjs" pnpm test`.
//
// Founder money rules covered here (the DB/HTTP side is in the api tests):
// 1. a transfer or cash entry builds balanced journal lines (debit = credit);
// 2. petty cash cannot go below zero (`applyPettyCashDelta`);
// 3. the input contracts refuse zero/negative/fractional money and unknown kinds;
// 4. posting roles missing from the account map fail closed.
//
// Assumptions where the design is silent (named in the design as functions only):
// - `cashBankJournalLines(input, gl)` returns an array of `{ accountId,
//   debitIdr, creditIdr }` (extra fields allowed); `input` is the parsed
//   create-input; `gl` is `{ bankGl, toBankGl?, counter? }` account ids. For a
//   transfer `bankGl` is the source account's GL and `toBankGl` the target's.
// - `applyPettyCashDelta(balance, delta)` takes a signed delta (negative =
//   spend) and returns the new balance.
// - A body that is not a strict match (extra field, wrong kind) is rejected.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import * as acc from "../packages/shared/src/accounting/index.ts";
import * as access from "../packages/shared/src/access/index.ts";

const id = () => randomUUID();
const throwsCode = (fn, expected) =>
  assert.throws(fn, (error) => {
    assert.equal(
      error.code,
      expected,
      `expected ${expected}, got ${error.code}: ${error.message}`,
    );
    return true;
  });

const legalEntityId = id();
const bankAccountId = id();
const toBankAccountId = id();
const counterAccountId = id();
const bankGl = id();
const toBankGl = id();
const counterGl = id();

const cashInBody = (extra = {}) => ({
  kind: "cash_in",
  legalEntityId,
  bankAccountId,
  counterAccountId,
  amountIdr: 250_000,
  entryDate: "2026-11-10",
  description: "Setoran modal pemilik",
  reference: "REF-0001",
  idempotencyKey: "cash-in-0001",
  ...extra,
});
const cashOutBody = (extra = {}) =>
  cashInBody({
    kind: "cash_out",
    description: "Bayar listrik",
    idempotencyKey: "cash-out-0001",
    ...extra,
  });
const transferBody = (extra = {}) => ({
  kind: "transfer",
  legalEntityId,
  fromBankAccountId: bankAccountId,
  toBankAccountId,
  amountIdr: 1_000_000,
  entryDate: "2026-11-10",
  description: "Pindah ke rekening operasional",
  reference: "REF-0002",
  idempotencyKey: "transfer-0001",
  ...extra,
});

/** Net per account id: { debit, credit } totals of a set of journal lines. */
function totals(lines) {
  const byAccount = new Map();
  for (const line of lines) {
    const row = byAccount.get(line.accountId) ?? { debit: 0, credit: 0 };
    row.debit += line.debitIdr;
    row.credit += line.creditIdr;
    byAccount.set(line.accountId, row);
  }
  return byAccount;
}
function assertBalanced(lines) {
  const debit = lines.reduce((sum, line) => sum + line.debitIdr, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditIdr, 0);
  assert.ok(debit > 0, "journal has a positive total");
  assert.equal(debit, credit, "total debit equals total credit");
  for (const line of lines)
    assert.ok(
      (line.debitIdr === 0) !== (line.creditIdr === 0),
      "a line is either debit or credit",
    );
}

const without = (obj, key) => {
  const copy = { ...obj };
  delete copy[key];
  return copy;
};

describe("legend-4961 cash-bank entry input contract", () => {
  test("legend-4961 cash_in, cash_out and transfer bodies parse", () => {
    for (const body of [cashInBody(), cashOutBody(), transferBody()]) {
      const parsed = acc.createCashBankEntryInputSchema.safeParse(body);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
      assert.equal(parsed.data.kind, body.kind);
      assert.equal(parsed.data.amountIdr, body.amountIdr);
    }
    assert.deepEqual([...acc.CASH_BANK_ENTRY_KINDS].sort(), [
      "cash_in",
      "cash_out",
      "transfer",
    ]);
  });

  test("legend-4961 the optional outlet tag is accepted on cash entries", () => {
    const parsed = acc.createCashBankEntryInputSchema.safeParse(
      cashOutBody({ outletId: id() }),
    );
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  test("legend-4961 money must be whole, positive rupiah", () => {
    for (const amountIdr of [0, -1, -250_000, 1.5, Number.NaN, "250000"]) {
      for (const body of [
        cashInBody({ amountIdr }),
        cashOutBody({ amountIdr }),
        transferBody({ amountIdr }),
      ])
        assert.equal(
          acc.createCashBankEntryInputSchema.safeParse(body).success,
          false,
          `${body.kind} amount ${String(amountIdr)} must be refused`,
        );
    }
  });

  test("legend-4961 a cash entry needs the counter account; a transfer must not carry one", () => {
    const noCounter = without(cashInBody(), "counterAccountId");
    assert.equal(
      acc.createCashBankEntryInputSchema.safeParse(noCounter).success,
      false,
    );
    assert.equal(
      acc.createCashBankEntryInputSchema.safeParse(
        transferBody({ counterAccountId }),
      ).success,
      false,
    );
    const noTarget = without(transferBody(), "toBankAccountId");
    assert.equal(
      acc.createCashBankEntryInputSchema.safeParse(noTarget).success,
      false,
    );
  });

  test("legend-4961 unknown kind, unknown field, bad ids and bad keys are refused", () => {
    const refused = (body) =>
      assert.equal(
        acc.createCashBankEntryInputSchema.safeParse(body).success,
        false,
        JSON.stringify(body),
      );
    refused(cashInBody({ kind: "cash_swap" }));
    refused(cashInBody({ journalEntryId: id() }));
    refused(cashInBody({ accountOverrides: { bank: id() } }));
    refused(cashInBody({ bankAccountId: "not-a-uuid" }));
    refused(cashInBody({ entryDate: "10-11-2026" }));
    refused(cashInBody({ description: "" }));
    refused(cashInBody({ idempotencyKey: "short" }));
    refused(cashInBody({ idempotencyKey: "has space in key" }));
    const noKey = without(transferBody(), "idempotencyKey");
    refused(noKey);
  });

  test("legend-4961 the list query needs an entity and a date window", () => {
    const parsed = acc.cashBankEntryQuerySchema.safeParse({
      legalEntityId,
      from: "2026-11-01",
      to: "2026-11-30",
      kind: "transfer",
      limit: 20,
    });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(
      acc.cashBankEntryQuerySchema.safeParse({ from: "2026-11-01" }).success,
      false,
    );
    assert.equal(
      acc.cashBankEntryQuerySchema.safeParse({
        legalEntityId,
        from: "2026-11-01",
        to: "2026-11-30",
        kind: "spend",
      }).success,
      false,
    );
  });
});

describe("legend-4961 cashBankJournalLines is balanced for every kind", () => {
  test("legend-4961 cash_in: Dr bank GL / Cr counter", () => {
    const input = acc.createCashBankEntryInputSchema.parse(cashInBody());
    const lines = acc.cashBankJournalLines(input, {
      bankGl,
      counter: counterGl,
    });
    assertBalanced(lines);
    const sum = totals(lines);
    assert.deepEqual(sum.get(bankGl), { debit: 250_000, credit: 0 });
    assert.deepEqual(sum.get(counterGl), { debit: 0, credit: 250_000 });
    assert.equal(sum.size, 2);
  });

  test("legend-4961 cash_out: Dr counter / Cr bank GL", () => {
    const input = acc.createCashBankEntryInputSchema.parse(cashOutBody());
    const lines = acc.cashBankJournalLines(input, {
      bankGl,
      counter: counterGl,
    });
    assertBalanced(lines);
    const sum = totals(lines);
    assert.deepEqual(sum.get(counterGl), { debit: 250_000, credit: 0 });
    assert.deepEqual(sum.get(bankGl), { debit: 0, credit: 250_000 });
  });

  test("legend-4961 transfer: Dr target GL / Cr source GL, same amount", () => {
    const input = acc.createCashBankEntryInputSchema.parse(transferBody());
    const lines = acc.cashBankJournalLines(input, { bankGl, toBankGl });
    assertBalanced(lines);
    const sum = totals(lines);
    assert.deepEqual(sum.get(toBankGl), { debit: 1_000_000, credit: 0 });
    assert.deepEqual(sum.get(bankGl), { debit: 0, credit: 1_000_000 });
    assert.equal(sum.size, 2);
  });

  test("legend-4961 a large amount stays exact (no float drift)", () => {
    const big = 9_007_199_254_740; // < Number.MAX_SAFE_INTEGER / 1000
    const input = acc.createCashBankEntryInputSchema.parse(
      transferBody({ amountIdr: big }),
    );
    const lines = acc.cashBankJournalLines(input, { bankGl, toBankGl });
    assertBalanced(lines);
    assert.equal(totals(lines).get(toBankGl).debit, big);
  });
});

describe("legend-4961 petty cash movement contract and balance rule", () => {
  const movement = (extra = {}) => ({
    kind: "topup",
    outletId: id(),
    bankAccountId,
    amountIdr: 100_000,
    description: "Isi kas kecil",
    idempotencyKey: "petty-topup-0001",
    ...extra,
  });

  test("legend-4961 topup and return parse; spend/purchase is not a movement kind", () => {
    for (const kind of ["topup", "return"]) {
      const parsed = acc.pettyCashMovementInputSchema.safeParse(
        movement({ kind }),
      );
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    }
    // Purchases only go through the photo-backed petty purchase (design 3).
    for (const kind of ["purchase", "spend", "adjust"])
      assert.equal(
        acc.pettyCashMovementInputSchema.safeParse(movement({ kind })).success,
        false,
        `${kind} must not be a movement`,
      );
    assert.deepEqual([...acc.PETTY_CASH_ENTRY_KINDS].sort(), [
      "purchase",
      "return",
      "topup",
    ]);
  });

  test("legend-4961 movement money must be whole, positive rupiah; no extra fields", () => {
    for (const amountIdr of [0, -5_000, 0.5, "100000"])
      assert.equal(
        acc.pettyCashMovementInputSchema.safeParse(movement({ amountIdr }))
          .success,
        false,
        `amount ${String(amountIdr)}`,
      );
    assert.equal(
      acc.pettyCashMovementInputSchema.safeParse(
        movement({ accountOverrides: { bank: id() } }),
      ).success,
      false,
    );
    assert.equal(
      acc.pettyCashMovementInputSchema.safeParse(
        movement({ idempotencyKey: "x" }),
      ).success,
      false,
    );
  });

  test("legend-4961 applyPettyCashDelta moves the balance and never goes below zero", () => {
    assert.equal(acc.applyPettyCashDelta(0, 100_000), 100_000);
    assert.equal(acc.applyPettyCashDelta(100_000, 50_000), 150_000);
    assert.equal(acc.applyPettyCashDelta(100_000, -40_000), 60_000);
    // Boundary: spending exactly the balance is allowed, one rupiah more is not.
    assert.equal(acc.applyPettyCashDelta(100_000, -100_000), 0);
    throwsCode(
      () => acc.applyPettyCashDelta(100_000, -100_001),
      "PETTY_CASH_INSUFFICIENT",
    );
    throwsCode(
      () => acc.applyPettyCashDelta(100_000, -150_000),
      "PETTY_CASH_INSUFFICIENT",
    );
    throwsCode(() => acc.applyPettyCashDelta(0, -1), "PETTY_CASH_INSUFFICIENT");
  });

  test("legend-4961 the entry DTO enforces a non-negative balance after the movement", () => {
    const base = {
      id: id(),
      tenantId: id(),
      legalEntityId,
      outletId: id(),
      fundId: id(),
      kind: "topup",
      amountIdr: 100_000,
      balanceAfterIdr: 100_000,
      bankAccountId,
      pettyPurchaseId: null,
      entryDate: "2026-11-10",
      description: "Isi kas kecil",
      journalStatus: "posted",
      journalEntryId: id(),
      parkCode: null,
      createdBy: id(),
      createdAt: "2026-11-10T03:00:00.000Z",
    };
    // The DTO field list is the engineer's call; only the negative balance is
    // pinned: whatever else the schema asks, -1 must never pass.
    const negative = acc.pettyCashEntrySchema.safeParse({
      ...base,
      balanceAfterIdr: -1,
    });
    assert.equal(negative.success, false);
    assert.ok(
      negative.error.issues.some((issue) =>
        issue.path.includes("balanceAfterIdr"),
      ),
      "the refusal names balanceAfterIdr",
    );
    assert.deepEqual([...acc.pettyCashJournalStatusSchema.options].sort(), [
      "external",
      "parked",
      "posted",
    ]);
  });
});

describe("legend-4961 errors, source types, posting rules, endpoints, permissions", () => {
  test("legend-4961 new error codes are 422 and carry a readable message", () => {
    for (const code of [
      "PETTY_CASH_INSUFFICIENT",
      "PETTY_CASH_FUND_REQUIRED",
      "CASH_BANK_COUNTER_ACCOUNT_INVALID",
    ]) {
      assert.equal(acc.accountingErrorHttpStatus[code], 422, code);
      const error = new acc.AccountingError(code);
      assert.equal(error.status, 422);
      assert.ok(error.message.length > 10 && error.message !== code, code);
    }
  });

  test("legend-4961 the five new journal source types exist and fit varchar(30)", () => {
    const added = [
      "cash_receipt",
      "cash_payment",
      "bank_transfer",
      "petty_cash_topup",
      "petty_cash_return",
    ];
    for (const type of added) {
      assert.ok(acc.JOURNAL_SOURCE_TYPES.includes(type), type);
      assert.ok(type.length <= 30, `${type} fits journal_entries.source_type`);
      assert.equal(acc.journalSourceTypeSchema.safeParse(type).success, true);
    }
    // Existing types are untouched.
    for (const type of ["cash_deposit", "petty_purchase", "manual", "reversal"])
      assert.ok(acc.JOURNAL_SOURCE_TYPES.includes(type), type);
  });

  test("legend-4961 petty cash topup posts Dr petty_cash / Cr bank, return is the mirror, both balanced", () => {
    const petty = id();
    const bank = id();
    const map = new Map([
      ["petty_cash", petty],
      ["bank", bank],
    ]);
    const top = acc.resolvePostingRule(acc.defaultPostingRules, {
      sourceType: "petty_cash_topup",
    });
    assert.deepEqual(acc.postingRuleAmountKeys(top), ["amountIdr"]);
    const topLines = acc.buildJournalLinesFromRule(
      top,
      { amountIdr: 100_000 },
      map,
      { outletId: null },
    );
    assertBalanced(topLines);
    assert.deepEqual(totals(topLines).get(petty), {
      debit: 100_000,
      credit: 0,
    });
    assert.deepEqual(totals(topLines).get(bank), { debit: 0, credit: 100_000 });

    const back = acc.resolvePostingRule(acc.defaultPostingRules, {
      sourceType: "petty_cash_return",
    });
    assert.deepEqual(acc.postingRuleAmountKeys(back), ["amountIdr"]);
    const backLines = acc.buildJournalLinesFromRule(
      back,
      { amountIdr: 40_000 },
      map,
      { outletId: null },
    );
    assertBalanced(backLines);
    assert.deepEqual(totals(backLines).get(bank), { debit: 40_000, credit: 0 });
    assert.deepEqual(totals(backLines).get(petty), {
      debit: 0,
      credit: 40_000,
    });
  });

  test("legend-4961 a missing petty_cash mapping fails closed with ACCOUNT_MAPPING_MISSING; a wrong amount key is refused", () => {
    const top = acc.resolvePostingRule(acc.defaultPostingRules, {
      sourceType: "petty_cash_topup",
    });
    throwsCode(
      () =>
        acc.buildJournalLinesFromRule(
          top,
          { amountIdr: 100_000 },
          new Map([["bank", id()]]),
          { outletId: null },
        ),
      "ACCOUNT_MAPPING_MISSING",
    );
    throwsCode(
      () =>
        acc.buildJournalLinesFromRule(
          top,
          { cashIdr: 100_000 },
          new Map([
            ["petty_cash", id()],
            ["bank", id()],
          ]),
          { outletId: null },
        ),
      "POSTING_AMOUNTS_MISMATCH",
    );
  });

  test("legend-4961 the seven endpoints are declared on /api/accounting with the designed verbs", () => {
    const declared = new Set(
      Object.values(acc)
        .filter(
          (value) =>
            value !== null &&
            typeof value === "object" &&
            typeof value.method === "string" &&
            typeof value.path === "string",
        )
        .map((value) => `${value.method} ${value.path}`),
    );
    for (const expected of [
      "GET /api/accounting/cash-bank/entries",
      "GET /api/accounting/cash-bank/entries/:entryId",
      "POST /api/accounting/cash-bank/entries",
      "GET /api/accounting/petty-cash/funds",
      "GET /api/accounting/petty-cash/entries",
      "POST /api/accounting/petty-cash/movements",
      "POST /api/accounting/petty-cash/entries/:entryId/post",
    ])
      assert.ok(declared.has(expected), `${expected} is declared`);
  });

  test("legend-4961 the two permissions exist, are finance-tagged and are in the finance template, not in front-line roles", () => {
    for (const code of [
      "accounting.cash_bank.record",
      "accounting.petty_cash.manage",
    ]) {
      assert.ok(access.isPermissionCode(code), `${code} is in the catalog`);
      assert.equal(
        access.permissionHasTag(code, "finance"),
        true,
        `${code} is tagged finance`,
      );
      assert.ok(
        access.roleTemplate("finance").permissions.includes(code),
        `finance template holds ${code}`,
      );
      // Money stays with finance: front-line roles do not get it by template.
      for (const key of ["cashier", "waiter", "barista_cook", "employee"])
        assert.equal(
          access.roleTemplate(key).permissions.includes(code),
          false,
          `${key} must not hold ${code}`,
        );
    }
  });
});
