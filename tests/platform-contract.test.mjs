import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CoreError,
  cafeLegendFixtures,
} from "../packages/shared/src/core/index.ts";
import * as accounting from "../packages/shared/src/accounting/index.ts";
import * as audit from "../packages/shared/src/audit/index.ts";
import * as events from "../packages/shared/src/events/index.ts";
import * as platform from "../packages/shared/src/platform/index.ts";

// WS-01 platform & organisation contract (bead legend-q88). PRD v1.7 §3 F4
// Multi-Tenant & Super Admin, §6 A Platform & Organisasi; acceptance
// TEN-04, TEN-05, TEN-06, TEN-09, TEN-10 at contract level (TEN-02 for the
// tenant boundary of every input).

const fx = platform.cafeLegendPlatformFixtures;

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error.code === code);
}

test("Cafe Legend platform fixtures parse against their schemas", () => {
  for (const row of fx.packages) platform.platformPackageSchema.parse(row);
  platform.tenantSchema.parse(fx.tenant);
  platform.brandSchema.parse(fx.brand);
  platform.legalEntitySchema.parse(fx.legalEntity);
  for (const row of fx.outlets) platform.outletSchema.parse(row);
  for (const row of fx.domains) platform.tenantDomainSchema.parse(row);
  for (const row of fx.integrations)
    platform.tenantIntegrationSchema.parse(row);
  for (const row of fx.themes) platform.tenantThemeSchema.parse(row);
  platform.brandContextSchema.parse(fx.brandContext);
  for (const row of fx.supportGrants)
    platform.supportAccessGrantSchema.parse(row);
  for (const row of fx.platformAdmins) platform.platformAdminSchema.parse(row);
  platform.tenantUsageSchema.parse(fx.usage);
  platform.configTemplateSchema.parse(fx.configTemplate);
  assert.equal(fx.platformAdmins.filter((a) => a.isBreakGlass).length, 1);
});

test("hierarchy ids join with core, accounting and the outlet ref shape", () => {
  assert.equal(fx.tenant.id, cafeLegendFixtures.tenant.id);
  assert.equal(fx.brand.tenantId, fx.tenant.id);
  for (const outlet of fx.outlets) {
    assert.equal(outlet.brandId, fx.brand.id);
    assert.equal(outlet.legalEntityId, fx.legalEntity.id);
    // Full DTO is a superset of the embedded core reference.
    const ref = Object.fromEntries(
      Object.keys(cafeLegendFixtures.outlets[0]).map((key) => [
        key,
        outlet[key],
      ]),
    );
    assert.deepEqual(
      cafeLegendFixtures.outlets.find((o) => o.id === outlet.id),
      ref,
    );
  }
  // LegalEntityId is the accounting brand: same runtime schema object.
  assert.equal(platform.legalEntityIdSchema, accounting.legalEntityIdSchema);
  const ledgerEntity = accounting.cafeLegendAccountingFixtures.legalEntity;
  assert.equal(ledgerEntity.id, fx.legalEntity.id);
  assert.equal(ledgerEntity.tenantId, fx.tenant.id);
  assert.equal(ledgerEntity.name, fx.legalEntity.name);
  assert.equal(ledgerEntity.isPkp, fx.legalEntity.isPkp);
});

test("TEN-06 tenant, brand and outlet are created from panel input without a deploy", () => {
  const tenant = platform.createTenantInputSchema.parse({
    slug: "kopi-baru",
    name: "Kopi Baru",
    plan: "outlet-dasar",
    deploymentMode: "shared",
    featureFlags: {
      modules: ["pos", "qr_order"],
      integrationProviders: ["doit"],
    },
    limits: fx.packages[1].defaultLimits,
    firstAdmin: { name: "Admin Kopi", whatsapp: "6281298765432", email: null },
  });
  assert.equal(tenant.plan, "outlet-dasar");
  // Packages are data: any well-formed key, no enum in code.
  assert.ok(platform.packageKeySchema.safeParse("paket-promo_2027").success);
  platform.createBrandInputSchema.parse({
    slug: "kopi-baru",
    name: "Kopi Baru",
  });
  const outlet = platform.createOutletInputSchema.parse({
    brandId: fx.brand.id,
    legalEntityId: fx.legalEntity.id,
    code: "JKT-01",
    name: "Kopi Baru Jakarta",
    address: "Jl. Contoh No. 3, Jakarta",
    openingHours: fx.outlets[0].openingHours,
  });
  assert.equal(outlet.timeZone, "Asia/Jakarta");
  assert.equal(outlet.geofence, null);
  platform.createLegalEntityInputSchema.parse({
    name: "PT Kopi Baru",
    npwp: "01.234.567.8-901.000",
    isPkp: true,
    address: null,
  });
});

test("TEN-06 TEN-02 org inputs refuse a client-supplied tenantId", () => {
  const inputs = [
    [platform.createBrandInputSchema, { slug: "x-y", name: "X" }],
    [
      platform.createOutletInputSchema,
      {
        brandId: fx.brand.id,
        legalEntityId: fx.legalEntity.id,
        code: "A-1",
        name: "A",
        address: "B",
        openingHours: fx.outlets[0].openingHours,
      },
    ],
    [
      platform.upsertIntegrationInputSchema,
      { outletId: null, provider: "doit", config: {} },
    ],
    [
      platform.addDomainInputSchema,
      { brandId: fx.brand.id, hostname: "a.example" },
    ],
  ];
  for (const [schema, body] of inputs) {
    assert.ok(schema.safeParse(body).success);
    assert.equal(
      schema.safeParse({ ...body, tenantId: fx.tenant.id }).success,
      false,
    );
  }
});

test("TEN-06 tenant and outlet status machines", () => {
  assert.ok(platform.canTransitionTenant("active", "suspended"));
  assert.ok(platform.canTransitionTenant("suspended", "active"));
  assert.ok(platform.canTransitionTenant("suspended", "archived"));
  assert.equal(platform.canTransitionTenant("archived", "active"), false);
  assert.ok(platform.canTransitionOutlet("preopening", "active"));
  assert.ok(platform.canTransitionOutlet("active", "closed"));
  assert.equal(platform.canTransitionOutlet("closed", "active"), false);
  assert.equal(platform.canTransitionOutlet("active", "preopening"), false);
});

test("worker reads only active tenants from app.active_tenant_registry", () => {
  const registry = platform.ACTIVE_TENANT_REGISTRY;
  assert.equal(registry.view, "app.active_tenant_registry");
  assert.deepEqual(registry.columns, ["id"]);
  assert.match(registry.definitionSql, /WHERE status = 'active'/);
  assert.ok(platform.isTenantActive(fx.tenant));
  assert.equal(platform.isTenantActive(fx.suspendedTenant), false);
  platform.activeTenantRegistryRowSchema.parse({ id: fx.tenant.id });
  assert.equal(
    platform.activeTenantRegistryRowSchema.safeParse({
      id: fx.tenant.id,
      status: "active",
    }).success,
    false,
  );
});

test("TEN-05 a module switched off is refused on UI, API, Tanya AI and MCP", () => {
  const flags = fx.tenant.featureFlags;
  assert.equal(platform.MODULE_KEYS.length, 14);
  for (const surface of platform.MODULE_SURFACES) {
    platform.assertModuleEnabled(flags, "pos", surface);
    assert.throws(
      () => platform.assertModuleEnabled(flags, "mcp", surface),
      (error) =>
        error instanceof CoreError &&
        error.code === "FEATURE_DISABLED" &&
        error.status === 403,
    );
  }
});

test("TEN-05 feature flags fail closed when missing or malformed", () => {
  assert.equal(platform.isModuleEnabled(undefined, "pos"), false);
  assert.equal(platform.isModuleEnabled(null, "pos"), false);
  assert.equal(platform.isModuleEnabled({}, "pos"), false);
  throwsCode(
    () => platform.assertModuleEnabled(null, "pos", "api"),
    "FEATURE_DISABLED",
  );
  assert.equal(
    platform.featureFlagsSchema.safeParse({
      modules: ["pos", "pos"],
      integrationProviders: [],
    }).success,
    false,
  );
  assert.equal(
    platform.featureFlagsSchema.safeParse({
      modules: ["teleport"],
      integrationProviders: [],
    }).success,
    false,
  );
});

test("TEN-05 Tanya AI / MCP tool lists drop tools of disabled modules", () => {
  const tools = [
    { name: "sales_today", module: "pos" },
    { name: "shareholder_report", module: "shareholder_dashboard" },
    { name: "whoami", module: null },
  ];
  const visible = platform.filterByEnabledModules(
    fx.tenant.featureFlags,
    tools,
  );
  assert.deepEqual(
    visible.map((t) => t.name),
    ["sales_today", "whoami"],
  );
  assert.deepEqual(
    platform.filterByEnabledModules(null, tools).map((t) => t.name),
    ["whoami"],
  );
});

test("TEN-05 integration providers are available only when Super Admin enabled them", () => {
  const flags = fx.tenant.featureFlags;
  assert.equal(platform.isIntegrationProviderAvailable(flags, "doit"), true);
  assert.equal(platform.isIntegrationProviderAvailable(flags, "duitku"), false);
  assert.equal(
    platform.isIntegrationProviderAvailable(undefined, "doit"),
    false,
  );
});

test("TEN-05 modules outside the package cannot be switched on", () => {
  const basic = fx.packages.find((p) => p.key === "outlet-dasar");
  assert.deepEqual(
    platform.modulesOutsidePackage(["pos", "payroll", "mcp"], basic),
    ["payroll", "mcp"],
  );
  assert.deepEqual(
    platform.modulesOutsidePackage(
      fx.tenant.featureFlags.modules,
      fx.packages[0],
    ),
    [],
  );
});

test("quotas: count limits refuse the next create at the limit (PRD §3 F4 Kuota)", () => {
  const limits = { ...fx.tenant.limits, maxOutlets: 2 };
  const outlets = platform.checkCountQuota(limits, fx.usage, "outlets");
  assert.equal(outlets.allowed, false);
  assert.equal(outlets.remaining, 0);
  const employees = platform.checkCountQuota(
    fx.tenant.limits,
    fx.usage,
    "active_employees",
    6,
  );
  assert.equal(employees.allowed, true);
  assert.equal(
    platform.checkCountQuota(fx.tenant.limits, fx.usage, "active_employees", 7)
      .allowed,
    false,
  );
  assert.ok(
    fx.tenant.limits.maxActiveEmployees >= platform.LEGEND_MIN_ACTIVE_EMPLOYEES,
  );
});

test("cost caps warn at 80% and stop at 100% (PRD R18, §2 Biaya operasional)", () => {
  const { limits } = fx.tenant;
  assert.equal(
    platform.evaluateCostCap(limits, fx.usage, "whatsapp").state,
    "warning",
  );
  assert.equal(platform.evaluateCostCap(limits, fx.usage, "ai").state, "ok");
  const atCap = { ...fx.usage, aiCostIdr: limits.aiCostCapIdr };
  assert.equal(platform.evaluateCostCap(limits, atCap, "ai").state, "stopped");
  const at80 = { ...fx.usage, aiCostIdr: 240_000 };
  assert.equal(platform.evaluateCostCap(limits, at80, "ai").state, "warning");
  const below = { ...fx.usage, aiCostIdr: 239_999 };
  assert.equal(platform.evaluateCostCap(limits, below, "ai").state, "ok");
  // Cap 0 = feature off (WhatsApp default).
  assert.equal(
    platform.evaluateCostCap(fx.packages[0].defaultLimits, fx.usage, "whatsapp")
      .state,
    "stopped",
  );
  assert.equal(platform.canSpend(limits, fx.usage, "whatsapp", 25_000), true);
  assert.equal(platform.canSpend(limits, fx.usage, "whatsapp", 25_001), false);
  assert.equal(platform.canSpend(limits, fx.usage, "whatsapp", -1), false);
  assert.equal(
    platform.tenantLimitsSchema.safeParse({ ...limits, aiCostCapIdr: -1 })
      .success,
    false,
  );
});

test("TEN-04 Super Admin cannot open personal or financial data without an active session", () => {
  const who = { tenantId: fx.tenant.id, superAdminUserId: fx.superAdmin.id };
  const expiredOnly = [fx.supportGrants[0]];
  for (const dataClass of platform.SUPPORT_GATED_DATA_CLASSES)
    throwsCode(
      () =>
        platform.assertSupportAccess(expiredOnly, {
          ...who,
          dataClass,
          intent: "read",
          now: fx.now,
        }),
      "SUPPORT_ACCESS_REQUIRED",
    );
  // Non-gated data (usage, health) needs only the platform role.
  assert.equal(
    platform.assertSupportAccess([], {
      ...who,
      dataClass: "usage",
      intent: "read",
      now: fx.now,
    }),
    null,
  );
  const grant = platform.assertSupportAccess(fx.supportGrants, {
    ...who,
    dataClass: "financial",
    intent: "read",
    now: fx.now,
  });
  assert.equal(grant.id, fx.supportGrants[1].id);
  // Another tenant or another Super Admin gets nothing from this grant.
  throwsCode(
    () =>
      platform.assertSupportAccess(fx.supportGrants, {
        ...who,
        tenantId: fx.suspendedTenant.id,
        dataClass: "personal",
        intent: "read",
        now: fx.now,
      }),
    "SUPPORT_ACCESS_REQUIRED",
  );
  throwsCode(
    () =>
      platform.assertSupportAccess(fx.supportGrants, {
        ...who,
        superAdminUserId: fx.breakGlass.id,
        dataClass: "personal",
        intent: "read",
        now: fx.now,
      }),
    "SUPPORT_ACCESS_REQUIRED",
  );
});

test("TEN-04 sessions are read-only by default, time-boxed and reasoned", () => {
  const input = platform.requestSupportAccessInputSchema.parse({
    reason: "Memeriksa selisih stok bulan Oktober atas permintaan owner.",
    mfaCode: "123456",
  });
  assert.equal(input.durationMinutes, platform.SUPPORT_ACCESS_DEFAULT_MINUTES);
  assert.equal(input.durationMinutes, 60);
  assert.equal(input.accessMode, "read_only");
  assert.equal(
    platform.requestSupportAccessInputSchema.safeParse({
      reason: "cek",
      mfaCode: "123456",
    }).success,
    false,
  );
  assert.equal(
    platform.requestSupportAccessInputSchema.safeParse({
      ...input,
      durationMinutes: 600,
    }).success,
    false,
  );
  assert.equal(
    platform.requestSupportAccessInputSchema.safeParse({
      ...input,
      tenantId: fx.tenant.id,
    }).success,
    false,
  );
  const who = { tenantId: fx.tenant.id, superAdminUserId: fx.superAdmin.id };
  throwsCode(
    () =>
      platform.assertSupportAccess(fx.supportGrants, {
        ...who,
        dataClass: "personal",
        intent: "write",
        now: fx.now,
      }),
    "SUPPORT_ACCESS_READ_ONLY",
  );
  throwsCode(
    () => platform.assertCanOpenSupportAccess(fx.supportGrants, who, fx.now),
    "SUPPORT_ACCESS_ALREADY_ACTIVE",
  );
  const active = fx.supportGrants[1];
  assert.equal(platform.supportAccessStatus(active, fx.now), "active");
  assert.equal(
    platform.supportAccessStatus(active, active.expiresAt),
    "expired",
  );
  assert.equal(
    platform.supportAccessStatus(
      {
        ...active,
        endedAt: "2026-11-01T04:45:00.000Z",
        endedBy: fx.superAdmin.id,
      },
      fx.now,
    ),
    "ended",
  );
  assert.equal(
    platform.supportAccessExpiry(active.startedAt, 60),
    active.expiresAt,
  );
  assert.equal(
    platform.supportAccessGrantSchema.safeParse({
      ...active,
      expiresAt: "2026-11-01T07:30:00.000Z",
    }).success,
    false,
  );
});

test("TEN-04 every session emits an event the tenant admin is notified from", () => {
  const grant = fx.supportGrants[1];
  const envelope = {
    id: "01JBR0000000000000000000A1",
    tenantId: fx.tenant.id,
    outletId: null,
    name: "support_access.granted",
    version: 1,
    aggregateType: "support_access",
    aggregateId: grant.id,
    sequence: 1,
    occurredAt: grant.startedAt,
    actor: { type: "user", id: fx.superAdmin.id },
    idempotencyKey: `support_access:${grant.id}:granted`,
    payloadSchemaRef: "support_access.granted.v1",
    payload: {
      grantId: grant.id,
      superAdminUserId: grant.superAdminUserId,
      reason: grant.reason,
      accessMode: grant.accessMode,
      startedAt: grant.startedAt,
      expiresAt: grant.expiresAt,
    },
  };
  platform.platformEvents["support_access.granted"].envelopeSchema.parse(
    envelope,
  );
  assert.ok(grant.tenantAdminNotifiedAt);
  // Audit rows written under the session are sensitive and carry its reason.
  const row = {
    ...audit.cafeLegendAuditFixtures[0],
    ...platform.supportAccessAuditFields(grant),
  };
  audit.auditEventSchema.parse(row);
  assert.ok(row.reason.includes(grant.id));
  platform.orgEndpoints.listSupportAccess.response.parse({
    data: fx.supportGrants,
    meta: { limit: 25, nextCursor: null },
  });
});

test("TEN-10 a Tenant Theme below WCAG 2.2 AA cannot be activated", () => {
  const [active, failingDraft] = fx.themes;
  assert.equal(platform.checkThemeTokens(active.tokens).ok, true);
  assert.equal(platform.checkThemeTokens(failingDraft.tokens).ok, false);
  throwsCode(
    () => platform.activateTheme(fx.themes, failingDraft.id, fx.now),
    "THEME_CONTRAST_FAILED",
  );
  // The stored flag is not trusted: a forged `true` still fails.
  const forged = { ...failingDraft, contrastCheckPassed: true };
  throwsCode(
    () => platform.activateTheme([active, forged], forged.id, fx.now),
    "THEME_CONTRAST_FAILED",
  );
  // A schema-level guard too: an active row must have passed.
  assert.equal(
    platform.tenantThemeSchema.safeParse({
      ...failingDraft,
      status: "active",
      activatedAt: fx.now,
    }).success,
    false,
  );
});

test("TEN-10 activating a passing draft archives the previous active version", () => {
  const [active] = fx.themes;
  const draft = {
    ...active,
    id: "7e3e0000-0000-4000-8000-000000000003",
    version: 3,
    status: "draft",
    activatedAt: null,
  };
  const next = platform.activateTheme([active, draft], draft.id, fx.now);
  assert.equal(next.find((t) => t.id === draft.id).status, "active");
  assert.equal(next.find((t) => t.id === active.id).status, "archived");
  assert.equal(next.filter((t) => t.status === "active").length, 1);
  throwsCode(
    () => platform.activateTheme(next, active.id, fx.now),
    "INVALID_TRANSITION",
  );
  // Only tenant-overridable tokens are accepted.
  assert.equal(
    platform.themeTokensSchema.safeParse({
      light: { background: "#000000" },
      dark: {},
    }).success,
    false,
  );
});

test("TEN-09 config bundle exports without source-tenant identifiers or transactions", () => {
  const sourceIds = [
    fx.tenant.id,
    fx.brand.id,
    fx.legalEntity.id,
    ...fx.outlets.map((o) => o.id),
  ];
  const result = platform.parseConfigBundle(fx.configBundle, sourceIds);
  assert.equal(result.ok, true);
  assert.deepEqual(
    platform.findBundleIdentifiers(fx.configBundle, sourceIds),
    [],
  );
  // Leaking an outlet id, a tenant key or an order row is refused.
  const leaky = structuredClone(fx.configBundle);
  leaky.sections.zones.items.push({ key: "vip", outletId: fx.outlets[0].id });
  leaky.sections.checklists = {
    version: 1,
    items: [{ key: "buka", note: `outlet ${fx.outlets[0].id}` }],
  };
  leaky.sections.chart_of_accounts = {
    version: 1,
    items: [{ key: "1101", orderId: "x" }],
  };
  const bad = platform.parseConfigBundle(leaky, sourceIds);
  assert.equal(bad.ok, false);
  const reasons = bad.identifierIssues.map(
    (issue) => `${issue.path}:${issue.reason}`,
  );
  assert.ok(
    reasons.includes("sections.zones.items[3].outletId:forbidden_key"),
    reasons.join(),
  );
  assert.ok(
    reasons.some((r) => r.startsWith("sections.checklists.items[0].note:")),
  );
  assert.ok(
    reasons.includes(
      "sections.chart_of_accounts.items[0].orderId:forbidden_key",
    ),
  );
  // Unknown sections and secrets are not part of a bundle.
  assert.equal(
    platform.configBundleSchema.safeParse({
      ...fx.configBundle,
      sections: { orders: {} },
    }).success,
    false,
  );
});

test("TEN-09 a template imports into a new tenant as a working configuration", () => {
  const template = fx.configTemplate;
  assert.equal(template.sourceTenantId, fx.tenant.id);
  const reparsed = platform.parseConfigBundle(
    JSON.parse(JSON.stringify(template.payload)),
  );
  assert.equal(reparsed.ok, true);
  const { modules, theme, text_overrides } = reparsed.bundle.sections;
  // Modules, quotas and theme are enough to run: theme passes TEN-10 as-is.
  platform.featureFlagsSchema.parse(modules.featureFlags);
  assert.equal(platform.checkThemeTokens(theme.tokens).ok, true);
  assert.ok(text_overrides.sets.length >= 1);
  const importInput = platform.importConfigInputSchema.parse({
    templateId: template.id,
  });
  assert.equal(importInput.templateId, template.id);
  assert.equal(
    platform.importConfigInputSchema.safeParse({
      templateId: template.id,
      bundle: template.payload,
    }).success,
    false,
  );
  assert.ok(platform.canTransitionConfigImport("validating", "applying"));
  assert.ok(platform.canTransitionConfigImport("applying", "applied"));
  assert.equal(
    platform.canTransitionConfigImport("applied", "applying"),
    false,
  );
  assert.equal(platform.canTransitionConfigImport("failed", "applying"), false);
});

test("TEN-02 hostnames resolve to the tenant only when verified and active", () => {
  const tenantStatus = (id) =>
    [fx.tenant, fx.suspendedTenant].find((t) => t.id === id)?.status;
  const domains = [...fx.domains, fx.suspendedDomain];
  const hit = platform.resolveHost(
    "Pesan.CafeLegend.example:443",
    domains,
    tenantStatus,
  );
  assert.equal(hit.ok, true);
  assert.equal(hit.tenantId, fx.tenant.id);
  assert.equal(hit.brandId, fx.brand.id);
  assert.deepEqual(
    platform.resolveHost("wfc.cafelegend.example", domains, tenantStatus),
    {
      ok: false,
      reason: "unverified",
    },
  );
  assert.deepEqual(
    platform.resolveHost("kopi-contoh.platform.example", domains, tenantStatus),
    {
      ok: false,
      reason: "tenant_inactive",
    },
  );
  assert.deepEqual(
    platform.resolveHost("lain.example", domains, tenantStatus),
    {
      ok: false,
      reason: "unknown_host",
    },
  );
  for (const bad of [
    "127.0.0.1",
    "localhost",
    "[::1]",
    "printer.local",
    "a..b",
    "intranet",
  ])
    assert.equal(platform.normalizeHostname(bad), null, bad);
  assert.equal(
    platform.platformSubdomain("kopi-baru", "Platform.Example."),
    "kopi-baru.platform.example",
  );
});

test("TEN-08 whitelabel brand context carries the tenant brand, never the platform", () => {
  const context = platform.brandContextSchema.parse(fx.brandContext);
  assert.deepEqual(Object.keys(context).sort(), [
    "brand",
    "enabledModules",
    "theme",
  ]);
  assert.deepEqual(Object.keys(context.brand).sort(), [
    "id",
    "logoMediaId",
    "name",
    "slug",
  ]);
  assert.equal(context.brand.id, fx.brand.id);
  assert.equal(context.brand.name, fx.brand.name);
  // The active Tenant Theme is what SSR draws with.
  assert.equal(context.theme.fontFamily, fx.themes[0].fontFamily);
  assert.equal(context.theme.corners, fx.themes[0].corners);
  // TEN-05: the same flag set the API gates on, not a copy maintained by the UI.
  assert.ok(context.enabledModules.includes("pos"));
  assert.equal(
    JSON.stringify(context).toLowerCase().includes("platform"),
    false,
  );
});

test("TEN-02 device token is opaque, versioned and strictly parsed", () => {
  const token = `dv1.${"a".repeat(40)}.${"b".repeat(43)}`;
  assert.ok(platform.deviceTokenSchema.safeParse(token).success);
  for (const bad of [
    `dv2.${"a".repeat(40)}.${"b".repeat(43)}`,
    `dv1..${"b".repeat(43)}`,
    "dv1.short.short",
    "not-a-token",
  ])
    assert.equal(platform.deviceTokenSchema.safeParse(bad).success, false, bad);

  const payload = {
    version: 1,
    tenantId: fx.tenant.id,
    brandId: fx.brand.id,
    deviceId: fx.brand.id,
    expiresAt: 1_800_000_000,
  };
  platform.deviceTokenPayloadSchema.parse(payload);
  assert.equal(
    platform.deviceTokenPayloadSchema.safeParse({ ...payload, version: 2 })
      .success,
    false,
  );
  assert.equal(
    platform.deviceTokenPayloadSchema.safeParse({
      ...payload,
      tenantId: undefined,
    }).success,
    false,
  );
  assert.equal(
    platform.deviceTokenPayloadSchema.safeParse({ ...payload, extra: true })
      .success,
    false,
  );
  assert.equal(platform.DEVICE_TOKEN_HEADER, "x-device-token");
});

test("integration credentials are write-only and never in config, events or logs", () => {
  for (const row of fx.integrations) {
    assert.equal(JSON.stringify(row).includes("credentials_encrypted"), false);
    if (row.credentials) assert.match(row.credentials.secretRef, /^sec_/);
  }
  assert.equal(
    platform.integrationConfigSchema.safeParse({ apiKey: "abc" }).success,
    false,
  );
  assert.equal(
    platform.integrationConfigSchema.safeParse({ webhook_secret: "abc" })
      .success,
    false,
  );
  const input = platform.upsertIntegrationInputSchema.parse({
    outletId: null,
    provider: "doit",
    config: { environment: "sandbox" },
    credentials: { apiKey: "live-secret-value", webhookSecret: "whsec-123" },
  });
  const redacted = JSON.stringify(platform.redactIntegrationInput(input));
  assert.equal(redacted.includes("live-secret-value"), false);
  assert.equal(redacted.includes("whsec-123"), false);
  // An active row must have credentials; draft without is fine.
  const draft = fx.integrations.find((r) => r.status === "draft");
  assert.equal(
    platform.tenantIntegrationSchema.safeParse({ ...draft, status: "active" })
      .success,
    false,
  );
  assert.equal(
    platform.canTransitionIntegration("draft", "active", false),
    false,
  );
  assert.equal(
    platform.canTransitionIntegration("draft", "active", true),
    true,
  );
  // Outlet row wins over the tenant row; none active = null (fail closed).
  const edc = platform.resolveIntegration(
    fx.integrations,
    "edc",
    fx.outlets[0].id,
  );
  assert.equal(edc.outletId, fx.outlets[0].id);
  assert.equal(
    platform.resolveIntegration(fx.integrations, "edc", fx.outlets[1].id),
    null,
  );
  assert.equal(
    platform.resolveIntegration(fx.integrations, "email", null),
    null,
  );
  assert.equal(
    platform.resolveIntegration(fx.integrations, "doit", fx.outlets[1].id)
      .outletId,
    null,
  );
});

test("legal entity NPWP is accepted in 15/16 digits and only the last four leave the server", () => {
  assert.equal(
    platform.npwpInputSchema.parse("01.234.567.8-901.000"),
    "012345678901000",
  );
  assert.equal(
    platform.npwpInputSchema.parse("3273012345678901"),
    "3273012345678901",
  );
  assert.equal(platform.npwpInputSchema.safeParse("12345").success, false);
  assert.equal(platform.npwpLast4("01.234.567.8-901.000"), "1000");
  assert.equal(
    platform.legalEntitySchema.safeParse({
      ...fx.legalEntity,
      npwp: "012345678901000",
    }).success,
    false,
  );
});

test("platform events are catalogued under WS-01 with typed payloads", () => {
  for (const name of platform.PLATFORM_EVENT_TYPES) {
    const entry = events.eventCatalogByName.get(name);
    assert.ok(entry, name);
    assert.equal(entry.workstream, "WS-01");
  }
  const cap = platform.platformEvents["usage_limit.reached"].payloadSchema;
  cap.parse({
    kind: "cost_cap",
    cap: "whatsapp",
    state: "warning",
    month: "2026-11",
    capIdr: 150000,
    spentIdr: 125000,
  });
  assert.equal(
    cap.safeParse({
      kind: "cost_cap",
      cap: "sms",
      state: "warning",
      month: "2026-11",
      capIdr: 1,
      spentIdr: 1,
    }).success,
    false,
  );
  const integration =
    platform.platformEvents["tenant_integration.updated"].payloadSchema;
  assert.equal(
    integration.safeParse({
      integrationId: fx.integrations[0].id,
      provider: "doit",
      outletId: null,
      configKeysChanged: [],
      credentialsReplaced: true,
      apiKey: "leak",
    }).success,
    false,
  );
});

test("endpoints use platform paths for Super Admin and org paths for tenant admins", () => {
  for (const endpoint of Object.values(platform.platformEndpoints))
    assert.match(endpoint.path, /^\/api\/platform\//, endpoint.id);
  for (const endpoint of Object.values(platform.orgEndpoints)) {
    assert.match(endpoint.path, /^\/api\/org\//, endpoint.id);
    assert.equal(endpoint.path.includes(":tenantId"), false, endpoint.id);
  }
  const ids = [
    ...Object.values(platform.platformEndpoints),
    ...Object.values(platform.orgEndpoints),
  ].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  platform.platformEndpoints.listTenants.response.parse({
    data: [fx.tenant, fx.suspendedTenant],
    meta: { limit: 25, nextCursor: null },
  });
  platform.orgEndpoints.getModules.response.parse({
    data: fx.tenant.featureFlags,
  });
});

test("platform error codes map to HTTP statuses", () => {
  for (const code of platform.PLATFORM_ERROR_CODES) {
    const error = new platform.PlatformError(code);
    assert.equal(error.status, platform.platformErrorHttpStatus[code]);
    assert.ok(error.message.length > 0);
  }
});

test("TEN-05 malformed whole flag document disables modules and providers", () => {
  assert.equal(
    platform.isModuleEnabled(
      { modules: ["pos"], integrationProviders: "bad" },
      "pos",
    ),
    false,
  );
  assert.equal(
    platform.isIntegrationProviderAvailable(
      { modules: "bad", integrationProviders: ["kirimdev"] },
      "kirimdev",
    ),
    false,
  );
});

test("TEN-04 invalid support access intent fails closed", () => {
  assert.throws(() =>
    platform.assertSupportAccess(fx.supportGrants, {
      tenantId: fx.tenant.id,
      superAdminUserId: fx.superAdmin.id,
      dataClass: "financial",
      intent: "delete",
      now: fx.now,
    }),
  );
});
