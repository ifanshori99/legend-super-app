// TEN-01/TEN-02 database-role isolation for the tax tables (PRD §6.C
// `tax_rules` / `service_charge_rules`, bead legend-559). The runtime login is
// a member of legend_app (no BYPASSRLS); with app.tenant_id = tenant A it must
// not see, change or delete tenant B's rows, and the composite foreign keys
// stop a privileged writer from crossing tenants.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const brandB = randomUUID();
const legalEntityB = randomUUID();
const outletB = randomUUID();
const ruleB = randomUUID();
const serviceB = randomUUID();
const settingsB = randomUUID();
const snapshotB = randomUUID();
const person = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
});
const app = new Pool({ connectionString: process.env.APP_DATABASE_URL });

/** DDL rows need the tenant context because every table is FORCE RLS. */
async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function asAppTenant<T>(
  tenantId: string,
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tax RLS tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantB, `tax-rls-${tenantB}`, person],
  );
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Tax RLS', $2)`,
    [person, `${person}@example.test`],
  );
  await asOwnerTenant(tenantB, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [brandB, tenantB],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [legalEntityB, tenantB],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [outletB, tenantB, brandB, legalEntityB],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-B', 'PBJT B', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ruleB, tenantB, person],
    );
    await client.query(
      `INSERT INTO service_charge_rules
         (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes, is_active,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'SC-B', 'Service B', 500, NULL, '[]',
               '["food_beverage"]', true, 1, '2026-01-01', 'published', now(), $3)`,
      [serviceB, tenantB, person],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [settingsB, tenantB, person],
    );
    await client.query(
      `INSERT INTO tax_snapshots
         (id, tenant_id, outlet_id, source_type, source_id, business_date, tax_rule_id, tax_rule_code,
          tax_rule_version, tax_type, rate_bp, price_includes_tax, gross_idr, tax_base_idr,
          service_charge_idr, tax_idr)
       VALUES ($1, $2, $3, 'order', $4, '2026-11-02', $5, 'PBJT-B', 1, 'pbjt', 1000, false,
               100000, 100000, 0, 10000)`,
      [snapshotB, tenantB, outletB, randomUUID(), ruleB],
    );
  });
});

afterAll(async () => {
  await asOwnerTenant(tenantB, async (client) => {
    await client.query("DELETE FROM tax_snapshots WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query("DELETE FROM tax_settings WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query(
      "DELETE FROM service_charge_rules WHERE tenant_id = $1",
      [tenantB],
    );
    await client.query("DELETE FROM tax_rules WHERE tenant_id = $1", [tenantB]);
    await client.query("DELETE FROM outlets WHERE tenant_id = $1", [tenantB]);
    await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query("DELETE FROM brands WHERE tenant_id = $1", [tenantB]);
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.query('DELETE FROM "user" WHERE id = $1', [person]);
  await owner.end();
  await app.end();
});

const tables = [
  ["tax_rules", ruleB],
  ["service_charge_rules", serviceB],
  ["tax_settings", settingsB],
  ["tax_snapshots", snapshotB],
] as const;

describe("TEN-01 tax tables force RLS for the application role", () => {
  for (const [table, id] of tables) {
    it(`TEN-01 denies tenant A reading or deleting tenant B ${table}`, async () => {
      const visible = await asAppTenant(tenantA, (client) =>
        client.query(`SELECT id FROM ${table} WHERE id = $1`, [id]),
      );
      expect(visible.rowCount).toBe(0);
      const deleted = await asAppTenant(tenantA, (client) =>
        client.query(`DELETE FROM ${table} WHERE id = $1`, [id]),
      );
      expect(deleted.rowCount).toBe(0);
      const updated = await asAppTenant(tenantA, (client) =>
        client.query(
          `UPDATE ${table} SET tenant_id = tenant_id WHERE id = $1`,
          [id],
        ),
      );
      expect(updated.rowCount).toBe(0);
    });

    it(`TEN-02 refuses writing a tenant B ${table} row under tenant A`, async () => {
      // Every INSERT below keeps the row in tenant B; the WITH CHECK clause of
      // tenant_isolation must reject it while app.tenant_id is tenant A.
      const insert = async (client: import("pg").PoolClient) => {
        switch (table) {
          case "tax_rules":
            return client.query(
              `INSERT INTO tax_rules
                 (id, tenant_id, code, name, tax_type, rate_bp, channels, applies_to,
                  price_includes_tax, include_service_in_base, is_active, version, effective_from, status)
               VALUES ($1, $2, 'PBJT-X', 'X', 'pbjt', 1000, '[]',
                       '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
                       false, true, true, 1, '2026-01-01', 'draft')`,
              [randomUUID(), tenantB],
            );
          case "service_charge_rules":
            return client.query(
              `INSERT INTO service_charge_rules
                 (id, tenant_id, code, name, rate_bp, order_types, item_classes, is_active,
                  version, effective_from, status)
               VALUES ($1, $2, 'SC-X', 'X', 500, '[]', '["food_beverage"]', true, 1, '2026-01-01', 'draft')`,
              [randomUUID(), tenantB],
            );
          case "tax_settings":
            return client.query(
              `INSERT INTO tax_settings
                 (id, tenant_id, calculation_order, prices_include_tax, service_rounding_mode,
                  tax_rounding_mode, inclusive_base_rounding_mode, package_allocation, version,
                  effective_from, status)
               VALUES ($1, $2, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up',
                       'fixed_bp', 2, '2026-01-01', 'draft')`,
              [randomUUID(), tenantB],
            );
          case "tax_snapshots":
            return client.query(
              `INSERT INTO tax_snapshots
                 (id, tenant_id, outlet_id, source_type, source_id, business_date, tax_rule_id,
                  tax_rule_code, tax_rule_version, tax_type, rate_bp, price_includes_tax,
                  gross_idr, tax_base_idr, service_charge_idr, tax_idr)
               VALUES ($1, $2, $3, 'order', $4, '2026-11-02', $5, 'PBJT-B', 1, 'pbjt', 1000, false,
                       1, 1, 0, 0)`,
              [randomUUID(), tenantB, outletB, randomUUID(), ruleB],
            );
        }
      };
      await expect(asAppTenant(tenantA, insert)).rejects.toThrow();
    });
  }
});
