import assert from "node:assert/strict";
import { test } from "node:test";

import * as platform from "../packages/shared/src/platform/index.ts";
import { cafeLegendQrOrderFixtures } from "../packages/shared/src/qr-order/fixtures.ts";

const rows = cafeLegendQrOrderFixtures.zones;
const outletKeys = new Map(rows.map((row) => [row.outletId, "legend-pusat"]));

function codec() {
  const value = platform.CONFIG_SECTION_CODECS.zones;
  assert.ok(value, "legend-qeott: zones codec is registered");
  return value;
}

function item(overrides = {}) {
  return {
    key: "legend-pusat.indoor",
    outletKey: "legend-pusat",
    name: "Indoor",
    paymentMode: "open_bill",
    serviceChargeBp: 500,
    minimumSpendIdr: 50_000,
    hours: [{ daysOfWeek: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" }],
    status: "active",
    sortOrder: 0,
    ...overrides,
  };
}

test("legend-qeott: zones export preserves the floor contract without tenant identifiers", () => {
  const zones = codec();
  assert.equal(zones.section, "zones");
  assert.equal(zones.version, 1);
  const items = zones.toTemplate(rows, { outletKeys });
  assert.equal(items.length, rows.length);
  assert.deepEqual(
    items,
    zones.toTemplate([...rows].reverse(), { outletKeys }),
  );
  assert.equal(new Set(items.map((value) => value.key)).size, items.length);
  assert.deepEqual(
    platform.findBundleIdentifiers(
      items,
      rows.flatMap((row) => [row.id, row.tenantId, row.outletId]),
    ),
    [],
  );
  for (const value of items) {
    zones.itemSchema.parse(value);
    const source = rows.find((row) => row.name === value.name);
    assert.equal(value.outletKey, "legend-pusat");
    assert.equal(value.serviceChargeBp, source.serviceChargeBp);
    assert.equal(value.minimumSpendIdr, source.minimumSpendIdr);
    assert.equal(value.paymentMode, source.paymentMode);
    assert.deepEqual(value.hours, source.hours);
    assert.equal("tableCount" in value, false);
  }
  const decoded = zones.fromTemplate(items);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  assert.deepEqual(decoded.drafts, items);
});

test("legend-qeott: zone keys match outlet/name convention, resolve slug collisions and detach nested hours", () => {
  const zones = codec();
  const source = [
    { ...rows[0], id: "source-a", name: "Indoor A", sortOrder: 0 },
    { ...rows[0], id: "source-b", name: "Indoor-A", sortOrder: 1 },
  ];
  const items = zones.toTemplate(source, { outletKeys });
  assert.deepEqual(
    items.map((value) => value.key),
    ["legend-pusat.indoor-a", "legend-pusat.indoor-a-2"],
  );
  assert.deepEqual(
    items,
    zones.toTemplate([...source].reverse(), { outletKeys }),
  );
  const previousDays = [...source[0].hours[0].daysOfWeek];
  items[0].hours[0].daysOfWeek.push(6);
  assert.deepEqual(source[0].hours[0].daysOfWeek, previousDays);
  const original = item();
  const decoded = zones.fromTemplate([original]);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  decoded.drafts[0].hours[0].daysOfWeek.push(6);
  assert.deepEqual(original.hours[0].daysOfWeek, [1, 2, 3, 4, 5]);
});

test("legend-qeott: zone export refuses an unmapped outlet rather than leaking or dropping its scope", () => {
  assert.throws(
    () => codec().toTemplate(rows, { outletKeys: new Map() }),
    /outlet/i,
  );
});

test("legend-qeott: direct zone import refuses duplicate keys, duplicate names within an outlet and unknown outlet references", () => {
  const zones = codec();
  for (const values of [
    [item(), item({ name: "Other" })],
    [item(), item({ key: "legend-pusat.other", name: "Indoor" })],
  ]) {
    const result = zones.fromTemplate(values);
    assert.equal(result.ok, false);
    assert.match(result.issues.join("\n"), /duplicate/i);
  }
  const twoOutlets = zones.fromTemplate([
    item(),
    item({ key: "legend-utara.indoor", outletKey: "legend-utara" }),
  ]);
  assert.equal(twoOutlets.ok, true, JSON.stringify(twoOutlets.issues));
  const missing = zones.fromTemplate([item()], {
    outletKeys: new Set(["other"]),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.issues.join("\n"), /outlet/i);
});

test("legend-qeott: case-sensitive zone names exported by the API remain distinct on import", () => {
  const zones = codec();
  const source = [
    { ...rows[0], id: "source-vip-upper", name: "VIP" },
    { ...rows[0], id: "source-vip-lower", name: "vip" },
  ];
  const items = zones.toTemplate(source, { outletKeys });
  assert.equal(new Set(items.map((value) => value.key)).size, 2);
  const decoded = zones.fromTemplate(items);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  assert.deepEqual(
    new Set(decoded.drafts.map((value) => value.name)),
    new Set(["VIP", "vip"]),
  );
});

test("legend-qeott: zone import rejects invalid floor settings and tenant-specific fields", () => {
  const zones = codec();
  for (const overrides of [
    { serviceChargeBp: -1 },
    { serviceChargeBp: 10_001 },
    { serviceChargeBp: 1.5 },
    { minimumSpendIdr: -1 },
    { minimumSpendIdr: 0.5 },
    { paymentMode: "cash" },
    { status: "deleted" },
    { sortOrder: -1 },
    { hours: [{ daysOfWeek: [7], start: "08:00", end: "18:00" }] },
    { hours: [{ daysOfWeek: [1], start: "25:00", end: "18:00" }] },
    { id: rows[0].id },
    { tenantId: rows[0].tenantId },
    { outletId: rows[0].outletId },
    { tableCount: 12 },
  ]) {
    const result = zones.fromTemplate([item(overrides)]);
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.ok(result.issues.length > 0);
  }
});

test("legend-qeott: bundle decoding includes portable zones and preserves monetary limits exactly", () => {
  const zones = codec();
  const items = [
    item({ minimumSpendIdr: 0, serviceChargeBp: 0 }),
    item({
      key: "legend-pusat.private",
      name: "Private",
      minimumSpendIdr: 500_000,
      serviceChargeBp: 10_000,
    }),
  ];
  const result = platform.decodeConfigBundle({
    sections: { zones: { version: 1, items } },
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.drafts.zones, items);
  assert.equal(result.withoutCodec.includes("zones"), false);
  for (const value of items) zones.itemSchema.parse(value);
});
