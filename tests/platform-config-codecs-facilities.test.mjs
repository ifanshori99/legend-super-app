import assert from "node:assert/strict";
import { test } from "node:test";

import { cafeLegendFacilityFixtures as fixture } from "../packages/shared/src/facility/fixtures.ts";
import * as platform from "../packages/shared/src/platform/index.ts";

function codec() {
  const value = platform.CONFIG_SECTION_CODECS.facilities;
  assert.ok(value, "facilities codec is registered");
  assert.equal(value.section, "facilities");
  assert.equal(value.version, 1);
  return value;
}

function rows() {
  const {
    facilities,
    areas,
    units,
    products,
    addons,
    entitlementRules,
    subscriptionPlans,
  } = fixture;
  return {
    facilities,
    areas,
    units,
    products,
    addons,
    entitlementRules,
    subscriptionPlans,
  };
}

function items() {
  return codec().toTemplate(rows(), {
    outletKeys: new Map([
      [fixture.outlet.id, fixture.outlet.code.toLowerCase()],
    ]),
    taxRuleKeys: new Map(
      fixture.products
        .filter((row) => row.taxRuleId !== null)
        .map((row) => [row.taxRuleId, "tax.default"]),
    ),
  });
}

test("legend-u74y8: facilities round-trip keeps prices and quotas, drops tenant and hardware refs", () => {
  const value = codec();
  const exported = items();
  const sourceIds = [fixture.tenant.id, fixture.outlet.id];
  for (const collection of Object.values(rows()))
    for (const row of collection) sourceIds.push(row.id);
  assert.deepEqual(platform.findBundleIdentifiers(exported, sourceIds), []);
  for (const item of exported) value.itemSchema.parse(item);
  assert.deepEqual(
    new Set(exported.map((item) => item.kind)),
    new Set([
      "facility",
      "area",
      "unit",
      "product",
      "addon",
      "entitlement",
      "subscription_plan",
    ]),
  );
  assert.equal(
    exported.some(
      (item) => item.kind === "entitlement" && item.type === "package",
    ),
    false,
  );
  assert.ok(
    exported
      .filter((item) => item.kind === "unit")
      .every((item) => ["available", "maintenance"].includes(item.status)),
  );
  const decoded = value.fromTemplate([...exported].reverse());
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  const kinds = decoded.drafts.map((draft) => draft.kind);
  assert.ok(kinds.lastIndexOf("facility") < kinds.indexOf("area"));
  assert.ok(kinds.lastIndexOf("area") < kinds.indexOf("unit"));
  for (const draft of decoded.drafts) {
    assert.equal("id" in draft, false);
    assert.equal("tenantId" in draft, false);
    assert.equal("outletId" in draft, false);
    assert.equal("lockDeviceId" in draft, false);
  }
  for (const kind of ["product", "addon", "subscription_plan"])
    assert.deepEqual(
      decoded.drafts
        .filter((draft) => draft.kind === kind)
        .map((draft) => draft.priceIdr)
        .sort((a, b) => a - b),
      exported
        .filter((item) => item.kind === kind)
        .map((item) => item.priceIdr)
        .sort((a, b) => a - b),
    );
  assert.deepEqual(items(), exported, "stable keys on repeated export");
});

test("legend-u74y8: facilities reject orphan and wrong-kind refs, foreign areas, duplicate keys", () => {
  const value = codec();
  const original = items();
  const area = original.find((item) => item.kind === "area");
  const unit = original.find((item) => item.kind === "unit");
  const otherFacility = original.find(
    (item) => item.kind === "facility" && item.key !== unit.facilityKey,
  );
  assert.ok(otherFacility);
  const badSets = [
    [...original, { ...area, key: "area.orphan", facilityKey: "missing" }],
    [...original, { ...area, key: "area.wrong-kind", facilityKey: unit.key }],
    [
      ...original,
      { ...unit, key: "unit.foreign", facilityKey: otherFacility.key },
    ],
    [...original, { ...unit, key: "unit.orphan", areaKey: "missing" }],
    [...original, original[0]],
  ];
  for (const candidate of badSets) {
    const result = value.fromTemplate(candidate);
    assert.equal(result.ok, false);
    assert.ok(result.issues.length > 0);
  }
});

test("legend-u74y8: facilities refuse unknown explicit tax refs and unsafe money or quotas", () => {
  const value = codec();
  const original = items();
  const product = original.find((item) => item.kind === "product");
  const withProduct = (next) =>
    original.map((item) => (item.key === product.key ? next : item));
  const tax = value.fromTemplate(
    withProduct({ ...product, taxRuleKey: "tax.missing" }),
    { taxRuleOutletKeyByKey: new Map() },
  );
  assert.equal(tax.ok, false);
  assert.match(tax.issues.join("\n"), /taxRuleKey/);
  for (const patch of [
    { priceIdr: -1 },
    { priceIdr: 0.5 },
    { priceIdr: Number.MAX_SAFE_INTEGER + 1 },
    { sessions: 0 },
    { sessions: 101 },
    { maxPerDay: 11 },
  ])
    assert.equal(
      value.fromTemplate(withProduct({ ...product, ...patch })).ok,
      false,
    );
  assert.equal(
    value.fromTemplate(
      withProduct({ ...product, priceIdr: 0, sessions: 1, maxPerDay: null }),
    ).ok,
    true,
  );
});

test("legend-u74y8: facilities export refuses missing parent or unknown non-null tax mapping", () => {
  const value = codec();
  const ctx = {
    outletKeys: new Map([
      [fixture.outlet.id, fixture.outlet.code.toLowerCase()],
    ]),
  };
  assert.throws(
    () => value.toTemplate({ ...rows(), facilities: [] }, ctx),
    /facility/i,
  );
  const products = [{ ...fixture.products[0], taxRuleId: "source-tax-rule" }];
  assert.throws(
    () => value.toTemplate({ ...rows(), products }, ctx),
    /taxRule/i,
  );
});

test("legend-u74y8: facilities enforce target outlet and preserve explicit known tax references", () => {
  const value = codec();
  const original = items();
  const product = original.find((item) => item.kind === "product");
  const withTax = original.map((item) =>
    item.key === product.key ? { ...item, taxRuleKey: "tax.vat" } : item,
  );
  const missingOutlet = value.fromTemplate(original, { outletKeys: new Set() });
  assert.equal(missingOutlet.ok, false);
  assert.match(missingOutlet.issues.join("\n"), /outletKey/);
  const imported = value.fromTemplate(withTax, {
    outletKeys: new Set([fixture.outlet.code.toLowerCase()]),
    taxRuleOutletKeyByKey: new Map([
      ["tax.default", null],
      ["tax.vat", null],
    ]),
  });
  assert.equal(imported.ok, true, JSON.stringify(imported.issues));
  assert.equal(
    imported.drafts.find((item) => item.key === product.key).taxRuleKey,
    "tax.vat",
  );
});

test("legend-u74y8: facilities import normalizes live unit state while preserving maintenance", () => {
  const value = codec();
  const original = items();
  const unit = original.find((item) => item.kind === "unit");
  for (const status of [
    "available",
    "in_use",
    "needs_cleaning",
    "cleaning",
    "maintenance",
  ]) {
    const imported = value.fromTemplate(
      original.map((item) =>
        item.key === unit.key ? { ...item, status } : item,
      ),
    );
    assert.equal(imported.ok, true, JSON.stringify(imported.issues));
    assert.equal(
      imported.drafts.find((item) => item.key === unit.key).status,
      status === "maintenance" ? "maintenance" : "available",
    );
  }
});

test("legend-u74y8 P2: facility products accept tenant-wide or own-outlet taxes and reject another outlet's tax", () => {
  const value = codec();
  const original = items();
  const product = original.find((item) => item.kind === "product");
  const facility = original.find((item) => item.key === product.facilityKey);
  const withOutletTax = original.map((item) =>
    item.key === product.key ? { ...item, taxRuleKey: "tax.outlet" } : item,
  );
  for (const taxOutletKey of [null, facility.outletKey]) {
    const accepted = value.fromTemplate(withOutletTax, {
      taxRuleOutletKeyByKey: new Map([
        ["tax.default", null],
        ["tax.outlet", taxOutletKey],
      ]),
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
    assert.equal(
      accepted.drafts.find((item) => item.key === product.key).priceIdr,
      product.priceIdr,
    );
  }
  const denied = value.fromTemplate(withOutletTax, {
    taxRuleOutletKeyByKey: new Map([
      ["tax.default", null],
      ["tax.outlet", "other-outlet"],
    ]),
  });
  assert.equal(
    denied.ok,
    false,
    "known tax from another outlet must not change this outlet's charges",
  );
  assert.match(denied.issues.join("\n"), /taxRuleKey.*outlet/);
});
