// Tenant settings rules (bead legend-5k0; PRD v1.7 §3 F4 "Integrasi per
// Tenant", "Whitelabel", "Teks & Kamus Istilah", "Konfigurasi sebagai Data").
// Acceptance: PAY-06 (credentials never reach the client), TEN-08 (no platform
// identity in tenant spaces), TEN-09 (config export/import), TEN-10 (theme
// below WCAG 2.2 AA cannot be activated).

import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";

// Shared sources use bundler-style extensionless imports; let Node try ".ts".
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { QueryClient, MutationObserver } = webRequire("@tanstack/react-query");

const platform = await import("../packages/shared/src/platform/index.ts");
const theme = await import("../packages/shared/src/theme/index.ts");
const textPkg = await import("../packages/shared/src/text/index.ts");
const feature = "../apps/web/src/features/ws01-tenant-settings";
const integrations = await import(`${feature}/integrations-lib.ts`);
const save = await import(`${feature}/integrations-save.ts`);
const { createSecretBuffer } = await import(`${feature}/secret-buffer.ts`);
const themeLib = await import(`${feature}/theme-lib.ts`);
const configLib = await import(`${feature}/config-lib.ts`);
const termsLib = await import(`${feature}/terms-lib.ts`);
const { tenantSettingsMessages } =
  await import("../packages/shared/src/i18n/messages/ws01-tenant-settings.ts");

const fx = platform.cafeLegendPlatformFixtures;
const doit = integrations.PROVIDER_DEFINITIONS.doit;
const SECRET_A = "sk_live_TOPSECRET_9f8e7d6c5b4a";
const SECRET_B = "whsec_ANOTHER_SECRET_1234567890";

// ------------------------------------------------------------------- PAY-06

test("PAY-06 · no secret value is kept in the query or mutation cache after a save", async () => {
  const client = new QueryClient();
  const listKey = ["GET /api/org/integrations", {}];
  client.setQueryData(listKey, { data: [...fx.integrations] });

  const buffer = createSecretBuffer();
  buffer.put({ apiKey: SECRET_A, webhookSecret: SECRET_B });

  let sent;
  const stored = fx.integrations[0];
  const send = async (body) => {
    sent = body;
    // The API answers with a secret reference and field names only.
    return {
      data: platform.tenantIntegrationSchema.parse({
        ...stored,
        updatedAt: "2026-11-03T03:00:00.000Z",
      }),
    };
  };

  const input = integrations.buildUpsertInput(
    doit,
    { outletId: null },
    { environment: "sandbox", merchantName: "Cafe Legend" },
    undefined,
  );
  assert.equal("credentials" in input, false, "form body carries no secrets");

  const observer = new MutationObserver(client, {
    gcTime: 0,
    mutationFn: (variables) =>
      save.runSaveIntegration(client, listKey, send, variables),
  });
  await observer.mutate({ input, secrets: buffer });

  // The secret went to the API exactly once, in the request body.
  assert.equal(sent.credentials.apiKey, SECRET_A);
  assert.equal(sent.credentials.webhookSecret, SECRET_B);

  // Nothing the client keeps afterwards contains it.
  const queries = JSON.stringify(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.state),
  );
  const mutations = JSON.stringify(
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  );
  for (const secret of [SECRET_A, SECRET_B]) {
    assert.equal(queries.includes(secret), false, "query cache");
    assert.equal(mutations.includes(secret), false, "mutation cache");
    assert.equal(JSON.stringify(buffer).includes(secret), false, "buffer");
  }
  assert.equal(buffer.take(), undefined, "the buffer was emptied by the send");
  client.clear();
});

test("PAY-06 · the wire contract refuses a credential value in a read, and in config", () => {
  const row = fx.integrations[0];
  assert.deepEqual(row.credentials.fields, ["apiKey", "webhookSecret"]);
  // A row that tried to carry a value next to the reference is rejected.
  const leaky = {
    ...row,
    credentials: { ...row.credentials, apiKey: SECRET_A },
  };
  assert.equal(
    platform.tenantIntegrationSchema.safeParse(leaky).success,
    false,
  );
  // Secret-looking config keys are refused too (credentials only).
  assert.equal(
    platform.integrationConfigSchema.safeParse({ apiKey: SECRET_A }).success,
    false,
  );
  // Audit/log copy redacts every credential value.
  const redacted = platform.redactIntegrationInput({
    outletId: null,
    provider: "doit",
    config: { merchantName: "Cafe Legend" },
    credentials: { apiKey: SECRET_A },
  });
  assert.equal(JSON.stringify(redacted).includes(SECRET_A), false);
});

test("PAY-06 · credentials are replaced all-or-nothing and the stored ones are never prefilled", () => {
  const draft = integrations.configDraftFor(doit, fx.integrations[0]);
  assert.deepEqual(draft, {
    environment: "sandbox",
    merchantName: "Cafe Legend",
  });

  // Untouched replacement set: valid, the stored secret is kept.
  assert.deepEqual(integrations.validateIntegrationDraft(doit, draft, {}), {});
  // Half a set is refused (the API replaces the blob as a whole).
  const half = integrations.validateIntegrationDraft(doit, draft, {
    apiKey: SECRET_A,
  });
  assert.ok(half["credential:webhookSecret"]);
  assert.equal(half["credential:apiKey"], undefined);
  // A full set is valid and is the only way credentials enter the body.
  const full = { apiKey: SECRET_A, webhookSecret: SECRET_B };
  assert.deepEqual(
    integrations.validateIntegrationDraft(doit, draft, full),
    {},
  );
  const body = integrations.buildUpsertInput(
    doit,
    { outletId: null },
    draft,
    full,
  );
  assert.deepEqual(body.credentials, full);
  assert.equal(
    platform.upsertIntegrationInputSchema.safeParse(body).success,
    true,
  );
  // The masked label is a constant, not derived from any stored value.
  assert.equal(integrations.CREDENTIAL_MASK, "••••••••");
  assert.deepEqual(integrations.storedCredentialFields(fx.integrations[0]), [
    "apiKey",
    "webhookSecret",
  ]);
});

test("PAY-06 · WhatsApp number and email sender are validated and normalized", () => {
  const wa = integrations.PROVIDER_DEFINITIONS.whatsapp;
  assert.equal(
    integrations.normalizeWhatsappNumber("0812-3450-0001"),
    "6281234500001",
  );
  assert.equal(
    integrations.normalizeWhatsappNumber("+62 812 3450 0001"),
    "6281234500001",
  );
  const bad = integrations.validateIntegrationDraft(
    wa,
    { vendor: "kirimdev", receivingNumber: "12345" },
    {},
  );
  assert.ok(bad.receivingNumber);
  const ok = integrations.buildUpsertInput(
    wa,
    { outletId: null },
    { vendor: "kirimdev", receivingNumber: "0812-3450-0001" },
    undefined,
  );
  assert.equal(ok.config.receivingNumber, "6281234500001");

  const email = integrations.PROVIDER_DEFINITIONS.email;
  assert.ok(
    integrations.validateIntegrationDraft(
      email,
      { senderAddress: "bukan-email" },
      {},
    ).senderAddress,
  );
  assert.deepEqual(
    integrations.validateIntegrationDraft(
      email,
      { senderAddress: "halo@cafelegend.example" },
      {},
    ),
    {},
  );
});

test("PAY-06 · scope rows resolve per outlet and an active integration needs stored credentials", () => {
  const rows = fx.integrations;
  const outletId = fx.outlets[0].id;
  assert.equal(
    integrations.rowForScope(rows, "doit", { outletId: null }).provider,
    "doit",
  );
  assert.equal(integrations.rowForScope(rows, "doit", { outletId }), null);
  assert.equal(
    integrations.inheritedRow(rows, "doit", { outletId }).outletId,
    null,
  );
  const email = rows.find((row) => row.provider === "email");
  assert.equal(integrations.integrationView(email), "draft");
  // Draft email has no credentials yet: it cannot be activated.
  assert.deepEqual(integrations.statusActions(email), {
    canActivate: false,
    canDisable: true,
  });
});

// ------------------------------------------------------------------- TEN-10

test("TEN-10 · a theme that passes WCAG 2.2 AA in both modes may be saved", () => {
  const draft = themeLib.draftFromTheme(fx.themes[0]);
  const evaluation = themeLib.evaluateTheme(draft);
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.failuresByMode, { light: 0, dark: 0 });
  assert.equal(
    themeLib.canSaveTheme(evaluation, { dirty: true, saving: false }),
    true,
  );
  // Nothing changed or already saving: no save.
  assert.equal(
    themeLib.canSaveTheme(evaluation, { dirty: false, saving: false }),
    false,
  );
  assert.equal(
    themeLib.canSaveTheme(evaluation, { dirty: true, saving: true }),
    false,
  );
});

test("TEN-10 · a theme below WCAG 2.2 AA BLOCKS the save, whatever else changed", () => {
  const failing = themeLib.draftFromTheme(fx.themes[1]);
  const evaluation = themeLib.evaluateTheme(failing);
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failures.length > 0);
  assert.equal(
    themeLib.canSaveTheme(evaluation, { dirty: true, saving: false }),
    false,
  );

  // A pale primary with white text on it fails the primary button pair.
  const pale = themeLib.setOverride(
    themeLib.BASE_THEME_DRAFT,
    "light",
    "primary",
    "#ffee00",
  );
  const result = themeLib.evaluateTheme(pale);
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.mode === "light" &&
        failure.fg === "primary-foreground" &&
        failure.bg === "primary",
    ),
  );
  // Dark mode alone failing also blocks (both modes are checked).
  const darkOnly = themeLib.setOverride(
    themeLib.BASE_THEME_DRAFT,
    "dark",
    "primary-foreground",
    "#6ac8d2", // nearly the dark primary itself: unreadable
  );
  assert.equal(themeLib.evaluateTheme(darkOnly).ok, false);
  // The Base Theme itself passes.
  assert.equal(themeLib.evaluateTheme(themeLib.BASE_THEME_DRAFT).ok, true);
});

test("TEN-10 · contrast ratios follow the WCAG definition", () => {
  assert.ok(Math.abs(theme.contrastRatio("#000000", "#ffffff") - 21) < 0.001);
  assert.ok(Math.abs(theme.contrastRatio("#ffffff", "#ffffff") - 1) < 0.001);
  // #767676 on white is the classic 4.54:1 AA boundary.
  const boundary = theme.contrastRatio("#767676", "#ffffff");
  assert.ok(boundary >= 4.5 && boundary < 4.6);
  assert.ok(theme.contrastRatio("#777777", "#ffffff") < 4.5 + 0.06);

  const pairs = themeLib.headlinePairs(themeLib.BASE_THEME_DRAFT);
  assert.equal(pairs.length, 8);
  assert.ok(pairs.every((pair) => pair.pass && pair.ratio >= 4.5));
});

test("TEN-10 · malformed color values are reported and never become preview CSS", () => {
  const typed = themeLib.setOverride(
    themeLib.BASE_THEME_DRAFT,
    "light",
    "primary",
    "red; background:url(x)",
  );
  const evaluation = themeLib.evaluateTheme(typed);
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.invalid.length > 0);
  const vars = themeLib.previewVars(typed, "light");
  for (const [name, value] of Object.entries(vars)) {
    if (name === "--font-brand" || name === "--radius-unit") continue;
    assert.match(value, /^#[0-9a-f]{6}$/, name);
  }
  assert.equal(themeLib.normalizeHex("#ABC"), "#aabbcc");
  assert.equal(themeLib.normalizeHex("0F5E68"), "#0f5e68");
  assert.equal(themeLib.normalizeHex("nope"), "nope");
  // Clearing an override returns to the Base Theme value.
  const cleared = themeLib.setOverride(typed, "light", "primary", "");
  assert.equal(cleared.tokens.light.primary, undefined);
  assert.equal(themeLib.themeDirty(cleared, themeLib.BASE_THEME_DRAFT), false);
});

// ------------------------------------------------------------------- TEN-08

test("TEN-08 · the theme preview text names no platform identity", () => {
  const preview = Object.entries(tenantSettingsMessages.theme)
    .filter(([key]) => key.startsWith("preview"))
    .map(([, value]) => String(value));
  assert.ok(preview.length >= 8);
  for (const text of preview)
    assert.doesNotMatch(text, /legend super app|sultan|platform/i, text);
  // The brand name in the preview comes from the tenant's own brand record.
  assert.ok(fx.brand.name.length > 0);
});

// ------------------------------------------------------------------- TEN-09

function bundleText(bundle) {
  return JSON.stringify(bundle);
}

test("TEN-09 · an exported bundle parses back and previews as unchanged against itself", () => {
  const parsed = configLib.parseBundleText(bundleText(fx.configBundle));
  assert.equal(parsed.ok, true);
  const diffs = configLib.diffBundles(fx.configBundle, parsed.bundle);
  assert.deepEqual(
    diffs.map((diff) => diff.section),
    configLib.presentSections(fx.configBundle),
  );
  assert.ok(diffs.every((diff) => diff.status === "unchanged"));
  assert.equal(configLib.diffTotals(diffs).changedSections, 0);
  assert.deepEqual(configLib.selectedSections(diffs, new Set()), []);
  assert.equal(
    configLib.bundleFileName("2026-11-03T03:00:00.000Z"),
    "konfigurasi-20261103.json",
  );
});

test("TEN-09 · the preview diff reports added, changed and removed rows per section", () => {
  const incoming = structuredClone(fx.configBundle);
  const [indoor, , wfc] = fx.configBundle.sections.zones.items;
  incoming.sections.zones.items = [
    { ...indoor, name: "Indoor Lantai 2" }, // changed
    wfc, // same
    { ...wfc, key: "rooftop", name: "Rooftop", sortOrder: 3 }, // added
    // "outdoor" is gone: removed
  ];
  incoming.sections.theme.corners = "bulat"; // theme: one setting changed
  delete incoming.sections.modules; // not in the file: not previewed
  incoming.sections.payroll_settings = {
    version: 1,
    items: [
      {
        key: "pt.staff",
        kind: "payroll_policy",
        legalEntityKey: "pt",
        name: "Bulanan",
        employeeGroup: {
          code: "STAFF",
          name: "Staff",
          employmentTypes: ["pkwtt"],
        },
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
      },
    ],
  }; // A section the tenant has not got yet.

  const parsed = configLib.parseBundleText(bundleText(incoming));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  const diffs = configLib.diffBundles(fx.configBundle, parsed.bundle);
  const bySection = Object.fromEntries(
    diffs.map((diff) => [diff.section, diff]),
  );

  assert.equal(bySection.modules, undefined);
  assert.equal(bySection.zones.status, "changed");
  assert.deepEqual(bySection.zones.added, ["rooftop"]);
  assert.deepEqual(bySection.zones.changed, ["indoor"]);
  assert.deepEqual(bySection.zones.removed, ["outdoor"]);
  assert.equal(bySection.zones.unchanged, 1);
  assert.equal(bySection.theme.status, "changed");
  assert.deepEqual(bySection.theme.changed, ["corners"]);
  assert.equal(bySection.payroll_settings.status, "added");
  assert.equal(bySection.text_overrides.status, "unchanged");

  // Unchanged sections are not applied; a section the user switches off is skipped.
  assert.deepEqual(configLib.selectedSections(diffs, new Set()).sort(), [
    "payroll_settings",
    "theme",
    "zones",
  ]);
  assert.deepEqual(
    configLib.selectedSections(diffs, new Set(["zones"])).sort(),
    ["payroll_settings", "theme"],
  );
});

test("TEN-09 · a bundle with source-tenant ids, secrets or bad JSON never reaches the preview", () => {
  const empty = configLib.parseBundleText("   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty");
  assert.equal(configLib.parseBundleText("{nope").reason, "json");
  assert.equal(
    configLib.parseBundleText('{"formatVersion":9}').reason,
    "schema",
  );

  const leaky = structuredClone(fx.configBundle);
  leaky.sections.payroll_settings = {
    version: 1,
    items: [
      { key: "a", tenantId: fx.tenant.id },
      { key: "b", note: `milik ${fx.tenant.id}` },
    ],
  };
  const result = configLib.parseBundleText(bundleText(leaky));
  assert.equal(result.ok, false);
  // The strict payroll schema rejects unknown fields; the independent
  // identifier scan must still report both the forbidden key and UUID.
  assert.equal(result.reason, "schema");
  assert.ok(
    result.identifierIssues.some((issue) => issue.reason === "forbidden_key"),
  );
  assert.ok(result.identifierIssues.some((issue) => issue.reason === "uuid"));

  // A schema-valid payroll policy with an ID embedded in its name is still
  // rejected specifically by the identifier scanner.
  const embedded = structuredClone(fx.configBundle);
  embedded.sections.payroll_settings = {
    version: 1,
    items: [
      {
        key: "pt.staff",
        kind: "payroll_policy",
        legalEntityKey: "pt",
        name: `Staff ${fx.tenant.id}`,
        employeeGroup: {
          code: "STAFF",
          name: "Staff",
          employmentTypes: ["pkwtt"],
        },
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
      },
    ],
  };
  const embeddedResult = configLib.parseBundleText(bundleText(embedded));
  assert.equal(embeddedResult.ok, false);
  assert.equal(embeddedResult.reason, "identifiers");
  assert.ok(
    embeddedResult.identifierIssues.some((issue) => issue.reason === "uuid"),
  );

  const secret = structuredClone(fx.configBundle);
  secret.sections.payroll_settings = {
    version: 1,
    items: [{ key: "a", credentials: { apiKey: SECRET_A } }],
  };
  assert.equal(configLib.parseBundleText(bundleText(secret)).ok, false);
});

// ------------------------------------------------------- term dictionary (F4)

test("TEN-09 · term rows show the tenant override, the platform default and the changes to save", () => {
  const overrides = textPkg.cafeLegendTextFixtures.overrides;
  const rows = termsLib.buildTermRows(overrides, "id");
  assert.equal(rows.length, textPkg.TERM_CATALOG.length);
  const bar = rows.find((row) => row.key === "terms.stationBarKopi");
  assert.equal(bar.override.value, "Kopi");
  assert.equal(bar.effective, "Kopi");
  assert.notEqual(bar.fallback, "Kopi");
  const table = rows.find((row) => row.key === "terms.table");
  assert.equal(table.override, null);
  assert.equal(table.effective, table.fallback);

  // English rows are separate from Indonesian ones.
  const en = termsLib.buildTermRows(overrides, "en");
  assert.equal(
    en.find((row) => row.key === "terms.table").override.value,
    "Table",
  );

  const { changes, invalid } = termsLib.termChanges(rows, {
    "terms.table": "Meja Tamu", // new override
    "terms.stationBarKopi": "", // clear
    "terms.showerRoom": "Shower Room Legend", // same as stored: no change
    "terms.zone": "   ", // blank on a term without a row: no change
  });
  assert.deepEqual(invalid, {});
  assert.deepEqual(
    changes.map((change) => [change.action, change.key]),
    [
      ["set", "terms.table"],
      ["clear", "terms.stationBarKopi"],
    ],
  );
  assert.equal(
    termsLib.termChanges(rows, { "terms.table": "x".repeat(501) }).invalid[
      "terms.table"
    ],
    "tooLong",
  );
});

test("TEN-09 · the local endpoints reuse the contract's own input schemas", () => {
  assert.equal(
    textPkg.textOverrideInputSchema.safeParse({
      locale: "id",
      key: "terms.table",
      value: "Meja",
    }).success,
    true,
  );
  // A tenant id in the body is refused (TEN-02).
  assert.equal(
    textPkg.textOverrideInputSchema.safeParse({
      locale: "id",
      key: "terms.table",
      value: "Meja",
      tenantId: fx.tenant.id,
    }).success,
    false,
  );
});

test("TEN-09 · an export carrying a secret or tenant id is never saved", () => {
  const clean = { ...fx.configBundle, exportedAt: new Date().toISOString() };
  assert.equal(configLib.exportIsSafe(clean), true);
  const leaky = structuredClone(clean);
  leaky.sections.leak = {
    items: [{ key: "x", credentials: { apiKey: SECRET_A } }],
  };
  assert.equal(configLib.exportIsSafe(leaky), false);
  assert.equal(configLib.exportIsSafe({ ...clean, note: fx.tenant.id }), false);
});
