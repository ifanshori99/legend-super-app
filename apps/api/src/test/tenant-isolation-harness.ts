// Shared two-tenant harness for the cross-tenant isolation suites
// (bead legend-wwsa; PRD v1.7 TEN-01, TEN-02, TEN-03). Tenant A is the seeded
// Cafe Legend tenant; tenant B is a throwaway tenant with its own brand, legal
// entity and outlet. Fixtures are written as the migration owner; every
// isolation check runs through the restricted legend_app login (RLS) or through
// the real service with a context minted for one tenant only.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { expect } from "vitest";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

export const tenantAId = cafeLegendPlatformFixtures.tenant.id;

export interface SecondTenant {
  tenantId: string;
  brandId: string;
  legalEntityId: string;
  outletId: string;
}

export function requireDisposableDatabase(): void {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
}

/** Migration-owner pool: writes fixtures, reads ground truth. Never for checks. */
export function createOwnerPool(): Pool {
  return new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 2,
  });
}

/** Restricted legend_app login: the role every tenant check must run as. */
export function createAppPool(): Pool {
  return new Pool({ connectionString: process.env.APP_DATABASE_URL, max: 2 });
}

/** Context a service receives for exactly one tenant (all of its outlets). */
export function tenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** Runs `run` inside a rolled-back legend_app transaction scoped to a tenant. */
export async function asTenant<T>(
  pool: Pool,
  tenantId: string | null,
  run: (client: PoolClient) => Promise<T>,
  outletIds: "*" | string[] = "*",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    if (tenantId !== null)
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenantId, outletIds === "*" ? "*" : JSON.stringify(outletIds)],
      );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Creates tenant B with a brand, legal entity and outlet. */
export async function createSecondTenant(
  owner: Pool,
  label: string,
): Promise<SecondTenant> {
  const tenant: SecondTenant = {
    tenantId: randomUUID(),
    brandId: randomUUID(),
    legalEntityId: randomUUID(),
    outletId: randomUUID(),
  };
  const suffix = randomBytes(4).toString("hex");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $4, $5)`,
    [
      tenant.tenantId,
      `uji-${label}-${suffix}`,
      `Isolation ${label} B`,
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
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')",
    [tenant.brandId, tenant.tenantId, `uji-${label}-${suffix}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Isolation B', false)",
    [tenant.legalEntityId, tenant.tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet B', 'Jl. B', '{}')`,
    [
      tenant.outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `ISO-${suffix}`.toUpperCase(),
    ],
  );
  return tenant;
}

/**
 * Removes tenant B's fixture rows. Module suites must delete their own child
 * rows first (children reference outlets and tenants).
 */
export async function removeSecondTenant(
  owner: Pool,
  tenant: SecondTenant,
): Promise<void> {
  await owner.query("DELETE FROM outlets WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM brands WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenant.tenantId]);
}

/**
 * Table-level RLS proof for one pair of rows: tenant A's row and tenant B's
 * row. Each tenant sees only its own row, and neither can update or delete the
 * other's row. `table` and `idColumn` are trusted test constants. `updateSet`
 * is a SQL assignment (e.g. "name = name || 'x'") that is valid for the table.
 */
export async function expectRowsIsolated(
  appPool: Pool,
  spec: {
    table: string;
    idColumn?: string;
    updateSet: string;
    /**
     * legend_app has no DELETE grant on the table (e.g. fiscal_periods, 0312):
     * the cross-tenant DELETE must then fail with 42501 instead of matching 0.
     */
    deleteRevoked?: boolean;
    tenantA: { tenantId: string; rowId: string };
    tenantB: { tenantId: string; rowId: string };
  },
  owner: Pool,
): Promise<void> {
  const col = spec.idColumn ?? "id";
  const both = [spec.tenantA.rowId, spec.tenantB.rowId];
  // Positive control: both rows really exist (owner bypasses RLS), so the
  // zero counts below cannot come from a wrong id, column or lost fixture.
  const present = await owner.query(
    `SELECT ${col}::text AS id FROM ${spec.table} WHERE ${col} = ANY($1::uuid[])`,
    [both],
  );
  expect(
    present.rows.map((row) => row.id).sort(),
    `${spec.table} fixture rows exist`,
  ).toEqual([...both].sort());
  const pairs = [
    [spec.tenantA, spec.tenantB],
    [spec.tenantB, spec.tenantA],
  ] as const;
  for (const [self, other] of pairs) {
    await asTenant(appPool, self.tenantId, async (client) => {
      const seen = await client.query<{ id: string }>(
        `SELECT ${col}::text AS id FROM ${spec.table} WHERE ${col} = ANY($1::uuid[])`,
        [both],
      );
      expect(
        seen.rows.map((row) => row.id),
        `${spec.table} read`,
      ).toEqual([self.rowId]);
      const updated = await client.query(
        `UPDATE ${spec.table} SET ${spec.updateSet} WHERE ${col} = $1`,
        [other.rowId],
      );
      expect(updated.rowCount, `${spec.table} update`).toBe(0);
      if (spec.deleteRevoked) {
        await client.query("SAVEPOINT delete_revoked");
        let code: string | undefined;
        try {
          await client.query(`DELETE FROM ${spec.table} WHERE ${col} = $1`, [
            other.rowId,
          ]);
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        expect(code, `${spec.table} delete is revoked`).toBe("42501");
        await client.query("ROLLBACK TO SAVEPOINT delete_revoked");
        return;
      }
      const deleted = await client.query(
        `DELETE FROM ${spec.table} WHERE ${col} = $1`,
        [other.rowId],
      );
      expect(deleted.rowCount, `${spec.table} delete`).toBe(0);
    });
  }
  // No tenant context at all: nothing is visible. Only the RLS-expected
  // errors (unset or invalid tenant setting) count as "sees nothing".
  await asTenant(appPool, null, async (client) => {
    let rowCount: number | null = null;
    try {
      rowCount = (
        await client.query(
          `SELECT 1 FROM ${spec.table} WHERE ${col} = ANY($1::uuid[])`,
          [both],
        )
      ).rowCount;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!["22P02", "42501", "42704"].includes(code ?? "")) throw error;
      rowCount = 0;
    }
    expect(rowCount, `${spec.table} without tenant`).toBe(0);
  });
}
