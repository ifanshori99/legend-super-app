// Menu master-data isolation at the database role (bead legend-lmk; TEN-01/02).
// Runs against the disposable test database as the migration owner (fixtures)
// and as the restricted legend_app login (checks). The generic catalog guard
// (db/rls.test.ts) proves every tenant table forces RLS; this file proves the
// menu tables actually isolate rows and refuse writes outside the tenant.
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";

const tenantA = cafeLegendFixtures.tenant.id;
const brandA = cafeLegendFixtures.brand.id;
const tenantB = randomUUID();
const brandB = randomUUID();
const entityB = randomUUID();
const categoryA = randomUUID();
const categoryB = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

async function asOwnerTenant(
  tenantId: string,
  run: (client: Client) => Promise<void>,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await run(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

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

describe("legend-lmk menu tenant isolation (TEN-01/02)", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    await asOwnerTenant(tenantB, async (client) => {
      await client.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         VALUES ($1, $2, 'Tenant Menu B', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
        [
          tenantB,
          `menu-b-${randomBytes(3).toString("hex")}`,
          JSON.stringify({
            maxOutlets: 1,
            maxActiveEmployees: 1,
            maxDevices: 1,
            aiRequestsPerMonth: 0,
            whatsappCostCapIdr: 0,
            aiCostCapIdr: 0,
            emailCostCapIdr: 0,
          }),
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand Menu B')`,
        [brandB, tenantB, `menu-brand-${randomBytes(3).toString("hex")}`],
      );
      await client.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Menu B', false)`,
        [entityB, tenantB],
      );
      await client.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Kategori B')`,
        [categoryB, tenantB, brandB],
      );
    });
    await asOwnerTenant(tenantA, async (client) => {
      await client.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Kategori A')`,
        [categoryA, tenantA, brandA],
      );
    });
  });

  afterAll(async () => {
    await asOwnerTenant(tenantA, async (client) => {
      await client.query("DELETE FROM menu_categories WHERE id = $1", [
        categoryA,
      ]);
    });
    await asOwnerTenant(tenantB, async (client) => {
      await client.query("DELETE FROM menu_categories WHERE tenant_id = $1", [
        tenantB,
      ]);
      await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
        tenantB,
      ]);
      await client.query("DELETE FROM brands WHERE tenant_id = $1", [tenantB]);
      await client.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
    });
    await appPool.end();
    await owner.end();
  });

  it("TEN-01 legend_app sees only the menu rows of its tenant", async () => {
    const visible = await asTenant(tenantA, (client) =>
      client.query<{ id: string }>(
        "SELECT id FROM menu_categories WHERE id = ANY($1::uuid[])",
        [[categoryA, categoryB]],
      ),
    );
    expect(visible.rows.map((row) => row.id)).toEqual([categoryA]);
    const foreign = await asTenant(tenantA, (client) =>
      client.query("SELECT id FROM menu_categories WHERE id = $1", [categoryB]),
    );
    expect(foreign.rowCount).toBe(0);
  });

  it("TEN-02 a menu query without tenant context is refused", async () => {
    await expect(
      asTenant(null, (client) => client.query("SELECT * FROM menu_categories")),
    ).rejects.toThrow();
  });

  it("TEN-02 a menu write cannot target another tenant", async () => {
    await expect(
      asTenant(tenantA, (client) =>
        client.query(
          `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Foreign')`,
          [randomUUID(), tenantB, brandB],
        ),
      ),
    ).rejects.toThrow();
  });
});
