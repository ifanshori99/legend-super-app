// Default provisioning of legal entities, outlets and tenants (beads
// legend-a7x7 and legend-4ryw; PRD v1.7 §3.19 chart of accounts + account
// mappings, §16 "Lokasi Stok", ACC-01, TEN-01, TEN-06).
//
// HTTP tests run the real Express app, Better Auth and PostgreSQL. Service
// tests call the provisioning services the way the API does, inside
// `withTenant`. Every service-level test owns a freshly seeded tenant (copy of
// the seeded tenant's plan/limits so unrelated suites that parse every tenant
// keep working), so counts and audit totals are exact and never depend on
// other test files. Seeded tenants stay in the disposable database, as in the
// other DB suites.
//
// Assumptions where the brief is silent:
// - `ChartProvisionResult.accounts/mappings` of an `already_present` result
//   are not asserted (only the status).
// - `backfillTenantInventoryDefaults(...).outlets` counts the tenant's outlets
//   it visited, so a one-outlet tenant reports 1 on every run.
// - Audit rows are matched by `action` (and `objectType`/`objectId` for the
//   chart audit, which the brief specifies); their `maskedChanges` payload is
//   not asserted.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  POSTING_ACCOUNT_ROLES,
  standardFnbChartTemplate,
} from "@starter/shared/accounting";
import {
  STANDARD_STOCK_LOCATIONS,
  STANDARD_UOM_CATALOG,
} from "@starter/shared/inventory";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  backfillTenantCharts,
  provisionStandardChart,
} from "../services/accounting-provisioning.service";
import {
  backfillTenantInventoryDefaults,
  provisionOutletStockLocations,
  provisionStandardUoms,
} from "../services/inventory-provisioning.service";
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
  max: 2,
});

const CHART_ACTION = "accounting.chart.provisioned";
const UOM_ACTION = "inventory.uoms.provisioned";
const LOCATION_ACTION = "inventory.stock_locations.provisioned";

const templateRoleToCode = new Map<string, string>(
  standardFnbChartTemplate.flatMap((row) =>
    row.roles.map((role) => [role, row.code] as const),
  ),
);

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

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.query("DELETE FROM platform_admins");
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
  const email = await signUp(client, "Provisioning Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
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

type Client = Awaited<ReturnType<typeof adminClient>>["client"];

/**
 * Signed-in admin of a dedicated tenant with a generous outlet quota. The HTTP
 * tests create several outlets each; doing that in the shared seeded tenant
 * hits its maxOutlets limit (409 QUOTA_EXCEEDED) and would change state other
 * suites rely on. The tenant is created through the platform panel (so it has
 * its role templates) by a platform admin, then a fresh user becomes its
 * owner (the template holding the org and accounting permissions; tenant_admin
 * is refused with 403 PERMISSION_DENIED on these routes).
 */
async function tenantAdminClient() {
  const { client: platform } = await adminClient();
  const created = await platform
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `uji-${unique()}`,
      name: "Uji Provisioning HTTP",
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
  const tenantId = created.body.data.id as string;

  const client = agent(app);
  const email = await signUp(client, "Provisioning Tenant Admin");
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

  // The tenant is resolved from the request Host: register a domain for the
  // dedicated tenant and send it on every call of the returned client.
  const hostname = `prov-${unique()}.contoh.example`;
  const domainBrandId = randomUUID();
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand domain')",
    [domainBrandId, tenantId, `dom-${unique()}`],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [randomUUID(), tenantId, domainBrandId, hostname],
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
  return { client: hosted, tenantId, domainBrandId };
}

/**
 * A tenant with no defaults at all, like one created before provisioning
 * existed: brand, `entities` legal entities (no chart), `outlets` outlets (no
 * stock locations), no UOMs.
 */
async function seedBareTenant(shape: { entities?: number; outlets?: number }) {
  const tenantId = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Provisioning uji', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `prov-${tenantId.slice(0, 8)}`, seededTenantId],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, tenantId],
  );
  const entityIds: string[] = [];
  for (let i = 0; i < (shape.entities ?? 1); i += 1) {
    const id = randomUUID();
    entityIds.push(id);
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
      [id, tenantId, `PT Uji ${i + 1}`],
    );
  }
  const outletIds: string[] = [];
  for (let i = 0; i < (shape.outlets ?? 1); i += 1) {
    const id = randomUUID();
    outletIds.push(id);
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji', 'Asia/Jakarta', $7, 'active')`,
      [
        id,
        tenantId,
        brandId,
        entityIds[0],
        `U-${i + 1}`,
        `Outlet Uji ${i + 1}`,
        JSON.stringify(OPENING_HOURS),
      ],
    );
  }
  return { tenantId, entityIds, outletIds };
}

/** Everything provisioning may write for one tenant, in a stable order. */
async function snapshot(tenantId: string) {
  const rows = async (sql: string) =>
    (await owner.query(sql, [tenantId])).rows as unknown[];
  return {
    accounts: await rows(
      "SELECT * FROM chart_of_accounts WHERE tenant_id = $1 ORDER BY legal_entity_id, code",
    ),
    mappings: await rows(
      "SELECT * FROM account_mappings WHERE tenant_id = $1 ORDER BY legal_entity_id, role",
    ),
    uoms: await rows("SELECT * FROM uoms WHERE tenant_id = $1 ORDER BY code"),
    locations: await rows(
      "SELECT * FROM stock_locations WHERE tenant_id = $1 ORDER BY outlet_id, type, id",
    ),
    auditTotal: (
      await owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1",
        [tenantId],
      )
    ).rows[0]!.n,
  };
}

async function auditActions(tenantId: string, action: string) {
  const { rows } = await owner.query<{
    event: { objectType?: string; objectId?: string | null };
  }>(
    "SELECT event FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2",
    [tenantId, action],
  );
  return rows.map((row) => row.event);
}

async function countRows(sql: string, params: unknown[]) {
  const { rows } = await owner.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

async function createBrandAndEntity(client: Client, domainBrandId?: string) {
  // The dedicated tenant's domain is bound to one brand; outlets must belong
  // to it to be reachable from that domain.
  if (domainBrandId)
    return {
      brandId: domainBrandId,
      entityId: await createLegalEntityApi(client),
    };
  const brand = await client
    .post("/api/org/brands")
    .set(originHeader)
    .send({
      slug: `brand-${unique()}`,
      name: "Brand Provisioning",
      logoMediaId: null,
    });
  expect(brand.status, JSON.stringify(brand.body)).toBe(201);
  const entity = await createLegalEntityApi(client);
  return { brandId: brand.body.data.id as string, entityId: entity };
}

async function createLegalEntityApi(client: Client): Promise<string> {
  const response = await client
    .post("/api/org/legal-entities")
    .set(originHeader)
    .send({
      name: `PT Provisioning ${unique()}`,
      npwp: null,
      isPkp: false,
      address: "Kota Bandung",
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

async function createOutletApi(
  client: Client,
  brandId: string,
  legalEntityId: string,
): Promise<string> {
  const response = await client
    .post("/api/org/outlets")
    .set(originHeader)
    .send({
      brandId,
      legalEntityId,
      code: `PRV-${unique()}`.toUpperCase(),
      name: "Outlet Provisioning",
      address: "Jl. Provisioning No. 1, Kota Bandung",
      regionId: null,
      geofence: null,
      timeZone: "Asia/Jakarta",
      openingHours: OPENING_HOURS,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

type ApiAccount = {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
};
type ApiMapping = { role: string; accountId: string };

async function listAccountsApi(client: Client, entityId: string) {
  const response = await client.get(
    `/api/accounting/legal-entities/${entityId}/accounts`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as ApiAccount[];
}

async function listMappingsApi(client: Client, entityId: string) {
  const response = await client.get(
    `/api/accounting/legal-entities/${entityId}/account-mappings`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as ApiMapping[];
}

// -------------------------------------------------------------------- tests

describe("legend-a7x7 legal entity chart provisioning", () => {
  it("TEN-06 ACC-01 a new legal entity gets the standard F&B chart, all default mappings and one audit row", async () => {
    const { client, tenantId } = await tenantAdminClient();
    const entityId = await createLegalEntityApi(client);

    const accounts = await listAccountsApi(client, entityId);
    expect(accounts).toHaveLength(standardFnbChartTemplate.length);
    expect(accounts.map((a) => a.code).sort()).toEqual(
      standardFnbChartTemplate.map((row) => row.code).sort(),
    );
    // Hierarchy follows the template: every parentCode resolves to that account.
    const idByCode = new Map(accounts.map((a) => [a.code, a.id]));
    for (const row of standardFnbChartTemplate) {
      const account = accounts.find((a) => a.code === row.code)!;
      expect(account.name).toBe(row.name);
      expect(account.parentId).toBe(
        row.parentCode === null ? null : idByCode.get(row.parentCode),
      );
    }

    const mappings = await listMappingsApi(client, entityId);
    expect(mappings.map((m) => m.role).sort()).toEqual(
      [...templateRoleToCode.keys()].sort(),
    );
    const codeById = new Map(accounts.map((a) => [a.id, a.code]));
    for (const mapping of mappings)
      expect(codeById.get(mapping.accountId)).toBe(
        templateRoleToCode.get(mapping.role),
      );

    const audits = (await auditActions(tenantId, CHART_ACTION)).filter(
      (event) => event.objectId === entityId,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.objectType).toBe("legal_entity");
  });

  it("provisions each new legal entity separately, never mixing charts", async () => {
    const { client } = await tenantAdminClient();
    const first = await createLegalEntityApi(client);
    const second = await createLegalEntityApi(client);
    const [a, b] = await Promise.all([
      listAccountsApi(client, first),
      listAccountsApi(client, second),
    ]);
    expect(a).toHaveLength(standardFnbChartTemplate.length);
    expect(b).toHaveLength(standardFnbChartTemplate.length);
    expect(new Set([...a, ...b].map((x) => x.id)).size).toBe(a.length * 2);
  });

  it("an already-charted entity stays untouched: no template rows mixed in, no mappings, no audit", async () => {
    const tenant = await seedBareTenant({ entities: 2 });
    const [chartedEntity, emptyEntity] = tenant.entityIds as [string, string];
    // The tenant's own bare-bones chart (one account, no mappings).
    await owner.query(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, '1101', 'Kas Buatan Tenant', 'asset', 'cash_and_equivalents')`,
      [tenant.tenantId, chartedEntity],
    );
    const before = await snapshot(tenant.tenantId);

    const results = await backfillTenantCharts(tenant.tenantId);
    const byEntity = new Map(results.map((r) => [r.legalEntityId, r]));
    expect(byEntity.get(chartedEntity)?.status).toBe("already_present");
    expect(byEntity.get(emptyEntity)?.status).toBe("provisioned");

    const after = await snapshot(tenant.tenantId);
    const chartedRows = (rows: unknown[]) =>
      (rows as { legal_entity_id: string }[]).filter(
        (row) => row.legal_entity_id === chartedEntity,
      );
    expect(chartedRows(after.accounts)).toEqual(chartedRows(before.accounts));
    expect(chartedRows(after.mappings)).toEqual([]);
    expect(
      (await auditActions(tenant.tenantId, CHART_ACTION)).map(
        (e) => e.objectId,
      ),
    ).toEqual([emptyEntity]);
    expect(
      (after.accounts as { legal_entity_id: string }[]).filter(
        (row) => row.legal_entity_id === emptyEntity,
      ),
    ).toHaveLength(standardFnbChartTemplate.length);
  });

  it("an entity with a hand-made partial chart and no mappings reports every posting role as missing and inserts nothing", async () => {
    const tenant = await seedBareTenant({});
    await owner.query(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, '1101', 'Kas Buatan Tenant', 'asset', 'cash_and_equivalents')`,
      [tenant.tenantId, tenant.entityIds[0]],
    );
    const before = await snapshot(tenant.tenantId);

    const results = await backfillTenantCharts(tenant.tenantId);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("already_present");
    expect(results[0]!.missingRoles).toBe(
      Object.keys(POSTING_ACCOUNT_ROLES).length,
    );
    expect(await snapshot(tenant.tenantId)).toEqual(before);
  });

  it("refuses to provision a legal entity that belongs to another tenant", async () => {
    const mine = await seedBareTenant({});
    const theirs = await seedBareTenant({});
    await expect(
      withTenant(db, scopedContext(mine.tenantId), (tx) =>
        provisionStandardChart(
          tx,
          scopedContext(mine.tenantId),
          theirs.entityIds[0]!,
          null,
        ),
      ),
    ).rejects.toThrow();
    expect((await snapshot(theirs.tenantId)).accounts).toEqual([]);
    expect((await snapshot(mine.tenantId)).accounts).toEqual([]);
  });
});

describe("legend-4ryw outlet and tenant inventory provisioning", () => {
  it("TEN-06 §16 a new outlet gets six stock locations (one per type) and the tenant gets the standard UOMs", async () => {
    const { client, domainBrandId } = await tenantAdminClient();
    const { brandId, entityId } = await createBrandAndEntity(
      client,
      domainBrandId,
    );
    const outletId = await createOutletApi(client, brandId, entityId);

    const locations = await client.get(
      `/api/inventory/locations?outletId=${outletId}&limit=100`,
    );
    expect(locations.status, JSON.stringify(locations.body)).toBe(200);
    const rows = locations.body.data as { type: string; name: string }[];
    expect(rows).toHaveLength(STANDARD_STOCK_LOCATIONS.length);
    expect(rows.map((row) => `${row.type}:${row.name}`).sort()).toEqual(
      STANDARD_STOCK_LOCATIONS.map((row) => `${row.type}:${row.name}`).sort(),
    );
    expect(new Set(rows.map((row) => row.type)).size).toBe(6);

    const uoms = await client.get("/api/inventory/uoms?limit=100");
    expect(uoms.status, JSON.stringify(uoms.body)).toBe(200);
    const codes = (uoms.body.data as { code: string }[]).map((u) => u.code);
    for (const standard of STANDARD_UOM_CATALOG)
      expect(codes).toContain(standard.code);
  });

  it("a second outlet gets its own six locations without duplicating the tenant UOMs", async () => {
    const { client, domainBrandId } = await tenantAdminClient();
    const { brandId, entityId } = await createBrandAndEntity(
      client,
      domainBrandId,
    );
    const first = await createOutletApi(client, brandId, entityId);
    const second = await createOutletApi(client, brandId, entityId);
    for (const outletId of [first, second]) {
      const locations = await client.get(
        `/api/inventory/locations?outletId=${outletId}&limit=100`,
      );
      expect(locations.body.data).toHaveLength(6);
    }
    const uoms = await client.get("/api/inventory/uoms?limit=100");
    const codes = (uoms.body.data as { code: string }[]).map((u) => u.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("TEN-06 a tenant created from the platform panel already has the standard UOMs", async () => {
    const { client } = await adminClient();
    const created = await client
      .post("/api/platform/tenants")
      .set(originHeader)
      .send({
        slug: `uji-${unique()}`,
        name: "Uji Provisioning",
        plan: "lengkap",
        deploymentMode: "shared",
        featureFlags: { modules: ["pos"], integrationProviders: [] },
        limits,
        firstAdmin: {
          name: "Admin Pertama",
          whatsapp: "6281234567890",
          email: null,
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const tenantId = created.body.data.id as string;

    const { rows } = await owner.query<{ code: string; name: string }>(
      "SELECT code, name FROM uoms WHERE tenant_id = $1 ORDER BY code",
      [tenantId],
    );
    expect(rows).toEqual(
      [...STANDARD_UOM_CATALOG]
        .map(({ code, name }) => ({ code, name }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );
    expect(await auditActions(tenantId, UOM_ACTION)).toHaveLength(1);
  });

  it("provisions only the missing location types and never touches existing UOMs or locations", async () => {
    const tenant = await seedBareTenant({});
    const outletId = tenant.outletIds[0]!;
    // Tenant already uses code "kg" and has its own bar location.
    await owner.query(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'kg', 'Kilo Versi Tenant')",
      [tenant.tenantId],
    );
    await owner.query(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Bar Utama Tenant', 'bar')",
      [tenant.tenantId, outletId],
    );
    const context = scopedContext(tenant.tenantId);

    const uomResult = await withTenant(db, context, (tx) =>
      provisionStandardUoms(tx, context, null),
    );
    expect(uomResult.inserted).toBe(STANDARD_UOM_CATALOG.length - 1);
    const locationResult = await withTenant(db, context, (tx) =>
      provisionOutletStockLocations(tx, context, outletId, null),
    );
    expect(locationResult.inserted).toBe(STANDARD_STOCK_LOCATIONS.length - 1);

    const kg = await owner.query(
      "SELECT name FROM uoms WHERE tenant_id = $1 AND code = 'kg'",
      [tenant.tenantId],
    );
    expect(kg.rows).toEqual([{ name: "Kilo Versi Tenant" }]);
    const bars = await owner.query(
      "SELECT name FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2 AND type = 'bar'",
      [tenant.tenantId, outletId],
    );
    expect(bars.rows).toEqual([{ name: "Bar Utama Tenant" }]);
    expect(
      await countRows(
        "SELECT count(*)::int AS n FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2",
        [tenant.tenantId, outletId],
      ),
    ).toBe(6);
  });

  it("adds a standard location whose name clashes (case-insensitive) under a free alternative name and leaves the existing row untouched", async () => {
    const tenant = await seedBareTenant({});
    const outletId = tenant.outletIds[0]!;
    // Legacy outlet: a chiller location the tenant named "freezer". The
    // standard "Freezer" (type freezer) clashes by name, so the freezer type is
    // still added as "Freezer 2"; the chiller is already covered by type.
    await owner.query(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'freezer', 'chiller')",
      [tenant.tenantId, outletId],
    );
    const before = await owner.query(
      "SELECT * FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2 AND type = 'chiller'",
      [tenant.tenantId, outletId],
    );
    const context = scopedContext(tenant.tenantId);

    const result = await withTenant(db, context, (tx) =>
      provisionOutletStockLocations(tx, context, outletId, null),
    );
    expect(result.inserted).toBe(STANDARD_STOCK_LOCATIONS.length - 1);

    const rows = await owner.query<{ type: string; name: string }>(
      "SELECT type, name FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.tenantId, outletId],
    );
    expect(rows.rows.map((row) => row.type).sort()).toEqual(
      ["bar", "chiller", "freezer", "kitchen", "pastry", "warehouse"].sort(),
    );
    expect(rows.rows.find((row) => row.type === "freezer")?.name).toBe(
      "Freezer 2",
    );
    const after = await owner.query(
      "SELECT * FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2 AND type = 'chiller'",
      [tenant.tenantId, outletId],
    );
    expect(after.rows).toEqual(before.rows);

    // The backfill finds every type present and adds nothing more.
    await backfillTenantInventoryDefaults(tenant.tenantId);
    expect(
      await countRows(
        "SELECT count(*)::int AS n FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2",
        [tenant.tenantId, outletId],
      ),
    ).toBe(STANDARD_STOCK_LOCATIONS.length);
  });

  it("adds kitchen as 'Dapur 2' when a warehouse is named 'Dapur', so production finds exactly one kitchen", async () => {
    const tenant = await seedBareTenant({});
    const outletId = tenant.outletIds[0]!;
    await owner.query(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Dapur', 'warehouse')",
      [tenant.tenantId, outletId],
    );
    const context = scopedContext(tenant.tenantId);

    await withTenant(db, context, (tx) =>
      provisionOutletStockLocations(tx, context, outletId, null),
    );

    const kitchens = await owner.query<{ name: string }>(
      "SELECT name FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2 AND type = 'kitchen' AND is_active",
      [tenant.tenantId, outletId],
    );
    expect(kitchens.rows).toEqual([{ name: "Dapur 2" }]);
    const warehouses = await owner.query<{ name: string }>(
      "SELECT name FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2 AND type = 'warehouse'",
      [tenant.tenantId, outletId],
    );
    expect(warehouses.rows).toEqual([{ name: "Dapur" }]);
  });

  it("audits only calls that insert something (one row per call, system actor)", async () => {
    const tenant = await seedBareTenant({});
    const outletId = tenant.outletIds[0]!;
    const context = scopedContext(tenant.tenantId);
    await withTenant(db, context, (tx) =>
      provisionStandardUoms(tx, context, null),
    );
    await withTenant(db, context, (tx) =>
      provisionOutletStockLocations(tx, context, outletId, null),
    );
    expect(await auditActions(tenant.tenantId, UOM_ACTION)).toHaveLength(1);
    expect(await auditActions(tenant.tenantId, LOCATION_ACTION)).toHaveLength(
      1,
    );
    const actor = await owner.query<{ actor_type: string | null }>(
      "SELECT event->>'actorType' AS actor_type FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2",
      [tenant.tenantId, UOM_ACTION],
    );
    expect(actor.rows).toEqual([{ actor_type: "system" }]);
  });
});

describe("provisioning is idempotent", () => {
  it("re-running every service and backfill adds no rows, reports already_present and writes no audit", async () => {
    const tenant = await seedBareTenant({});
    const entityId = tenant.entityIds[0]!;
    const outletId = tenant.outletIds[0]!;
    const context = scopedContext(tenant.tenantId);

    // First run: a legacy tenant with nothing gets everything.
    const first = await withTenant(db, context, (tx) =>
      provisionStandardChart(tx, context, entityId, null),
    );
    expect(first).toMatchObject({
      legalEntityId: entityId,
      status: "provisioned",
      accounts: standardFnbChartTemplate.length,
      mappings: templateRoleToCode.size,
    });
    const uoms = await withTenant(db, context, (tx) =>
      provisionStandardUoms(tx, context, null),
    );
    expect(uoms.inserted).toBe(STANDARD_UOM_CATALOG.length);
    const locations = await withTenant(db, context, (tx) =>
      provisionOutletStockLocations(tx, context, outletId, null),
    );
    expect(locations.inserted).toBe(STANDARD_STOCK_LOCATIONS.length);
    const baseline = await snapshot(tenant.tenantId);
    expect(baseline.accounts).toHaveLength(standardFnbChartTemplate.length);
    expect(baseline.mappings).toHaveLength(templateRoleToCode.size);

    // Second run of everything.
    const chartAgain = await withTenant(db, context, (tx) =>
      provisionStandardChart(tx, context, entityId, null),
    );
    expect(chartAgain.status).toBe("already_present");
    expect(
      (
        await withTenant(db, context, (tx) =>
          provisionStandardUoms(tx, context, null),
        )
      ).inserted,
    ).toBe(0);
    expect(
      (
        await withTenant(db, context, (tx) =>
          provisionOutletStockLocations(tx, context, outletId, null),
        )
      ).inserted,
    ).toBe(0);
    const charts = await backfillTenantCharts(tenant.tenantId);
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({
      legalEntityId: entityId,
      status: "already_present",
    });
    expect(await backfillTenantInventoryDefaults(tenant.tenantId)).toEqual({
      uomsInserted: 0,
      outlets: 1,
      locationsInserted: 0,
    });

    // Same rows (same ids, same values) and the same audit total.
    expect(await snapshot(tenant.tenantId)).toEqual(baseline);
    expect(await auditActions(tenant.tenantId, CHART_ACTION)).toHaveLength(1);
    expect(await auditActions(tenant.tenantId, UOM_ACTION)).toHaveLength(1);
    expect(await auditActions(tenant.tenantId, LOCATION_ACTION)).toHaveLength(
      1,
    );
  });

  it("backfill fills a legacy tenant (charts, UOMs, locations of every outlet) exactly once", async () => {
    const tenant = await seedBareTenant({ entities: 2, outlets: 2 });
    const charts = await backfillTenantCharts(tenant.tenantId);
    expect(charts.map((r) => r.status)).toEqual(["provisioned", "provisioned"]);
    expect(new Set(charts.map((r) => r.legalEntityId))).toEqual(
      new Set(tenant.entityIds),
    );

    const inventory = await backfillTenantInventoryDefaults(tenant.tenantId);
    expect(inventory).toEqual({
      uomsInserted: STANDARD_UOM_CATALOG.length,
      outlets: 2,
      locationsInserted: STANDARD_STOCK_LOCATIONS.length * 2,
    });
    expect(await auditActions(tenant.tenantId, CHART_ACTION)).toHaveLength(2);

    const before = await snapshot(tenant.tenantId);
    await backfillTenantCharts(tenant.tenantId);
    await backfillTenantInventoryDefaults(tenant.tenantId);
    expect(await snapshot(tenant.tenantId)).toEqual(before);
  });

  it("concurrent provisioning of the same entity and outlet inserts the defaults once", async () => {
    const tenant = await seedBareTenant({});
    const entityId = tenant.entityIds[0]!;
    const outletId = tenant.outletIds[0]!;
    const context = scopedContext(tenant.tenantId);
    const results = await Promise.all([
      withTenant(db, context, (tx) =>
        provisionStandardChart(tx, context, entityId, null),
      ),
      withTenant(db, context, (tx) =>
        provisionStandardChart(tx, context, entityId, null),
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "already_present",
      "provisioned",
    ]);
    await Promise.all([
      withTenant(db, context, (tx) =>
        provisionOutletStockLocations(tx, context, outletId, null),
      ),
      withTenant(db, context, (tx) =>
        provisionOutletStockLocations(tx, context, outletId, null),
      ),
    ]);
    const after = await snapshot(tenant.tenantId);
    expect(after.accounts).toHaveLength(standardFnbChartTemplate.length);
    expect(after.mappings).toHaveLength(templateRoleToCode.size);
    expect(after.locations).toHaveLength(STANDARD_STOCK_LOCATIONS.length);
    expect(await auditActions(tenant.tenantId, CHART_ACTION)).toHaveLength(1);
    expect(await auditActions(tenant.tenantId, LOCATION_ACTION)).toHaveLength(
      1,
    );
  });
});

describe("tenant edits survive provisioning", () => {
  it("backfill changes no row of a chart, UOM list or location set the tenant has edited", async () => {
    const tenant = await seedBareTenant({});
    const entityId = tenant.entityIds[0]!;
    const outletId = tenant.outletIds[0]!;
    await backfillTenantCharts(tenant.tenantId);
    await backfillTenantInventoryDefaults(tenant.tenantId);

    // Tenant edits: rename + deactivate a template account, add a custom one,
    // rename a UOM, rename and deactivate a location.
    await owner.query(
      "UPDATE chart_of_accounts SET name = 'Kas Toko Kami' WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1101'",
      [tenant.tenantId, entityId],
    );
    await owner.query(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, '6199', 'Beban Khusus Tenant', 'expense', 'operating_expense')`,
      [tenant.tenantId, entityId],
    );
    await owner.query(
      "UPDATE uoms SET name = 'Kilo Kami' WHERE tenant_id = $1 AND code = 'kg'",
      [tenant.tenantId],
    );
    await owner.query(
      "UPDATE stock_locations SET name = 'Gudang Belakang', is_active = false WHERE tenant_id = $1 AND outlet_id = $2 AND type = 'warehouse'",
      [tenant.tenantId, outletId],
    );
    const before = await snapshot(tenant.tenantId);

    const charts = await backfillTenantCharts(tenant.tenantId);
    expect(charts.map((r) => r.status)).toEqual(["already_present"]);
    const inventory = await backfillTenantInventoryDefaults(tenant.tenantId);
    expect(inventory.uomsInserted).toBe(0);
    expect(inventory.locationsInserted).toBe(0);

    expect(await snapshot(tenant.tenantId)).toEqual(before);
    const renamed = await owner.query(
      "SELECT name FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1101'",
      [tenant.tenantId, entityId],
    );
    expect(renamed.rows).toEqual([{ name: "Kas Toko Kami" }]);
  });
});

describe("tenant isolation of provisioned defaults", () => {
  it("TEN-01 tenant A never sees tenant B's accounts, locations or UOMs, and A's backfill leaves B untouched", async () => {
    const a = await seedBareTenant({});
    const b = await seedBareTenant({});
    await backfillTenantCharts(b.tenantId);
    await backfillTenantInventoryDefaults(b.tenantId);
    const bBefore = await snapshot(b.tenantId);
    expect(bBefore.accounts).toHaveLength(standardFnbChartTemplate.length);

    const aResults = await backfillTenantCharts(a.tenantId);
    expect(aResults.map((r) => r.legalEntityId)).toEqual(a.entityIds);
    await backfillTenantInventoryDefaults(a.tenantId);
    const aAfter = await snapshot(a.tenantId);
    expect(aAfter.accounts).toHaveLength(standardFnbChartTemplate.length);
    expect(aAfter.uoms).toHaveLength(STANDARD_UOM_CATALOG.length);
    expect(aAfter.locations).toHaveLength(STANDARD_STOCK_LOCATIONS.length);

    // B did not change, and the two tenants share no row.
    expect(await snapshot(b.tenantId)).toEqual(bBefore);
    const ids = (rows: unknown[]) =>
      (rows as { id: string }[]).map((r) => r.id);
    const shared = ids(aAfter.accounts).filter((id) =>
      ids(bBefore.accounts).includes(id),
    );
    expect(shared).toEqual([]);

    // Through the application database role, A's session sees only A's rows.
    const appPool = new Pool({
      connectionString: process.env.APP_DATABASE_URL,
      max: 1,
    });
    try {
      await appPool.query("BEGIN");
      await appPool.query("SET LOCAL ROLE legend_app");
      await appPool.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [a.tenantId],
      );
      for (const table of [
        "chart_of_accounts",
        "account_mappings",
        "uoms",
        "stock_locations",
      ]) {
        const foreign = await appPool.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
          [b.tenantId],
        );
        expect(foreign.rows[0].n, table).toBe(0);
        const own = await appPool.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
          [a.tenantId],
        );
        expect(own.rows[0].n, table).toBeGreaterThan(0);
      }
      await appPool.query("ROLLBACK");
    } finally {
      await appPool.end();
    }
  });

  it("TEN-01 outlet provisioning never writes locations for another tenant's outlet", async () => {
    const a = await seedBareTenant({});
    const b = await seedBareTenant({});
    const context = scopedContext(a.tenantId);
    await expect(
      withTenant(db, context, (tx) =>
        provisionOutletStockLocations(tx, context, b.outletIds[0]!, null),
      ),
    ).rejects.toThrow();
    expect((await snapshot(b.tenantId)).locations).toEqual([]);
    expect((await snapshot(a.tenantId)).locations).toEqual([]);
  });
});

describe("tenant can still manage the provisioned chart", () => {
  it("ACC-01 adds a new account and replaces a default mapping through the chart routes", async () => {
    const { client } = await tenantAdminClient();
    const entityId = await createLegalEntityApi(client);
    const before = await listAccountsApi(client, entityId);

    const created = await client
      .post(`/api/accounting/legal-entities/${entityId}/accounts`)
      .set(originHeader)
      .send({
        code: "1190",
        name: "Kas Cabang Baru",
        type: "asset",
        reportGroup: "cash_and_equivalents",
        parentId: null,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const newAccountId = created.body.data.id as string;
    expect(await listAccountsApi(client, entityId)).toHaveLength(
      before.length + 1,
    );

    const current = await listMappingsApi(client, entityId);
    expect(current.find((m) => m.role === "cash_on_hand")).toBeDefined();
    const replaced = await client
      .put(`/api/accounting/legal-entities/${entityId}/account-mappings`)
      .set(originHeader)
      .send({
        mappings: current.map(({ role, accountId }) => ({
          role,
          accountId: role === "cash_on_hand" ? newAccountId : accountId,
        })),
      });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    const after = await listMappingsApi(client, entityId);
    expect(after).toHaveLength(current.length);
    expect(after.find((m) => m.role === "cash_on_hand")?.accountId).toBe(
      newAccountId,
    );

    // A refused mapping (wrong account type for the role) still fails: the
    // defaults do not loosen validation.
    const expense = before.find((a) => a.code === "6101")!;
    const refused = await client
      .put(`/api/accounting/legal-entities/${entityId}/account-mappings`)
      .set(originHeader)
      .send({
        mappings: after.map(({ role, accountId }) => ({
          role,
          accountId: role === "cash_on_hand" ? expense.id : accountId,
        })),
      });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const unchanged = await listMappingsApi(client, entityId);
    expect(unchanged.find((m) => m.role === "cash_on_hand")?.accountId).toBe(
      newAccountId,
    );
  });
});
