// Integrations store + usage tables at the database role and service layer
// (PRD v1.7 §3 F4 "Integrasi per Tenant", "Kuota & Plafon", §6 J
// `usage_costs_daily`; PAY-06, TEN-06, TEN-01). Fixtures are written as the
// migration owner; checks run as the restricted legend_app login.
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  currentCredentialKeyVersion,
  listIntegrations,
  loadActiveIntegrationCredentials,
  rotateIntegrationCredentials,
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service.ts";
import {
  assertCountQuota,
  getOrgUsage,
  recordUsageCost,
  usageDate,
} from "../services/platform-usage.service.ts";
import type { Idr } from "@starter/shared/core";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const brandB = randomUUID();
const legalEntityB = randomUUID();
const outletB = randomUUID();
const integrationB = randomUUID();
const usageB = randomUUID();
const actor = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

const limitsB = {
  maxOutlets: 1,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 3,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 10_000,
  emailCostCapIdr: 1_000,
};

function contextFor(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}
const ctxB = contextFor(tenantB);

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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant B Kuota', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":["doit","email"]}', $3, $4)`,
    [
      tenantB,
      `uji-kuota-${randomBytes(4).toString("hex")}`,
      JSON.stringify(limitsB),
      actor,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')`,
    [brandB, tenantB, `uji-kuota-b-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
    [legalEntityB, tenantB],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', '{}')`,
    [outletB, tenantB, brandB, legalEntityB],
  );
  await owner.query(
    `INSERT INTO tenant_integrations (id, tenant_id, provider, config) VALUES ($1, $2, 'email', '{}')`,
    [integrationB, tenantB],
  );
  // Outside the current month: never counted.
  await owner.query(
    `INSERT INTO usage_costs_daily (id, tenant_id, cost_date, component, units, cost_idr)
     VALUES ($1, $2, '2000-01-01', 'ai', 99, 99999)`,
    [usageB, tenantB],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query("DELETE FROM usage_costs_daily WHERE tenant_id = $1", [
    tenantB,
  ]);
  await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [
    tenantB,
  ]);
  await owner.query("DELETE FROM outlets WHERE tenant_id = $1", [tenantB]);
  await owner.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
    tenantB,
  ]);
  await owner.query("DELETE FROM brands WHERE tenant_id = $1", [tenantB]);
  // audit_logs is append-only but has no tenants FK (its tenant-wide rows
  // stay); drop the tenant so later suites listing every tenant never see it.
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
  await appPool.end();
});

describe("TEN-01 isolation of the integrations and usage tables", () => {
  const cases = [
    {
      table: "tenant_integrations",
      select: "SELECT id FROM tenant_integrations WHERE id = $1",
      update:
        "UPDATE tenant_integrations SET credentials_key_version = 9 WHERE id = $1",
      remove: "DELETE FROM tenant_integrations WHERE id = $1",
      insert:
        "INSERT INTO tenant_integrations (tenant_id, provider, config) VALUES ($1, 'gofood', '{}')",
      id: integrationB,
    },
    {
      table: "usage_costs_daily",
      select: "SELECT id FROM usage_costs_daily WHERE id = $1",
      update: "UPDATE usage_costs_daily SET cost_idr = 0 WHERE id = $1",
      remove: "DELETE FROM usage_costs_daily WHERE id = $1",
      insert:
        "INSERT INTO usage_costs_daily (tenant_id, cost_date, component, units, cost_idr) VALUES ($1, '2000-01-02', 'email', 1, 1)",
      id: usageB,
    },
  ];

  for (const testCase of cases) {
    it(`PAY-06 TEN-01 tenant A cannot read, change or delete ${testCase.table} rows of tenant B`, async () => {
      await asTenant(tenantA, async (client) => {
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
          client.query(testCase.insert, [tenantB]),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT tenant_write");
      });
      const row = await owner.query(
        `SELECT 1 FROM ${testCase.table} WHERE id = $1`,
        [testCase.id],
      );
      expect(row.rowCount).toBe(1);
    });
  }

  it("TEN-06 usage_costs_daily refuses queries without tenant context and is FORCE RLS", async () => {
    await asTenant(null, async (client) => {
      await expect(
        client.query("SELECT id FROM usage_costs_daily"),
      ).rejects.toThrow(/tenant context/i);
    });
    const { rows } = await owner.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.usage_costs_daily'::regclass",
    );
    expect(rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });

  it("PAY-06 a tenant-A context never lists tenant B's integrations", async () => {
    const { data } = await listIntegrations(contextFor(tenantA));
    expect(data.map((row) => row.id)).not.toContain(integrationB);
    for (const row of data) expect(row.tenantId).toBe(tenantA);
  });
});

describe("PAY-06 sealed credentials and key rotation", () => {
  it("PAY-06 seals with the current key version, binds the blob to its row and re-seals on rotation", async () => {
    const apiKey = `doit-${randomBytes(12).toString("hex")}`;
    const created = await upsertIntegration(
      ctxB,
      {
        outletId: null,
        provider: "doit",
        config: { merchantCode: "B-1" },
        credentials: { apiKey },
      },
      actor,
    );
    expect(JSON.stringify(created)).not.toContain(apiKey);
    // Draft rows are never handed to a provider adapter (fail closed).
    expect(await loadActiveIntegrationCredentials(ctxB, "doit", null)).toBe(
      null,
    );
    await setIntegrationStatus(ctxB, created.id, { status: "active" }, actor);
    const loaded = await loadActiveIntegrationCredentials(ctxB, "doit", null);
    expect(loaded?.credentials).toEqual({ apiKey });
    expect(loaded?.integration.id).toBe(created.id);

    const sealedRow = async () =>
      (
        await owner.query<{
          credentials_encrypted: string;
          credentials_key_version: number | null;
          credential_secret_ref: string;
        }>(
          "SELECT credentials_encrypted, credentials_key_version, credential_secret_ref FROM tenant_integrations WHERE id = $1",
          [created.id],
        )
      ).rows[0]!;
    const before = await sealedRow();
    expect(before.credentials_key_version).toBe(currentCredentialKeyVersion());

    // Nothing stale: a plain rotation touches no row.
    expect(await rotateIntegrationCredentials(ctxB)).toEqual({ rotated: 0 });

    // A row sealed under an older key version is re-sealed with the current one.
    await owner.query(
      "UPDATE tenant_integrations SET credentials_key_version = 0 WHERE id = $1",
      [created.id],
    );
    expect(await rotateIntegrationCredentials(ctxB)).toEqual({ rotated: 1 });
    const after = await sealedRow();
    expect(after.credentials_key_version).toBe(currentCredentialKeyVersion());
    expect(after.credentials_encrypted).not.toBe(before.credentials_encrypted);
    expect(after.credential_secret_ref).toBe(before.credential_secret_ref);
    expect(
      (await loadActiveIntegrationCredentials(ctxB, "doit", null))?.credentials,
    ).toEqual({ apiKey });

    // A blob copied onto another row does not open there (AAD binding).
    await owner.query(
      "UPDATE tenant_integrations SET credentials_encrypted = $1, credential_secret_ref = $2, credential_fields = ARRAY['apiKey'], credentials_set_at = now(), credentials_set_by = $3, status = 'active' WHERE id = $4",
      [
        after.credentials_encrypted,
        `sec_${"x".repeat(20)}`,
        actor,
        integrationB,
      ],
    );
    await expect(
      loadActiveIntegrationCredentials(ctxB, "email", null),
    ).rejects.toThrow();

    const audited = await owner.query<{ event: unknown }>(
      "SELECT event FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2",
      [tenantB, created.id],
    );
    expect(audited.rowCount).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audited.rows)).not.toContain(apiKey);
  });
});

describe("TEN-06 quota and cost-cap enforcement", () => {
  it("TEN-06 refuses a create past the count quota (QUOTA_EXCEEDED)", async () => {
    await expect(
      withTenant(db, ctxB, (tx) => assertCountQuota(tx, ctxB, "outlets")),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(
      withTenant(db, ctxB, (tx) => assertCountQuota(tx, ctxB, "devices")),
    ).resolves.toBeUndefined();
  });

  it("TEN-06 counts this month's costs, warns at 80% and stops at the cap (R18)", async () => {
    const now = new Date();
    await recordUsageCost(ctxB, {
      component: "ai",
      units: 2,
      costIdr: 7_000 as Idr,
      now,
    });
    let view = await getOrgUsage(ctxB, now);
    expect(view.usage.aiRequests).toBe(2);
    expect(view.usage.aiCostIdr).toBe(7_000);
    expect(view.costCaps.find((cap) => cap.cap === "ai")?.state).toBe("ok");

    await recordUsageCost(ctxB, {
      component: "ai",
      units: 1,
      costIdr: 1_000 as Idr,
      now,
    });
    view = await getOrgUsage(ctxB, now);
    expect(view.costCaps.find((cap) => cap.cap === "ai")).toMatchObject({
      state: "warning",
      spentIdr: 8_000,
      remainingIdr: 2_000,
    });
    expect(view.quotas.find((quota) => quota.quota === "ai_requests")).toEqual({
      quota: "ai_requests",
      limit: 3,
      used: 3,
      remaining: 0,
    });

    // AI request quota reached.
    await expect(
      recordUsageCost(ctxB, {
        component: "ai",
        units: 1,
        costIdr: 0 as Idr,
        now,
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    // Spending that would cross the cap is refused up front.
    await expect(
      recordUsageCost(ctxB, {
        component: "ai",
        units: 0,
        costIdr: 2_001 as Idr,
        now,
      }),
    ).rejects.toMatchObject({ code: "COST_CAP_REACHED" });
    // A zero cap means the feature is off.
    await expect(
      recordUsageCost(ctxB, {
        component: "whatsapp",
        units: 1,
        costIdr: 1 as Idr,
        now,
      }),
    ).rejects.toMatchObject({ code: "COST_CAP_REACHED" });
    // Uncapped components are recorded only.
    await recordUsageCost(ctxB, {
      component: "server",
      units: 1,
      costIdr: 500_000 as Idr,
      now,
    });

    const rows = await owner.query<{ component: string; cost_idr: string }>(
      "SELECT component, cost_idr::text FROM usage_costs_daily WHERE tenant_id = $1 AND cost_date = $2 ORDER BY component",
      [tenantB, usageDate(now)],
    );
    expect(rows.rows).toEqual([
      { component: "ai", cost_idr: "8000" },
      { component: "server", cost_idr: "500000" },
    ]);
  });

  it("TEN-06 two concurrent spends cannot both slip under the cap", async () => {
    const now = new Date();
    const results = await Promise.allSettled([
      recordUsageCost(ctxB, {
        component: "email",
        units: 1,
        costIdr: 600 as Idr,
        now,
      }),
      recordUsageCost(ctxB, {
        component: "email",
        units: 1,
        costIdr: 600 as Idr,
        now,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "COST_CAP_REACHED",
    });
    const view = await getOrgUsage(ctxB, now);
    expect(view.usage.emailCostIdr).toBe(600);
  });
});
