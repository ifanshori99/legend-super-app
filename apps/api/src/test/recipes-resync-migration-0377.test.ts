// Migration 0377_recipes_resync_edges.sql (bead legend-2uqcd): re-stamps the
// cloud rows of recipes, menu_items and item_variants so that every edge pulls
// them again (all recipes of the tenant, correct recipe_id links). Written from
// the brief ("data only, cloud only, touch updated_at so the 0262 trigger
// writes a fresh sync_txid; skip when legend.edge_mode=on"), not from the SQL.
//
// Assumptions:
//  - The file is applied by running its statements (split on the drizzle
//    statement breakpoint) as the database owner in one transaction.
//  - A fresh stamp is a strictly greater `sync_txid` (compared as BigInt).
//  - `updated_at` (the real last-modified time) and the business values do not
//    change.
//  - On an edge database (`legend.edge_mode` = on) nothing is re-stamped.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const file = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle/0377_recipes_resync_edges.sql",
);
const statements = readFileSync(file, "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantId = randomUUID();
const brandId = randomUUID();
const ids = {
  user: randomUUID(),
  uom: randomUUID(),
  category: randomUUID(),
  recipe: randomUUID(),
  item: randomUUID(),
  variant: randomUUID(),
};
const OLD = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));

async function runMigration(edgeMode: boolean) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (edgeMode)
      await client.query("SELECT set_config('legend.edge_mode', 'on', true)");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function stamps() {
  const read = async (table: string, rowId: string) => {
    const { rows } = await owner.query(
      `SELECT sync_txid::text AS txid, updated_at FROM ${table} WHERE id = $1`,
      [rowId],
    );
    return {
      txid: BigInt(rows[0].txid as string),
      updatedAt: rows[0].updated_at as Date,
    };
  };
  return {
    recipes: await read("recipes", ids.recipe),
    menu_items: await read("menu_items", ids.item),
    item_variants: await read("item_variants", ids.variant),
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const q = (text: string, params: unknown[]) => owner.query(text, params);
  await q(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant migrasi 0377', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants ORDER BY created_at LIMIT 1`,
    [tenantId, `mig0377-${tenantId}`, "test"],
  );
  await q(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1,$2,'uji','Uji')`,
    [brandId, tenantId],
  );
  await q(`INSERT INTO "user" (id, name, email) VALUES ($1,'Penulis',$2)`, [
    ids.user,
    `${ids.user}@mig.example.test`,
  ]);
  await q(
    `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1,$2,'u0377','u0377')`,
    [ids.uom, tenantId],
  );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order, updated_at) VALUES ($1,$2,$3,'Kat',0,$4)`,
    [ids.category, tenantId, brandId, OLD],
  );
  await q(
    `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by, updated_at)
     VALUES ($1,$2,$3,'Resep 0377',NULL,'1.0000',$4,true,$5,$6)`,
    [ids.recipe, tenantId, brandId, ids.uom, ids.user, OLD],
  );
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, updated_at) VALUES ($1,$2,$3,$4,'Menu 0377',true,$5)`,
    [ids.item, tenantId, brandId, ids.category, OLD],
  );
  await q(
    `INSERT INTO item_variants (id, tenant_id, menu_item_id, name, updated_at) VALUES ($1,$2,$3,'Besar',$4)`,
    [ids.variant, tenantId, ids.item, OLD],
  );
}, 60_000);

afterAll(async () => {
  try {
    for (const [table, key] of [
      ["item_variants", ids.variant],
      ["menu_items", ids.item],
      ["menu_categories", ids.category],
      ["recipes", ids.recipe],
      ["uoms", ids.uom],
    ] as const)
      await owner.query(`DELETE FROM ${table} WHERE id = $1`, [key]);
    await owner.query("DELETE FROM brands WHERE id = $1", [brandId]);
    await owner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await owner.query(`DELETE FROM "user" WHERE id = $1`, [ids.user]);
  } catch {
    // Best effort: private ids.
  }
  await owner.end();
});

describe("legend-2uqcd migration 0377 re-stamps catalog rows for the edges", () => {
  it("legend-2uqcd-f on the cloud it raises sync_txid of recipes, menu_items and item_variants, and keeps updated_at", async () => {
    const before = await stamps();
    await runMigration(false);
    const after = await stamps();
    for (const table of ["recipes", "menu_items", "item_variants"] as const) {
      expect(after[table].txid, table).toBeGreaterThan(before[table].txid);
      expect(after[table].updatedAt.getTime(), table).toBe(
        before[table].updatedAt.getTime(),
      );
    }
  });

  it("legend-2uqcd-f running it again stamps again (idempotent) and FORCE RLS is back on", async () => {
    const before = await stamps();
    await runMigration(false);
    const after = await stamps();
    expect(after.recipes.txid).toBeGreaterThan(before.recipes.txid);
    const { rows } = await owner.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname IN ('recipes','menu_items','item_variants') AND relkind = 'r'`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(row.relforcerowsecurity, row.relname).toBe(true);
  });

  it("legend-2uqcd-f on an edge database (legend.edge_mode=on) no fresh stamp: sync_txid goes to 0 and updated_at stays (details: recipes-resync-migration-0377-edge.test.ts)", async () => {
    const before = await stamps();
    await runMigration(true);
    const after = await stamps();
    for (const table of ["recipes", "menu_items", "item_variants"] as const) {
      expect(after[table].txid, table).toBe(0n);
      expect(after[table].updatedAt, table).toEqual(before[table].updatedAt);
    }
  });
});
