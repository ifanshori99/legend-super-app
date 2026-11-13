// Default tax provisioning (bead legend-9obf; PRD v1.7 §3.14 F11/F14, TEN-01).
// A tenant created from the Platform panel gets a published PBJT F&B 10% rule
// and published tax settings, so the tax preview works from day one. Existing
// tenants are filled by `backfillTenantTaxDefaults`, which never touches
// configuration a tenant already has.
//
// HTTP tests run the real Express app, Better Auth and PostgreSQL. Service
// tests call the provisioning functions the way the API does, inside
// `withTenant`, on freshly seeded bare tenants so counts are exact.
//
// Assumptions where the brief is silent:
// - "Published by not null" for the backfill means the reserved system user
//   id; for the Platform panel it only means the column is filled.
// - Audit rows are matched by `event->>'action'` and tenant id; their
//   `maskedChanges` payload is not asserted.
// - priceReady semantics follow the coordinator note: true only with a published,
//   active, tenant-wide rule and tenant-wide settings; a draft or outlet-scoped
//   rule/draft settings block it and the backfill adds nothing for that table.
// - The preview tests create one outlet for the new tenant directly in SQL
//   (the panel creates none); the line's item id is a random uuid.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  backfillTenantTaxDefaults,
  provisionDefaultTaxConfig,
  TAX_PROVISIONING_SYSTEM_USER,
} from "../services/tax-provisioning.service";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const RULES_ACTION = "tax.rules.provisioned";
const SETTINGS_ACTION = "tax.settings.provisioned";

const OPENING_HOURS = {
  mon: { opens: "08:00", closes: "22:00" },
  tue: { opens: "08:00", closes: "22:00" },
  wed: { opens: "08:00", closes: "22:00" },
  thu: { opens: "08:00", closes: "22:00" },
  fri: { opens: "08:00", closes: "23:00" },
  sat: { opens: "08:00", closes: "23:00" },
  sun: { opens: "08:00", closes: "22:00" },
};

const limits = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 50_000,
  emailCostCapIdr: 10_000,
};

const unique = () => randomBytes(4).toString("hex");
// platform_admins rows this file inserted; cleanup deletes only these.
const adminUserIds: string[] = [];

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (adminUserIds.length > 0)
    await owner.query(
      "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
      [adminUserIds],
    );
  await owner.end();
});

// ------------------------------------------------------------------ helpers

function scopedContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

/** Platform admin who also owns the seeded tenant (same pattern as platform-org-api). */
async function adminClient() {
  const client = agent(app);
  const email = await signUp(client, "Tax Provisioning Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  adminUserIds.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [seededTenantId, userId],
  );
  await verifySessionMfa(email);
  return { client, userId };
}

/** Creates a tenant through the Platform panel API and returns its id. */
async function createTenantViaPanel() {
  const { client: platform } = await adminClient();
  const created = await platform
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `uji-${unique()}`,
      name: "Uji Tax Provisioning",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos"], integrationProviders: [] },
      limits: { ...limits, maxOutlets: 50 },
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: "6281234567890",
        email: null,
      },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

/**
 * A signed-in owner of the given tenant. The tenant is resolved from the Host
 * header, so a domain is registered and sent on every call of the client.
 */
async function tenantOwnerClient(tenantId: string) {
  const client = agent(app);
  const email = await signUp(client, "Tax Provisioning Owner");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  await verifySessionMfa(email);

  const hostname = `tax-${unique()}.contoh.example`;
  const brandId = randomUUID();
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand domain')",
    [brandId, tenantId, `dom-${unique()}`],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [randomUUID(), tenantId, brandId, hostname],
  );
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  const hosted = new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && methods.has(prop))
        return (url: string) =>
          (target as unknown as Record<string, (u: string) => Test>)[prop]!(
            url,
          ).set("Host", hostname);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client: hosted, brandId };
}

/** A tenant with no tax configuration, like one created before provisioning. */
async function seedBareTenant() {
  const tenantId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tax provisioning uji', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `taxp-${tenantId.slice(0, 8)}`, seededTenantId],
  );
  return tenantId;
}

async function insertCustomRule(tenantId: string, rateBp = 1100) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO tax_rules
       (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
        published_at, published_by)
     VALUES ($1, $2, NULL, 'CUSTOM-PBJT', 'Pajak Kustom', 'pbjt', $3, NULL, '[]',
             '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
             false, true, true, 1, '2026-01-01', 'published', now(), $4)`,
    [id, tenantId, rateBp, randomUUID()],
  );
  return id;
}

async function insertCustomSettings(tenantId: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO tax_settings
       (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
        tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
        version, effective_from, status, published_at, published_by)
     VALUES ($1, $2, NULL, 'discount_service_tax', true, 'half_up', 'half_up', 'half_up', NULL,
             'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
    [id, tenantId, randomUUID()],
  );
  return id;
}

const selectRules = (tenantId: string) =>
  owner
    .query("SELECT * FROM tax_rules WHERE tenant_id = $1 ORDER BY id", [
      tenantId,
    ])
    .then((r) => r.rows as Record<string, unknown>[]);

const selectSettings = (tenantId: string) =>
  owner
    .query("SELECT * FROM tax_settings WHERE tenant_id = $1 ORDER BY id", [
      tenantId,
    ])
    .then((r) => r.rows as Record<string, unknown>[]);

async function auditCount(tenantId: string, action: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2",
    [tenantId, action],
  );
  return rows[0]!.n;
}

async function auditTotal(tenantId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]!.n;
}

function provisionInTx(tenantId: string) {
  const context = scopedContext(tenantId);
  return withTenant(db, context, (tx) =>
    provisionDefaultTaxConfig(tx, context, null),
  );
}

/**
 * Previews a Rp 100.000 F&B line (no region) for the tenant on the given
 * business date. The panel creates no outlet, so one is inserted in SQL.
 */
async function previewHundredThousand(tenantId: string, businessDate: string) {
  const { client, brandId } = await tenantOwnerClient(tenantId);
  const legalEntityId = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji Pajak', false)",
    [legalEntityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'TX-1', 'Outlet Pajak', 'Jl. Uji', 'Asia/Jakarta', $5, 'active')`,
    [outletId, tenantId, brandId, legalEntityId, JSON.stringify(OPENING_HOURS)],
  );
  return client
    .post("/api/tax/preview")
    .set(originHeader)
    .send({
      outletId,
      businessDate,
      channel: "dine_in",
      zoneId: null,
      regionCode: null,
      orderDiscountIdr: 0,
      lines: [
        {
          lineId: "L1",
          itemId: randomUUID(),
          categoryId: null,
          itemClass: "food_beverage",
          grossIdr: 100_000,
          discountIdr: 0,
          components: [],
        },
      ],
    });
}

async function insertDraftRule(tenantId: string) {
  await owner.query(
    `INSERT INTO tax_rules
       (id, tenant_id, code, name, tax_type, rate_bp, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status)
     VALUES ($1, $2, 'PBJT-DRAFT', 'Draft', 'pbjt', 1000, '[]',
             '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
             false, true, true, 1, '2026-01-01', 'draft')`,
    [randomUUID(), tenantId],
  );
}

async function insertDraftSettings(tenantId: string) {
  await owner.query(
    `INSERT INTO tax_settings
       (id, tenant_id, calculation_order, prices_include_tax, service_rounding_mode,
        tax_rounding_mode, inclusive_base_rounding_mode, package_allocation, version,
        effective_from, status)
     VALUES ($1, $2, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up',
             'fixed_bp', 1, '2026-01-01', 'draft')`,
    [randomUUID(), tenantId],
  );
}

/** A published rule scoped to one outlet (not tenant-wide). */
async function insertOutletScopedRule(tenantId: string) {
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)",
    [legalEntityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'U-1', 'Outlet Uji', 'Jl. Uji', 'Asia/Jakarta', $5, 'active')`,
    [outletId, tenantId, brandId, legalEntityId, JSON.stringify(OPENING_HOURS)],
  );
  await owner.query(
    `INSERT INTO tax_rules
       (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
        published_at, published_by)
     VALUES ($1, $2, $3, 'PBJT-OUTLET', 'Pajak Outlet', 'pbjt', 1000, NULL, '[]',
             '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
             false, true, true, 1, '2026-01-01', 'published', now(), $4)`,
    [randomUUID(), tenantId, outletId, randomUUID()],
  );
}

// -------------------------------------------------------------------- tests

describe("legend-9obf default tax config for a tenant created in the Platform panel", () => {
  it("creates one published PBJT-FNB 10% rule and one published tax settings row, with audit", async () => {
    const tenantId = await createTenantViaPanel();

    const rules = await selectRules(tenantId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      tenant_id: tenantId,
      code: "PBJT-FNB",
      tax_type: "pbjt",
      rate_bp: 1000,
      region_code: null,
      outlet_id: null,
      price_includes_tax: false,
      status: "published",
      version: 1,
    });
    expect(rules[0]!.published_by).not.toBeNull();

    const settings = await selectSettings(tenantId);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      tenant_id: tenantId,
      outlet_id: null,
      prices_include_tax: false,
      service_rounding_mode: "half_up",
      tax_rounding_mode: "half_up",
      inclusive_base_rounding_mode: "half_up",
      package_allocation: "fixed_bp",
      calculation_order: "discount_service_tax",
      status: "published",
    });
    expect(settings[0]!.published_by).not.toBeNull();

    expect(await auditCount(tenantId, RULES_ACTION)).toBe(1);
    expect(await auditCount(tenantId, SETTINGS_ACTION)).toBe(1);
  });

  it("makes /api/tax/preview work: Rp 100.000 F&B dine-in line gives service Rp 5.000 and tax Rp 10.500 exclusive", async () => {
    const tenantId = await createTenantViaPanel();
    const preview = await previewHundredThousand(
      tenantId,
      businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK),
    );
    expect(preview.body?.error?.code).not.toBe("TAX_SETTINGS_NOT_FOUND");
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    // legend-2qz7: dine-in also gets the default 5% service charge, and the
    // PBJT rule takes service into its base: 10% of Rp 105.000.
    expect(preview.body.data.serviceChargeIdr).toBe(5_000);
    expect(preview.body.data.taxIdr).toBe(10_500);
    // Exclusive: service and tax are added on top of the Rp 100.000 base.
    expect(preview.body.data.baseIdr).toBe(100_000);
    expect(preview.body.data.totalIdr).toBe(115_500);
  });

  it("covers dates back to 2024-01-01: rows start 2024-01-01 and a 2025-06-01 preview gives 10% tax and 5% service", async () => {
    const tenantId = await createTenantViaPanel();

    const { rows: rules } = await owner.query<{ d: string }>(
      "SELECT effective_from::text AS d FROM tax_rules WHERE tenant_id = $1",
      [tenantId],
    );
    const { rows: settings } = await owner.query<{ d: string }>(
      "SELECT effective_from::text AS d FROM tax_settings WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rules.map((r) => r.d)).toEqual(["2024-01-01"]);
    expect(settings.map((r) => r.d)).toEqual(["2024-01-01"]);

    const preview = await previewHundredThousand(tenantId, "2025-06-01");
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.serviceChargeIdr).toBe(5_000);
    expect(preview.body.data.taxIdr).toBe(10_500);
    expect(preview.body.data.totalIdr).toBe(115_500);
  });
});

describe("legend-9obf provisioning is idempotent", () => {
  it("a second backfill and two direct provision calls insert nothing and add no audit rows", async () => {
    const tenantId = await seedBareTenant();

    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 1,
      settingsInserted: 1,
      priceReady: true,
    });
    const rulesBefore = await selectRules(tenantId);
    const settingsBefore = await selectSettings(tenantId);
    const auditBefore = await auditTotal(tenantId);
    expect(rulesBefore).toHaveLength(1);
    expect(settingsBefore).toHaveLength(1);
    // Backfill has no human actor: the reserved system user is recorded.
    expect(rulesBefore[0]!.published_by).toBe(TAX_PROVISIONING_SYSTEM_USER);
    expect(settingsBefore[0]!.published_by).toBe(TAX_PROVISIONING_SYSTEM_USER);
    expect(await auditCount(tenantId, RULES_ACTION)).toBe(1);
    expect(await auditCount(tenantId, SETTINGS_ACTION)).toBe(1);

    const again = await backfillTenantTaxDefaults(tenantId);
    expect(again).toEqual({
      rulesInserted: 0,
      settingsInserted: 0,
      priceReady: true,
    });
    expect(await provisionInTx(tenantId)).toEqual({
      rulesInserted: 0,
      settingsInserted: 0,
    });
    expect(await provisionInTx(tenantId)).toEqual({
      rulesInserted: 0,
      settingsInserted: 0,
    });

    expect(await selectRules(tenantId)).toEqual(rulesBefore);
    expect(await selectSettings(tenantId)).toEqual(settingsBefore);
    expect(await auditTotal(tenantId)).toBe(auditBefore);
  });

  it("a tenant from the Platform panel is not duplicated by a later backfill", async () => {
    const tenantId = await createTenantViaPanel();
    const auditBefore = await auditTotal(tenantId);

    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 0,
      settingsInserted: 0,
      priceReady: true,
    });
    expect(await selectRules(tenantId)).toHaveLength(1);
    expect(await selectSettings(tenantId)).toHaveLength(1);
    expect(await auditTotal(tenantId)).toBe(auditBefore);
  });

  it("two concurrent calls leave exactly one rule and one settings row", async () => {
    const tenantId = await seedBareTenant();

    const results = await Promise.all([
      backfillTenantTaxDefaults(tenantId),
      backfillTenantTaxDefaults(tenantId),
    ]);

    expect(results.reduce((sum, r) => sum + r.rulesInserted, 0)).toBe(1);
    expect(results.reduce((sum, r) => sum + r.settingsInserted, 0)).toBe(1);
    expect(await selectRules(tenantId)).toHaveLength(1);
    expect(await selectSettings(tenantId)).toHaveLength(1);
    expect(await auditCount(tenantId, RULES_ACTION)).toBe(1);
    expect(await auditCount(tenantId, SETTINGS_ACTION)).toBe(1);
  });
});

describe("legend-9obf existing tax configuration is never changed", () => {
  it("a tenant with a custom 11% rule and inclusive-price settings is left identical", async () => {
    const tenantId = await seedBareTenant();
    await insertCustomRule(tenantId, 1100);
    await insertCustomSettings(tenantId);
    const rulesBefore = await selectRules(tenantId);
    const settingsBefore = await selectSettings(tenantId);
    const auditBefore = await auditTotal(tenantId);

    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 0,
      settingsInserted: 0,
      priceReady: true,
    });

    const rulesAfter = await selectRules(tenantId);
    const settingsAfter = await selectSettings(tenantId);
    expect(rulesAfter).toHaveLength(1);
    expect(settingsAfter).toHaveLength(1);
    expect(rulesAfter[0]).toMatchObject({ code: "CUSTOM-PBJT", rate_bp: 1100 });
    expect(settingsAfter[0]).toMatchObject({ prices_include_tax: true });
    expect(rulesAfter).toEqual(rulesBefore);
    expect(settingsAfter).toEqual(settingsBefore);
    expect(await auditTotal(tenantId)).toBe(auditBefore);
  });

  it("a tenant with settings but no rules gets only the default rule", async () => {
    const tenantId = await seedBareTenant();
    await insertCustomSettings(tenantId);
    const settingsBefore = await selectSettings(tenantId);

    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 1,
      settingsInserted: 0,
      priceReady: true,
    });

    const rules = await selectRules(tenantId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ code: "PBJT-FNB", rate_bp: 1000 });
    expect(await selectSettings(tenantId)).toEqual(settingsBefore);
    expect(await auditCount(tenantId, RULES_ACTION)).toBe(1);
    expect(await auditCount(tenantId, SETTINGS_ACTION)).toBe(0);
  });

  it("a tenant with a rule but no settings gets only the default settings", async () => {
    const tenantId = await seedBareTenant();
    await insertCustomRule(tenantId, 1100);
    const rulesBefore = await selectRules(tenantId);

    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 0,
      settingsInserted: 1,
      priceReady: true,
    });

    const settings = await selectSettings(tenantId);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      prices_include_tax: false,
      calculation_order: "discount_service_tax",
      status: "published",
    });
    expect(await selectRules(tenantId)).toEqual(rulesBefore);
    expect(await auditCount(tenantId, RULES_ACTION)).toBe(0);
    expect(await auditCount(tenantId, SETTINGS_ACTION)).toBe(1);
  });
});

describe("legend-9obf backfill reports whether the tenant can price orders", () => {
  it("priceReady is true after a fresh backfill", async () => {
    const tenantId = await seedBareTenant();
    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 1,
      settingsInserted: 1,
      priceReady: true,
    });
  });

  it("priceReady is true for a tenant with custom published tenant-wide config", async () => {
    const tenantId = await seedBareTenant();
    await insertCustomRule(tenantId, 1100);
    await insertCustomSettings(tenantId);
    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 0,
      settingsInserted: 0,
      priceReady: true,
    });
  });

  it("priceReady is false and no rule is inserted when the only rule is a draft", async () => {
    const tenantId = await seedBareTenant();
    await insertDraftRule(tenantId);

    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 0,
      settingsInserted: 1,
      priceReady: false,
    });
    const rules = await selectRules(tenantId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ code: "PBJT-DRAFT", status: "draft" });
  });

  it("priceReady is false and no rule is inserted when the only rule is outlet-scoped", async () => {
    const tenantId = await seedBareTenant();
    await insertOutletScopedRule(tenantId);

    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 0,
      settingsInserted: 1,
      priceReady: false,
    });
    const rules = await selectRules(tenantId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      code: "PBJT-OUTLET",
      outlet_id: expect.any(String),
    });
  });

  it("priceReady is false and no settings are inserted when the only settings row is a draft", async () => {
    const tenantId = await seedBareTenant();
    await insertDraftSettings(tenantId);

    expect(await backfillTenantTaxDefaults(tenantId)).toEqual({
      rulesInserted: 1,
      settingsInserted: 0,
      priceReady: false,
    });
    const settings = await selectSettings(tenantId);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ status: "draft" });
  });
});

describe("legend-9obf tenant isolation", () => {
  it("backfilling tenant A creates nothing for tenant B", async () => {
    const tenantA = await seedBareTenant();
    const tenantB = await seedBareTenant();

    await backfillTenantTaxDefaults(tenantA);

    const rulesA = await selectRules(tenantA);
    const settingsA = await selectSettings(tenantA);
    expect(rulesA).toHaveLength(1);
    expect(settingsA).toHaveLength(1);
    expect(rulesA.every((row) => row.tenant_id === tenantA)).toBe(true);
    expect(settingsA.every((row) => row.tenant_id === tenantA)).toBe(true);

    expect(await selectRules(tenantB)).toHaveLength(0);
    expect(await selectSettings(tenantB)).toHaveLength(0);
    expect(await auditCount(tenantB, RULES_ACTION)).toBe(0);
    expect(await auditCount(tenantB, SETTINGS_ACTION)).toBe(0);
    expect(await auditCount(tenantA, RULES_ACTION)).toBe(1);
    expect(await auditCount(tenantA, SETTINGS_ACTION)).toBe(1);
  });
});
