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

test("registry has a codec for every section", () => {
  for (const section of [
    "roles",
    "approval_policies",
    "chart_of_accounts",
    "zones",
    "tax_rules",
    "service_charge_rules",
    "checklists",
    "facilities",
    "loyalty_policy",
    "wifi_policies",
    "payroll_settings",
  ]) {
    const codec = platform.CONFIG_SECTION_CODECS[section];
    assert.ok(codec, section);
    assert.equal(codec.section, section);
    assert.equal(codec.version, 1);
    assert.equal(platform.configSectionCodec(section), codec);
  }
  assert.ok(platform.configSectionCodec("payroll_settings"));
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
  const cash = items.find((i) => i.kind === "account" && i.code === "1101");
  assert.equal(cash.parentKey, "acct.1100");

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
  const orphan = coa.fromTemplate([{ ...a, parentKey: "acct.9999" }]);
  assert.equal(orphan.ok, false);
  assert.match(orphan.issues.join(), /9999/);

  const cycle = coa.fromTemplate([
    { ...a, parentKey: "acct.8001", key: "acct.8000", code: "8000" },
    { ...a, parentKey: "acct.8000", key: "acct.8001", code: "8001" },
  ]);
  assert.equal(cycle.ok, false);
  assert.match(cycle.issues.join(), /cycle/i);

  const other = books.accounts.find((x) => x.type !== a.type);
  const mismatch = coa.fromTemplate([
    a,
    {
      ...b,
      key: "acct.8100",
      code: "8100",
      parentKey: a.key,
      type: other.type,
    },
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
    "zones",
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
  const raw = structuredClone(platform.cafeLegendPlatformFixtures.configBundle);
  raw.sections.payroll_settings = { version: 1, items: [] };
  const parsed = platform.parseConfigBundle(raw, SOURCE_IDS);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  const decoded = platform.decodeConfigBundle(parsed.bundle);
  assert.equal(decoded.ok, true);
  assert.ok(!decoded.withoutCodec.includes("payroll_settings"));
  assert.ok(decoded.withoutCodec.includes("modules"));
  assert.ok(!decoded.withoutCodec.includes("wifi_policies"));
  assert.ok(!decoded.withoutCodec.includes("roles"));
  assert.ok(!decoded.withoutCodec.includes("zones"));
});

// ---------------------------------------------------------------------------
// legend-5cwrq: the codecs speak the `kind`-discriminated item shape of
// configSectionItemSchemas (the shape tenant-config-export writes), the
// temporary `hasKind` bridge in configBundleSchema is gone, and reference
// checks (approver role key, CoA parent key) run for kind items. Bundles
// written in the old codec shape (no `kind`) must still parse and decode.
//
// ASSUMPTIONS (spec is silent, flagged in the report):
// - a `mapping` item whose accountKey names no account of the bundle can
//   never be imported, so it is refused like an orphan parent;
// - kind "template" needs a non-null templateKey, kind "custom" needs null;
// - item keys are the exporter's choice (tpl.*, custom.*, acct.*, ...); the
//   codec must not require key == templateKey / key == account code.
// ---------------------------------------------------------------------------

const { roles: rolesCodec, approval_policies: policiesCodec } =
  platform.CONFIG_SECTION_CODECS;
const coaCodec = platform.CONFIG_SECTION_CODECS.chart_of_accounts;
const sectionItemSchemas = platform.configSectionItemSchemas;

function slugOf(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Kind-shaped role items built by hand from the fixtures (not via a codec). */
function kindRoleItems() {
  return acc.roles
    .filter((r) => r.templateKey !== "super_admin")
    .map((r) => ({
      key: r.templateKey ? `tpl.${r.templateKey}` : `custom.${slugOf(r.name)}`,
      kind: r.templateKey ? "template" : "custom",
      templateKey: r.templateKey,
      name: r.name,
      permissions: [...r.permissions],
      mfaRequired: r.mfaRequired,
      allowedScopeTypes: [...r.allowedScopeTypes],
    }));
}
function roleKeyOfId(id) {
  const row = acc.roles.find((r) => r.id === id);
  return row.templateKey
    ? `tpl.${row.templateKey}`
    : `custom.${slugOf(row.name)}`;
}
function kindApprovalItems() {
  return acc.approvalPolicies.map((p, i) => ({
    key: `ap.${i}`,
    kind: "approval",
    actionType: p.actionType,
    thresholdIdr: p.thresholdIdr,
    approverRoleKey: roleKeyOfId(p.approverRoleId),
    levels: p.levels,
    requiresDistinctActor: true,
  }));
}
function kindCoaItems() {
  const codeOf = new Map(books.accounts.map((a) => [a.id, a.code]));
  const accounts = books.accounts.map((a) => ({
    key: `acct.${a.code}`,
    kind: "account",
    code: a.code,
    name: a.name,
    type: a.type,
    reportGroup: a.reportGroup,
    parentKey: a.parentId === null ? null : `acct.${codeOf.get(a.parentId)}`,
    isActive: a.isActive,
  }));
  const seenRoles = new Set();
  const mappings = [];
  for (const m of books.accountMappings) {
    if (m.legalEntityId !== books.legalEntity.id || seenRoles.has(m.role))
      continue;
    seenRoles.add(m.role);
    mappings.push({
      key: `map.${m.role}`,
      kind: "mapping",
      role: m.role,
      accountKey: `acct.${codeOf.get(m.accountId)}`,
    });
  }
  return [...accounts, ...mappings];
}
function kindBundle() {
  const bundle = structuredClone(
    platform.cafeLegendPlatformFixtures.configBundle,
  );
  bundle.sections.roles = { version: 1, items: kindRoleItems() };
  bundle.sections.approval_policies = {
    version: 1,
    items: [
      ...kindApprovalItems(),
      {
        key: "pos.tenant",
        kind: "pos_discount",
        outletKey: null,
        discountThresholdBp: 1000,
      },
    ],
  };
  bundle.sections.chart_of_accounts = { version: 1, items: kindCoaItems() };
  return bundle;
}

/** Frozen old-codec items (no `kind`), written out as the tct8 codecs did. */
function legacyBundle() {
  const bundle = structuredClone(
    platform.cafeLegendPlatformFixtures.configBundle,
  );
  const policy = acc.approvalPolicies[0];
  bundle.sections.roles = {
    version: 1,
    items: [
      {
        key: "custom.kasir-senior",
        name: "Kasir Senior",
        templateKey: null,
        permissions: ["floor.table.view"],
        allowedScopeTypes: ["outlet"],
        mfaRequired: false,
      },
    ],
  };
  bundle.sections.approval_policies = {
    version: 1,
    items: [
      {
        key: "legacy.approval",
        actionType: policy.actionType,
        thresholdIdr: null,
        levels: 1,
        approverRoleKey: "custom.kasir-senior",
        requiresDistinctActor: true,
      },
    ],
  };
  bundle.sections.chart_of_accounts = {
    version: 1,
    items: [
      {
        key: "8000",
        name: "Aset Uji",
        type: "asset",
        reportGroup: "cash_and_equivalents",
        parentCode: null,
        isActive: true,
      },
      {
        key: "8001",
        name: "Kas Uji",
        type: "asset",
        reportGroup: "cash_and_equivalents",
        parentCode: "8000",
        isActive: true,
      },
    ],
  };
  return bundle;
}

test("legend-5cwrq: codec item schemas accept the kind shape of configSectionItemSchemas", () => {
  const sets = [
    [rolesCodec, kindRoleItems()],
    [
      policiesCodec,
      [
        ...kindApprovalItems(),
        {
          key: "pos.x",
          kind: "pos_discount",
          outletKey: "bdg-01",
          discountThresholdBp: 500,
        },
      ],
    ],
    [coaCodec, kindCoaItems()],
  ];
  for (const [codec, items] of sets) {
    assert.ok(items.length > 0, codec.section);
    for (const item of items) {
      // The export boundary and the codec agree on one shape.
      assert.equal(
        sectionItemSchemas[codec.section].safeParse(item).success,
        true,
        `${codec.section} ${item.key} (boundary)`,
      );
      const parsed = codec.itemSchema.safeParse(item);
      assert.equal(
        parsed.success,
        true,
        `${codec.section} ${item.key}: ${JSON.stringify(parsed.error?.issues)}`,
      );
      assert.equal(
        codec.itemSchema.safeParse({ ...item, kind: "nope" }).success,
        false,
        `${codec.section} ${item.key} unknown kind`,
      );
      assert.equal(
        codec.itemSchema.safeParse({ ...item, extra: 1 }).success,
        false,
        `${codec.section} ${item.key} extra field`,
      );
    }
  }
});

test("legend-5cwrq: toTemplate emits kind items the export boundary accepts", () => {
  const roleKeyById = access.roleConfigKeys(acc.roles);
  const roleItems = rolesCodec.toTemplate(acc.roles);
  const policyItems = policiesCodec.toTemplate(acc.approvalPolicies, {
    roleKeyById,
  });
  const coaItems = coaCodec.toTemplate(books.accounts);
  for (const [section, items] of [
    ["roles", roleItems],
    ["approval_policies", policyItems],
    ["chart_of_accounts", coaItems],
  ]) {
    assert.ok(items.length > 0, section);
    assert.equal(new Set(items.map((i) => i.key)).size, items.length, section);
    for (const item of items) {
      assert.ok("kind" in item, `${section} ${item.key} has a kind`);
      const parsed = sectionItemSchemas[section].safeParse(item);
      assert.equal(
        parsed.success,
        true,
        `${section} ${item.key}: ${JSON.stringify(parsed.error?.issues)}`,
      );
    }
    assert.deepEqual(platform.findBundleIdentifiers(items, SOURCE_IDS), []);
  }
  // roles: kind follows the template key.
  for (const item of roleItems) {
    assert.equal(item.kind, item.templateKey === null ? "custom" : "template");
  }
  assert.ok(!roleItems.some((i) => i.templateKey === "super_admin"));
  // approvals: policy rows are kind "approval" and name roles by item key.
  const roleKeys = new Set(roleItems.map((i) => i.key));
  assert.equal(policyItems.length, acc.approvalPolicies.length);
  for (const item of policyItems) {
    assert.equal(item.kind, "approval");
    assert.ok(roleKeys.has(item.approverRoleKey), item.approverRoleKey);
  }
  // CoA: accounts carry their code and point at the parent's item key.
  assert.equal(coaItems.length, books.accounts.length);
  const accountKeys = new Set(coaItems.map((i) => i.key));
  for (const item of coaItems) {
    assert.equal(item.kind, "account");
    assert.ok(typeof item.code === "string" && item.code !== "");
    if (item.parentKey !== null) assert.ok(accountKeys.has(item.parentKey));
  }
  const cash = coaItems.find((i) => i.code === "1101");
  assert.equal(coaItems.find((i) => i.key === cash.parentKey).code, "1100");
  // Same input, same output, whatever the row order.
  assert.deepEqual(
    coaCodec.toTemplate([...books.accounts].reverse()),
    coaItems,
  );
});

test("legend-5cwrq: kind items decode into id-less drafts", () => {
  const roles = rolesCodec.fromTemplate(kindRoleItems());
  assert.equal(roles.ok, true, JSON.stringify(roles.issues));
  assert.equal(roles.drafts.length, kindRoleItems().length);
  for (const draft of roles.drafts)
    for (const forbidden of ["id", "tenantId", "createdAt", "updatedAt"])
      assert.equal(forbidden in draft, false, forbidden);
  const custom = roles.drafts.find((d) => d.templateKey === null);
  assert.equal(custom.isTemplate, false);
  assert.ok(roles.drafts.some((d) => d.isTemplate === true));

  const roleKeys = new Set(kindRoleItems().map((i) => i.key));
  const policies = policiesCodec.fromTemplate(kindApprovalItems(), {
    roleKeys,
  });
  assert.equal(policies.ok, true, JSON.stringify(policies.issues));
  assert.equal(policies.drafts.length, acc.approvalPolicies.length);
  for (const draft of policies.drafts) {
    assert.equal("id" in draft, false);
    assert.equal("approverRoleId" in draft, false);
  }
  // A POS discount item is valid and needs no role.
  const pos = policiesCodec.fromTemplate(
    [
      {
        key: "pos.tenant",
        kind: "pos_discount",
        outletKey: null,
        discountThresholdBp: 1000,
      },
    ],
    { roleKeys: new Set() },
  );
  assert.equal(pos.ok, true, JSON.stringify(pos.issues));

  const coa = coaCodec.fromTemplate(kindCoaItems());
  assert.equal(coa.ok, true, JSON.stringify(coa.issues));
  const seen = new Set();
  for (const draft of coa.drafts) {
    if (draft.parentCode !== null)
      assert.ok(seen.has(draft.parentCode), `parent before ${draft.code}`);
    seen.add(draft.code);
    for (const forbidden of ["id", "tenantId", "legalEntityId", "parentId"])
      assert.equal(forbidden in draft, false, forbidden);
  }
  assert.ok(seen.has("1101"));
});

test("legend-5cwrq: kind role items keep the template/custom rules", () => {
  const [custom] = kindRoleItems().filter((i) => i.kind === "custom");
  const [template] = kindRoleItems().filter(
    (i) => i.kind === "template" && i.templateKey !== "super_admin",
  );
  const customWithTemplate = rolesCodec.fromTemplate([
    { ...custom, templateKey: "cashier" },
  ]);
  assert.equal(customWithTemplate.ok, false);
  assert.match(customWithTemplate.issues.join(), /templateKey/);
  const templateWithout = rolesCodec.fromTemplate([
    { ...template, templateKey: null },
  ]);
  assert.equal(templateWithout.ok, false);
  assert.match(templateWithout.issues.join(), /templateKey/);
  // A bundle can never create or match the platform super_admin role.
  const superAdmin = rolesCodec.fromTemplate([
    {
      ...template,
      key: "tpl.super_admin",
      templateKey: "super_admin",
      permissions: [],
    },
  ]);
  assert.equal(superAdmin.ok, false);
  // The exporter chooses keys: a custom role key need not look like a
  // template key (a template role key must, see the 5cwrq key-shape test).
  const odd = rolesCodec.fromTemplate([
    { ...custom, key: "role.pilihan-saya" },
  ]);
  assert.equal(odd.ok, true, JSON.stringify(odd.issues));
});

test("legend-5cwrq: kind references are checked on decode", () => {
  const roleKeys = new Set(kindRoleItems().map((i) => i.key));
  const approvals = kindApprovalItems();

  const ghost = policiesCodec.fromTemplate(
    [{ ...approvals[0], approverRoleKey: "ghost" }],
    { roleKeys },
  );
  assert.equal(ghost.ok, false);
  assert.match(ghost.issues.join("\n"), /ghost/);
  assert.match(ghost.issues.join("\n"), /approverRoleKey/);

  const gap = policiesCodec.fromTemplate(
    [
      {
        ...approvals[0],
        key: "gap.level3",
        thresholdIdr: 987_654_321,
        levels: 3,
      },
    ],
    { roleKeys },
  );
  assert.equal(gap.ok, false);
  assert.match(gap.issues.join("\n"), /level/i);

  const [a, b] = kindCoaItems().filter((i) => i.kind === "account");
  const orphan = coaCodec.fromTemplate([{ ...a, parentKey: "acct.9999" }]);
  assert.equal(orphan.ok, false);
  assert.match(orphan.issues.join(), /acct\.9999/);

  const cycle = coaCodec.fromTemplate([
    { ...a, key: "acct.8000", code: "8000", parentKey: "acct.8001" },
    { ...a, key: "acct.8001", code: "8001", parentKey: "acct.8000" },
  ]);
  assert.equal(cycle.ok, false);
  assert.match(cycle.issues.join(), /cycle/i);

  const other = books.accounts.find((x) => x.type !== a.type);
  const mismatch = coaCodec.fromTemplate([
    { ...a, key: "acct.8000", code: "8000", parentKey: null },
    {
      ...b,
      key: "acct.8100",
      code: "8100",
      parentKey: "acct.8000",
      type: other.type,
      reportGroup: other.reportGroup,
    },
  ]);
  assert.equal(mismatch.ok, false);

  const mapping = kindCoaItems().find((i) => i.kind === "mapping");
  const dangling = coaCodec.fromTemplate([
    a,
    { ...mapping, accountKey: "acct.9999" },
  ]);
  assert.equal(dangling.ok, false);
  assert.match(dangling.issues.join(), /acct\.9999/);
});

test("legend-5cwrq: a kind-shaped bundle parses and decodes in one pass", () => {
  const parsed = platform.parseConfigBundle(kindBundle(), SOURCE_IDS);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.schemaIssues));
  // The server boundary accepts the same three sections (the shared fixture's
  // other sections are loose, so they are left out of the strict check).
  const strictSections = {};
  for (const section of ["roles", "approval_policies", "chart_of_accounts"])
    strictSections[section] = kindBundle().sections[section];
  const strict = platform.strictConfigBundleSchema.safeParse({
    formatVersion: 1,
    exportedAt: kindBundle().exportedAt,
    sections: strictSections,
  });
  assert.equal(strict.success, true, JSON.stringify(strict.error?.issues));
  const decoded = platform.decodeConfigBundle(parsed.bundle);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  assert.deepEqual(Object.keys(decoded.drafts).sort(), [
    "approval_policies",
    "chart_of_accounts",
    "roles",
    "zones",
  ]);
  // approval_policies alone needs the target tenant's role keys.
  const only = platform.decodeConfigBundle(parsed.bundle, {
    sections: ["approval_policies"],
  });
  assert.equal(only.ok, false);
  assert.equal(only.issues[0].section, "approval_policies");
  const withTarget = platform.decodeConfigBundle(parsed.bundle, {
    sections: ["approval_policies"],
    existingRoleKeys: new Set(kindRoleItems().map((i) => i.key)),
  });
  assert.equal(withTarget.ok, true, JSON.stringify(withTarget.issues));
});

test("legend-5cwrq: parse runs the codec checks on kind items (no hasKind bridge)", () => {
  const bad = (mutate) => {
    const bundle = kindBundle();
    mutate(bundle.sections);
    return platform.parseConfigBundle(bundle, SOURCE_IDS);
  };

  // Item-level: an unknown permission code in a kind role.
  const permission = bad((s) => {
    s.roles.items[0].permissions = ["no.such.code"];
  });
  assert.equal(permission.ok, false);
  assert.ok(
    permission.schemaIssues.some((m) => m.startsWith("sections.roles.")),
  );

  // Item-level: an unknown kind is refused, not waved through.
  const unknownKind = bad((s) => {
    s.chart_of_accounts.items[0].kind = "nope";
  });
  assert.equal(unknownKind.ok, false);
  assert.ok(
    unknownKind.schemaIssues.some((m) =>
      m.startsWith("sections.chart_of_accounts."),
    ),
  );

  // Item-level, mixed section: one good kind item must not shield a
  // malformed old-shape item next to it.
  const mixed = bad((s) => {
    s.roles.items.push({
      key: "custom.rusak",
      name: "Rusak",
      templateKey: null,
      permissions: ["no.such.code"],
      allowedScopeTypes: ["outlet"],
      mfaRequired: false,
    });
  });
  assert.equal(mixed.ok, false);

  // Reference: approver role key that the bundle's roles do not carry.
  const ghost = bad((s) => {
    s.approval_policies.items[0].approverRoleKey = "ghost";
  });
  assert.equal(ghost.ok, false);
  assert.match(ghost.schemaIssues.join("\n"), /ghost/);

  // Reference: CoA parent that does not exist.
  const orphan = bad((s) => {
    const account = s.chart_of_accounts.items.find(
      (i) => i.kind === "account" && i.parentKey !== null,
    );
    account.parentKey = "acct.9999";
  });
  assert.equal(orphan.ok, false);
  assert.match(orphan.schemaIssues.join("\n"), /acct\.9999/);

  // Reference: a role mapping that points at no account (assumption above).
  const dangling = bad((s) => {
    s.chart_of_accounts.items.find((i) => i.kind === "mapping").accountKey =
      "acct.9999";
  });
  assert.equal(dangling.ok, false);

  // approval_policies alone may reference the target tenant's roles.
  const partial = kindBundle();
  delete partial.sections.roles;
  assert.equal(platform.parseConfigBundle(partial, SOURCE_IDS).ok, true);
});

test("legend-5cwrq: legacy (kind-less) bundles still parse and decode", () => {
  const parsed = platform.parseConfigBundle(legacyBundle(), SOURCE_IDS);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.schemaIssues));
  const decoded = platform.decodeConfigBundle(parsed.bundle);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  assert.equal(decoded.drafts.roles.length, 1);
  assert.equal(decoded.drafts.roles[0].name, "Kasir Senior");
  assert.equal(decoded.drafts.approval_policies.length, 1);
  assert.equal(decoded.drafts.chart_of_accounts.length, 2);
  for (const draft of decoded.drafts.chart_of_accounts)
    for (const forbidden of ["id", "tenantId", "legalEntityId", "parentId"])
      assert.equal(forbidden in draft, false, forbidden);
});

test("legend-5cwrq: legacy bundles fail loudly, never silently", () => {
  const ghost = legacyBundle();
  ghost.sections.approval_policies.items[0].approverRoleKey = "ghost";
  const ghostResult = platform.parseConfigBundle(ghost, SOURCE_IDS);
  assert.equal(ghostResult.ok, false);
  assert.match(ghostResult.schemaIssues.join("\n"), /ghost/);

  const orphan = legacyBundle();
  orphan.sections.chart_of_accounts.items[1].parentCode = "9";
  assert.equal(platform.parseConfigBundle(orphan, SOURCE_IDS).ok, false);

  const badPermission = legacyBundle();
  badPermission.sections.roles.items[0].permissions = ["no.such.code"];
  const result = platform.parseConfigBundle(badPermission, SOURCE_IDS);
  assert.equal(result.ok, false);
  assert.ok(result.schemaIssues.some((m) => m.startsWith("sections.roles.")));
});

test("legend-5cwrq: a role in either shape decodes to the same draft", () => {
  const parsed = platform.parseConfigBundle(legacyBundle(), SOURCE_IDS);
  const decoded = platform.decodeConfigBundle(parsed.bundle);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  const kind = rolesCodec.fromTemplate([
    {
      key: "custom.kasir-senior",
      kind: "custom",
      templateKey: null,
      name: "Kasir Senior",
      permissions: ["floor.table.view"],
      allowedScopeTypes: ["outlet"],
      mfaRequired: false,
    },
  ]);
  assert.equal(kind.ok, true, JSON.stringify(kind.issues));
  assert.deepEqual(kind.drafts, decoded.drafts.roles);
});

test("legend-5cwrq: a legacy section next to a kind section resolves keys across both", () => {
  const legacyBase = legacyBundle;
  // A legacy section next to a kind section: each is judged in its own
  // shape, and cross-section role keys still resolve.
  const mixed = legacyBase();
  mixed.sections.chart_of_accounts = {
    version: 1,
    items: kindCoaItems(),
  };
  const mixedResult = platform.parseConfigBundle(mixed, SOURCE_IDS);
  assert.equal(mixedResult.ok, true, JSON.stringify(mixedResult.schemaIssues));
  const decoded = platform.decodeConfigBundle(mixedResult.bundle);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  mixed.sections.approval_policies.items[0].approverRoleKey = "ghost";
  assert.equal(platform.parseConfigBundle(mixed, SOURCE_IDS).ok, false);
});

// legend-5cwrq reviewer findings: role key rules, posting-role mapping rules
// (the ones coa.ts accountMappingIssues enforces) and duplicate item keys on
// the direct fromTemplate path (the bundle path refuses them already).

test("legend-5cwrq: roles refuse two template items with the same templateKey", () => {
  const [template] = kindRoleItems().filter(
    (i) => i.kind === "template" && i.templateKey !== "super_admin",
  );
  const result = rolesCodec.fromTemplate([
    template,
    { ...template, key: "tpl.other", name: `${template.name} 2` },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /templateKey/);
  assert.match(result.issues.join("\n"), /tpl\.other/);
});

test("legend-5cwrq: a custom role key cannot equal a template role key", () => {
  const [custom] = kindRoleItems().filter((i) => i.kind === "custom");
  const bad = rolesCodec.fromTemplate([{ ...custom, key: "owner" }]);
  assert.equal(bad.ok, false);
  assert.match(bad.issues.join("\n"), /template role key/);
  // The server exports custom roles under keys like role.kepala-bar.
  const exported = rolesCodec.fromTemplate([
    { ...custom, key: "role.kepala-bar" },
  ]);
  assert.equal(exported.ok, true, JSON.stringify(exported.issues));
  const good = rolesCodec.fromTemplate([custom]);
  assert.equal(good.ok, true, JSON.stringify(good.issues));
});

test("legend-5cwrq: mapping items follow the posting-role type rules", () => {
  const items = kindCoaItems();
  const accounts = items.filter((i) => i.kind === "account");
  const parentKeys = new Set(accounts.map((i) => i.parentKey).filter(Boolean));
  const accountOfType = (type) =>
    accounts.find((i) => i.type === type && !parentKeys.has(i.key));
  const mappingFor = (role, accountKey) => ({
    key: `map.${role}`,
    kind: "mapping",
    role,
    accountKey,
  });
  const withMapping = (mapping) => [
    ...items.filter((i) => i.kind === "account"),
    mapping,
  ];

  // Fixed-type role: salary_expense needs an expense account.
  const asset = accountOfType("asset");
  assert.ok(asset);
  const fixed = coaCodec.fromTemplate(
    withMapping(mappingFor("salary_expense", asset.key)),
  );
  assert.equal(fixed.ok, false);
  assert.match(fixed.issues.join("\n"), /salary_expense/);
  assert.match(fixed.issues.join("\n"), /expense/);

  // Restricted role: service_charge takes liability or revenue only.
  const asRestricted = coaCodec.fromTemplate(
    withMapping(mappingFor("service_charge", asset.key)),
  );
  assert.equal(asRestricted.ok, false);
  assert.match(asRestricted.issues.join("\n"), /liability or revenue/);
  for (const type of ["liability", "revenue"]) {
    const account = accountOfType(type);
    assert.ok(account, type);
    const ok = coaCodec.fromTemplate(
      withMapping(mappingFor("service_charge", account.key)),
    );
    assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  }
  const expense = accountOfType("expense");
  assert.ok(expense);
  assert.equal(
    coaCodec.fromTemplate(
      withMapping(mappingFor("payroll_custom_deduction", expense.key)),
    ).ok,
    true,
  );
  const revenue = accountOfType("revenue");
  assert.equal(
    coaCodec.fromTemplate(
      withMapping(mappingFor("payroll_custom_deduction", revenue.key)),
    ).ok,
    false,
  );
});

test("legend-5cwrq: a mapping may target a header account (server accepts it)", () => {
  const expense = kindCoaItems().find(
    (i) => i.kind === "account" && i.type === "expense",
  );
  const result = coaCodec.fromTemplate([
    { ...expense, key: "acct.8000", code: "8000", parentKey: null },
    { ...expense, key: "acct.8001", code: "8001", parentKey: "acct.8000" },
    {
      key: "map.salary_expense",
      kind: "mapping",
      role: "salary_expense",
      accountKey: "acct.8000",
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("legend-5cwrq: direct fromTemplate refuses duplicate item keys", () => {
  const roles = kindRoleItems();
  const dupRole = rolesCodec.fromTemplate([
    roles[0],
    { ...roles[1], key: roles[0].key },
  ]);
  assert.equal(dupRole.ok, false);
  assert.match(dupRole.issues.join("\n"), /duplicate key/i);

  const roleKeys = new Set(roles.map((i) => i.key));
  const approvals = kindApprovalItems();
  const dupApproval = policiesCodec.fromTemplate(
    [approvals[0], { ...approvals[1], key: approvals[0].key }],
    { roleKeys },
  );
  assert.equal(dupApproval.ok, false);
  assert.match(dupApproval.issues.join("\n"), /duplicate key/i);

  // A pos_discount item shares the key space with approval rules.
  const dupPos = policiesCodec.fromTemplate(
    [
      approvals[0],
      {
        key: approvals[0].key,
        kind: "pos_discount",
        outletKey: null,
        discountThresholdBp: 1000,
      },
    ],
    { roleKeys },
  );
  assert.equal(dupPos.ok, false);
  assert.match(dupPos.issues.join("\n"), /duplicate key/i);
  const dupPosPair = policiesCodec.fromTemplate(
    [
      {
        key: "pos.x",
        kind: "pos_discount",
        outletKey: null,
        discountThresholdBp: 1000,
      },
      {
        key: "pos.x",
        kind: "pos_discount",
        outletKey: "bali",
        discountThresholdBp: 500,
      },
    ],
    { roleKeys },
  );
  assert.equal(dupPosPair.ok, false);
  assert.match(dupPosPair.issues.join("\n"), /duplicate key/i);

  const items = kindCoaItems();
  const [a, b] = items.filter((i) => i.kind === "account");
  const dupAccount = coaCodec.fromTemplate([
    a,
    { ...b, key: a.key, code: "8000", parentKey: null },
  ]);
  assert.equal(dupAccount.ok, false);
  assert.match(dupAccount.issues.join("\n"), /duplicate key/i);
  // Mapping keys share the section key space with account keys.
  const mapping = items.find((i) => i.kind === "mapping");
  const dupMapping = coaCodec.fromTemplate([
    ...items.filter((i) => i.kind === "account"),
    mapping,
    { ...mapping, role: "service_charge" },
  ]);
  assert.equal(dupMapping.ok, false);
  assert.match(dupMapping.issues.join("\n"), /duplicate key/i);
  const clash = coaCodec.fromTemplate([
    a,
    { ...mapping, key: a.key, accountKey: a.key },
  ]);
  assert.equal(clash.ok, false);
  assert.match(clash.issues.join("\n"), /duplicate key/i);
});

// legend-5cwrq: a kind "template" role item's key is not free text. The
// exporter's uniqueKey (config-codec.ts) emits the template key itself, or
// `<templateKey>-<n>` (n >= 2) when two roles share it. Import must refuse
// any other key, so a template role can never be filed under another role's
// name (e.g. key "owner" carrying templateKey "cashier").
// Assumption: any `-<digits>` suffix is accepted, not only n >= 2.
test("legend-5cwrq: a template role key must be its templateKey or <templateKey>-<n>", () => {
  const [base] = kindRoleItems().filter(
    (i) => i.kind === "template" && i.templateKey === "cashier",
  );
  assert.ok(base, "fixtures have a cashier template role");
  const template = (key, templateKey) => ({
    ...base,
    key,
    kind: "template",
    templateKey,
  });

  // Refused: key unrelated to the template key.
  for (const [key, templateKey] of [
    ["owner", "cashier"],
    ["tpl.owner", "cashier"],
    ["role.pilihan-saya", "cashier"],
    ["cashier-x", "cashier"],
    ["cashier-", "cashier"],
    ["cashier-2x", "cashier"],
    ["xcashier-2", "cashier"],
  ]) {
    const refused = rolesCodec.fromTemplate([template(key, templateKey)]);
    assert.equal(refused.ok, false, `${key} / ${templateKey} is refused`);
    assert.match(
      refused.issues.join("\n"),
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(refused.issues.join("\n"), /templateKey|key/);
  }

  // Accepted: the template key itself, or the exporter's `-<n>` suffix.
  for (const [key, templateKey] of [
    ["owner", "owner"],
    ["cashier", "cashier"],
    ["cashier-2", "cashier"],
    ["cashier-12", "cashier"],
    ["tpl.cashier", "cashier"],
    ["tpl.cashier-2", "cashier"],
    ["tpl.owner", "owner"],
  ]) {
    const ok = rolesCodec.fromTemplate([template(key, templateKey)]);
    assert.equal(
      ok.ok,
      true,
      `${key} / ${templateKey}: ${JSON.stringify(ok.issues)}`,
    );
    assert.equal(ok.drafts[0].key, key);
    assert.equal(ok.drafts[0].templateKey, templateKey);
  }

  // kind "custom" is unchanged: any non-template key is fine.
  const [custom] = kindRoleItems().filter((i) => i.kind === "custom");
  const customOk = rolesCodec.fromTemplate([
    { ...custom, key: "custom.apa-saja" },
  ]);
  assert.equal(customOk.ok, true, JSON.stringify(customOk.issues));

  // Legacy items (no `kind`) are unchanged: key must equal templateKey.
  const legacyBase = { ...base };
  delete legacyBase.kind;
  const legacyOk = rolesCodec.fromTemplate([
    { ...legacyBase, key: "cashier", templateKey: "cashier" },
  ]);
  assert.equal(legacyOk.ok, true, JSON.stringify(legacyOk.issues));
  const legacyBad = rolesCodec.fromTemplate([
    { ...legacyBase, key: "owner", templateKey: "cashier" },
  ]);
  assert.equal(legacyBad.ok, false);
  assert.match(legacyBad.issues.join(), /templateKey/);
});

// Founder decision (2026-11-11): the cashier discount approval threshold is
// 1..5000 bp. 0 is refused everywhere (importer and DB check), and so is
// anything above 50%.
test("pos_discount threshold: codec fromTemplate accepts 1..5000 bp and refuses 0, 5001 and 10000", () => {
  const posItem = (discountThresholdBp) => ({
    key: "pos.tenant",
    kind: "pos_discount",
    outletKey: null,
    discountThresholdBp,
  });
  const run = (bp) =>
    policiesCodec.fromTemplate([posItem(bp)], { roleKeys: new Set() });
  for (const bp of [1, 5000]) {
    const ok = run(bp);
    assert.equal(ok.ok, true, `${bp} bp: ${JSON.stringify(ok.issues)}`);
  }
  for (const bp of [0, 5001, 10000]) {
    const refused = run(bp);
    assert.equal(refused.ok, false, `${bp} bp must be refused`);
  }
});

// legend-9k0a5: wifi_policies codec. `spendMode` (0216_wifi_quota_engine.sql,
// legend-kmd3) must survive the bundle; the item stays secret-free (no Wi-Fi
// password) and id-free (zoneKey/facilityKey/outletKey are keys).
const wifiCodec = platform.CONFIG_SECTION_CODECS.wifi_policies;

function wifiItem(overrides = {}) {
  return {
    key: "kemang.wifi.main",
    outletKey: "kemang",
    zoneKey: "main-hall",
    facilityKey: null,
    freeMinutes: 60,
    peakFreeMinutes: 30,
    spendPerExtraHourIdr: 50_000,
    extraMinutes: 60,
    maxDevices: 3,
    peakSchedule: [{ daysOfWeek: [5, 6], startsAt: "18:00", endsAt: "23:00" }],
    baseSpeedKbps: 2000,
    fullSpeedKbps: 10_000,
    minSpendPerHourIdr: null,
    tierBonusMinutes: { gold: 30 },
    ...overrides,
  };
}

test("legend-9k0a5: wifi spendMode round-trips through toTemplate and fromTemplate", () => {
  for (const spendMode of ["per_day_multiple", "per_order", null]) {
    const row = wifiItem({ spendMode });
    const [exported] = wifiCodec.toTemplate([row]);
    assert.equal(exported.spendMode, spendMode, String(spendMode));
    const decoded = wifiCodec.fromTemplate([exported]);
    assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
    assert.deepEqual(decoded.drafts, [exported]);
  }
});

test("legend-9k0a5: wifi item without spendMode (older bundle) still decodes", () => {
  const decoded = wifiCodec.fromTemplate([wifiItem()]);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  assert.equal(decoded.drafts[0].spendMode ?? null, null);
});

test("legend-9k0a5: wifi spendMode refuses values the DB check refuses", () => {
  const ok = wifiCodec.fromTemplate([wifiItem({ spendMode: "per_order" })]);
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  for (const spendMode of ["weekly", "", "PER_ORDER", 1, true]) {
    const refused = wifiCodec.fromTemplate([wifiItem({ spendMode })]);
    assert.equal(refused.ok, false, `${String(spendMode)} must be refused`);
    assert.match(refused.issues.join(), /spendMode/);
  }
  assert.throws(
    () => wifiCodec.toTemplate([wifiItem({ spendMode: "weekly" })]),
    /spendMode/,
  );
});

test("legend-9k0a5: wifi item refuses secrets (password, ssid key, token)", () => {
  for (const field of [
    "password",
    "wifiPassword",
    "psk",
    "passphrase",
    "radiusSecret",
    "apiToken",
  ]) {
    const refused = wifiCodec.fromTemplate([wifiItem({ [field]: "hunter2" })]);
    assert.equal(refused.ok, false, `${field} must be refused`);
    assert.throws(
      () => wifiCodec.toTemplate([wifiItem({ [field]: "hunter2" })]),
      new RegExp(field),
    );
  }
});

test("legend-9k0a5: wifi item refuses ids and id-shaped references", () => {
  const id = crypto.randomUUID();
  for (const field of [
    "id",
    "tenantId",
    "outletId",
    "zoneId",
    "facilityId",
    "createdAt",
  ]) {
    const refused = wifiCodec.fromTemplate([wifiItem({ [field]: id })]);
    assert.equal(refused.ok, false, `${field} must be refused`);
    assert.throws(() => wifiCodec.toTemplate([wifiItem({ [field]: id })]));
  }
  for (const field of ["key", "outletKey", "zoneKey", "facilityKey"]) {
    const refused = wifiCodec.fromTemplate([wifiItem({ [field]: id })]);
    assert.equal(refused.ok, false, `${field} as a uuid must be refused`);
  }
});

test("legend-9k0a5: wifi refs are keys checked against the bundle, spendMode kept", () => {
  const item = wifiItem({
    spendMode: "per_order",
    facilityKey: "kemang.facility.lounge",
  });
  const good = wifiCodec.fromTemplate([item], {
    zoneKeys: new Set(["main-hall"]),
    facilityKeys: new Set(["kemang.facility.lounge"]),
  });
  assert.equal(good.ok, true, JSON.stringify(good.issues));
  assert.equal(good.drafts[0].spendMode, "per_order");
  const bad = wifiCodec.fromTemplate([item], {
    zoneKeys: new Set(["other-zone"]),
    facilityKeys: new Set(),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.issues.join(), /zoneKey main-hall/);
  assert.match(bad.issues.join(), /facilityKey kemang\.facility\.lounge/);
});

test("legend-9k0a5: wifi section item schema in the bundle accepts spendMode", () => {
  const schema = sectionItemSchemas.wifi_policies;
  assert.equal(
    schema.safeParse(wifiItem({ spendMode: "per_order" })).success,
    true,
  );
  assert.equal(
    schema.safeParse(wifiItem({ spendMode: "weekly" })).success,
    false,
  );
});

// legend-p5vke: payroll policy settings travel without tenant or legal entity IDs.
test("payroll settings round-trip safely and reject invalid references", () => {
  const codec = platform.CONFIG_SECTION_CODECS.payroll_settings;
  const row = {
    id: crypto.randomUUID(),
    tenantId: crypto.randomUUID(),
    legalEntityId: crypto.randomUUID(),
    name: "Bulanan",
    employeeGroup: { code: "STAFF", name: "Staff", employmentTypes: ["pkwtt"] },
    cycle: {
      frequency: "monthly",
      cutoffDay: 20,
      payDay: 25,
      payMonthOffset: 0,
    },
    payDateAdjustment: "previous_working_day",
    jkkRiskClass: "low",
    bpjsProgrammes: [],
    isActive: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
  const items = codec.toTemplate([row], {
    legalEntityKeys: new Map([[row.legalEntityId, "pt-legend"]]),
  });
  assert.deepEqual(
    platform.findBundleIdentifiers(items, [
      row.id,
      row.tenantId,
      row.legalEntityId,
    ]),
    [],
  );
  const decoded = codec.fromTemplate(items, {
    legalEntityKeys: new Set(["pt-legend"]),
  });
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  assert.equal(decoded.drafts[0].cycle.payDay, 25);
  assert.equal(decoded.drafts[0].legalEntityKey, "pt-legend");
  assert.equal("legalEntityId" in decoded.drafts[0], false);
  const bundle = {
    formatVersion: 1,
    exportedAt: "2026-11-01T00:00:00.000Z",
    sections: { payroll_settings: { version: 1, items } },
  };
  const parsed = platform.parseConfigBundle(bundle, [
    row.tenantId,
    row.legalEntityId,
  ]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.schemaIssues));
  assert.equal(
    platform.decodeConfigBundle(parsed.bundle, {
      lockedPointValueIdr: null,
      existingLegalEntityKeys: new Set(["pt-legend"]),
    }).ok,
    true,
  );
  assert.equal(
    platform.decodeConfigBundle(parsed.bundle, {
      lockedPointValueIdr: null,
      existingLegalEntityKeys: new Set(),
    }).ok,
    false,
  );
  const longKeys = new Map([[row.legalEntityId, "a".repeat(100)]]);
  const longItems = codec.toTemplate([row], { legalEntityKeys: longKeys });
  assert.ok(longItems[0].key.length <= 100);
  assert.deepEqual(
    codec.toTemplate([row], { legalEntityKeys: longKeys }),
    longItems,
  );
  assert.equal(
    codec.fromTemplate(items, { legalEntityKeys: new Set() }).ok,
    false,
  );
  assert.equal(codec.fromTemplate([items[0], items[0]]).ok, false);
  assert.equal(
    codec.fromTemplate([{ ...items[0], tenantId: row.tenantId }]).ok,
    false,
  );
  assert.equal(
    codec.fromTemplate([
      { ...items[0], cycle: { ...items[0].cycle, payDay: 10 } },
    ]).ok,
    false,
  );
});

test("payroll settings: legacy stored JSON remains readable but cannot be imported", () => {
  const template = structuredClone(
    platform.cafeLegendPlatformFixtures.configTemplate,
  );
  template.payload.sections.payroll_settings = {
    version: 1,
    items: [{ key: "legacy", amountIdr: 5000000 }],
  };
  assert.equal(platform.configTemplateSchema.safeParse(template).success, true);
  assert.equal(
    platform.parseConfigBundle(template.payload, [], { strictItems: true }).ok,
    false,
  );
  const bad = structuredClone(template);
  bad.payload.sections.payroll_settings.items[0].tenantId = crypto.randomUUID();
  assert.equal(platform.configTemplateSchema.safeParse(bad).success, false);
  const malformed = structuredClone(template);
  malformed.payload.sections.payroll_settings.items[0].kind = "payroll_policy";
  assert.equal(
    platform.configTemplateSchema.safeParse(malformed).success,
    false,
  );
});
