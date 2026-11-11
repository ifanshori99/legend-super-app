import assert from "node:assert/strict";
import { test } from "node:test";
import * as platform from "../packages/shared/src/platform/index.ts";
import * as tax from "../packages/shared/src/tax/index.ts";

const fixtures = tax.cafeLegendTaxFixtures;
const source = fixtures.taxRules[0];
const codec = () => {
  const value = platform.CONFIG_SECTION_CODECS.tax_rules;
  assert.ok(value, "legend-j568k: tax_rules codec is registered");
  return value;
};

test("legend-j568k: export selects latest published tenant-wide tax rules without identifiers", () => {
  const rows = [
    source,
    {
      ...source,
      id: crypto.randomUUID(),
      version: 2,
      rateBp: 1500,
      effectiveFrom: "2026-12-01",
    },
    {
      ...source,
      id: crypto.randomUUID(),
      version: 3,
      status: "draft",
      publishedAt: null,
      publishedBy: null,
      rateBp: 9999,
    },
    {
      ...source,
      id: crypto.randomUUID(),
      code: "OUTLET",
      outletId: fixtures.privateRoomBill.outletId,
    },
    {
      ...source,
      id: crypto.randomUUID(),
      code: "ARCHIVED",
      status: "archived",
      publishedAt: null,
      publishedBy: null,
    },
  ];
  const items = codec().toTemplate(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "tenant.pbjt-fnb");
  assert.equal(items[0].rateBp, 1500);
  assert.equal(items[0].effectiveFrom, "2026-12-01");
  assert.equal(items[0].outletKey, null);
  assert.equal(items[0].kind, "rule");
  assert.deepEqual(items[0].appliesTo, { itemClasses: ["food_beverage"] });
  assert.deepEqual(
    platform.findBundleIdentifiers(
      items,
      rows.map((row) => row.id).concat(source.tenantId, source.publishedBy),
    ),
    [],
  );
  assert.deepEqual(codec().toTemplate(rows.toReversed()), items);
  assert.equal(
    platform.configSectionItemSchemas.tax_rules.safeParse(items[0]).success,
    true,
  );
});

test("legend-j568k: import preserves rate, tax base flags, tombstones and effective date as unpublished drafts", () => {
  const [item] = codec().toTemplate([{ ...source, isActive: false }]);
  const decoded = codec().fromTemplate([item]);
  assert.equal(decoded.ok, true);
  const [draft] = decoded.drafts;
  assert.equal(draft.status, "draft");
  assert.equal(draft.version, 1);
  assert.equal(draft.rateBp, source.rateBp);
  assert.equal(draft.priceIncludesTax, source.priceIncludesTax);
  assert.equal(draft.includeServiceInBase, source.includeServiceInBase);
  assert.equal(draft.effectiveFrom, source.effectiveFrom);
  assert.equal(draft.isActive, false);
  assert.deepEqual(draft.appliesTo, source.appliesTo);
  for (const field of [
    "id",
    "tenantId",
    "outletId",
    "publishedAt",
    "publishedBy",
    "createdAt",
  ]) {
    assert.equal(Object.hasOwn(draft, field), false, field);
  }
});

test("legend-j568k: invalid rates, dates, scope identifiers and duplicate rule identities are refused", () => {
  const [item] = codec().toTemplate([source]);
  for (const fields of [
    { rateBp: -1 },
    { rateBp: 10001 },
    { rateBp: 0.5 },
    { effectiveFrom: "2026-02-30" },
    { tenantId: source.tenantId },
    { appliesTo: { itemClasses: ["food_beverage"], itemIds: [source.id] } },
    { appliesTo: { itemClasses: [] } },
  ]) {
    assert.equal(
      codec().fromTemplate([{ ...item, ...fields }]).ok,
      false,
      JSON.stringify(fields),
    );
  }
  assert.equal(codec().fromTemplate([item, item]).ok, false);
  assert.equal(
    codec().fromTemplate([item, { ...item, key: "another-key" }]).ok,
    false,
  );
  assert.throws(
    () =>
      codec().toTemplate([
        { ...source, appliesTo: { ...source.appliesTo, itemIds: [source.id] } },
      ]),
    /menu|portable|target/i,
  );
  assert.throws(
    () =>
      codec().toTemplate([
        source,
        {
          ...source,
          id: crypto.randomUUID(),
          tenantId: crypto.randomUUID(),
          code: "OTHER",
        },
      ]),
    /tenant/i,
  );
});

test("legend-j568k: legacy API rules and settings remain accepted without invented effective dates", () => {
  const [rule] = codec().toTemplate([source]);
  delete rule.effectiveFrom;
  const settings = {
    key: "settings.tenant",
    kind: "settings",
    outletKey: null,
    calculationOrder: "discount_service_tax",
    pricesIncludeTax: false,
    serviceRoundingMode: "half_up",
    taxRoundingMode: "half_up",
    inclusiveBaseRoundingMode: "half_up",
    billRounding: null,
    packageAllocation: "fixed_bp",
  };
  assert.equal(codec().itemSchema.safeParse(settings).success, true);
  const decoded = codec().fromTemplate([rule, settings]);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.drafts.length, 2);
  assert.equal(decoded.drafts[0].effectiveFrom, undefined);
  assert.equal(decoded.drafts[1].status, "draft");
});

test("legend-j568k: tax codec round-trip preserves customer total and outlet tax liability", () => {
  const { privateRoomBill, settings, serviceChargeRules } = fixtures;
  for (const priceIncludesTax of [false, true]) {
    const rows = fixtures.taxRules.map((rule) => ({
      ...rule,
      priceIncludesTax,
    }));
    const decoded = codec().fromTemplate(codec().toTemplate(rows));
    assert.equal(decoded.ok, true);
    const restored = decoded.drafts.map((draft) => {
      const original = rows.find(
        (row) => row.code === draft.code && row.status === "published",
      );
      const { key, kind, outletKey, ...fields } = draft;
      assert.equal(typeof key, "string");
      assert.equal(kind, "rule");
      assert.equal(outletKey, null);
      return tax.taxRuleSchema.parse({
        ...original,
        ...fields,
        status: "published",
      });
    });
    // Publishing belongs to the importer; the pure codec never authorizes it.
    const before = tax.calculateTax(privateRoomBill, {
      taxRules: rows,
      settings,
      serviceChargeRules,
    });
    const after = tax.calculateTax(privateRoomBill, {
      taxRules: restored,
      settings,
      serviceChargeRules,
    });
    for (const amount of [
      "grossIdr",
      "discountIdr",
      "baseIdr",
      "roundingIdr",
      "totalIdr",
      "taxIdr",
      "serviceChargeIdr",
    ]) {
      assert.equal(after[amount], before[amount], amount);
    }
  }
});
