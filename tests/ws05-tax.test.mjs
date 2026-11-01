// Tax & service-charge back office (bead legend-efr; PRD v1.7 §3.14 F11/D13,
// R20/R21). Two layers:
//   - the pure helpers the screens use (effective-version lookup, rate/period
//     formatting, PBJT CSV), tested directly;
//   - the FE mock runtime behind VITE_API_MOCK, exercised through dispatchMock
//     so the handlers enforce the contract's versioning and idempotency rules
//     the API will enforce (the screens never change).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as tax from "../packages/shared/src/tax/index.ts";
import * as lib from "../apps/web/src/features/ws05-tax/lib.ts";
import "../apps/web/src/features/ws05-tax/mock.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";

const fixtures = tax.cafeLegendTaxFixtures;
const today = lib.businessDateToday();
const TAG = "legend-efr · F11 D13";

function fresh() {
  resetMocks();
}

function ruleBody(overrides = {}) {
  return {
    outletId: null,
    code: "PBJT-TEST",
    name: "PBJT uji",
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: "ID-JB-3273",
    channels: [],
    appliesTo: { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
    priceIncludesTax: false,
    includeServiceInBase: true,
    isActive: true,
    effectiveFrom: today,
    ...overrides,
  };
}

// ---- Pure helpers ----------------------------------------------------------

test(`${TAG} public API: rates render as id-ID percentages and parse back to basis points`, () => {
  assert.equal(lib.formatBasisPoints(1000), "10%");
  assert.equal(lib.formatBasisPoints(550), "5,5%");
  assert.equal(lib.formatBasisPoints(0), "0%");
  assert.equal(lib.parseRatePercent("10"), 1000);
  assert.equal(lib.parseRatePercent("5,5"), 550);
  assert.equal(lib.parseRatePercent("5.5"), 550);
  assert.equal(lib.parseRatePercent("10,123"), null);
  assert.equal(lib.parseRatePercent("101"), null);
  assert.equal(lib.parseRatePercent(""), null);
});

test(`${TAG} R20 effective dates pick the version; a future draft is not in force`, () => {
  const rules = fixtures.taxRules;
  const v1 = rules.find(
    (rule) => rule.code === "PBJT-FNB" && rule.version === 1,
  );
  const draft = rules.find(
    (rule) => rule.code === "PBJT-FNB" && rule.version === 2,
  );
  const facility = rules.find((rule) => rule.code === "PBJT-FASILITAS");
  assert.ok(v1 && draft && facility);
  assert.equal(lib.isEffectiveVersion(v1, rules, "2026-11-02"), true);
  assert.equal(lib.isEffectiveVersion(draft, rules, "2026-11-02"), false);
  assert.equal(lib.isEffectiveVersion(facility, rules, "2026-11-02"), true);
  // Before the first effective date nothing applies.
  assert.equal(lib.isEffectiveVersion(v1, rules, "2026-10-31"), false);
});

test(`${TAG} R21 a new version continues the code and starts after the latest one`, () => {
  const rules = fixtures.taxRules;
  assert.equal(lib.nextVersionNumber(rules, "PBJT-FNB", null), 3);
  assert.equal(lib.nextVersionNumber(rules, "PBJT-BARU", null), 1);
  // Latest published version is in the past: a change may start today.
  assert.equal(
    lib.suggestEffectiveFrom(
      rules.filter((rule) => rule.code === "PBJT-FNB"),
      "2026-11-02",
    ),
    "2026-11-02",
  );
  // A scheduled version pushes the next change to the day after it.
  assert.equal(
    lib.suggestEffectiveFrom(
      [
        { status: "published", effectiveFrom: "2027-01-01" },
        { status: "draft", effectiveFrom: "2026-12-01" },
      ],
      "2026-11-02",
    ),
    "2027-01-02",
  );
  assert.equal(lib.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(lib.addDays("2024-02-28", 1), "2024-02-29");
});

test(`${TAG} list filters search code and name plus the version status`, () => {
  const rules = fixtures.taxRules;
  assert.equal(
    lib.filterRuleVersions(rules, { search: "fasilitas", status: "all" })
      .length,
    1,
  );
  assert.equal(
    lib.filterRuleVersions(rules, { search: "", status: "draft" }).length,
    1,
  );
  assert.equal(
    lib.filterRuleVersions(rules, { search: "", status: "published" }).length,
    2,
  );
  assert.equal(
    lib.filterRuleVersions(rules, { search: "tidak-ada", status: "all" })
      .length,
    0,
  );
  const sorted = lib
    .sortRuleVersions(rules)
    .map((rule) => `${rule.code}@${rule.version}`);
  assert.deepEqual(sorted, ["PBJT-FASILITAS@1", "PBJT-FNB@2", "PBJT-FNB@1"]);
});

test(`${TAG} settings: the effective options version is the published one on the date`, () => {
  const settings = fixtures.settings;
  const current = lib.effectiveSettings(settings, "2026-11-02");
  assert.equal(current?.version, 1);
  assert.equal(current?.pricesIncludeTax, false);
  assert.equal(lib.effectiveSettings(settings, "2026-10-31"), undefined);
});

test(`${TAG} Laporan Pajak: the PBJT CSV carries every row and a totals line`, () => {
  const recap = fixtures.pbjtRecap;
  const headers = {
    code: "Kode",
    rate: "Tarif",
    transactions: "Transaksi",
    gross: "Bruto",
    base: "Dasar",
    service: "Service",
    tax: "Pajak",
    total: "Total",
  };
  const lines = lib.toPbjtCsv(recap, headers).trimEnd().split("\r\n");
  assert.equal(lines[0], "Kode,Tarif,Transaksi,Bruto,Dasar,Service,Pajak");
  assert.equal(
    lines[1],
    "PBJT-FNB,1000,4812,412350000,398120000,6240000,39812000",
  );
  assert.equal(lines[2], "PBJT-FASILITAS,1000,386,21840000,21840000,0,2184000");
  // Totals: row sums for the columns the recap does not total itself.
  assert.equal(lines[3], "Total,,5198,434190000,419960000,6240000,41996000");
  assert.equal(lib.pbjtRowTotals(recap).transactionCount, 5198);
  assert.equal(
    lib.pbjtCsvFileName("2026-11", recap.outletId),
    "pbjt-2026-11-6a2d4f80.csv",
  );
  assert.equal(lib.downloadTextFile("x.csv", "a,b"), false); // no DOM in Node
});

test(`${TAG} period helpers accept YYYY-MM and render the Indonesian month`, () => {
  assert.equal(lib.isTaxPeriod("2026-11"), true);
  assert.equal(lib.isTaxPeriod("2026-13"), false);
  assert.equal(lib.isTaxPeriod(undefined), false);
  assert.equal(lib.currentTaxPeriod("2026-11-02"), "2026-11");
  assert.equal(lib.formatTaxPeriod("2026-11"), "November 2026");
});

// ---- Mock runtime (VITE_API_MOCK) -----------------------------------------

test(`${TAG} mock: the rule list serves the fixtures, newest version per code`, async () => {
  fresh();
  const page = await dispatchMock({
    method: "GET",
    path: "/api/tax/rules",
    query: { limit: 100 },
  });
  assert.equal(page.data.length, fixtures.taxRules.length);
  assert.deepEqual(
    page.data.map((rule) => `${rule.code}@${rule.version}`),
    ["PBJT-FASILITAS@1", "PBJT-FNB@2", "PBJT-FNB@1"],
  );
  const drafts = await dispatchMock({
    method: "GET",
    path: "/api/tax/rules",
    query: { limit: 100, status: "draft" },
  });
  assert.deepEqual(
    drafts.data.map((rule) => rule.version),
    [2],
  );
});

test(`${TAG} mock: creating a draft inherits the exclusive price setting`, async () => {
  fresh();
  const created = await dispatchMock({
    method: "POST",
    path: "/api/tax/rules",
    body: ruleBody({ priceIncludesTax: undefined }),
  });
  assert.equal(created.data.status, "draft");
  assert.equal(created.data.version, 1);
  assert.equal(created.data.priceIncludesTax, false);
  assert.equal(created.data.publishedAt, null);
  assert.equal(tax.taxRuleSchema.safeParse(created.data).success, true);
});

test(`${TAG} R21 mock: publishing is idempotent and makes the version immutable`, async () => {
  fresh();
  const created = await dispatchMock({
    method: "POST",
    path: "/api/tax/rules",
    body: ruleBody(),
  });
  const publishPath = `/api/tax/rules/${created.data.id}/publish`;
  const first = await dispatchMock({
    method: "POST",
    path: publishPath,
    body: { idempotencyKey: "publish-key-0001" },
  });
  assert.equal(first.data.status, "published");
  assert.equal(first.data.publishedAt !== null, true);
  assert.equal(first.data.publishedBy, fixtures.financeUserId);

  // Same key + same version → the recorded answer, no double publish.
  const replay = await dispatchMock({
    method: "POST",
    path: publishPath,
    body: { idempotencyKey: "publish-key-0001" },
  });
  assert.deepEqual(replay, first);

  // Any other publish attempt on a published version is refused.
  await assert.rejects(
    dispatchMock({
      method: "POST",
      path: publishPath,
      body: { idempotencyKey: "publish-key-0002" },
    }),
    (error) => error.code === "TAX_RULE_IMMUTABLE" && error.status === 409,
  );

  // Editing a published version is refused too.
  await assert.rejects(
    dispatchMock({
      method: "PATCH",
      path: `/api/tax/rules/${created.data.id}`,
      body: { name: "Ubah terbit" },
    }),
    (error) => error.code === "TAX_RULE_IMMUTABLE",
  );
});

test(`${TAG} R21 mock: a backdated effective date cannot be published`, async () => {
  fresh();
  const created = await dispatchMock({
    method: "POST",
    path: "/api/tax/rules",
    body: ruleBody({ effectiveFrom: "2020-01-01" }),
  });
  await assert.rejects(
    dispatchMock({
      method: "POST",
      path: `/api/tax/rules/${created.data.id}/publish`,
      body: { idempotencyKey: "publish-backdated-01" },
    }),
    (error) => error.code === "TAX_RULE_BACKDATED" && error.status === 422,
  );
});

test(`${TAG} mock: service-charge rules keep zone, order types and classes`, async () => {
  fresh();
  const created = await dispatchMock({
    method: "POST",
    path: "/api/tax/service-charge-rules",
    body: {
      outletId: null,
      code: "SC-UJI",
      name: "Service charge uji",
      rateBp: 500,
      zoneId: null,
      orderTypes: ["dine_in"],
      itemClasses: ["food_beverage"],
      isActive: true,
      effectiveFrom: today,
    },
  });
  assert.equal(created.data.zoneId, null);
  assert.deepEqual(created.data.orderTypes, ["dine_in"]);

  const published = await dispatchMock({
    method: "POST",
    path: `/api/tax/service-charge-rules/${created.data.id}/publish`,
    body: { idempotencyKey: "publish-sc-0001" },
  });
  assert.equal(published.data.status, "published");

  const page = await dispatchMock({
    method: "GET",
    path: "/api/tax/service-charge-rules",
    query: { limit: 100 },
  });
  assert.equal(page.data.length, fixtures.serviceChargeRules.length + 1);
});

test(`${TAG} mock: settings version drafts can be published, then apply`, async () => {
  fresh();
  const created = await dispatchMock({
    method: "POST",
    path: "/api/tax/settings",
    body: {
      outletId: null,
      calculationOrder: "discount_service_tax",
      pricesIncludeTax: true,
      serviceRoundingMode: "half_even",
      taxRoundingMode: "half_up",
      inclusiveBaseRoundingMode: "half_up",
      billRounding: { incrementIdr: 100, mode: "half_up" },
      packageAllocation: "fixed_bp",
      effectiveFrom: today,
    },
  });
  assert.equal(created.data.version, 2);
  assert.equal(created.data.status, "draft");

  const published = await dispatchMock({
    method: "POST",
    path: `/api/tax/settings/${created.data.id}/publish`,
    body: { idempotencyKey: "publish-settings-01" },
  });
  assert.equal(published.data.status, "published");

  const page = await dispatchMock({
    method: "GET",
    path: "/api/tax/settings",
    query: { limit: 100 },
  });
  const current = lib.effectiveSettings(page.data, today);
  assert.equal(current?.id, created.data.id);
  assert.equal(current?.pricesIncludeTax, true);
});

test(`${TAG} Laporan Pajak mock: the fixture month has rows, other months are empty`, async () => {
  fresh();
  const recap = await dispatchMock({
    method: "GET",
    path: "/api/tax/reports/pbjt",
    query: {
      outletId: fixtures.pbjtRecap.outletId,
      period: fixtures.pbjtRecap.period,
    },
  });
  assert.equal(recap.data.rows.length, 2);
  assert.equal(recap.data.totalTaxIdr, 41_996_000);
  assert.equal(recap.data.regionCode, "ID-JB-3273");

  const other = await dispatchMock({
    method: "GET",
    path: "/api/tax/reports/pbjt",
    query: { outletId: fixtures.pbjtRecap.outletId, period: "2026-12" },
  });
  assert.deepEqual(other.data.rows, []);
  assert.equal(other.data.totalTaxIdr, 0);

  setScenario("empty");
  const empty = await dispatchMock({
    method: "GET",
    path: "/api/tax/reports/pbjt",
    query: {
      outletId: fixtures.pbjtRecap.outletId,
      period: fixtures.pbjtRecap.period,
    },
  });
  assert.deepEqual(empty.data.rows, []);
});
