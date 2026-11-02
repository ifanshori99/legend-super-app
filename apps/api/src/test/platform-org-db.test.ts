// Platform & organisation isolation at the database role (TEN-01/02) and the
// worker registry contract. Runs against the disposable test database as the
// migration owner (fixtures) and as the restricted legend_app login (checks).
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { resolveHostname } from "../services/org-resolve.service";

const fixtures = cafeLegendPlatformFixtures;
const tenantA = fixtures.tenant.id;
const tenantB = randomUUID();
const brandB = randomUUID();
const legalEntityB = randomUUID();
const outletB = randomUUID();
const domainB = randomUUID();
const integrationB = randomUUID();
const themeB = randomUUID();
const grantB = randomUUID();
const superAdminB = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

/** Runs `run` inside a rolled-back legend_app transaction with tenant context. */
async function asTenant<T>(
  tenantId: string | null,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    if (tenantId !== null)
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("TEN-01 cross-tenant isolation on the platform tables", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, 'uji-tenant-b', ' Tenant B', 'lengkap', 'active', 'shared', '{"modules":[]}', $2, $3)`,
      [
        tenantB,
        JSON.stringify({
          maxOutlets: 5,
          maxActiveEmployees: 30,
          maxDevices: 10,
          aiRequestsPerMonth: 0,
          whatsappCostCapIdr: 0,
          aiCostCapIdr: 0,
          emailCostCapIdr: 0,
        }),
        randomUUID(),
      ],
    );
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji-brand-b', 'Brand B')`,
      [brandB, tenantB],
    );
    await owner.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Tenant B', false)`,
      [legalEntityB, tenantB],
    );
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', '{}')`,
      [outletB, tenantB, brandB, legalEntityB],
    );
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, verified_at) VALUES ($1, $2, $3, 'tenant-b.example.com', 'custom', now())`,
      [domainB, tenantB, brandB],
    );
    await owner.query(
      `INSERT INTO tenant_integrations (id, tenant_id, provider, config) VALUES ($1, $2, 'doit', '{}')`,
      [integrationB, tenantB],
    );
    await owner.query(
      `INSERT INTO tenant_themes (id, tenant_id, brand_id, version, tokens, font_family, corners, created_by)
       VALUES ($1, $2, $3, 1, '{"light":{},"dark":{}}', 'inter', 'soft', $4)`,
      [themeB, tenantB, brandB, randomUUID()],
    );
    await owner.query(
      `INSERT INTO support_access_grants
        (id, tenant_id, super_admin_user_id, reason, access_mode, duration_minutes, started_at, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, 'Sesi dukungan untuk pengujian isolasi tenant', 'read_only', 60, now(), now() + interval '60 minutes', now())`,
      [grantB, tenantB, superAdminB],
    );
  });

  afterAll(async () => {
    await owner.query(
      "DELETE FROM support_access_grants WHERE tenant_id = $1",
      [tenantB],
    );
    await owner.query("DELETE FROM tenant_themes WHERE tenant_id = $1", [
      tenantB,
    ]);
    await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [
      tenantB,
    ]);
    await owner.query("DELETE FROM tenant_domains WHERE tenant_id = $1", [
      tenantB,
    ]);
    await owner.query("DELETE FROM outlets WHERE tenant_id = $1", [tenantB]);
    await owner.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      tenantB,
    ]);
    await owner.query("DELETE FROM brands WHERE tenant_id = $1", [tenantB]);
    await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  });

  const cases = [
    {
      table: "brands",
      select: "SELECT id FROM brands WHERE id = $1",
      update: "UPDATE brands SET name = 'stolen' WHERE id = $1",
      remove: "DELETE FROM brands WHERE id = $1",
      insert:
        "INSERT INTO brands (tenant_id, slug, name) VALUES ($1, 'cross-tenant', 'Cross')",
      id: brandB,
    },
    {
      table: "legal_entities",
      select: "SELECT id FROM legal_entities WHERE id = $1",
      update: "UPDATE legal_entities SET name = 'stolen' WHERE id = $1",
      remove: "DELETE FROM legal_entities WHERE id = $1",
      insert:
        "INSERT INTO legal_entities (tenant_id, name, is_pkp) VALUES ($1, 'Cross', false)",
      id: legalEntityB,
    },
    {
      table: "outlets",
      select: "SELECT id FROM outlets WHERE id = $1",
      update: "UPDATE outlets SET name = 'stolen' WHERE id = $1",
      remove: "DELETE FROM outlets WHERE id = $1",
      insert:
        "INSERT INTO outlets (tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours) VALUES ($1, $2, $3, 'X-01', 'Cross', 'Jl. X', '{}')",
      id: outletB,
      extra: [brandB, legalEntityB],
    },
    {
      table: "tenant_domains",
      // Reads are open on purpose so host resolution works before a tenant
      // context exists (TEN-02); only writes must stay tenant-bound.
      skipSelect: true,
      select: "SELECT id FROM tenant_domains WHERE id = $1",
      update:
        "UPDATE tenant_domains SET hostname = 'stolen.example.com' WHERE id = $1",
      remove: "DELETE FROM tenant_domains WHERE id = $1",
      insert:
        "INSERT INTO tenant_domains (tenant_id, brand_id, hostname, kind) VALUES ($1, $2, 'cross-tenant.example.com', 'custom')",
      id: domainB,
      extra: [brandB],
    },
    {
      table: "tenant_integrations",
      select: "SELECT id FROM tenant_integrations WHERE id = $1",
      update:
        "UPDATE tenant_integrations SET config = '{\"x\":1}' WHERE id = $1",
      remove: "DELETE FROM tenant_integrations WHERE id = $1",
      insert:
        "INSERT INTO tenant_integrations (tenant_id, provider, config) VALUES ($1, 'email', '{}')",
      id: integrationB,
    },
    {
      table: "tenant_themes",
      select: "SELECT id FROM tenant_themes WHERE id = $1",
      update: "UPDATE tenant_themes SET tokens = '{}' WHERE id = $1",
      remove: "DELETE FROM tenant_themes WHERE id = $1",
      insert:
        "INSERT INTO tenant_themes (tenant_id, brand_id, version, tokens, font_family, corners, created_by) VALUES ($1, $2, 2, '{}', 'inter', 'soft', $3)",
      id: themeB,
      extra: [brandB, randomUUID()],
    },
    {
      table: "support_access_grants",
      select: "SELECT id FROM support_access_grants WHERE id = $1",
      update:
        "UPDATE support_access_grants SET reason = 'stolen' WHERE id = $1",
      remove: "DELETE FROM support_access_grants WHERE id = $1",
      insert:
        "INSERT INTO support_access_grants (tenant_id, super_admin_user_id, reason, started_at, expires_at, mfa_verified_at) VALUES ($1, $2, 'Sesi lintas tenant yang harus ditolak', now(), now() + interval '60 minutes', now())",
      id: grantB,
      extra: [superAdminB],
    },
  ];

  for (const testCase of cases) {
    it(`TEN-01 tenant A cannot read, change or delete ${testCase.table} rows of tenant B`, async () => {
      const insertParams = [tenantB, ...(testCase.extra ?? [])];
      await asTenant(tenantA, async (client) => {
        if (!testCase.skipSelect)
          expect(
            (await client.query(testCase.select, [testCase.id])).rowCount,
          ).toBe(0);
        expect(
          (await client.query(testCase.update, [testCase.id])).rowCount,
        ).toBe(0);
        expect(
          (await client.query(testCase.remove, [testCase.id])).rowCount,
        ).toBe(0);
        await client.query("SAVEPOINT tenant_write");
        await expect(
          client.query(testCase.insert, insertParams),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT tenant_write");
      });
      // The row is still there, unchanged, for its own tenant.
      const row = await owner.query(
        `SELECT 1 FROM ${testCase.table} WHERE id = $1`,
        [testCase.id],
      );
      expect(row.rowCount).toBe(1);
    });
  }

  it("TEN-02 rejects a tenant table query without tenant context", async () => {
    await asTenant(null, async (client) => {
      await expect(client.query("SELECT id FROM brands")).rejects.toThrow(
        /tenant context/i,
      );
    });
  });

  it("TEN-02 tenant A sees its own brands and never tenant B's", async () => {
    await asTenant(tenantA, async (client) => {
      const rows = await client.query<{ id: string }>("SELECT id FROM brands");
      expect(rows.rows.map((row) => row.id)).toContain(fixtures.brand.id);
      expect(rows.rows.map((row) => row.id)).not.toContain(brandB);
    });
  });

  it("resolves a host name without tenant context, and only for verified domains", async () => {
    const verified = await resolveHostname(fixtures.domains[0]!.hostname);
    expect(verified).toMatchObject({
      ok: true,
      tenantId: tenantA,
      brandId: fixtures.brand.id,
    });
    const unverified = await resolveHostname(fixtures.domains[2]!.hostname);
    expect(unverified).toEqual({ ok: false, reason: "unverified" });
    expect(await resolveHostname("tidak-dikenal.example.com")).toEqual({
      ok: false,
      reason: "unknown_host",
    });
    expect(await resolveHostname("localhost")).toEqual({
      ok: false,
      reason: "invalid_host",
    });
    // Host resolution never exposes another tenant's host to a tenant request.
    expect(await resolveHostname("tenant-b.example.com")).toMatchObject({
      ok: true,
      tenantId: tenantB,
    });
  });

  it("keeps the global tables read-only for the app role except tenants", async () => {
    await asTenant(tenantA, async (client) => {
      // Read paths needed by the API: registry, packages, admins, regions.
      expect(
        (await client.query("SELECT id FROM tenants")).rowCount,
      ).toBeGreaterThanOrEqual(2);
      await expect(
        client.query("SELECT key FROM platform_packages"),
      ).resolves.toBeTruthy();
      await expect(
        client.query("SELECT id FROM platform_admins"),
      ).resolves.toBeTruthy();
      await expect(
        client.query("SELECT id FROM regions"),
      ).resolves.toBeTruthy();
      // Least privilege: no DELETE on the tenant registry (archive instead)
      // and no writes at all on packages/admins/regions.
      // Each denial aborts the transaction, so fence them with savepoints.
      await client.query("SAVEPOINT deny_delete");
      await expect(client.query("DELETE FROM tenants")).rejects.toThrow(
        /permission denied/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT deny_delete");
      await client.query("SAVEPOINT deny_package");
      await expect(
        client.query(
          "INSERT INTO platform_packages (key, name, modules, default_limits) VALUES ('x', 'X', '[]', '{}')",
        ),
      ).rejects.toThrow(/permission denied/i);
      await client.query("ROLLBACK TO SAVEPOINT deny_package");
      await client.query("SAVEPOINT deny_region");
      await expect(
        client.query(
          "INSERT INTO regions (code, name, type) VALUES ('00', 'X', 'province')",
        ),
      ).rejects.toThrow(/permission denied/i);
      await client.query("ROLLBACK TO SAVEPOINT deny_region");
    });
  });
});

afterAll(async () => {
  await owner.end();
  await appPool.end();
});

describe("worker tenant registry", () => {
  it("exposes exactly app.active_tenant_registry for active tenants only", async () => {
    const tenantC = randomUUID();
    try {
      await owner.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         VALUES ($1, $2, 'Tenant C', 'lengkap', 'active', 'shared', '{"modules":[]}', $3, $4)`,
        [
          tenantC,
          `uji-tenant-c-${randomBytes(3).toString("hex")}`,
          JSON.stringify({
            maxOutlets: 5,
            maxActiveEmployees: 30,
            maxDevices: 10,
            aiRequestsPerMonth: 0,
            whatsappCostCapIdr: 0,
            aiCostCapIdr: 0,
            emailCostCapIdr: 0,
          }),
          randomUUID(),
        ],
      );
      const active = await owner.query(
        "SELECT id FROM app.active_tenant_registry WHERE id IN ($1, $2)",
        [tenantA, tenantC],
      );
      expect(active.rows.map((row) => row.id).sort()).toEqual(
        [tenantA, tenantC].sort(),
      );
      await owner.query(
        "UPDATE tenants SET status = 'suspended' WHERE id = $1",
        [tenantC],
      );
      const suspended = await owner.query(
        "SELECT id FROM app.active_tenant_registry WHERE id = $1",
        [tenantC],
      );
      expect(suspended.rowCount).toBe(0);
    } finally {
      await owner.query("DELETE FROM tenants WHERE id = $1", [tenantC]);
    }
  });

  it("provisions a worker role that reads only the registry once the view exists", async () => {
    const suffix = randomBytes(8).toString("hex");
    const role = `legend_worker_${suffix}`;
    const workerUrl = new URL(process.env.STARTER_TEST_DATABASE_URL ?? "");
    workerUrl.username = role;
    workerUrl.password = randomBytes(24).toString("hex");
    const moduleUrl = new URL(
      "../../../../scripts/provision-app-role.mjs",
      import.meta.url,
    ).href;
    const { provisionWorkerRole } = await import(moduleUrl);
    // The queue schema must not already be owned by another role; the other
    // worker test creates it on its own database, not here.
    await owner.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    let worker: Client | undefined;
    try {
      await provisionWorkerRole(
        process.env.STARTER_TEST_DATABASE_URL as string,
        workerUrl.toString(),
      );
      worker = new Client({ connectionString: workerUrl.toString() });
      await worker.connect();
      const registry = await worker.query(
        "SELECT id FROM app.active_tenant_registry",
      );
      expect(registry.rows.map((row) => row.id)).toContain(tenantA);
      await expect(
        worker.query("SELECT id FROM tenants"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await worker?.end().catch(() => {});
      await owner.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
      // provisionWorkerRole granted USAGE on app and SELECT on the view.
      await owner.query(
        `REVOKE ALL ON app.active_tenant_registry FROM "${role}"`,
      );
      await owner.query(`REVOKE USAGE ON SCHEMA app FROM "${role}"`);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  });
});
