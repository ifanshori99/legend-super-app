// Menu -> recipe composite foreign key (bead legend-3kdd, brief 790 card B).
// menu_items, item_variants and modifiers each carry a nullable recipe_id. It
// must point at a recipe of the SAME tenant: (tenant_id, recipe_id) references
// recipes (tenant_id, id). Written from the menu endpoint contract
// (packages/shared/src/menu/endpoints.ts) and the brief, not from the services.
//
// Runs against the disposable PostgreSQL test database in two tenants this file
// creates (A is driven over HTTP, B only holds a foreign recipe) and removes.
//
// Assumptions where the spec is silent:
// - A recipe id from another tenant (or one that does not exist) sent on
//   create or update is refused with a 4xx (not 500) that carries an
//   `error.code`, and nothing is written. The exact status (400/404/409/422)
//   and code are not pinned.
// - recipe_id = null (sent or omitted) stays valid on all three tables.
// - Deleting a recipe that a menu item, variant or modifier still references
//   is refused by the database with foreign_key_violation 23503 (RESTRICT or
//   NO ACTION); there is no recipe delete endpoint, so this is proven on SQL.
//   Once the reference is cleared the recipe deletes normally.
// - A recipe of another brand of the same tenant is refused on menu items and
//   variants like a foreign one (recipes are brand-scoped; the edge delivers
//   them only to outlets of that brand). Modifiers are tenant-level and are not
//   tested for brand.
// - The FK's own cross-tenant rejection is proven with raw SQL (service bypassed)
//   so the constraint itself, not only the service check, is covered.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const brandA2 = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const tenantB = randomUUID();
const brandB = randomUUID();
const slugA = `mfk${randomUUID().slice(0, 8)}`;
const slugB = `mfk${randomUUID().slice(0, 8)}`;
const hostA = `tenant-${slugA}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp();

const short = () => randomUUID().slice(0, 6);

let admin: { client: ReturnType<typeof agent>; userId: string };
let categoryA: string;
let uomA: string;
let uomB: string;

// ------------------------------------------------------------ owner fixtures

/** Owner-side SQL under one tenant's RLS context (policies are FORCED). */
async function asTenant<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

async function insertRecipe(
  tenant: string,
  brand: string,
  yieldUom: string,
): Promise<string> {
  return asTenant(tenant, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
       VALUES ($1, $2, $3, NULL, '1.0000', $4, true, $5) RETURNING id`,
      [tenant, brand, `Resep FK ${short()}`, yieldUom, admin.userId],
    );
    return rows[0]!.id;
  });
}

/** Error code of a failed owner statement (pg puts SQLSTATE in `code`). */
async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

async function recipeIdOf(table: string, id: string): Promise<string | null> {
  const { rows } = await asTenant(tenantA, (client) =>
    client.query<{ recipe_id: string | null }>(
      `SELECT recipe_id FROM ${table} WHERE id = $1`,
      [id],
    ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.recipe_id;
}

async function countRows(table: string, name: string): Promise<number> {
  const { rows } = await asTenant(tenantA, (client) =>
    client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1 AND name = $2`,
      [tenantA, name],
    ),
  );
  return Number(rows[0]!.n);
}

// ------------------------------------------------------------------ HTTP

function dataOf(res: { body: unknown }): Record<string, unknown> {
  return (res.body as { data: Record<string, unknown> }).data;
}

function expectClientError(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
  const code = (res.body as { error?: { code?: unknown } }).error?.code;
  expect(typeof code).toBe("string");
}

async function createItem(extra: Record<string, unknown> = {}) {
  return admin.client
    .post("/api/menu/items")
    .set(originHeader)
    .send({
      brandId: brandA,
      categoryId: categoryA,
      name: `Item FK ${short()}`,
      ...extra,
    });
}

async function createVariant(
  itemId: string,
  extra: Record<string, unknown> = {},
) {
  return admin.client
    .post(`/api/menu/items/${itemId}/variants`)
    .set(originHeader)
    .send({ name: `Varian FK ${short()}`, ...extra });
}

async function createGroup(): Promise<string> {
  const res = await admin.client
    .post("/api/menu/modifier-groups")
    .set(originHeader)
    .send({ name: `Grup FK ${short()}`, minSelect: 0, maxSelect: 1 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return dataOf(res).id as string;
}

async function createModifier(
  groupId: string,
  extra: Record<string, unknown> = {},
) {
  return admin.client
    .post(`/api/menu/modifier-groups/${groupId}/modifiers`)
    .set(originHeader)
    .send({ name: `Modifier FK ${short()}`, priceIdr: 0, ...extra });
}

async function newItemId(): Promise<string> {
  const res = await createItem();
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return dataOf(res).id as string;
}

async function newVariantId(): Promise<string> {
  const res = await createVariant(await newItemId());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return dataOf(res).id as string;
}

async function newModifierId(): Promise<string> {
  const res = await createModifier(await createGroup());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return dataOf(res).id as string;
}

// -------------------------------------------------------------------- setup

async function insertTenant(
  id: string,
  slug: string,
  brand: string,
): Promise<void> {
  const fixtures = cafeLegendPlatformFixtures;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      id,
      `tenant-${slug}`,
      `Tenant ${slug}`,
      JSON.stringify(fixtures.tenant.featureFlags),
      JSON.stringify(fixtures.tenant.limits),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brand, id, `brand-${slug}`, `Brand ${slug}`],
  );
}

async function createTenants() {
  const fixtures = cafeLegendPlatformFixtures;
  await insertTenant(tenantA, slugA, brandA);
  await insertTenant(tenantB, slugB, brandB);
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandA2, tenantA, `brand2-${slugA}`, `Brand 2 ${slugA}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityA, tenantA, `Entity ${slugA}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
    [
      outletA,
      tenantA,
      brandA,
      legalEntityA,
      `R${slugA.slice(3)}`.toUpperCase(),
      `Outlet ${slugA}`,
      JSON.stringify(fixtures.outlets[0]!.openingHours),
    ],
  );
  for (const template of ROLE_TEMPLATES.filter((t) => t.level === "tenant"))
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7)`,
      [
        randomUUID(),
        tenantA,
        template.defaultName,
        template.key,
        JSON.stringify(template.permissions),
        template.mfaRequired,
        JSON.stringify(template.allowedScopeTypes),
      ],
    );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantA, brandA, hostA],
  );
}

async function insertUom(tenant: string, code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenant, `${code}${short().slice(0, 4)}`.slice(0, 10)],
  );
  return rows[0]!.id;
}

async function dropTenants() {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'`,
    );
    for (const tenant of [tenantA, tenantB]) {
      for (const { table_name } of rows)
        await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
          tenant,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [tenant]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let recipeA: string;
let recipeA2: string;
let recipeB: string;
let recipeOtherBrand: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createTenants();
  const client = agent(app);
  await signUp(client, "Menu FK Owner");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  client.set("Host", hostA);
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantA],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantA, userId, rows[0]!.id],
  );
  admin = { client, userId };

  uomA = await insertUom(tenantA, "cup");
  uomB = await insertUom(tenantB, "cup");
  recipeA = await insertRecipe(tenantA, brandA, uomA);
  recipeA2 = await insertRecipe(tenantA, brandA, uomA);
  recipeB = await insertRecipe(tenantB, brandB, uomB);
  recipeOtherBrand = await insertRecipe(tenantA, brandA2, uomA);

  const category = await client
    .post("/api/menu/categories")
    .set(originHeader)
    .send({ brandId: brandA, name: `Kategori FK ${short()}` });
  expect(category.status, JSON.stringify(category.body)).toBe(201);
  categoryA = dataOf(category).id as string;
});

afterAll(async () => {
  await dropTenants();
  await owner.query("DELETE FROM role_assignments WHERE user_id = $1", [
    admin.userId,
  ]);
  await owner.end();
});

// ---------------------------------------------------------------- the tests

const referencingTables = ["menu_items", "item_variants", "modifiers"] as const;

describe("legend-3kdd menu recipe composite foreign key in the database", () => {
  for (const table of referencingTables) {
    it(`legend-3kdd ${table} has a validated FK (tenant_id, recipe_id) -> recipes (tenant_id, id) that blocks recipe deletes`, async () => {
      const { rows } = await owner.query<{
        conname: string;
        convalidated: boolean;
        confdeltype: string;
        cols: string[];
        refcols: string[];
      }>(
        `SELECT con.conname, con.convalidated, con.confdeltype,
                (SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
                (SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS refcols
           FROM pg_constraint con
          WHERE con.contype = 'f'
            AND con.conrelid = $1::regclass
            AND con.confrelid = 'public.recipes'::regclass`,
        [`public.${table}`],
      );
      const composite = rows.filter(
        (row) =>
          row.cols.length === 2 &&
          row.cols[0] === "tenant_id" &&
          row.cols[1] === "recipe_id",
      );
      expect(composite, JSON.stringify(rows)).toHaveLength(1);
      const fk = composite[0]!;
      expect(fk.refcols).toEqual(["tenant_id", "id"]);
      expect(fk.convalidated).toBe(true);
      // 'a' = NO ACTION, 'r' = RESTRICT: a referenced recipe cannot be deleted,
      // and the menu row is never silently nulled or cascaded away.
      expect(["a", "r"]).toContain(fk.confdeltype);
    });
  }

  it("legend-3kdd the database itself refuses a recipe_id of another tenant on all three tables", async () => {
    const itemId = await newItemId();
    const variantId = await newVariantId();
    const modifierId = await newModifierId();
    for (const [table, id] of [
      ["menu_items", itemId],
      ["item_variants", variantId],
      ["modifiers", modifierId],
    ] as const) {
      const state = await sqlState(() =>
        asTenant(tenantA, (client) =>
          client.query(`UPDATE ${table} SET recipe_id = $1 WHERE id = $2`, [
            recipeB,
            id,
          ]),
        ),
      );
      expect(state, table).toBe("23503");
      expect(await recipeIdOf(table, id), table).toBeNull();
    }
  });

  it("legend-3kdd a recipe cannot be deleted while a menu item, variant or modifier references it, and can after", async () => {
    const itemId = await newItemId();
    const variantId = await newVariantId();
    const modifierId = await newModifierId();
    const targets = [
      ["menu_items", itemId],
      ["item_variants", variantId],
      ["modifiers", modifierId],
    ] as const;
    for (const [table, id] of targets) {
      const recipe = await insertRecipe(tenantA, brandA, uomA);
      await asTenant(tenantA, (client) =>
        client.query(`UPDATE ${table} SET recipe_id = $1 WHERE id = $2`, [
          recipe,
          id,
        ]),
      );
      const state = await sqlState(() =>
        asTenant(tenantA, (client) =>
          client.query("DELETE FROM recipes WHERE id = $1", [recipe]),
        ),
      );
      expect(state, table).toBe("23503");
      const stillThere = await asTenant(tenantA, (client) =>
        client.query("SELECT 1 FROM recipes WHERE id = $1", [recipe]),
      );
      expect(stillThere.rowCount, table).toBe(1);
      expect(await recipeIdOf(table, id), table).toBe(recipe);

      // Clearing the reference makes the recipe deletable again.
      await asTenant(tenantA, async (client) => {
        await client.query(
          `UPDATE ${table} SET recipe_id = NULL WHERE id = $1`,
          [id],
        );
        await client.query("DELETE FROM recipes WHERE id = $1", [recipe]);
      });
    }
  });
});

describe("legend-3kdd menu API validates the recipe belongs to the tenant", () => {
  it("legend-3kdd item: same-tenant recipe is accepted on create and update, null is accepted", async () => {
    const created = await createItem({ recipeId: recipeA });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = dataOf(created).id as string;
    expect(dataOf(created).recipeId).toBe(recipeA);
    expect(await recipeIdOf("menu_items", id)).toBe(recipeA);

    const moved = await admin.client
      .patch(`/api/menu/items/${id}`)
      .set(originHeader)
      .send({ recipeId: recipeA2 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await recipeIdOf("menu_items", id)).toBe(recipeA2);

    const cleared = await admin.client
      .patch(`/api/menu/items/${id}`)
      .set(originHeader)
      .send({ recipeId: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(await recipeIdOf("menu_items", id)).toBeNull();

    const withNull = await createItem({ recipeId: null });
    expect(withNull.status, JSON.stringify(withNull.body)).toBe(201);
    expect(dataOf(withNull).recipeId).toBeNull();
  });

  it("legend-3kdd item: a recipe of another tenant is refused with 4xx on create and update, nothing is written", async () => {
    const name = `Item Asing ${short()}`;
    const refused = await createItem({ name, recipeId: recipeB });
    expectClientError(refused);
    expect(await countRows("menu_items", name)).toBe(0);

    const id = await newItemId();
    const patched = await admin.client
      .patch(`/api/menu/items/${id}`)
      .set(originHeader)
      .send({ recipeId: recipeB });
    expectClientError(patched);
    expect(await recipeIdOf("menu_items", id)).toBeNull();
  });

  it("legend-3kdd item: a recipe id that does not exist is refused with 4xx, not 500", async () => {
    const refused = await createItem({ recipeId: randomUUID() });
    expectClientError(refused);
  });

  it("legend-3kdd item: a recipe of another brand of the same tenant is refused with 4xx on create and update", async () => {
    const name = `Item Brand Lain ${short()}`;
    const refused = await createItem({ name, recipeId: recipeOtherBrand });
    expectClientError(refused);
    expect(await countRows("menu_items", name)).toBe(0);

    const id = await newItemId();
    const patched = await admin.client
      .patch(`/api/menu/items/${id}`)
      .set(originHeader)
      .send({ recipeId: recipeOtherBrand });
    expectClientError(patched);
    expect(await recipeIdOf("menu_items", id)).toBeNull();
  });

  it("legend-3kdd variant: a recipe of another brand of the same tenant is refused with 4xx on create and update", async () => {
    const itemId = await newItemId();
    const name = `Varian Brand Lain ${short()}`;
    const refused = await createVariant(itemId, {
      name,
      recipeId: recipeOtherBrand,
    });
    expectClientError(refused);
    expect(await countRows("item_variants", name)).toBe(0);

    const ok = await createVariant(itemId, { recipeId: recipeA });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const variantId = dataOf(ok).id as string;
    const patched = await admin.client
      .patch(`/api/menu/variants/${variantId}`)
      .set(originHeader)
      .send({ recipeId: recipeOtherBrand });
    expectClientError(patched);
    expect(await recipeIdOf("item_variants", variantId)).toBe(recipeA);
  });

  it("legend-3kdd variant: same-tenant recipe and null are accepted, a foreign recipe is refused with 4xx", async () => {
    const itemId = await newItemId();

    const ok = await createVariant(itemId, { recipeId: recipeA });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const variantId = dataOf(ok).id as string;
    expect(await recipeIdOf("item_variants", variantId)).toBe(recipeA);

    const nulled = await createVariant(itemId, { recipeId: null });
    expect(nulled.status, JSON.stringify(nulled.body)).toBe(201);

    const name = `Varian Asing ${short()}`;
    const refused = await createVariant(itemId, { name, recipeId: recipeB });
    expectClientError(refused);
    expect(await countRows("item_variants", name)).toBe(0);

    const patched = await admin.client
      .patch(`/api/menu/variants/${variantId}`)
      .set(originHeader)
      .send({ recipeId: recipeB });
    expectClientError(patched);
    expect(await recipeIdOf("item_variants", variantId)).toBe(recipeA);

    const moved = await admin.client
      .patch(`/api/menu/variants/${variantId}`)
      .set(originHeader)
      .send({ recipeId: recipeA2 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await recipeIdOf("item_variants", variantId)).toBe(recipeA2);
  });

  it("legend-3kdd modifier: same-tenant recipe and null are accepted, a foreign recipe is refused with 4xx", async () => {
    const groupId = await createGroup();

    const ok = await createModifier(groupId, { recipeId: recipeA });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const modifierId = dataOf(ok).id as string;
    expect(await recipeIdOf("modifiers", modifierId)).toBe(recipeA);

    const nulled = await createModifier(groupId, { recipeId: null });
    expect(nulled.status, JSON.stringify(nulled.body)).toBe(201);

    const name = `Modifier Asing ${short()}`;
    const refused = await createModifier(groupId, { name, recipeId: recipeB });
    expectClientError(refused);
    expect(await countRows("modifiers", name)).toBe(0);

    const patched = await admin.client
      .patch(`/api/menu/modifiers/${modifierId}`)
      .set(originHeader)
      .send({ recipeId: recipeB });
    expectClientError(patched);
    expect(await recipeIdOf("modifiers", modifierId)).toBe(recipeA);

    const moved = await admin.client
      .patch(`/api/menu/modifiers/${modifierId}`)
      .set(originHeader)
      .send({ recipeId: null });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await recipeIdOf("modifiers", modifierId)).toBeNull();
  });
});
