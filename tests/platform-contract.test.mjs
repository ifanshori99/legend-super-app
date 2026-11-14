import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CoreError,
  cafeLegendFixtures,
} from "../packages/shared/src/core/index.ts";
import * as access from "../packages/shared/src/access/index.ts";
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
    serverNow: "2026-11-13T00:00:00.000Z",
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

test("TEN-09 every config section has a strict item schema keyed by reference, not id", () => {
  const sample = {
    roles: [
      {
        key: "tpl.tenant_admin",
        kind: "template",
        templateKey: "tenant_admin",
        name: "Admin Tenant",
        permissions: ["org.settings.manage"],
        mfaRequired: true,
        allowedScopeTypes: ["tenant"],
      },
    ],
    approval_policies: [
      {
        key: "ap.void.any.1.tpl.tenant_admin",
        kind: "approval",
        actionType: "void",
        thresholdIdr: null,
        approverRoleKey: "tpl.tenant_admin",
        levels: 1,
        requiresDistinctActor: true,
      },
      {
        key: "pos.bdg-01",
        kind: "pos_discount",
        outletKey: "bdg-01",
        discountThresholdBp: 1000,
      },
    ],
    chart_of_accounts: [
      {
        key: "acct.1100",
        kind: "account",
        code: "1100",
        name: "Kas",
        type: "asset",
        reportGroup: "cash_and_equivalents",
        parentKey: null,
        isActive: true,
      },
      {
        key: "map.cash_on_hand",
        kind: "mapping",
        role: "cash_on_hand",
        accountKey: "acct.1100",
      },
    ],
    tax_rules: [
      {
        key: "tenant.pb1",
        kind: "rule",
        outletKey: null,
        code: "PB1",
        name: "PB1 10%",
        taxType: "pbjt",
        rateBp: 1000,
        regionCode: null,
        channels: [],
        appliesTo: { itemClasses: ["food_beverage"] },
        priceIncludesTax: false,
        includeServiceInBase: true,
        isActive: true,
      },
      {
        key: "settings.tenant",
        kind: "settings",
        outletKey: null,
        calculationOrder: "discount_service_tax",
        pricesIncludeTax: false,
        serviceRoundingMode: "half_up",
        taxRoundingMode: "half_up",
        inclusiveBaseRoundingMode: "half_up",
        billRounding: { incrementIdr: 100, mode: "half_up" },
        packageAllocation: "fixed_bp",
      },
    ],
    service_charge_rules: [
      {
        key: "bdg-01.sc",
        outletKey: "bdg-01",
        code: "SC",
        name: "Service 5%",
        rateBp: 500,
        zoneKey: "bdg-01.indoor",
        orderTypes: [],
        itemClasses: ["food_beverage"],
        isActive: true,
      },
    ],
    checklists: [
      {
        key: "bdg-01.chk.buka",
        outletKey: "bdg-01",
        name: "Buka toko",
        type: "opening",
        items: [
          { label: "Nyalakan mesin", instruction: null, requiredEvidence: [] },
        ],
        schedule: { dueTime: "07:30", zoneKey: null },
        roleKey: null,
      },
    ],
    facilities: [
      {
        key: "bdg-01.shower",
        kind: "facility",
        outletKey: "bdg-01",
        name: "Shower",
        type: "shower",
        sessionMinutes: 20,
        cleaningMinutes: 10,
        arrivalGraceMinutes: 10,
        operatingHours: [
          { daysOfWeek: [1], opensAt: "06:00", closesAt: "10:00" },
        ],
        overtimePolicy: {
          graceMinutes: 5,
          blockMinutes: 10,
          feePerBlockIdr: 5000,
        },
        cancellationPolicy: {
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        },
      },
      {
        key: "bdg-01.shower.area",
        kind: "area",
        facilityKey: "bdg-01.shower",
        name: "Lantai 1",
        sortOrder: 0,
      },
    ],
  };
  const schemas = platform.configSectionItemSchemas;
  assert.deepEqual(
    Object.keys(schemas).sort(),
    [...platform.GENERIC_CONFIG_SECTIONS].sort(),
  );
  for (const [section, items] of Object.entries(sample))
    for (const item of items) {
      const parsed = schemas[section].safeParse(item);
      assert.equal(
        parsed.success,
        true,
        `${section}: ${JSON.stringify(parsed.error?.issues)}`,
      );
      // Strict: an unknown field or a missing key never passes.
      assert.equal(
        schemas[section].safeParse({ ...item, extra: 1 }).success,
        false,
      );
      const withoutKey = { ...item };
      delete withoutKey.key;
      assert.equal(schemas[section].safeParse(withoutKey).success, false);
    }
  // Unknown kind fails the discriminated sections.
  assert.equal(
    schemas.facilities.safeParse({ key: "x", kind: "nope" }).success,
    false,
  );

  // The bundle validates items with their section schema, and duplicate keys fail.
  const bundle = (sections) => ({
    formatVersion: 1,
    exportedAt: fx.now,
    sections,
  });
  const whole = platform.strictConfigBundleSchema.safeParse(
    bundle(
      Object.fromEntries(
        Object.entries(sample).map(([section, items]) => [
          section,
          { version: 1, items },
        ]),
      ),
    ),
  );
  assert.equal(whole.success, true, JSON.stringify(whole.error?.issues));
  assert.equal(
    platform.strictConfigBundleSchema.safeParse(
      bundle({ zones: { version: 1, items: [{ key: "a", name: "x" }] } }),
    ).success,
    false,
  );
  // Payroll now has a codec, so preview and import both reject arbitrary items.
  assert.equal(
    platform.configBundleSchema.safeParse(
      bundle({
        payroll_settings: { version: 1, items: [{ key: "a", name: "x" }] },
      }),
    ).success,
    false,
  );
  // Codec-backed sections require the portable domain contract.
  assert.equal(
    platform.configBundleSchema.safeParse(
      bundle({ zones: { version: 1, items: [{ key: "a", name: "x" }] } }),
    ).success,
    false,
  );
  assert.equal(
    platform.configBundleSchema.safeParse(
      bundle({
        roles: { version: 1, items: [sample.roles[0], sample.roles[0]] },
      }),
    ).success,
    false,
  );
  // Loyalty now has a domain codec and rejects arbitrary JSON items.
  assert.equal(
    platform.configBundleSchema.safeParse(
      bundle({
        loyalty_policy: { version: 1, items: [{ key: "tier", any: 1 }] },
      }),
    ).success,
    false,
  );
  // An item carrying an id is refused by the identifier scan.
  const leaked = bundle({
    wifi_policies: { version: 1, items: [{ key: "w", zoneId: "x", id: "y" }] },
  });
  assert.equal(platform.parseConfigBundle(leaked).ok, false);
});

test("538-G1b stored legacy zone and loyalty templates remain readable without inventing import values", () => {
  const payload = {
    formatVersion: 1,
    exportedAt: fx.now,
    sections: {
      zones: {
        version: 1,
        items: [{ key: "indoor", name: "Indoor", tableCount: 12 }],
      },
      loyalty_policy: { version: 1, items: [{ key: "tier", any: 1 }] },
    },
  };
  const stored = platform.configTemplateSchema.safeParse({
    ...fx.configTemplate,
    payload,
  });
  assert.equal(stored.success, true, JSON.stringify(stored.error?.issues));
  assert.deepEqual(stored.data.payload, payload);
  assert.equal(
    "minimumSpendIdr" in stored.data.payload.sections.zones.items[0],
    false,
  );
  assert.equal(
    "pointValueIdr" in stored.data.payload.sections.loyalty_policy.items[0],
    false,
  );

  // Reading an old record never makes its incomplete configuration importable.
  assert.equal(platform.configBundleSchema.safeParse(payload).success, false);
  assert.equal(
    platform.strictConfigBundleSchema.safeParse(payload).success,
    false,
  );
  assert.equal(
    platform.parseConfigBundle(payload, [], { strictItems: true }).ok,
    false,
  );
});

test("538-G1b stored legacy templates still reject malformed envelopes and identifiers", () => {
  const payload = {
    formatVersion: 1,
    exportedAt: fx.now,
    sections: {
      zones: { version: 1, items: [{ key: "indoor", name: "Indoor" }] },
    },
  };
  for (const section of [
    { version: 2, items: [{ key: "indoor", name: "Indoor" }] },
    { version: 1, items: [{ name: "Indoor" }] },
    { version: 1, items: [{ key: "indoor" }, { key: "indoor" }] },
    { version: 1, items: [{ key: "indoor", outletId: fx.outlets[0].id }] },
  ])
    assert.equal(
      platform.configTemplateSchema.safeParse({
        ...fx.configTemplate,
        payload: { ...payload, sections: { zones: section } },
      }).success,
      false,
    );

  // The read compatibility path must not disguise a malformed modern item.
  for (const sections of [
    {
      zones: {
        version: 1,
        items: [
          {
            ...fx.configTemplate.payload.sections.zones.items[0],
            serviceChargeBp: -1,
          },
        ],
      },
    },
    {
      ...payload.sections,
      loyalty_policy: { version: 1, items: [{ key: "tier", kind: "unknown" }] },
    },
  ])
    assert.equal(
      platform.configTemplateSchema.safeParse({
        ...fx.configTemplate,
        payload: { ...payload, sections },
      }).success,
      false,
    );
});

test("TEN-09 legend-5cwrq a bundle of kind items is judged by the codec checks, not waved through", () => {
  const role = {
    key: "custom.auditor",
    kind: "custom",
    templateKey: null,
    name: "Auditor",
    permissions: ["floor.table.view"],
    mfaRequired: false,
    allowedScopeTypes: ["tenant"],
  };
  const approval = {
    key: "ap.void.1",
    kind: "approval",
    actionType: "void",
    thresholdIdr: null,
    approverRoleKey: "custom.auditor",
    levels: 1,
    requiresDistinctActor: true,
  };
  const account = {
    key: "acct.1100",
    kind: "account",
    code: "1100",
    name: "Kas",
    type: "asset",
    reportGroup: "cash_and_equivalents",
    parentKey: null,
    isActive: true,
  };
  const bundle = (items = {}) => ({
    formatVersion: 1,
    exportedAt: fx.now,
    sections: {
      roles: { version: 1, items: items.roles ?? [role] },
      approval_policies: { version: 1, items: items.approvals ?? [approval] },
      chart_of_accounts: { version: 1, items: items.coa ?? [account] },
    },
  });
  assert.equal(platform.parseConfigBundle(bundle()).ok, true);
  // Unknown permission code in a kind role: refused with a roles path.
  const badPermission = platform.parseConfigBundle(
    bundle({ roles: [{ ...role, permissions: ["no.such.code"] }] }),
  );
  assert.equal(badPermission.ok, false);
  assert.ok(
    badPermission.schemaIssues.some((m) => m.startsWith("sections.roles.")),
  );
  // Approver role key not among the bundle's roles.
  const ghost = platform.parseConfigBundle(
    bundle({ approvals: [{ ...approval, approverRoleKey: "ghost" }] }),
  );
  assert.equal(ghost.ok, false);
  assert.match(ghost.schemaIssues.join("\n"), /ghost/);
  // CoA parent key that names no account.
  const orphan = platform.parseConfigBundle(
    bundle({ coa: [{ ...account, key: "acct.1101", parentKey: "acct.9" }] }),
  );
  assert.equal(orphan.ok, false);
  assert.match(orphan.schemaIssues.join("\n"), /acct\.9/);
  // The schema itself (what the browser preview uses) carries the same
  // reference check: the hasKind bridge no longer skips it.
  assert.equal(
    platform.configBundleSchema.safeParse(
      bundle({ approvals: [{ ...approval, approverRoleKey: "ghost" }] }),
    ).success,
    false,
  );
});

test("TEN-09 config readiness, platform-only permission and endpoints", () => {
  assert.equal(
    platform.configReadinessSchema.safeParse({
      tenantId: fx.tenant.id,
      ready: false,
      checks: [
        { check: "zones", ok: false, detail: "Outlet BDG-02 tanpa zona" },
      ],
    }).success,
    true,
  );
  assert.equal(
    platform.configReadinessSchema.safeParse({
      tenantId: fx.tenant.id,
      ready: true,
      checks: [{ check: "nope", ok: true, detail: "" }],
    }).success,
    false,
  );
  const imported = platform.configImportSchema.shape.warnings;
  assert.equal(imported.safeParse(["Outlet X dilewati"]).success, true);
  assert.equal(imported.safeParse(["x".repeat(501)]).success, false);
  const code = "platform.config_template.manage";
  assert.ok(access.PERMISSION_CODES.includes(code));
  assert.ok(access.permissionHasTag(code, "platform"));
  assert.equal(
    access.tenantPermissionCodeSchema.safeParse(code).success,
    false,
  );
  const { platformEndpoints: ep } = platform;
  assert.equal(
    ep.getConfigTemplate.path,
    "/api/platform/config-templates/:templateId",
  );
  assert.equal(ep.exportConfig.method, "GET");
  assert.equal(
    ep.exportConfig.path,
    "/api/platform/tenants/:tenantId/config-export",
  );
  assert.equal(
    ep.getConfigReadiness.path,
    "/api/platform/tenants/:tenantId/config-readiness",
  );
  assert.equal(platform.platformErrorHttpStatus.CONFIG_IMPORT_FAILED, 422);
});

test("legend-t57t resolveHost prefers the verified claim over unverified rows of other tenants", () => {
  const tenantStatus = () => "active";
  const verified = fx.domains.find(
    (row) => row.verifiedAt !== null && row.kind === "custom",
  );
  const intruder = {
    ...verified,
    id: "d0a10000-0000-4000-8000-0000000000aa",
    tenantId: fx.suspendedTenant.id,
    verifiedAt: null,
    verification: platform.domainVerificationRecord(verified.hostname, "t"),
  };
  for (const rows of [
    [intruder, verified],
    [verified, intruder],
  ]) {
    const hit = platform.resolveHost(verified.hostname, rows, tenantStatus);
    assert.equal(hit.ok, true);
    assert.equal(hit.tenantId, verified.tenantId);
  }
  assert.deepEqual(
    platform.resolveHost(verified.hostname, [intruder], tenantStatus),
    { ok: false, reason: "unverified" },
  );
});

test("legend-t57t reserved hostnames and verification record", () => {
  const base = ["platform.example", "app.example.com"];
  assert.equal(platform.isReservedHostname("platform.example", base), true);
  assert.equal(
    platform.isReservedHostname("Kopi.Platform.Example", base),
    true,
  );
  assert.equal(platform.isReservedHostname("a.b.app.example.com", base), true);
  assert.equal(platform.isReservedHostname("notplatform.example", base), false);
  assert.equal(platform.isReservedHostname("example.com", base), false);
  assert.equal(platform.isReservedHostname("platform.example", []), false);
  assert.deepEqual(platform.domainVerificationRecord("pesan.toko.id", "abc"), {
    type: "TXT",
    name: "_legend-verification.pesan.toko.id",
    value: "legend-domain-verification=abc",
  });
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
    issuedAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
  };
  platform.deviceTokenPayloadSchema.parse(payload);
  // legend-165: issuedAt is compared with the registry's token floor.
  assert.equal(
    platform.deviceTokenPayloadSchema.safeParse({
      ...payload,
      issuedAt: undefined,
    }).success,
    false,
  );
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

// Read-write support access needs tenant owner approval (founder Q37,
// legend-c9kbk). Assumption: the 30-minute cap and the 24-hour approval
// window are the contract values; ids are plain UUIDs at runtime.
const writeReason =
  "Memperbaiki konfigurasi pajak yang salah atas permintaan owner tenant.";
const requestedAt = "2026-11-01T04:00:00.000Z";
const requestId = "5ac0000b-0000-4000-8000-000000000001";
const ownerUserId = "0a0e0000-0000-4000-8000-000000000001";

function pendingRequest(overrides = {}) {
  return {
    id: requestId,
    tenantId: fx.tenant.id,
    superAdminUserId: fx.superAdmin.id,
    reason: writeReason,
    accessMode: "read_write",
    durationMinutes: 30,
    mfaVerifiedAt: "2026-11-01T03:59:30.000Z",
    requestedAt,
    approvalExpiresAt: "2026-11-02T04:00:00.000Z",
    status: "pending",
    decidedAt: null,
    decidedBy: null,
    grantId: null,
    ownerNotifiedAt: null,
    ...overrides,
  };
}

test("legend-c9kbk write access request accepts only 15 or 30 minutes and defaults to 30", () => {
  const base = { reason: writeReason, mfaCode: "123456" };
  const schema = platform.requestSupportWriteAccessInputSchema;
  for (const durationMinutes of [15, 30])
    assert.equal(
      schema.parse({ ...base, durationMinutes }).durationMinutes,
      durationMinutes,
    );
  for (const durationMinutes of [60, 120])
    assert.equal(
      schema.safeParse({ ...base, durationMinutes }).success,
      false,
      `${durationMinutes} minutes is above the read-write cap`,
    );
  assert.equal(schema.parse(base).durationMinutes, 30);
});

test("legend-c9kbk write access request rejects unknown keys and a malformed MFA code", () => {
  const base = { reason: writeReason, durationMinutes: 15 };
  const schema = platform.requestSupportWriteAccessInputSchema;
  assert.equal(schema.safeParse({ ...base, mfaCode: "123456" }).success, true);
  assert.equal(
    schema.safeParse({ ...base, mfaCode: "123456", accessMode: "read_only" })
      .success,
    false,
  );
  for (const mfaCode of ["12345", "1234567", "12345a", ""])
    assert.equal(
      schema.safeParse({ ...base, mfaCode }).success,
      false,
      `mfaCode "${mfaCode}"`,
    );
  assert.equal(schema.safeParse(base).success, false);
});

test("legend-c9kbk support access request refines pending, approved and the 24h window", () => {
  const schema = platform.supportAccessRequestSchema;
  schema.parse(pendingRequest());
  // Approved with a grant parses (positive control for the refines below).
  schema.parse(
    pendingRequest({
      status: "approved",
      decidedAt: "2026-11-01T05:00:00.000Z",
      decidedBy: ownerUserId,
      grantId: fx.supportGrants[0].id,
    }),
  );
  assert.equal(
    schema.safeParse(pendingRequest({ decidedAt: "2026-11-01T05:00:00.000Z" }))
      .success,
    false,
    "pending with decidedAt",
  );
  assert.equal(
    schema.safeParse(
      pendingRequest({
        status: "approved",
        decidedAt: "2026-11-01T05:00:00.000Z",
        decidedBy: ownerUserId,
        grantId: null,
      }),
    ).success,
    false,
    "approved without grantId",
  );
  for (const approvalExpiresAt of [
    "2026-11-02T03:59:59.000Z",
    "2026-11-02T04:00:01.000Z",
    requestedAt,
  ])
    assert.equal(
      schema.safeParse(pendingRequest({ approvalExpiresAt })).success,
      false,
      `approvalExpiresAt ${approvalExpiresAt}`,
    );
});

test("legend-c9kbk deciding a support access request takes no body", () => {
  const schema = platform.decideSupportAccessRequestInputSchema;
  assert.equal(schema.safeParse({}).success, true);
  assert.equal(schema.safeParse({ reason: "setuju" }).success, false);
  assert.equal(schema.safeParse({ anything: 1 }).success, false);
});

test("legend-c9kbk support_access.requested event payload parses", () => {
  const payload = {
    requestId,
    superAdminUserId: fx.superAdmin.id,
    reason: writeReason,
    durationMinutes: 30,
    approvalExpiresAt: "2026-11-02T04:00:00.000Z",
  };
  const schema = platform.platformEvents["support_access.requested"];
  schema.payloadSchema.parse(payload);
  assert.equal(
    schema.payloadSchema.safeParse({ ...payload, durationMinutes: 60 }).success,
    false,
  );
  schema.envelopeSchema.parse({
    id: "01JBR0000000000000000000A2",
    tenantId: fx.tenant.id,
    outletId: null,
    name: "support_access.requested",
    version: 1,
    aggregateType: "support_access",
    aggregateId: requestId,
    sequence: 1,
    occurredAt: requestedAt,
    actor: { type: "user", id: fx.superAdmin.id },
    idempotencyKey: `support_access:${requestId}:requested`,
    payloadSchemaRef: "support_access.requested.v1",
    payload,
  });
});

test("legend-c9kbk owner approval endpoints and the platform request endpoint exist", () => {
  const expected = [
    [
      platform.orgEndpoints.listSupportAccessRequests,
      "GET",
      "/api/org/support-access/requests",
    ],
    [
      platform.orgEndpoints.approveSupportAccessRequest,
      "POST",
      "/api/org/support-access/requests/:requestId/approve",
    ],
    [
      platform.orgEndpoints.rejectSupportAccessRequest,
      "POST",
      "/api/org/support-access/requests/:requestId/reject",
    ],
    [
      platform.platformEndpoints.requestSupportWriteAccess,
      "POST",
      "/api/platform/tenants/:tenantId/support-access-requests",
    ],
  ];
  for (const [endpoint, method, path] of expected) {
    assert.ok(endpoint, path);
    assert.equal(endpoint.method, method, path);
    assert.equal(endpoint.path, path);
  }
  platform.orgEndpoints.listSupportAccessRequests.response.parse({
    data: [pendingRequest()],
    meta: { limit: 25, nextCursor: null },
  });
});

// Founder decision (2026-11-11): the cashier discount approval threshold is
// 1..5000 bp; 0 is refused everywhere, as is anything above 50%.
test("TEN-09 pos_discount threshold in a bundle: 5000 accepted, 0, 5001 and 10000 refused", () => {
  const bundleWith = (bp) => ({
    formatVersion: 1,
    exportedAt: fx.now,
    sections: {
      approval_policies: {
        version: 1,
        items: [
          {
            key: "pos.tenant",
            kind: "pos_discount",
            outletKey: null,
            discountThresholdBp: bp,
          },
        ],
      },
    },
  });
  for (const bp of [1, 5000]) {
    assert.equal(
      platform.configBundleSchema.safeParse(bundleWith(bp)).success,
      true,
      `${bp} bp accepted by configBundleSchema`,
    );
  }
  for (const bp of [0, 5001, 10000]) {
    assert.equal(
      platform.configBundleSchema.safeParse(bundleWith(bp)).success,
      false,
      `${bp} bp refused by configBundleSchema`,
    );
    assert.equal(
      platform.parseConfigBundle(bundleWith(bp)).ok,
      false,
      `${bp} bp refused by parseConfigBundle`,
    );
  }
});
