import assert from "node:assert/strict";
import { test } from "node:test";

import * as access from "../packages/shared/src/access/index.ts";
import * as accounting from "../packages/shared/src/accounting/index.ts";
import * as platform from "../packages/shared/src/platform/index.ts";

// legend-tct8: TEN-09 config bundle section codecs (toTemplate/fromTemplate)
// for roles, approval_policies and chart_of_accounts. A codec turns tenant
// rows into tenant-free, key-addressed items and back into id-less drafts
// the importer inserts with freshly minted ids.

const acc = access.cafeLegendAccessFixtures;
const books = accounting.cafeLegendAccountingFixtures;

const SOURCE_IDS = [acc.tenantId, books.tenantId, books.legalEntity.id];

function customRole(name, overrides = {}) {
  return access.roleSchema.parse({
    id: crypto.randomUUID(),
    tenantId: acc.tenantId,
    name,
    isTemplate: false,
    templateKey: null,
    permissions: acc.roles.find((r) => r.permissions.length > 0).permissions,
    mfaRequired: false,
    allowedScopeTypes: ["outlet"],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  });
}

test("registry has codecs for roles, approval_policies, chart_of_accounts", () => {
  for (const section of ["roles", "approval_policies", "chart_of_accounts"]) {
    const codec = platform.CONFIG_SECTION_CODECS[section];
    assert.ok(codec, section);
    assert.equal(codec.section, section);
    assert.equal(codec.version, 1);
    assert.equal(platform.configSectionCodec(section), codec);
  }
  assert.equal(platform.configSectionCodec("zones"), undefined);
});

test("roles: toTemplate is tenant-free, keys are unique and stable", () => {
  const codec = platform.CONFIG_SECTION_CODECS.roles;
  const rows = [
    ...acc.roles,
    customRole("Kasir Senior"),
    customRole("kasir  senior"), // slug collision with the one above
  ];
  const items = codec.toTemplate(rows);
  assert.equal(new Set(items.map((i) => i.key)).size, items.length);
  for (const item of items) codec.itemSchema.parse(item);
  assert.deepEqual(platform.findBundleIdentifiers(items, SOURCE_IDS), []);
  // Template roles keep their template key as item key; custom ones are
  // namespaced so they cannot collide with it.
  for (const row of rows.filter((r) => r.templateKey)) {
    if (row.templateKey === "super_admin") continue;
    assert.ok(
      items.some((i) => i.key === row.templateKey),
      row.templateKey,
    );
  }
  assert.ok(items.some((i) => i.key === "custom.kasir-senior"));
  assert.ok(items.some((i) => i.key === "custom.kasir-senior-2"));
  // Platform-level super_admin is never part of a tenant bundle.
  assert.ok(!items.some((i) => i.templateKey === "super_admin"));
  // Same input, same keys.
  assert.deepEqual(codec.toTemplate(rows), items);
});

test("roles: fromTemplate yields id-less drafts that round-trip", () => {
  const codec = platform.CONFIG_SECTION_CODECS.roles;
  const rows = [customRole("Kasir Senior", { mfaRequired: true })];
  const decoded = codec.fromTemplate(codec.toTemplate(rows));
  assert.equal(decoded.ok, true);
  const [draft] = decoded.drafts;
  for (const forbidden of ["id", "tenantId", "createdAt", "updatedAt"])
    assert.equal(forbidden in draft, false, forbidden);
  assert.equal(draft.name, "Kasir Senior");
  assert.equal(draft.isTemplate, false);
  assert.equal(draft.templateKey, null);
  assert.equal(draft.mfaRequired, true);
  assert.deepEqual(draft.permissions, rows[0].permissions);
  assert.deepEqual(draft.allowedScopeTypes, ["outlet"]);
});

test("roles: item schema refuses unknown permissions and template mismatch", () => {
  const codec = platform.CONFIG_SECTION_CODECS.roles;
  const [good] = codec.toTemplate([customRole("Kasir Senior")]);
  assert.equal(codec.itemSchema.safeParse(good).success, true);
  assert.equal(
    codec.itemSchema.safeParse({ ...good, permissions: ["no.such.code"] })
      .success,
    false,
  );
  assert.equal(
    codec.itemSchema.safeParse({ ...good, extra: 1 }).success,
    false,
  );
  // A custom-namespaced key cannot carry a template key, and a template key
  // must equal the item key.
  const bad = codec.fromTemplate([{ ...good, templateKey: "cashier" }]);
  assert.equal(bad.ok, false);
  assert.match(bad.issues.join(), /templateKey/);
});

test("approval_policies: approver is a role key, never a role id", () => {
  const roles = platform.CONFIG_SECTION_CODECS.roles;
  const policies = platform.CONFIG_SECTION_CODECS.approval_policies;
  const roleKeyById = access.roleConfigKeys(acc.roles);
  const items = policies.toTemplate(acc.approvalPolicies, { roleKeyById });
  assert.ok(items.length > 0);
  assert.equal(new Set(items.map((i) => i.key)).size, items.length);
  for (const item of items) policies.itemSchema.parse(item);
  assert.deepEqual(platform.findBundleIdentifiers(items, SOURCE_IDS), []);
  const roleKeys = new Set(roles.toTemplate(acc.roles).map((i) => i.key));
  for (const item of items) assert.ok(roleKeys.has(item.approverRoleKey));

  const decoded = policies.fromTemplate(items, { roleKeys });
  assert.equal(decoded.ok, true);
  assert.equal(decoded.drafts.length, acc.approvalPolicies.length);
  for (const draft of decoded.drafts) {
    assert.equal("id" in draft, false);
    assert.equal("approverRoleId" in draft, false);
    assert.equal(draft.requiresDistinctActor, true);
  }
});

test("approval_policies: export fails loudly on an unknown approver role", () => {
  const policies = platform.CONFIG_SECTION_CODECS.approval_policies;
  assert.throws(
    () => policies.toTemplate(acc.approvalPolicies, { roleKeyById: new Map() }),
    /approver role/i,
  );
});

test("approval_policies: import refuses unknown role keys and level gaps", () => {
  const policies = platform.CONFIG_SECTION_CODECS.approval_policies;
  const roleKeyById = access.roleConfigKeys(acc.roles);
  const items = policies.toTemplate(acc.approvalPolicies, { roleKeyById });
  const roleKeys = new Set(roleKeyById.values());

  const missing = policies.fromTemplate(items, { roleKeys: new Set() });
  assert.equal(missing.ok, false);
  assert.match(missing.issues.join("\n"), /approverRoleKey/);

  const first = items[0];
  const gap = policies.fromTemplate(
    [
      {
        ...first,
        key: "gap.level3",
        thresholdIdr: 987_654_321,
        levels: 3,
      },
    ],
    { roleKeys },
  );
  assert.equal(gap.ok, false);
  assert.match(gap.issues.join("\n"), /level/i);
});

test("chart_of_accounts: parents by code, parents-first order, no ids", () => {
  const coa = platform.CONFIG_SECTION_CODECS.chart_of_accounts;
  const items = coa.toTemplate(books.accounts);
  assert.equal(items.length, books.accounts.length);
  for (const item of items) coa.itemSchema.parse(item);
  assert.deepEqual(platform.findBundleIdentifiers(items, SOURCE_IDS), []);
  const cash = items.find((i) => i.key === "1101");
  assert.equal(cash.parentCode, "1100");

  const decoded = coa.fromTemplate(items);
  assert.equal(decoded.ok, true);
  const seen = new Set();
  for (const draft of decoded.drafts) {
    if (draft.parentCode !== null)
      assert.ok(seen.has(draft.parentCode), `parent before ${draft.code}`);
    seen.add(draft.code);
    for (const forbidden of ["id", "tenantId", "legalEntityId", "parentId"])
      assert.equal(forbidden in draft, false, forbidden);
  }
});

test("chart_of_accounts: refuses orphans, cycles, type mismatch", () => {
  const coa = platform.CONFIG_SECTION_CODECS.chart_of_accounts;
  const [a, b] = coa.toTemplate(books.accounts);
  const orphan = coa.fromTemplate([{ ...a, parentCode: "9999" }]);
  assert.equal(orphan.ok, false);
  assert.match(orphan.issues.join(), /9999/);

  const cycle = coa.fromTemplate([
    { ...a, parentCode: "8001", key: "8000" },
    { ...a, parentCode: "8000", key: "8001" },
  ]);
  assert.equal(cycle.ok, false);
  assert.match(cycle.issues.join(), /cycle/i);

  const other = books.accounts.find((x) => x.type !== a.type);
  const mismatch = coa.fromTemplate([
    a,
    { ...b, key: "8100", parentCode: a.key, type: other.type },
  ]);
  assert.equal(mismatch.ok, false);
});

test("bundle: registered item schemas run inside parseConfigBundle", () => {
  const roleItems = platform.CONFIG_SECTION_CODECS.roles.toTemplate(acc.roles);
  const bundle = structuredClone(
    platform.cafeLegendPlatformFixtures.configBundle,
  );
  bundle.sections.roles = { version: 1, items: roleItems };
  assert.equal(platform.parseConfigBundle(bundle, SOURCE_IDS).ok, true);

  bundle.sections.roles.items[0].permissions = ["no.such.code"];
  const bad = platform.parseConfigBundle(bundle, SOURCE_IDS);
  assert.equal(bad.ok, false);
  assert.ok(bad.schemaIssues.some((s) => s.startsWith("sections.roles.")));
});

test("decodeConfigBundle resolves cross-section role keys in one pass", () => {
  const { roles, approval_policies, chart_of_accounts } =
    platform.CONFIG_SECTION_CODECS;
  const roleKeyById = access.roleConfigKeys(acc.roles);
  const bundle = structuredClone(
    platform.cafeLegendPlatformFixtures.configBundle,
  );
  bundle.sections.roles = { version: 1, items: roles.toTemplate(acc.roles) };
  bundle.sections.approval_policies = {
    version: 1,
    items: approval_policies.toTemplate(acc.approvalPolicies, { roleKeyById }),
  };
  bundle.sections.chart_of_accounts = {
    version: 1,
    items: chart_of_accounts.toTemplate(books.accounts),
  };
  const parsed = platform.parseConfigBundle(bundle, SOURCE_IDS);
  assert.equal(parsed.ok, true);

  const decoded = platform.decodeConfigBundle(parsed.bundle);
  assert.equal(decoded.ok, true);
  assert.deepEqual(Object.keys(decoded.drafts).sort(), [
    "approval_policies",
    "chart_of_accounts",
    "roles",
  ]);

  // Importing only approval_policies needs the target tenant's role keys.
  const only = platform.decodeConfigBundle(parsed.bundle, {
    sections: ["approval_policies"],
  });
  assert.equal(only.ok, false);
  assert.equal(only.issues[0].section, "approval_policies");
  const withTarget = platform.decodeConfigBundle(parsed.bundle, {
    sections: ["approval_policies"],
    existingRoleKeys: new Set(roleKeyById.values()),
  });
  assert.equal(withTarget.ok, true);
});

test("roles/policies: export keys do not depend on row order", () => {
  const a = customRole("Kasir Senior");
  const b = customRole("Kasir-Senior"); // same slug as a
  const roles = platform.CONFIG_SECTION_CODECS.roles;
  const policies = platform.CONFIG_SECTION_CODECS.approval_policies;
  const forward = access.roleConfigKeys([a, b]);
  const backward = access.roleConfigKeys([b, a]);
  assert.deepEqual([...forward].sort(), [...backward].sort());
  assert.deepEqual(roles.toTemplate([a, b]), roles.toTemplate([b, a]));
  const rows = [...acc.approvalPolicies];
  const roleKeyById = access.roleConfigKeys(acc.roles);
  assert.deepEqual(
    policies.toTemplate(rows, { roleKeyById }),
    policies.toTemplate([...rows].reverse(), { roleKeyById }),
  );
});

test("bundle: parse refuses references that could never be imported", () => {
  const { roles, approval_policies, chart_of_accounts } =
    platform.CONFIG_SECTION_CODECS;
  const roleKeyById = access.roleConfigKeys(acc.roles);
  const base = () => {
    const bundle = structuredClone(
      platform.cafeLegendPlatformFixtures.configBundle,
    );
    bundle.sections.roles = { version: 1, items: roles.toTemplate(acc.roles) };
    bundle.sections.approval_policies = {
      version: 1,
      items: approval_policies.toTemplate(acc.approvalPolicies, {
        roleKeyById,
      }),
    };
    bundle.sections.chart_of_accounts = {
      version: 1,
      items: chart_of_accounts.toTemplate(books.accounts),
    };
    return bundle;
  };
  assert.equal(platform.parseConfigBundle(base(), SOURCE_IDS).ok, true);

  const ghost = base();
  ghost.sections.approval_policies.items[0].approverRoleKey = "ghost";
  const ghostResult = platform.parseConfigBundle(ghost, SOURCE_IDS);
  assert.equal(ghostResult.ok, false);
  assert.match(ghostResult.schemaIssues.join("\n"), /ghost/);

  const orphan = base();
  orphan.sections.chart_of_accounts.items[1].parentCode = "9";
  assert.equal(platform.parseConfigBundle(orphan, SOURCE_IDS).ok, false);

  // approval_policies alone may reference roles of the target tenant.
  const partial = base();
  delete partial.sections.roles;
  assert.equal(platform.parseConfigBundle(partial, SOURCE_IDS).ok, true);
});

test("decodeConfigBundle reports sections it has no codec for", () => {
  const bundle = platform.parseConfigBundle(
    platform.cafeLegendPlatformFixtures.configBundle,
    SOURCE_IDS,
  ).bundle;
  const decoded = platform.decodeConfigBundle(bundle);
  assert.equal(decoded.ok, true);
  assert.ok(decoded.withoutCodec.includes("zones"));
  assert.ok(!decoded.withoutCodec.includes("roles"));
});
