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
/** A stored object in a new outlet of the tenant (media library row). */
export async function storedMedia(t: TestTenant): Promise<string> {
  const legalEntityId = randomUUID();
  const outletId = randomUUID();
  const mediaId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Logo', false)",
    [legalEntityId, t.tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Logo', 'Jl. Logo', '{}')`,
    [
      outletId,
      t.tenantId,
      t.brandId,
      legalEntityId,
      `LOGO-${outletId.slice(0, 8).toUpperCase()}`,
    ],
  );
  await owner.query(
    `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
     VALUES ($1, $2, $3, 'document', $4, 'image/webp', 1024)`,
    [t.tenantId, outletId, mediaId, `legend-iiqx/${mediaId}.webp`],
  );
  return mediaId;
}

export async function removeTestTenant(t: TestTenant): Promise<void> {
  const statements: [string, unknown[]][] = [
    ["DELETE FROM core_storage_objects WHERE tenant_id = $1", [t.tenantId]],
    ["DELETE FROM outlets WHERE tenant_id = $1", [t.tenantId]],
    ["DELETE FROM legal_entities WHERE tenant_id = $1", [t.tenantId]],
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
