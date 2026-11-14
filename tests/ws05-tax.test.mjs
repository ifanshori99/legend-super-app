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
    priceMode: "Mode",
    priceModeIncluded: "Termasuk",
    priceModeExcluded: "Belum",
    transactions: "Transaksi",
    gross: "Bruto",
    base: "Dasar",
    service: "Service",
    tax: "Pajak",
    total: "Total",
  };
  const lines = lib.toPbjtCsv(recap, headers).trimEnd().split("\r\n");
  assert.equal(lines[0], "Kode,Tarif,Mode,Transaksi,Bruto,Dasar,Service,Pajak");
  assert.equal(
    lines[1],
    "PBJT-FNB,1000,Belum,4812,412350000,398120000,6240000,39812000",
  );
  assert.equal(
    lines[2],
    "PBJT-FASILITAS,1000,Belum,386,21840000,21840000,0,2184000",
  );
  // Totals: row sums for the columns the recap does not total itself.
  assert.equal(lines[3], "Total,,,5198,434190000,419960000,6240000,41996000");
  assert.equal(lib.pbjtRowTotals(recap).transactionCount, 5198);
  assert.equal(
    lib.pbjtCsvFileName("2026-11", recap.outletId),
    "pbjt-2026-11-6a2d4f80.csv",
  );
  assert.equal(lib.downloadTextFile("x.csv", "a,b"), false); // no DOM in Node
});

test(`${TAG} Laporan Pajak: CSV neutralizes formula-looking rule codes (CSV injection)`, () => {
  const base = fixtures.pbjtRecap;
  const recap = {
    ...base,
    rows: [{ ...base.rows[0], taxRuleCode: '=HYPERLINK("x","y")' }],
  };
  const headers = {
    code: "Kode",
    rate: "Tarif",
    priceMode: "Mode",
    priceModeIncluded: "Termasuk",
    priceModeExcluded: "Belum",
    transactions: "Transaksi",
    gross: "Bruto",
    base: "Dasar",
    service: "Service",
    tax: "Pajak",
    total: "Total",
  };
  const lines = lib.toPbjtCsv(recap, headers).trimEnd().split("\r\n");
  assert.ok(lines[1].startsWith(`"'=HYPERLINK(""x"",""y"")"`), lines[1]);
  for (const prefix of ["+", "-", "@"]) {
    const row = { ...base.rows[0], taxRuleCode: `${prefix}1` };
    const csv = lib.toPbjtCsv({ ...base, rows: [row] }, headers);
    assert.equal(csv.split("\r\n")[1].split(",")[0], `'${prefix}1`);
  }
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

// ---- legend-d5pz: warn before switching off the last food_beverage rule -----

function fbVersion(overrides = {}) {
  const code = overrides.code ?? "FB";
  return {
    id: overrides.id ?? `${code}-${overrides.version ?? 1}`,
    code,
    name: code,
    version: 1,
    status: "published",
    effectiveFrom: "2026-01-01",
    outletId: null,
    isActive: true,
    channels: [],
    regionCode: null,
    appliesTo: {
      itemClasses: ["food_beverage"],
      categoryIds: [],
      itemIds: [],
    },
    ...overrides,
  };
}

test("isOnlyActiveFoodBeverageRule: the only rule in force is the last one", () => {
  const rules = [fbVersion()];
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      rules,
      { code: "FB", outletId: null },
      "2026-11-11",
    ),
    true,
  );
});

test("isOnlyActiveFoodBeverageRule: an unrestricted active rule with another code replaces it", () => {
  const rules = [fbVersion(), fbVersion({ code: "FB2" })];
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      rules,
      { code: "FB", outletId: null },
      "2026-11-11",
    ),
    false,
  );
});

test("isOnlyActiveFoodBeverageRule: a limited, inactive or facility-only rule is no replacement", () => {
  const chain = { code: "FB", outletId: null };
  const date = "2026-11-11";
  for (const other of [
    fbVersion({ code: "X", channels: ["dine_in"] }),
    fbVersion({ code: "X", regionCode: "ID-JB-3273" }),
    fbVersion({
      code: "X",
      appliesTo: {
        itemClasses: ["food_beverage"],
        categoryIds: [],
        itemIds: ["0d7a9d6e-1111-4111-8111-111111111111"],
      },
    }),
    fbVersion({
      code: "X",
      appliesTo: {
        itemClasses: ["food_beverage"],
        categoryIds: ["0d7a9d6e-2222-4222-8222-222222222222"],
        itemIds: [],
      },
    }),
    fbVersion({ code: "X", isActive: false }),
    fbVersion({
      code: "X",
      appliesTo: { itemClasses: ["facility"], categoryIds: [], itemIds: [] },
    }),
    // Not in force yet on the date.
    fbVersion({ code: "X", effectiveFrom: "2027-02-01" }),
    fbVersion({ code: "X", status: "draft" }),
  ]) {
    assert.equal(
      lib.isOnlyActiveFoodBeverageRule([fbVersion(), other], chain, date),
      true,
      JSON.stringify(other),
    );
  }
});

test("isOnlyActiveFoodBeverageRule: a replacement switched off by an outlet version does not count", () => {
  const outlet = "0d7a9d6e-3333-4333-8333-333333333333";
  const rules = [
    fbVersion(),
    fbVersion({ code: "X" }),
    fbVersion({ code: "X", id: "X-outlet", outletId: outlet, isActive: false }),
  ];
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      rules,
      { code: "FB", outletId: null },
      "2026-11-11",
    ),
    true,
  );
  // An outlet version that is itself a full cover keeps the replacement.
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      [
        fbVersion(),
        fbVersion({ code: "X" }),
        fbVersion({ code: "X", id: "X-outlet", outletId: outlet }),
      ],
      { code: "FB", outletId: null },
      "2026-11-11",
    ),
    false,
  );
});

test("isOnlyActiveFoodBeverageRule: judged at the change date, not today", () => {
  const rules = [
    fbVersion(),
    fbVersion({ code: "NEW", effectiveFrom: "2027-01-01" }),
  ];
  const chain = { code: "FB", outletId: null };
  // Today the new rule is not yet in force, so FB is the last one.
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(rules, chain, "2026-11-11"),
    true,
  );
  // A change that starts after the replacement begins is safe.
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(rules, chain, "2027-01-01"),
    false,
  );
});

test("isOnlyActiveFoodBeverageRule: a chain with nothing in force, already off, or facility-only has nothing to lose", () => {
  const chain = { code: "FB", outletId: null };
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule([], chain, "2026-11-11"),
    false,
  );
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      [fbVersion({ isActive: false })],
      chain,
      "2026-11-11",
    ),
    false,
  );
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      [fbVersion({ status: "draft" })],
      chain,
      "2026-11-11",
    ),
    false,
  );
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      [
        fbVersion({
          appliesTo: {
            itemClasses: ["facility"],
            categoryIds: [],
            itemIds: [],
          },
        }),
      ],
      chain,
      "2026-11-11",
    ),
    false,
  );
});

test("isOnlyActiveFoodBeverageRule: an outlet chain accepts a tenant-wide replacement but not another outlet's", () => {
  const outletA = "0d7a9d6e-4444-4444-8444-444444444444";
  const outletB = "0d7a9d6e-5555-4555-8555-555555555555";
  const own = fbVersion({ outletId: outletA });
  const chain = { code: "FB", outletId: outletA };
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      [own, fbVersion({ code: "T" })],
      chain,
      "2026-11-11",
    ),
    false,
  );
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      [own, fbVersion({ code: "B", outletId: outletB })],
      chain,
      "2026-11-11",
    ),
    true,
  );
});

test("isOnlyActiveFoodBeverageRule: an outlet override only disqualifies a replacement for its own outlet", () => {
  const outletA = "0d7a9d6e-6666-4666-8666-666666666666";
  const outletB = "0d7a9d6e-7777-4777-8777-777777777777";
  const own = fbVersion({ outletId: outletA });
  const chain = { code: "FB", outletId: outletA };
  const replacement = fbVersion({ code: "X" });
  // X is switched off at outlet B only: still a safety net for outlet A.
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      [
        own,
        replacement,
        fbVersion({ code: "X", id: "X-b", outletId: outletB, isActive: false }),
      ],
      chain,
      "2026-11-11",
    ),
    false,
  );
  // X is switched off at outlet A itself: no safety net there.
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      [
        own,
        replacement,
        fbVersion({ code: "X", id: "X-a", outletId: outletA, isActive: false }),
      ],
      chain,
      "2026-11-11",
    ),
    true,
  );
  // For a tenant-wide chain any outlet override that is off disqualifies it.
  assert.equal(
    lib.isOnlyActiveFoodBeverageRule(
      [
        fbVersion(),
        replacement,
        fbVersion({ code: "X", id: "X-b", outletId: outletB, isActive: false }),
      ],
      { code: "FB", outletId: null },
      "2026-11-11",
    ),
    true,
  );
});

function nextRule(overrides = {}) {
  return {
    isActive: true,
    appliesTo: {
      itemClasses: ["food_beverage"],
      categoryIds: [],
      itemIds: [],
    },
    channels: [],
    regionCode: null,
    ...overrides,
  };
}

function loss(overrides = {}) {
  return lib.foodBeverageCoverLoss({
    publishedRules: [fbVersion()],
    loadedRules: [fbVersion()],
    chain: { code: "FB", outletId: null },
    date: "2026-11-11",
    mustExist: true,
    next: nextRule(),
    ...overrides,
  });
}

test("foodBeverageCoverLoss: an unchanged full cover is safe", () => {
  assert.equal(loss(), null);
});

test("foodBeverageCoverLoss: switching off or dropping food_beverage warns", () => {
  assert.equal(loss({ next: nextRule({ isActive: false }) }), "inactive");
  assert.equal(
    loss({
      next: nextRule({
        appliesTo: { itemClasses: ["facility"], categoryIds: [], itemIds: [] },
      }),
    }),
    "class",
  );
});

test("foodBeverageCoverLoss: adding a channel, region, category or item limit to the last full cover warns", () => {
  const limited = [
    nextRule({ channels: ["dine_in"] }),
    nextRule({ regionCode: "ID-JB-3273" }),
    nextRule({
      appliesTo: {
        itemClasses: ["food_beverage"],
        categoryIds: ["0d7a9d6e-8888-4888-8888-888888888888"],
        itemIds: [],
      },
    }),
    nextRule({
      appliesTo: {
        itemClasses: ["food_beverage"],
        categoryIds: [],
        itemIds: ["0d7a9d6e-9999-4999-8999-999999999999"],
      },
    }),
  ];
  for (const next of limited)
    assert.equal(loss({ next }), "narrowed", JSON.stringify(next));
});

test("foodBeverageCoverLoss: narrowing is safe when another full cover exists or the rule was already limited", () => {
  const next = nextRule({ channels: ["dine_in"] });
  const withReplacement = [fbVersion(), fbVersion({ code: "X" })];
  assert.equal(loss({ publishedRules: withReplacement, next }), null);
  const alreadyLimited = [fbVersion({ channels: ["takeaway"] })];
  assert.equal(loss({ publishedRules: alreadyLimited, next }), null);
  assert.equal(
    loss({
      publishedRules: alreadyLimited,
      next: nextRule({ isActive: false }),
    }),
    "inactive",
  );
});

test("foodBeverageCoverLoss: a change with nothing in force to lose is safe", () => {
  assert.equal(
    loss({ publishedRules: [], next: nextRule({ isActive: false }) }),
    null,
  );
  assert.equal(
    loss({
      publishedRules: [fbVersion({ effectiveFrom: "2027-03-01" })],
      next: nextRule({ isActive: false }),
    }),
    null,
  );
});

test("foodBeverageCoverLoss: without the published list it warns when the rule must exist or the typed code is known", () => {
  const off = nextRule({ isActive: false });
  // Editing or versioning an existing rule: unsure, so warn.
  assert.equal(
    loss({ publishedRules: undefined, loadedRules: [], next: off }),
    "inactive",
  );
  // Creating with a code the loaded list already has: warn.
  assert.equal(
    loss({
      publishedRules: undefined,
      loadedRules: [fbVersion()],
      mustExist: false,
      next: off,
    }),
    "inactive",
  );
  assert.equal(
    loss({
      publishedRules: undefined,
      loadedRules: [fbVersion()],
      mustExist: false,
      next: nextRule({ channels: ["dine_in"] }),
    }),
    "narrowed",
  );
  // Creating a brand-new code, or the same code at another outlet: nothing to lose.
  assert.equal(
    loss({
      publishedRules: undefined,
      loadedRules: [fbVersion()],
      chain: { code: "NEW", outletId: null },
      mustExist: false,
      next: off,
    }),
    null,
  );
  assert.equal(
    loss({
      publishedRules: undefined,
      loadedRules: [
        fbVersion({ outletId: "0d7a9d6e-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      ],
      mustExist: false,
      next: off,
    }),
    null,
  );
  // A safe edit never warns, data or not.
  assert.equal(
    loss({ publishedRules: undefined, loadedRules: [], next: nextRule() }),
    null,
  );
});
