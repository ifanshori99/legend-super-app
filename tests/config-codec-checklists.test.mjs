import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_SECTION_CODECS } from "../packages/shared/src/platform/config-codecs.ts";

const sourceIds = {
  tenant: "10000000-0000-4000-8000-000000000001",
  outlet: "10000000-0000-4000-8000-000000000002",
  zone: "10000000-0000-4000-8000-000000000003",
  role: "10000000-0000-4000-8000-000000000004",
};
const exportContext = {
  outletKeyById: new Map([[sourceIds.outlet, "cafe"]]),
  zoneKeyById: new Map([[sourceIds.zone, "cafe.zone.terrace"]]),
  roleKeyById: new Map([[sourceIds.role, "tpl.cashier"]]),
};
const importContext = {
  outletKeys: new Set(["cafe", "other"]),
  zoneOutletKeyByKey: new Map([
    ["cafe.zone.terrace", "cafe"],
    ["other.zone.bar", "other"],
  ]),
  roleKeys: new Set(["tpl.cashier"]),
};

function codec() {
  const value = CONFIG_SECTION_CODECS.checklists;
  assert.ok(value, "TEN-09 registers the operations checklists codec");
  return value;
}

function row(overrides = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000005",
    tenantId: sourceIds.tenant,
    outletId: sourceIds.outlet,
    name: "Opening Bar",
    type: "opening",
    items: [
      {
        id: "10000000-0000-4000-8000-000000000006",
        label: "Clean workbench",
        instruction: "Use the approved sanitizer",
        requiredEvidence: ["photo", "number"],
      },
    ],
    schedule: {
      shiftTemplateId: "10000000-0000-4000-8000-000000000007",
      stationId: "10000000-0000-4000-8000-000000000008",
      zoneId: sourceIds.zone,
      dueTime: "08:30",
    },
    roleId: sourceIds.role,
    version: 4,
    updatedAt: "2026-11-12T00:00:00.000Z",
    ...overrides,
  };
}

function item(overrides = {}) {
  return {
    key: "cafe.chk.opening-bar",
    outletKey: "cafe",
    name: "Opening Bar",
    type: "opening",
    items: [
      {
        label: "Clean workbench",
        instruction: "Use the approved sanitizer",
        requiredEvidence: ["photo", "number"],
      },
    ],
    schedule: { zoneKey: "cafe.zone.terrace", dueTime: "08:30" },
    roleKey: "tpl.cashier",
    ...overrides,
  };
}

test("legend-f7t7z TEN-09 checklist export strips identifiers and transaction state", () => {
  const value = codec();
  assert.equal(value.section, "checklists");
  assert.equal(value.version, 1);
  const rows = [row()];
  const before = structuredClone(rows);
  const exported = value.toTemplate(rows, exportContext);
  assert.deepEqual(exported, [item()]);
  assert.equal(value.itemSchema.safeParse(exported[0]).success, true);
  assert.deepEqual(rows, before);
  const encoded = JSON.stringify(exported);
  for (const id of Object.values(sourceIds))
    assert.equal(encoded.includes(id), false);
  for (const name of [
    "tenantId",
    "outletId",
    "roleId",
    "zoneId",
    "stationId",
    "shiftTemplateId",
    "updatedAt",
    "version",
  ])
    assert.equal(encoded.includes(`"${name}"`), false, name);
  exported[0].items[0].requiredEvidence.push("signature");
  assert.deepEqual(
    rows,
    before,
    "export does not share nested arrays with source rows",
  );
});

test("legend-f7t7z checklist export keys are stable under input reordering and slug collisions", () => {
  const value = codec();
  const rows = [
    row(),
    row({
      id: "10000000-0000-4000-8000-000000000009",
      name: "Opening  Bar",
      type: "closing",
    }),
    row({
      id: "10000000-0000-4000-8000-000000000010",
      name: "opening-bar",
      type: "shift",
    }),
  ];
  const exported = value.toTemplate(rows, exportContext);
  assert.deepEqual(
    exported,
    value.toTemplate([...rows].reverse(), exportContext),
  );
  assert.equal(new Set(exported.map((entry) => entry.key)).size, rows.length);
  for (const entry of exported)
    assert.equal(value.itemSchema.safeParse(entry).success, true);
});

test("legend-f7t7z checklist decode preserves template-only drafts and null references", () => {
  const value = codec();
  const items = [
    item(),
    item({
      key: "cafe.chk.closing",
      name: "Closing",
      type: "closing",
      roleKey: null,
      schedule: { zoneKey: null, dueTime: "23:59" },
    }),
  ];
  const before = structuredClone(items);
  const result = value.fromTemplate(items, importContext);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.drafts, items);
  assert.equal(
    value.fromTemplate(items, {
      zoneOutletKeyByKey: importContext.zoneOutletKeyByKey,
      roleKeys: importContext.roleKeys,
    }).ok,
    true,
    "bundle parsing can defer outlet validation until target outlets are known",
  );
  result.drafts[0].items[0].requiredEvidence.push("signature");
  assert.deepEqual(
    items,
    before,
    "drafts do not share nested arrays with imported data",
  );
});

test("legend-f7t7z checklist decode refuses identifiers, HRIS/run data, duplicate keys and evidence", () => {
  const value = codec();
  for (const malformed of [
    item({ tenantId: sourceIds.tenant }),
    item({ runId: sourceIds.tenant }),
    item({ kind: "onboarding" }),
    item({ items: [{ ...item().items[0], id: sourceIds.tenant }] }),
    item({
      items: [{ ...item().items[0], requiredEvidence: ["photo", "photo"] }],
    }),
    item({ items: [] }),
    item({ schedule: { ...item().schedule, dueTime: "24:00" } }),
    item({ schedule: { ...item().schedule, stationId: sourceIds.tenant } }),
  ]) {
    assert.equal(
      value.fromTemplate([malformed], importContext).ok,
      false,
      JSON.stringify(malformed),
    );
  }
  const duplicated = value.fromTemplate([item(), item()], importContext);
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.issues.join("\n"), /duplicate key/i);
});

test("legend-f7t7z checklist decode refuses missing references and a zone from another outlet", () => {
  const value = codec();
  for (const malformed of [
    item({ outletKey: "missing" }),
    item({ roleKey: "role.missing" }),
    item({ schedule: { ...item().schedule, zoneKey: "zone.missing" } }),
    item({ schedule: { ...item().schedule, zoneKey: "other.zone.bar" } }),
  ]) {
    const refused = value.fromTemplate([malformed], importContext);
    assert.equal(refused.ok, false, JSON.stringify(malformed));
    assert.ok(refused.issues.length > 0);
  }
});

test("legend-f7t7z checklist export fails closed when non-null source references cannot resolve", () => {
  const value = codec();
  for (const context of [
    { ...exportContext, outletKeyById: new Map() },
    { ...exportContext, roleKeyById: new Map() },
    { ...exportContext, zoneKeyById: new Map() },
  ])
    assert.throws(
      () => value.toTemplate([row()], context),
      /checklists|role|zone|outlet/i,
    );
});
