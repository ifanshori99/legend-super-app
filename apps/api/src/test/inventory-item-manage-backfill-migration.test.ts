// legend-1ozj: data migration 0172 appends `inventory.item.manage` to the
// stored roles of tenants that existed before the code did: the owner and
// warehouse templates, and every custom role that holds
// `inventory.stock.receive` (the code that gated item writes before). The
// resolver reads the stored rows, so a template-only change left old tenants
// with 403 on item create/update. Also pins the FK of legend-tk7i. The role
// statements run as the migration owner, twice (idempotent), like the 0155 data
// test; the FK statements are proven by the catalog, since they already ran.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const NEW_CODE = "inventory.item.manage";
const RECEIVE = "inventory.stock.receive";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(6).toString("hex");
const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../drizzle/0172_inventory_item_manage_backfill.sql",
  ),
  "utf8",
);

afterAll(async () => {
  await owner.end();
});

/** Runs only the role statements; the FK statements ran with the schema. */
const migrate = async () => {
  for (const statement of migration.split("--> statement-breakpoint")) {
    const sql = statement.replace(/--.*$/gm, "").trim();
    if (sql && /\broles\b/.test(sql) && !/production_orders/.test(sql))
      await owner.query(statement);
  }
};

async function customRole(permissions: string[]): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, '["outlet"]'::jsonb)`,
    [id, tenantId, `Backfill ${unique()}`, JSON.stringify(permissions)],
  );
  return id;
}

const permissionsOf = async (id: string): Promise<string[]> =>
  (
    await owner.query<{ permissions: string[] }>(
      "SELECT permissions FROM roles WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    )
  ).rows[0]!.permissions;

/** Strips the new code from a stored template, as a pre-0172 tenant has it. */
async function legacyTemplate(key: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `UPDATE roles SET permissions = permissions - '${NEW_CODE}'
     WHERE tenant_id = $1 AND is_template AND template_key = $2 RETURNING id`,
    [tenantId, key],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

describe("legend-1ozj inventory.item.manage backfill migration", () => {
  it("adds the code to the owner and warehouse templates, twice over, once", async () => {
    const ownerId = await legacyTemplate("owner");
    const warehouseId = await legacyTemplate("warehouse");
    expect(await permissionsOf(warehouseId)).not.toContain(NEW_CODE);

    await migrate();
    await migrate();

    for (const id of [ownerId, warehouseId]) {
      const permissions = await permissionsOf(id);
      expect(permissions.filter((code) => code === NEW_CODE)).toHaveLength(1);
    }
    expect(await permissionsOf(warehouseId)).toContain(RECEIVE);
  });

  it("adds the code to a custom role holding stock.receive, keeping the rest", async () => {
    const holder = await customRole(["inventory.stock.view", RECEIVE]);

    await migrate();

    expect(await permissionsOf(holder)).toEqual([
      "inventory.stock.view",
      RECEIVE,
      NEW_CODE,
    ]);
  });

  it("leaves a custom role without stock.receive untouched", async () => {
    const viewer = await customRole(["inventory.stock.view"]);

    await migrate();

    expect(await permissionsOf(viewer)).toEqual(["inventory.stock.view"]);
  });

  it("does not duplicate the code on a role that already holds it", async () => {
    const already = await customRole([RECEIVE, NEW_CODE]);

    await migrate();

    expect(await permissionsOf(already)).toEqual([RECEIVE, NEW_CODE]);
  });

  it("legend-tk7i: production_orders.recipe_id has a validated tenant-scoped FK to recipes", async () => {
    const { rows } = await owner.query<{
      def: string;
      validated: boolean;
    }>(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated
       FROM pg_constraint
       WHERE conname = 'production_orders_recipe_fk'
         AND conrelid = 'public.production_orders'::regclass`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.validated).toBe(true);
    expect(rows[0]!.def).toMatch(
      /FOREIGN KEY \(tenant_id, recipe_id\) REFERENCES recipes\(tenant_id, id\)/,
    );
  });
});
