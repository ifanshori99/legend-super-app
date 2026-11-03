// Shared fixtures for the theme / text-override / consent DB tests: two
// disposable tenants, each with one brand, created as the migration owner and
// removed afterwards. Services run as the restricted legend_app role.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

export type TestTenant = {
  tenantId: string;
  brandId: string;
  context: ScopedTenantContext;
  actorId: string;
};

const limits = JSON.stringify({
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 0,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 0,
  emailCostCapIdr: 0,
});

export async function createTestTenant(label: string): Promise<TestTenant> {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const slug = `uji-${label}-${tenantId.slice(0, 8)}`;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant Uji', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [tenantId, slug, limits, randomUUID()],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand Uji')`,
    [brandId, tenantId, `b-${slug}`],
  );
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "session",
  });
  return {
    tenantId,
    brandId,
    actorId: randomUUID(),
    context: establishScopedTenantContext(tenant, { kind: "tenant" }),
  };
}

/** Best-effort cleanup as the migration owner (append-only tables may refuse). */
export async function removeTestTenant(t: TestTenant): Promise<void> {
  const statements: [string, unknown[]][] = [
    ["DELETE FROM consents WHERE tenant_id = $1", [t.tenantId]],
    ["DELETE FROM text_overrides WHERE tenant_id = $1", [t.tenantId]],
    ["UPDATE brands SET theme_id = NULL WHERE tenant_id = $1", [t.tenantId]],
    ["DELETE FROM tenant_themes WHERE tenant_id = $1", [t.tenantId]],
    ["DELETE FROM brands WHERE tenant_id = $1", [t.tenantId]],
    ["DELETE FROM tenants WHERE id = $1", [t.tenantId]],
  ];
  for (const [sql, params] of statements)
    await owner.query(sql, params).catch(() => undefined);
}
