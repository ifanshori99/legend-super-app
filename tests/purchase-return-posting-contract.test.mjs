// Purchase return and petty purchase posting contract (brief
// docs/briefs/298a-sub-purchase-return-posting-design.md, Potongan A; cards
// legend-1xbs, legend-v3lh; PRD v1.7 §3.18 Retur Pembelian / Pembelian
// Sederhana, §3.19 Jurnal Otomatis; ACC-01 balanced journals).
//
// Pure shared contract, no database: the `purchase_return.recorded` payload
// refines (split must add up, PPN only on invoiced value), the new
// `petty_purchase.recorded` event, the posting rules and the 5104 account.
//
// Assumptions:
// - Journal lines of a rule are asserted per role and side, so the order of
//   the lines inside the rule does not matter.
// - Pesanan latihan (training orders) does not apply: these events are not
//   orders.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as acc from "../packages/shared/src/accounting/index.ts";
import * as events from "../packages/shared/src/events/index.ts";
import * as shared from "../packages/shared/src/inventory/index.ts";

const fixtures = shared.cafeLegendPurchasingFixtures;
const returnNote = fixtures.purchaseReturnDetails[0].purchaseReturn;
const pettyRow = fixtures.pettyPurchases[0];
const userId = "00000000-0000-4000-8000-000000009999";

const returnPayload = (overrides = {}) => ({
  purchaseReturnId: returnNote.id,
  supplierId: returnNote.supplierId,
  outletId: pettyRow.outletId,
  number: returnNote.number,
  valueIdr: 185_000,
  uninvoicedValueIdr: 185_000,
  invoicedValueIdr: 0,
  ppnIdr: 0,
  returnedBy: userId,
  returnedAt: "2026-11-01T05:00:00.000Z",
  ...overrides,
});

const pettyPayload = (overrides = {}) => ({
  pettyPurchaseId: pettyRow.id,
  outletId: pettyRow.outletId,
  amountIdr: 285_000,
  businessDate: "2026-11-02",
  paidBy: userId,
  paidAt: "2026-11-02T05:00:00.000Z",
  ...overrides,
});

describe("purchase_return.recorded payload (Potongan A.1)", () => {
  const parse = (payload) =>
    shared.purchaseReturnRecordedEventPayloadSchema.safeParse(payload);

  test("PRP-CONTRACT-01 an uninvoiced return validates and carries outlet and split", () => {
    const result = parse(returnPayload());
    assert.equal(result.success, true);
    assert.equal(result.data.outletId, pettyRow.outletId);
    assert.equal(result.data.uninvoicedValueIdr, 185_000);
    assert.equal(result.data.invoicedValueIdr, 0);
    assert.equal(result.data.ppnIdr, 0);
  });

  test("PRP-CONTRACT-02 invoiced and mixed returns validate; PPN rides on invoiced value", () => {
    assert.equal(
      parse(
        returnPayload({
          valueIdr: 100_000,
          uninvoicedValueIdr: 0,
          invoicedValueIdr: 100_000,
          ppnIdr: 11_000,
        }),
      ).success,
      true,
    );
    assert.equal(
      parse(
        returnPayload({
          valueIdr: 100_000,
          uninvoicedValueIdr: 60_000,
          invoicedValueIdr: 40_000,
          ppnIdr: 4_400,
        }),
      ).success,
      true,
    );
  });

  test("PRP-CONTRACT-03 a split that does not add up to valueIdr is rejected", () => {
    assert.equal(
      parse(
        returnPayload({
          valueIdr: 100_000,
          uninvoicedValueIdr: 60_000,
          invoicedValueIdr: 30_000,
        }),
      ).success,
      false,
    );
    // PPN is not part of valueIdr: it never fixes a short split.
    assert.equal(
      parse(
        returnPayload({
          valueIdr: 100_000,
          uninvoicedValueIdr: 60_000,
          invoicedValueIdr: 30_000,
          ppnIdr: 10_000,
        }),
      ).success,
      false,
    );
  });

  test("PRP-CONTRACT-04 ppnIdr above 0 without invoiced value is rejected", () => {
    assert.equal(parse(returnPayload({ ppnIdr: 1_000 })).success, false);
  });

  test("PRP-CONTRACT-05 outlet and split amounts are required, amounts are whole non-negative rupiah", () => {
    for (const key of [
      "outletId",
      "uninvoicedValueIdr",
      "invoicedValueIdr",
      "ppnIdr",
    ]) {
      const payload = returnPayload();
      delete payload[key];
      assert.equal(parse(payload).success, false, `${key} is required`);
    }
    assert.equal(
      parse(
        returnPayload({
          valueIdr: 99_999,
          uninvoicedValueIdr: 100_000,
          invoicedValueIdr: -1,
        }),
      ).success,
      false,
    );
    assert.equal(
      parse(
        returnPayload({
          valueIdr: 100_000.5,
          uninvoicedValueIdr: 100_000.5,
        }),
      ).success,
      false,
    );
  });
});

describe("malformed payloads are rejected (Potongan A.1, A.2)", () => {
  const parseReturn = (payload) =>
    shared.purchaseReturnRecordedEventPayloadSchema.safeParse(payload);
  const parsePetty = (payload) =>
    shared.purchasingEventPayloadSchemas["petty_purchase.recorded"].safeParse(
      payload,
    );

  test("PRP-CONTRACT-09 a negative ppnIdr is rejected, a valid PPN is the positive control", () => {
    const invoiced = {
      valueIdr: 100_000,
      uninvoicedValueIdr: 0,
      invoicedValueIdr: 100_000,
    };
    assert.equal(
      parseReturn(returnPayload({ ...invoiced, ppnIdr: 11_000 })).success,
      true,
    );
    assert.equal(
      parseReturn(returnPayload({ ...invoiced, ppnIdr: -11_000 })).success,
      false,
    );
  });

  test("PRP-CONTRACT-10 a petty payload with a bad uuid is rejected, a valid one is the positive control", () => {
    assert.equal(parsePetty(pettyPayload()).success, true);
    for (const key of ["pettyPurchaseId", "outletId", "paidBy"])
      assert.equal(
        parsePetty(pettyPayload({ [key]: "not-a-uuid" })).success,
        false,
        `${key} must be a uuid`,
      );
  });

  test("PRP-CONTRACT-11 a petty businessDate that is not a real calendar date is rejected", () => {
    assert.equal(
      parsePetty(pettyPayload({ businessDate: "2026-11-02" })).success,
      true,
    );
    for (const businessDate of ["2026-13-45", "2026-02-30", "02-11-2026", ""])
      assert.equal(
        parsePetty(pettyPayload({ businessDate })).success,
        false,
        `businessDate ${JSON.stringify(businessDate)}`,
      );
  });
});

describe("petty_purchase.recorded event (Potongan A.2)", () => {
  const schema = () => shared.purchasingEventPayloadSchemas;
  const parse = (payload) =>
    schema()["petty_purchase.recorded"].safeParse(payload);

  test("PRP-CONTRACT-06 the event is registered once in the purchasing list and the WS-06 catalog", () => {
    assert.ok(shared.purchasingEventNames.includes("petty_purchase.recorded"));
    assert.equal(
      shared.purchasingEventNames.filter(
        (name) => name === "petty_purchase.recorded",
      ).length,
      1,
    );
    const entries = events.eventCatalog.filter(
      (entry) => entry.name === "petty_purchase.recorded",
    );
    assert.equal(entries.length, 1, "exactly one catalog row");
    assert.equal(entries[0].workstream, "WS-06");
    assert.equal(entries[0].version, 1);
    assert.equal(entries[0].payloadSchemaRef, "petty_purchase.recorded.v1");
  });

  test("PRP-CONTRACT-07 a valid id-only payload parses and wraps in the envelope", () => {
    assert.equal(parse(pettyPayload()).success, true);
    const envelope = {
      ...events.eventFixture,
      name: "petty_purchase.recorded",
      aggregateType: "petty_purchase",
      aggregateId: pettyRow.id,
      payloadSchemaRef: "petty_purchase.recorded.v1",
      payload: pettyPayload(),
    };
    assert.equal(
      shared.purchasingEventSchema.parse(envelope).name,
      "petty_purchase.recorded",
    );
    assert.equal(
      shared.purchasingEventSchema.safeParse({
        ...envelope,
        payload: events.eventFixture.payload,
      }).success,
      false,
      "the envelope validates the catalogued payload",
    );
  });

  test("PRP-CONTRACT-08 amount must be above 0, ids and fields are required, extra keys are rejected", () => {
    assert.equal(parse(pettyPayload({ amountIdr: 0 })).success, false);
    assert.equal(parse(pettyPayload({ amountIdr: -5_000 })).success, false);
    assert.equal(parse(pettyPayload({ amountIdr: 1_000.5 })).success, false);
    for (const key of [
      "pettyPurchaseId",
      "outletId",
      "amountIdr",
      "businessDate",
      "paidBy",
      "paidAt",
    ]) {
      const payload = pettyPayload();
      delete payload[key];
      assert.equal(parse(payload).success, false, `${key} is required`);
    }
    assert.equal(
      parse(pettyPayload({ description: "kopi" })).success,
      false,
      "payload is id-only and strict",
    );
  });
});

describe("posting rules (Potongan A.3 to A.5)", () => {
  const roles = [
    "grni",
    "accounts_payable",
    "inventory",
    "inventory_price_variance",
    "ppn_input",
    "petty_purchase_expense",
    "petty_cash",
  ];
  const map = new Map(roles.map((role) => [role, `account-of-${role}`]));
  const ruleOf = (eventName) =>
    acc.resolvePostingRule(acc.defaultPostingRules, { eventName });
  const build = (eventName, amounts) =>
    acc.buildJournalLinesFromRule(ruleOf(eventName), amounts, map, {
      outletId: pettyRow.outletId,
    });
  /** `{ role: [debit, credit] }` of the built lines. */
  const byRole = (lines) =>
    Object.fromEntries(
      lines.map((line) => [
        line.accountId.replace("account-of-", ""),
        [line.debitIdr, line.creditIdr],
      ]),
    );
  const assertBalanced = (lines) => {
    const debit = lines.reduce((sum, line) => sum + line.debitIdr, 0);
    const credit = lines.reduce((sum, line) => sum + line.creditIdr, 0);
    assert.ok(debit > 0);
    assert.equal(debit, credit);
  };

  test("PRP-RULE-01 journal source types purchase_return and petty_purchase exist", () => {
    for (const type of ["purchase_return", "petty_purchase"])
      assert.equal(acc.journalSourceTypeSchema.safeParse(type).success, true);
  });

  test("PRP-RULE-02 a return before invoicing posts Dr grni / Cr inventory only", () => {
    const rule = ruleOf("purchase_return.recorded");
    assert.equal(rule.sourceType, "purchase_return");
    const lines = build("purchase_return.recorded", {
      uninvoicedValueIdr: 185_000,
      debitNoteIdr: 0,
      returnPriceVarianceIdr: 0,
      returnMovingAvgVarianceIdr: 0,
      valueIdr: 185_000,
      ppnIdr: 0,
    });
    assert.deepEqual(byRole(lines), {
      grni: [185_000, 0],
      inventory: [0, 185_000],
    });
    assertBalanced(lines);
  });

  test("PRP-RULE-03 a return after invoicing posts Dr accounts_payable (debit note) / Cr inventory, Cr ppn_input", () => {
    // invoiced 100.000 + PPN 11.000: the supplier's debit note is 111.000.
    const lines = build("purchase_return.recorded", {
      uninvoicedValueIdr: 0,
      debitNoteIdr: 111_000,
      returnPriceVarianceIdr: 0,
      returnMovingAvgVarianceIdr: 0,
      valueIdr: 100_000,
      ppnIdr: 11_000,
    });
    assert.deepEqual(byRole(lines), {
      accounts_payable: [111_000, 0],
      inventory: [0, 100_000],
      ppn_input: [0, 11_000],
    });
    assertBalanced(lines);
  });

  test("PRP-RULE-04 an invoiced return of a non-PPN supplier has no ppn_input line", () => {
    const lines = build("purchase_return.recorded", {
      uninvoicedValueIdr: 0,
      debitNoteIdr: 100_000,
      returnPriceVarianceIdr: 0,
      returnMovingAvgVarianceIdr: 0,
      valueIdr: 100_000,
      ppnIdr: 0,
    });
    assert.deepEqual(byRole(lines), {
      accounts_payable: [100_000, 0],
      inventory: [0, 100_000],
    });
    assertBalanced(lines);
  });

  test("PRP-RULE-05 a mixed return splits Dr grni and Dr accounts_payable and still balances", () => {
    // uninvoiced 60.000 + invoiced 40.000 with PPN 4.400.
    const lines = build("purchase_return.recorded", {
      uninvoicedValueIdr: 60_000,
      debitNoteIdr: 44_400,
      returnPriceVarianceIdr: 0,
      returnMovingAvgVarianceIdr: 0,
      valueIdr: 100_000,
      ppnIdr: 4_400,
    });
    assert.deepEqual(byRole(lines), {
      grni: [60_000, 0],
      accounts_payable: [44_400, 0],
      inventory: [0, 100_000],
      ppn_input: [0, 4_400],
    });
    assertBalanced(lines);
  });

  test("PRP-RULE-06 a petty purchase posts Dr petty_purchase_expense / Cr petty_cash", () => {
    const rule = ruleOf("petty_purchase.recorded");
    assert.equal(rule.sourceType, "petty_purchase");
    const lines = build("petty_purchase.recorded", { amountIdr: 285_000 });
    assert.deepEqual(byRole(lines), {
      petty_purchase_expense: [285_000, 0],
      petty_cash: [0, 285_000],
    });
    assertBalanced(lines);
  });

  test("PRP-RULE-07 the rules expect exactly the amount keys the fact builder sends", () => {
    assert.deepEqual(
      acc.postingRuleAmountKeys(ruleOf("purchase_return.recorded")),
      [
        "debitNoteIdr",
        "ppnIdr",
        "returnMovingAvgVarianceIdr",
        "returnPriceVarianceIdr",
        "uninvoicedValueIdr",
        "valueIdr",
      ],
    );
    assert.deepEqual(
      acc.postingRuleAmountKeys(ruleOf("petty_purchase.recorded")),
      ["amountIdr"],
    );
  });

  test("PRP-RULE-09 a moving-average variance on a return moves the inventory credit to Dr inventory / Cr inventory_price_variance, signed and balanced (legend-uloj6)", () => {
    const amounts = (returnMovingAvgVarianceIdr) => ({
      uninvoicedValueIdr: 185_000,
      debitNoteIdr: 0,
      returnPriceVarianceIdr: 0,
      returnMovingAvgVarianceIdr,
      valueIdr: 185_000,
      ppnIdr: 0,
    });
    /** `[role, debit, credit]` of the variance pair, plus the full lines. */
    const rows = (lines) =>
      lines.map((line) => [
        line.accountId.replace("account-of-", ""),
        line.debitIdr,
        line.creditIdr,
      ]);
    const sorted = (list) => list.map(String).sort();

    // Positive: Dr inventory / Cr inventory_price_variance on top of the
    // order-price credit to inventory.
    const positive = build("purchase_return.recorded", amounts(5_000));
    assert.deepEqual(
      sorted(rows(positive)),
      sorted([
        ["grni", 185_000, 0],
        ["inventory", 0, 185_000],
        ["inventory", 5_000, 0],
        ["inventory_price_variance", 0, 5_000],
      ]),
    );
    assertBalanced(positive);

    // Negative: both variance lines flip sides.
    const negative = build("purchase_return.recorded", amounts(-5_000));
    assert.deepEqual(
      sorted(rows(negative)),
      sorted([
        ["grni", 185_000, 0],
        ["inventory", 0, 185_000],
        ["inventory", 0, 5_000],
        ["inventory_price_variance", 5_000, 0],
      ]),
    );
    assertBalanced(negative);

    // Zero: no variance lines at all.
    const zero = build("purchase_return.recorded", amounts(0));
    assert.deepEqual(byRole(zero), {
      grni: [185_000, 0],
      inventory: [0, 185_000],
    });
    assert.equal(zero.length, 2);
    assertBalanced(zero);
  });

  test("PRP-RULE-08 goods_receipt.recorded keeps its own purchase rule and has no purchase_return effect (out of scope, card legend-29vw)", () => {
    // Assumption: the brief forbids changing goods_receipt.recorded in this
    // change. Observed baseline: Dr inventory / Cr grni of the received value
    // under source type "purchase". The purchase_return rule must not be keyed
    // under it and no other rule may claim the purchase_return source type.
    const receipt = ruleOf("goods_receipt.recorded");
    assert.equal(receipt.eventName, "goods_receipt.recorded");
    assert.equal(receipt.sourceType, "purchase");
    assert.notEqual(receipt.key, ruleOf("purchase_return.recorded").key);
    const lines = acc.buildJournalLinesFromRule(
      receipt,
      { receivedValueIdr: 500_000 },
      map,
      { outletId: pettyRow.outletId },
    );
    assert.deepEqual(byRole(lines), {
      inventory: [500_000, 0],
      grni: [0, 500_000],
    });
    assertBalanced(lines);
    const returnRules = acc.defaultPostingRules.filter(
      (rule) => rule.sourceType === "purchase_return",
    );
    assert.deepEqual(
      returnRules.map((rule) => rule.eventName),
      ["purchase_return.recorded"],
    );
  });
});

describe("chart of accounts 5104 (Potongan A.3)", () => {
  test("PRP-COA-01 role petty_purchase_expense is an expense role and exists in the role list", () => {
    assert.equal(acc.POSTING_ACCOUNT_ROLES.petty_purchase_expense, "expense");
    assert.equal(acc.POSTING_ACCOUNT_ROLES.petty_cash, "asset");
    assert.equal(
      acc.postingAccountRoleSchema.safeParse("petty_purchase_expense").success,
      true,
    );
  });

  test("PRP-COA-02 the standard chart has 5104 Pembelian Langsung (Kas Kecil) under 5100, mapped to the role", () => {
    const row = acc.standardFnbChartTemplate.find(
      (candidate) => candidate.code === "5104",
    );
    assert.ok(row, "account 5104 is missing from the template");
    assert.equal(row.name, "Pembelian Langsung (Kas Kecil)");
    assert.equal(row.type, "expense");
    assert.equal(row.parentCode, "5100");
    assert.deepEqual(row.roles, ["petty_purchase_expense"]);
    const mapped = acc.standardFnbChartTemplate.filter((candidate) =>
      candidate.roles.includes("petty_purchase_expense"),
    );
    assert.equal(mapped.length, 1, "the role maps to one account only");
  });
});
