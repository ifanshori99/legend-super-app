import assert from "node:assert/strict";
import { test } from "node:test";
import * as tax from "../packages/shared/src/tax/index.ts";
import { eventCatalogByName } from "../packages/shared/src/events/index.ts";

const f = tax.cafeLegendTaxFixtures;
const config = {
  taxRules: f.taxRules,
  serviceChargeRules: f.serviceChargeRules,
  settings: f.settings,
};
const fnbRule = f.taxRules[0];
const settings = f.settings[0];
const throwsCode = (fn, code) =>
  assert.throws(
    fn,
    (error) => error instanceof tax.TaxError && error.code === code,
  );
const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);
const line = (overrides = {}) => ({
  lineId: "X1",
  itemId: f.privateRoomBill.lines[0].itemId,
  categoryId: f.privateRoomBill.lines[0].categoryId,
  itemClass: "food_beverage",
  grossIdr: 100_000,
  discountIdr: 0,
  components: [],
  ...overrides,
});
const bill = (overrides = {}) => ({
  ...f.privateRoomBill,
  zoneId: null,
  orderDiscountIdr: 0,
  lines: [line()],
  ...overrides,
});

test("F11 D13 fixtures parse: default PBJT 10% for F&B in Kota Bandung", () => {
  for (const rule of f.taxRules) tax.taxRuleSchema.parse(rule);
  for (const rule of f.serviceChargeRules)
    tax.serviceChargeRuleSchema.parse(rule);
  for (const row of f.settings) tax.taxSettingsSchema.parse(row);
  tax.taxCalculationInputSchema.parse(f.privateRoomBill);
  tax.pbjtMonthlyRecapSchema.parse(f.pbjtRecap);
  assert.equal(fnbRule.code, "PBJT-FNB");
  assert.equal(fnbRule.taxType, "pbjt");
  assert.equal(fnbRule.rateBp, 1000);
  assert.equal(fnbRule.regionCode, tax.BANDUNG_REGION);
});

test("F11 ORD-03 calc order discount -> service -> tax on the Private Room bill", () => {
  const result = tax.calculateTax(f.privateRoomBill, config);
  tax.taxCalculationResultSchema.parse(result);
  // Owner decision (2026-11-01): the menu prices in grossIdr exclude tax and
  // service charge, so both are added on top at checkout (never backed out).
  // Order discount 10,000 spread pro rata over nets 56,000/40,000/34,000/51,000
  // (largest remainder): 3,094 / 2,210 / 1,878 / 2,818.
  assert.deepEqual(
    result.lines.map((l) => l.discountIdr),
    [3_094, 7_210, 1_878, 2_818],
  );
  // F&B group with 5% Private Room service in the PBJT base:
  // N = 122,818; service half_up(6,140.9) = 6,141; tax half_up(12,895.9) = 12,896.
  // Facility component (shower): no service, tax half_up(4,818.2) = 4,818.
  assert.equal(result.grossIdr, 186_000);
  assert.equal(result.discountIdr, 15_000);
  assert.equal(result.baseIdr, 171_000);
  assert.equal(result.serviceChargeIdr, 6_141);
  assert.equal(result.taxIdr, 17_714);
  assert.equal(result.roundingIdr, 0);
  assert.equal(result.totalIdr, 194_855);
  const byCode = Object.fromEntries(result.taxes.map((t) => [t.code, t]));
  assert.equal(byCode["PBJT-FNB"].taxBaseIdr, 128_959);
  assert.equal(byCode["PBJT-FNB"].taxIdr, 12_896);
  assert.equal(byCode["PBJT-FASILITAS"].taxBaseIdr, 48_182);
  assert.equal(byCode["PBJT-FASILITAS"].taxIdr, 4_818);
});

test("F11 owner decision: tenant default prices are exclusive; inclusive stays opt-in", () => {
  // Owner decision 2026-11-01: menu prices exclude tax and service charge; both
  // appear at checkout (QR web + POS). The tenant setting is the default and
  // every published menu rule below follows it.
  assert.equal(settings.pricesIncludeTax, false);
  const inForce = tax.effectiveRuleVersions(
    f.taxRules,
    f.privateRoomBill.outletId,
    "2026-11-02",
  );
  assert.equal(inForce.length, 2);
  for (const rule of inForce) assert.equal(rule.priceIncludesTax, false);

  // A rule created without a mode inherits the tenant default instead of an
  // implicit inclusive fallback; an explicit inclusive rule is still accepted
  // as opt-in configuration.
  const draftInput = {
    outletId: null,
    code: "PBJT-FNB",
    name: "PBJT Makanan dan Minuman",
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: tax.BANDUNG_REGION,
    channels: [],
    appliesTo: {
      itemClasses: ["food_beverage"],
      categoryIds: [],
      itemIds: [],
    },
    includeServiceInBase: true,
    isActive: true,
    effectiveFrom: "2026-12-01",
  };
  assert.equal(
    tax.createTaxRuleInputSchema.safeParse(draftInput).success,
    true,
  );
  assert.equal(
    tax.createTaxRuleInputSchema.safeParse({
      ...draftInput,
      priceIncludesTax: true,
    }).success,
    true,
  );

  // The settings write contract carries the default explicitly.
  const settingsInput = {
    outletId: null,
    calculationOrder: "discount_service_tax",
    serviceRoundingMode: "half_up",
    taxRoundingMode: "half_up",
    inclusiveBaseRoundingMode: "half_up",
    billRounding: null,
    packageAllocation: "fixed_bp",
    effectiveFrom: "2026-11-01",
  };
  assert.equal(
    tax.createTaxSettingsInputSchema.safeParse({
      ...settingsInput,
      pricesIncludeTax: false,
    }).success,
    true,
  );
  assert.equal(
    tax.createTaxSettingsInputSchema.safeParse(settingsInput).success,
    false,
  );

  // Hand-checked Private Room example: 186,000 menu prices - 15,000 discount
  // = 171,000 base, + 6,141 service + 17,714 tax = 194,855 at checkout.
  const result = tax.calculateTax(f.privateRoomBill, config);
  assert.equal(result.baseIdr, result.grossIdr - result.discountIdr);
  assert.ok(result.serviceChargeIdr > 0);
  assert.ok(result.taxIdr > 0);
  assert.equal(
    result.totalIdr,
    result.baseIdr + result.serviceChargeIdr + result.taxIdr,
  );
});

test("ORD-06 per-line allocation sums exactly to the bill totals", () => {
  const result = tax.calculateTax(f.privateRoomBill, config);
  assert.equal(sum(result.lines, "baseIdr"), result.baseIdr);
  assert.equal(sum(result.lines, "serviceChargeIdr"), result.serviceChargeIdr);
  assert.equal(sum(result.lines, "taxIdr"), result.taxIdr);
  assert.equal(
    sum(result.lines, "totalIdr"),
    result.totalIdr - result.roundingIdr,
  );
  assert.equal(sum(result.taxes, "taxIdr"), result.taxIdr);
  for (const l of result.lines)
    assert.equal(l.totalIdr, l.baseIdr + l.serviceChargeIdr + l.taxIdr);
});

test("A20 mixed package splits price per component and taxes each by its own rule", () => {
  const result = tax.calculateTax(f.privateRoomBill, config);
  const pkg = result.lines.filter((l) => l.lineId === "L3");
  assert.equal(pkg.length, 2);
  assert.deepEqual(
    pkg.map((l) => l.grossIdr),
    [34_000, 51_000],
  ); // 40% / 60%
  assert.deepEqual(
    pkg.map((l) => l.itemClass),
    ["food_beverage", "facility"],
  );
  assert.equal(pkg[0].taxRuleId, f.taxRules[0].id);
  assert.equal(pkg[1].taxRuleId, f.taxRules[1].id);
  assert.equal(pkg[1].serviceChargeIdr, 0);

  // standalone_price_ratio (30,000 : 60,000) is a config switch, not code.
  const ratio = {
    ...settings,
    id: settings.id,
    packageAllocation: "standalone_price_ratio",
  };
  const pkgOnly = bill({ lines: [f.privateRoomBill.lines[2]] });
  const r2 = tax.calculateTax(pkgOnly, { ...config, settings: [ratio] });
  assert.deepEqual(
    r2.lines.map((l) => l.grossIdr),
    [28_333, 56_667],
  );

  const broken = structuredClone(f.privateRoomBill.lines[2]);
  broken.components[0].allocationBp = 3000;
  throwsCode(
    () => tax.calculateTax(bill({ lines: [broken] }), config),
    "TAX_PACKAGE_ALLOCATION_INVALID",
  );
  assert.equal(
    tax.taxableLineSchema.safeParse({
      ...broken,
      components: [broken.components[0]],
    }).success,
    false,
  );
});

test("F11 tax-inclusive prices back out base, service and tax exactly", () => {
  const inclusive = (includeServiceInBase) => ({
    ...config,
    taxRules: [{ ...fnbRule, priceIncludesTax: true, includeServiceInBase }],
  });
  // No service: 110,000 nett = 100,000 + 10,000 PBJT.
  const a = tax.calculateTax(
    bill({ lines: [line({ grossIdr: 110_000 })] }),
    inclusive(true),
  );
  assert.equal(a.baseIdr, 100_000);
  assert.equal(a.taxIdr, 10_000);
  assert.equal(a.totalIdr, 110_000);
  // 5% service in base: 115,500 = 100,000 x 1.05 x 1.10.
  const zoned = bill({
    zoneId: f.privateRoomBill.zoneId,
    lines: [line({ grossIdr: 115_500 })],
  });
  const b = tax.calculateTax(zoned, inclusive(true));
  assert.deepEqual(
    [b.baseIdr, b.serviceChargeIdr, b.taxIdr, b.totalIdr],
    [100_000, 5_000, 10_500, 115_500],
  );
  // Service outside base: 115,000 = 100,000 x (1 + 0.05 + 0.10).
  const c = tax.calculateTax(
    { ...zoned, lines: [line({ grossIdr: 115_000 })] },
    inclusive(false),
  );
  assert.deepEqual(
    [c.baseIdr, c.serviceChargeIdr, c.taxIdr],
    [100_000, 5_000, 10_000],
  );
  // An awkward price still sums exactly to what the guest pays.
  const d = tax.calculateTax(
    { ...zoned, lines: [line({ grossIdr: 28_001 })] },
    inclusive(true),
  );
  assert.equal(d.baseIdr + d.serviceChargeIdr + d.taxIdr, 28_001);
});

test("F11 rounding modes and cash rounding increment come from settings data", () => {
  const exclusive = bill({ lines: [line({ grossIdr: 28_005 })] });
  const up = tax.calculateTax(exclusive, config); // 2,800.5 half_up -> 2,801
  assert.equal(up.taxIdr, 2_801);
  const down = tax.calculateTax(exclusive, {
    ...config,
    settings: [{ ...settings, taxRoundingMode: "down" }],
  });
  assert.equal(down.taxIdr, 2_800);
  const cash = tax.calculateTax(f.privateRoomBill, {
    ...config,
    settings: [
      { ...settings, billRounding: { incrementIdr: 100, mode: "half_up" } },
    ],
  });
  assert.equal(cash.totalIdr, 194_900);
  assert.equal(cash.roundingIdr, 45);
  assert.equal(cash.taxIdr, 17_714); // rounding never touches the tax base
});

test("R21 versioning: effective date picks the version, tombstones stop a code, outlet overrides tenant", () => {
  const outletId = f.privateRoomBill.outletId;
  const v2 = {
    ...f.taxRules[2],
    status: "published",
    publishedAt: "2026-12-20T00:00:00.000Z",
    publishedBy: f.financeUserId,
  };
  const rules = [fnbRule, v2];
  assert.equal(
    tax.effectiveRuleVersions(rules, outletId, "2026-12-31")[0].version,
    1,
  );
  assert.equal(
    tax.effectiveRuleVersions(rules, outletId, "2027-01-01")[0].version,
    2,
  );
  // Drafts never apply.
  assert.equal(
    tax.effectiveRuleVersions([f.taxRules[2]], outletId, "2027-02-01").length,
    0,
  );
  const tomb = { ...v2, isActive: false };
  assert.equal(
    tax.effectiveRuleVersions([fnbRule, tomb], outletId, "2027-01-02").length,
    0,
  );
  const outletVersion = {
    ...fnbRule,
    id: "7a000000-0000-4000-8000-000000000099",
    outletId,
    rateBp: 0,
  };
  const inForce = tax.effectiveRuleVersions(
    [fnbRule, outletVersion],
    outletId,
    "2026-11-02",
  );
  assert.deepEqual(
    inForce.map((r) => r.rateBp),
    [0],
  );
  const otherOutlet = tax.effectiveRuleVersions(
    [fnbRule, outletVersion],
    "9e4b7c21-5d6f-4a8b-b3c0-1f2e3d4c5b6a",
    "2026-11-02",
  );
  assert.deepEqual(
    otherOutlet.map((r) => r.rateBp),
    [1000],
  );
});

test("F11 rule resolution: item rule beats class rule; missing or ambiguous rules fail closed", () => {
  const exempt = {
    ...fnbRule,
    id: "7a000000-0000-4000-8000-000000000098",
    code: "BEBAS-AIR",
    rateBp: 0,
    appliesTo: { itemClasses: [], categoryIds: [], itemIds: [line().itemId] },
  };
  const r = tax.calculateTax(bill(), {
    ...config,
    taxRules: [fnbRule, exempt],
  });
  assert.equal(r.taxIdr, 0);
  assert.equal(r.lines[0].taxRuleId, exempt.id);
  throwsCode(
    () =>
      tax.calculateTax(bill({ lines: [line({ itemClass: "facility" })] }), {
        ...config,
        taxRules: [fnbRule],
      }),
    "TAX_RULE_NOT_FOUND",
  );
  throwsCode(
    () => tax.calculateTax(bill({ regionCode: "ID-JK" }), config),
    "TAX_RULE_NOT_FOUND",
  );
  const twin = {
    ...fnbRule,
    id: "7a000000-0000-4000-8000-000000000097",
    code: "PBJT-LAIN",
  };
  throwsCode(
    () => tax.calculateTax(bill(), { ...config, taxRules: [fnbRule, twin] }),
    "TAX_RULE_AMBIGUOUS",
  );
  throwsCode(
    () => tax.calculateTax(bill(), { ...config, settings: [] }),
    "TAX_SETTINGS_NOT_FOUND",
  );
  throwsCode(
    () => tax.calculateTax(bill({ businessDate: "2026-10-31" }), config),
    "TAX_SETTINGS_NOT_FOUND",
  );
});

test("F11 service charge applies per zone and order type only", () => {
  const takeaway = { ...f.privateRoomBill, channel: "takeaway" };
  assert.equal(tax.calculateTax(takeaway, config).serviceChargeIdr, 0);
  assert.equal(
    tax.calculateTax({ ...f.privateRoomBill, zoneId: null }, config)
      .serviceChargeIdr,
    0,
  );
  assert.equal(
    tax.calculateTax(f.privateRoomBill, config).serviceChargeIdr,
    6_141,
  );
});

test("R21 lifecycle: publish only drafts, never backdated, published versions immutable", () => {
  const draft = f.taxRules[2];
  const opts = {
    today: "2026-11-02",
    actorId: f.financeUserId,
    at: "2026-11-02T03:00:00.000Z",
  };
  const done = tax.publishRuleVersion(draft, opts);
  assert.equal(done.status, "published");
  assert.equal(done.publishedBy, f.financeUserId);
  tax.taxRuleSchema.parse(done);
  throwsCode(() => tax.publishRuleVersion(done, opts), "TAX_RULE_IMMUTABLE");
  throwsCode(() => tax.archiveRuleVersion(done), "TAX_RULE_IMMUTABLE");
  throwsCode(
    () => tax.assertRuleVersionEditable("published"),
    "TAX_RULE_IMMUTABLE",
  );
  throwsCode(
    () =>
      tax.publishRuleVersion({ ...draft, effectiveFrom: "2026-11-01" }, opts),
    "TAX_RULE_BACKDATED",
  );
  const archived = tax.archiveRuleVersion(draft);
  throwsCode(
    () => tax.publishRuleVersion(archived, opts),
    "TAX_INVALID_TRANSITION",
  );
  assert.equal(tax.canTransitionRuleVersion("draft", "published"), true);
  assert.equal(tax.canTransitionRuleVersion("published", "draft"), false);
  // publishedAt/publishedBy must match the status.
  assert.equal(
    tax.taxRuleSchema.safeParse({ ...draft, publishedAt: opts.at }).success,
    false,
  );
});

test("TEN-02 ORD-03 endpoint inputs refuse tenant fields and invalid money", () => {
  const input = {
    outletId: null,
    code: "PBJT-FNB",
    name: "PBJT",
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: tax.BANDUNG_REGION,
    channels: [],
    appliesTo: { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
    priceIncludesTax: false,
    includeServiceInBase: true,
    isActive: true,
    effectiveFrom: "2026-12-01",
  };
  assert.equal(tax.createTaxRuleInputSchema.safeParse(input).success, true);
  assert.equal(
    tax.createTaxRuleInputSchema.safeParse({
      ...input,
      tenantId: fnbRule.tenantId,
    }).success,
    false,
  );
  assert.equal(
    tax.createTaxRuleInputSchema.safeParse({ ...input, rateBp: 10.5 }).success,
    false,
  );
  assert.equal(
    tax.createTaxRuleInputSchema.safeParse({ ...input, rateBp: 10_001 })
      .success,
    false,
  );
  assert.equal(
    tax.createTaxRuleInputSchema.safeParse({
      ...input,
      appliesTo: { itemClasses: [], categoryIds: [], itemIds: [] },
    }).success,
    false,
  );
  assert.equal(
    tax.previewTaxCalculation.body.safeParse(f.privateRoomBill).success,
    true,
  );
  assert.equal(
    tax.previewTaxCalculation.body.safeParse({
      ...f.privateRoomBill,
      orderDiscountIdr: 1_000_000,
    }).success,
    false,
  );
  assert.equal(
    tax.getPbjtMonthlyRecap.query.safeParse({
      outletId: f.privateRoomBill.outletId,
      period: "2026-13",
    }).success,
    false,
  );
  assert.equal(
    tax.pbjtMonthlyRecapSchema.safeParse({ ...f.pbjtRecap, totalTaxIdr: 1 })
      .success,
    false,
  );
  for (const endpoint of tax.taxEndpoints)
    assert.ok(endpoint.path.startsWith("/api/tax/"));
});

test("F11 tax events are registered on the WS-05 catalog line and validate envelopes", () => {
  for (const event of tax.TAX_EVENTS) {
    assert.equal(eventCatalogByName.get(event.name)?.workstream, "WS-05");
  }
  const envelope = {
    id: "01JBR2M4T0A1B2C3D4E5F6G7H8",
    tenantId: fnbRule.tenantId,
    outletId: null,
    name: "tax_rule.published",
    version: 1,
    aggregateType: "tax_rule",
    aggregateId: fnbRule.id,
    sequence: 1,
    occurredAt: "2026-10-25T03:00:00.000Z",
    actor: { type: "user", id: f.financeUserId },
    idempotencyKey: "tax-rule-publish-001",
    payloadSchemaRef: "tax_rule.published.v1",
    payload: {
      taxRuleId: fnbRule.id,
      code: fnbRule.code,
      rateBp: 1000,
      isActive: true,
      outletId: null,
      version: 1,
      effectiveFrom: "2026-11-01",
    },
  };
  const parsed = tax.taxRulePublished.envelopeSchema.safeParse(envelope);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(
    tax.taxRulePublished.envelopeSchema.safeParse({
      ...envelope,
      payload: { ...envelope.payload, rateBp: 1.5 },
    }).success,
    false,
  );
});
