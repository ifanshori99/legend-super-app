import assert from "node:assert/strict";
import { test } from "node:test";
import * as platform from "../packages/shared/src/platform/index.ts";

const tenantId = "10000000-0000-4000-8000-000000000001";
const outletId = "10000000-0000-4000-8000-000000000002";
const zoneId = "10000000-0000-4000-8000-000000000003";
const exportContext = {
  outletKeyById: new Map([[outletId, "bandung"]]),
  zoneKeyById: new Map([[zoneId, "bandung.terrace"]]),
  zoneOutletKeyByKey: new Map([["bandung.terrace", "bandung"]]),
};
const importContext = {
  zoneKeys: new Set(["bandung.terrace"]),
  outletKeys: new Set(["bandung"]),
  zoneOutletKeyByKey: exportContext.zoneOutletKeyByKey,
};
const row = {
  id: "10000000-0000-4000-8000-000000000004",
  tenantId,
  outletId,
  zoneId,
  code: "SC-DINE-IN",
  name: "Terrace service",
  rateBp: 500,
  orderTypes: ["dine_in"],
  itemClasses: ["food_beverage"],
  isActive: true,
  effectiveFrom: "2026-11-01",
};

function codec() {
  const value = platform.CONFIG_SECTION_CODECS.service_charge_rules;
  assert.ok(value, "service_charge_rules codec is registered");
  return value;
}

test("service_charge_rules: registered codec exports portable rows and stable keys", () => {
  const value = codec();
  assert.equal(value.section, "service_charge_rules");
  assert.equal(value.version, 1);
  const rows = [row, { ...row, outletId: null, zoneId: null }];
  const items = value.toTemplate(rows, exportContext);
  assert.deepEqual(value.toTemplate([...rows].reverse(), exportContext), items);
  assert.deepEqual(
    items.map((item) => item.key),
    ["tenant.sc-dine-in", "bandung.sc-dine-in"].sort(),
  );
  assert.deepEqual(
    platform.findBundleIdentifiers(items, [tenantId, outletId, zoneId, row.id]),
    [],
  );
  for (const item of items) value.itemSchema.parse(item);
  const item = items.find((entry) => entry.outletKey === "bandung");
  assert.equal(item.zoneKey, "bandung.terrace");
  assert.equal(item.effectiveFrom, row.effectiveFrom);
  const result = value.fromTemplate(items, importContext);
  assert.equal(result.ok, true);
  assert.deepEqual(result.drafts, items);
});

test("service_charge_rules: missing and foreign-zone references cannot broaden a charge", () => {
  const value = codec();
  assert.throws(
    () => value.toTemplate([row], { ...exportContext, zoneKeyById: new Map() }),
    /zone/i,
  );
  assert.throws(
    () =>
      value.toTemplate([row], { ...exportContext, outletKeyById: new Map() }),
    /outlet/i,
  );
  const [item] = value.toTemplate([row], exportContext);
  const missing = value.fromTemplate([item], {
    ...importContext,
    zoneKeys: new Set(),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.issues.join(" "), /zone/i);
  const foreign = value.fromTemplate([item], {
    ...importContext,
    zoneOutletKeyByKey: new Map([["bandung.terrace", "jakarta"]]),
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.issues.join(" "), /outlet/i);
});

test("service_charge_rules: duplicate rules and invalid money inputs reject the whole draft set", () => {
  const value = codec();
  const [item] = value.toTemplate([row], exportContext);
  for (const items of [
    [item, { ...item, key: "other" }],
    [item, { ...item, code: "SC-OTHER" }],
    [{ ...item, rateBp: -1 }],
    [{ ...item, rateBp: 10001 }],
    [{ ...item, rateBp: 0.5 }],
    [{ ...item, itemClasses: [] }],
    [{ ...item, effectiveFrom: "2026-02-30" }],
    [{ ...item, zoneId }],
    [{ ...item, tenantId }],
  ]) {
    const result = value.fromTemplate(items, importContext);
    assert.equal(result.ok, false, JSON.stringify(items));
    assert.ok(result.issues.length > 0);
    assert.equal("drafts" in result, false);
  }
});

test("service_charge_rules: preserves zero rate, tombstones and legacy effective-date omission", () => {
  const value = codec();
  const [item] = value.toTemplate(
    [{ ...row, rateBp: 0, isActive: false }],
    exportContext,
  );
  const result = value.fromTemplate([item], importContext);
  assert.equal(result.ok, true);
  assert.equal(result.drafts[0].rateBp, 0);
  assert.equal(result.drafts[0].isActive, false);
  const { effectiveFrom, ...legacy } = item;
  assert.equal(effectiveFrom, row.effectiveFrom);
  const legacyResult = value.fromTemplate([legacy], importContext);
  assert.equal(legacyResult.ok, true);
  assert.equal("effectiveFrom" in legacyResult.drafts[0], false);
  assert.throws(() =>
    value.toTemplate([{ ...row, rateBp: -1 }], exportContext),
  );
});
