// Reference guards on inventory setup deletes (legend-o1n1) and transitive
// recipe-cycle refusal on recipe version save (legend-kzn1). Written from
// packages/shared/src/inventory/{endpoints,errors}.ts, not from the services.
//
// Every scenario runs over HTTP in a tenant this file creates and removes.
//
// Assumptions where the spec is silent:
// - A conversion (item, from -> to) is "in use" when deleting it would leave a
//   unit that a recipe line (componentType 'item'), modifier rule component,
//   supplier price, purchase request / order line or goods receipt line uses
//   unable to reach the item base unit over the remaining conversions (both
//   directions). A redundant conversion whose units stay reachable never blocks.
// - An alternate link has no referencing table yet (nothing stores a reference
//   to an alternate row), so its delete is always allowed (204).
// - A blocked delete is 409 with code CONFLICT, the row stays; a successful
//   delete is 204 and the row is gone.
// - RECIPE_CYCLE is HTTP 422 with body.error.code "RECIPE_CYCLE".
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const slugA = `ref${randomUUID().slice(0, 8)}`;
const hostA = `tenant-${slugA}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp();
const createdUserIds: string[] = [];

const short = () => randomUUID().slice(0, 6);
const key = (prefix: string) => `${prefix}-${randomUUID()}`;

let admin: { client: ReturnType<typeof agent>; userId: string };
let gramId: string;
let cartonId: string;
let portionId: string;
let kgId: string;
let boxId: string;

// ------------------------------------------------------------ owner fixtures

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${short().slice(0, 4)}`.slice(0, 10)],
  );
  return rows[0]!.id;
}

async function insertItem(
  name: string,
  baseUomId: string,
  type: "raw_material" | "semi_finished" = "raw_material",
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', $3, $4, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, type, baseUomId],
  );
  return rows[0]!.id;
}

async function insertSupplier(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, created_by)
     VALUES ($1, $2, 7, $3) RETURNING id`,
    [tenantA, `Pemasok ${short()}`, admin.userId],
  );
  return rows[0]!.id;
}

/** A purchase order with one line of the item in the given unit. */
async function insertPurchaseOrderLine(
  itemId: string,
  uomId: string,
): Promise<void> {
  const supplierId = await insertSupplier();
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO purchase_orders (tenant_id, outlet_id, supplier_id, number, status, expected_date, subtotal_idr, tax_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, 'draft', '2031-01-01', 50000, 0, 50000, $5) RETURNING id`,
    [tenantA, outletA, supplierId, `PO-${short()}`, admin.userId],
  );
  await owner.query(
    `INSERT INTO purchase_order_lines (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity, uom_id, unit_price_idr, line_total_idr, line_no)
     VALUES ($1, $2, $3, $4, '1.0000', $5, '50000.0000', 50000, 1)`,
    [tenantA, outletA, rows[0]!.id, itemId, uomId],
  );
}

async function insertSupplierPrice(itemId: string, uomId: string) {
  await owner.query(
    `INSERT INTO supplier_prices (tenant_id, supplier_id, inventory_item_id, purchase_uom_id, price_idr, effective_from, created_by)
     VALUES ($1, $2, $3, $4, '50000.0000', '2031-01-01', $5)`,
    [tenantA, await insertSupplier(), itemId, uomId, admin.userId],
  );
}

/** A recipe that produces the item in the given yield unit, seeded directly. */
async function insertRecipeOutputting(
  outputItemId: string,
  yieldUomId: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, $4, '1.0000', $5, true, $6)`,
    [
      tenantA,
      brandA,
      `Resep Hasil ${short()}`,
      outputItemId,
      yieldUomId,
      admin.userId,
    ],
  );
}

/** A recipe holding one item line, seeded directly (fixture, not under test). */
async function insertRecipeWithItemLine(
  itemId: string,
  uomId: string,
): Promise<void> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, '1.0000', $4, true, $5) RETURNING id`,
    [tenantA, brandA, `Resep Uji ${short()}`, portionId, admin.userId],
  );
  await owner.query(
    `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
     VALUES ($1, $2, 0, 'item', $3, '1.0000', $4, 0)`,
    [tenantA, rows[0]!.id, itemId, uomId],
  );
}

// ------------------------------------------------------------------ HTTP

async function createConversion(
  itemId: string,
  fromUomId: string,
  toUomId: string,
  factor = "1000.0000",
): Promise<string> {
  const res = await admin.client
    .post(`/api/inventory/items/${itemId}/uom-conversions`)
    .set(originHeader)
    .send({
      fromUomId,
      toUomId,
      factor,
      idempotencyKey: key("uom"),
    });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.data.id as string;
}

async function createAlternate(
  itemId: string,
  alternateItemId: string,
): Promise<string> {
  const res = await admin.client
    .post(`/api/inventory/items/${itemId}/alternates`)
    .set(originHeader)
    .send({ alternateItemId, priority: 1, idempotencyKey: key("alt") });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.data.id as string;
}

const deleteConversion = (itemId: string, id: string) =>
  admin.client
    .delete(`/api/inventory/items/${itemId}/uom-conversions/${id}`)
    .set(originHeader);

const deleteAlternate = (itemId: string, id: string) =>
  admin.client
    .delete(`/api/inventory/items/${itemId}/alternates/${id}`)
    .set(originHeader);

async function rowExists(table: string, id: string): Promise<boolean> {
  const { rows } = await owner.query(`SELECT 1 FROM ${table} WHERE id = $1`, [
    id,
  ]);
  return rows.length === 1;
}

// -------------------------------------------------------------------- setup

async function createOwnTenant() {
  const fixtures = cafeLegendPlatformFixtures;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      tenantA,
      `tenant-${slugA}`,
      `Tenant ${slugA}`,
      JSON.stringify(fixtures.tenant.featureFlags),
      JSON.stringify(fixtures.tenant.limits),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandA, tenantA, `brand-${slugA}`, `Brand ${slugA}`],
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

async function dropOwnTenant() {
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
    for (const { table_name } of rows)
      await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
        tenantA,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantA]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createOwnTenant();
  const client = agent(app);
  await signUp(client, "Reference Owner");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
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
  gramId = await insertUom("g");
  cartonId = await insertUom("ctn");
  portionId = await insertUom("porsi");
  kgId = await insertUom("kg");
  boxId = await insertUom("box");
});

afterAll(async () => {
  await dropOwnTenant();
  await owner.end();
});

// ------------------------------------------------------------------- o1n1

describe("legend-o1n1 UOM conversion delete is refused while it keeps a used unit reachable", () => {
  it("legend-o1n1 an unused conversion deletes (204) and is gone", async () => {
    const item = await insertItem("Tepung Bebas", gramId);
    const conversionId = await createConversion(item, cartonId, gramId);
    const res = await deleteConversion(item, conversionId);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await rowExists("uom_conversions", conversionId)).toBe(false);
  });

  it("legend-o1n1 a conversion whose unit a recipe line uses is refused with 409 and stays", async () => {
    const item = await insertItem("Tepung Resep", gramId);
    const conversionId = await createConversion(item, cartonId, gramId);
    await insertRecipeWithItemLine(item, cartonId);
    const res = await deleteConversion(item, conversionId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(await rowExists("uom_conversions", conversionId)).toBe(true);
  });

  it("legend-o1n1 a conversion whose unit a supplier price uses is refused with 409 and stays", async () => {
    const item = await insertItem("Tepung Harga", gramId);
    const conversionId = await createConversion(item, cartonId, gramId);
    await insertSupplierPrice(item, cartonId);
    const res = await deleteConversion(item, conversionId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(await rowExists("uom_conversions", conversionId)).toBe(true);
  });

  it("legend-o1n1 usage of the same unit by ANOTHER item does not block this item's conversion", async () => {
    const item = await insertItem("Gula Bebas", gramId);
    const otherItem = await insertItem("Garam Dipakai", gramId);
    const conversionId = await createConversion(item, cartonId, gramId);
    await insertRecipeWithItemLine(otherItem, cartonId);
    await insertSupplierPrice(otherItem, cartonId);
    const res = await deleteConversion(item, conversionId);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await rowExists("uom_conversions", conversionId)).toBe(false);
  });
  it("legend-o1n1 a conversion whose unit a purchase order line uses is refused with 409 and stays", async () => {
    const item = await insertItem("Tepung Pesanan", gramId);
    const conversionId = await createConversion(item, cartonId, gramId);
    await insertPurchaseOrderLine(item, cartonId);
    const res = await deleteConversion(item, conversionId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(await rowExists("uom_conversions", conversionId)).toBe(true);
  });

  it("legend-o1n1 a chain kg -> g + box -> kg: deleting kg -> g strands the box a recipe uses (409)", async () => {
    const item = await insertItem("Beras Rantai", gramId);
    const kgToGram = await createConversion(item, kgId, gramId);
    await createConversion(item, boxId, kgId, "10.0000");
    await insertRecipeWithItemLine(item, boxId);
    const res = await deleteConversion(item, kgToGram);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(await rowExists("uom_conversions", kgToGram)).toBe(true);
  });

  it("legend-o1n1 a conversion that leaves every used unit reachable deletes (204)", async () => {
    // kg -> g and box -> kg; only kg is used, so box -> kg is not load-bearing
    // (it touches the used unit kg, which the old neighbour check blocked).
    const item = await insertItem("Beras Redundan", gramId);
    await createConversion(item, kgId, gramId);
    const boxToKg = await createConversion(item, boxId, kgId, "10.0000");
    await insertRecipeWithItemLine(item, kgId);
    await insertPurchaseOrderLine(item, kgId);
    const res = await deleteConversion(item, boxToKg);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await rowExists("uom_conversions", boxToKg)).toBe(false);
  });
});

describe("legend-o1n1 UOM conversion delete honours the recipe yield unit of the output item", () => {
  it("legend-o1n1 a conversion whose unit is the yield unit of a recipe outputting the item is refused (409); a base-unit yield deletes (204)", async () => {
    const mlId = await insertUom("ml");
    const bottleId = await insertUom("btl");
    const syrup = await insertItem("Sirup Hasil", mlId, "semi_finished");
    const conversionId = await createConversion(
      syrup,
      bottleId,
      mlId,
      "500.0000",
    );
    await insertRecipeOutputting(syrup, bottleId);
    const refused = await deleteConversion(syrup, conversionId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("CONFLICT");
    expect(await rowExists("uom_conversions", conversionId)).toBe(true);

    const syrupBase = await insertItem("Sirup Dasar", mlId, "semi_finished");
    const baseConversionId = await createConversion(
      syrupBase,
      bottleId,
      mlId,
      "500.0000",
    );
    await insertRecipeOutputting(syrupBase, mlId);
    const allowed = await deleteConversion(syrupBase, baseConversionId);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(204);
    expect(await rowExists("uom_conversions", baseConversionId)).toBe(false);
  });
});

describe("legend-o1n1 alternate link delete is not blocked: no table references an alternate row", () => {
  it("legend-o1n1 an unused alternate deletes (204) and is gone", async () => {
    const item = await insertItem("Susu Utama", gramId);
    const alternate = await insertItem("Susu Pengganti", gramId);
    const alternateId = await createAlternate(item, alternate);
    const res = await deleteAlternate(item, alternateId);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await rowExists("inventory_item_alternates", alternateId)).toBe(
      false,
    );
  });

  it("legend-o1n1 an alternate item that a recipe line also uses still deletes (204): the line references the item, not the link", async () => {
    const item = await insertItem("Mentega Utama", gramId);
    const alternate = await insertItem("Mentega Pengganti", gramId);
    const alternateId = await createAlternate(item, alternate);
    await insertRecipeWithItemLine(alternate, gramId);
    const res = await deleteAlternate(item, alternateId);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await rowExists("inventory_item_alternates", alternateId)).toBe(
      false,
    );
  });

  it("legend-o1n1 an alternate item that a supplier price also uses still deletes (204): the price references the item, not the link", async () => {
    const item = await insertItem("Telur Utama", gramId);
    const alternate = await insertItem("Telur Pengganti", gramId);
    const alternateId = await createAlternate(item, alternate);
    await insertSupplierPrice(alternate, gramId);
    const res = await deleteAlternate(item, alternateId);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await rowExists("inventory_item_alternates", alternateId)).toBe(
      false,
    );
  });
});

// ------------------------------------------------------------------- kzn1

describe("legend-kzn1 recipe version save refuses transitive cycles", () => {
  /** A semi-finished recipe (own output item), created over HTTP. */
  async function createSemiRecipe(name: string, leafItem: string) {
    const output = await insertItem(name, portionId, "semi_finished");
    const res = await admin.client
      .post("/api/inventory/recipes")
      .set(originHeader)
      .send({
        brandId: brandA,
        name: `${name} ${short()}`,
        outputItemId: output,
        yieldQuantity: "1.0000",
        yieldUomId: portionId,
        lines: [
          {
            componentType: "item",
            componentId: leafItem,
            quantity: "10.0000",
            uomId: gramId,
            wastePctBp: 0,
          },
        ],
        idempotencyKey: key("recipe"),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.recipe.id as string;
  }

  const recipeLine = (recipeId: string) => ({
    componentType: "recipe",
    componentId: recipeId,
    quantity: "1.0000",
    uomId: portionId,
    wastePctBp: 0,
  });

  const saveVersion = (recipeId: string, lines: unknown[]) =>
    admin.client
      .post(`/api/inventory/recipes/${recipeId}/versions`)
      .set(originHeader)
      .send({ lines, idempotencyKey: key("version") });

  it("legend-kzn1 A -> B is saved, then B -> A is refused with RECIPE_CYCLE (422)", async () => {
    const leaf = await insertItem("Daun", gramId);
    const a = await createSemiRecipe("Saus A", leaf);
    const b = await createSemiRecipe("Saus B", leaf);
    const aToB = await saveVersion(a, [recipeLine(b)]);
    expect(aToB.status, JSON.stringify(aToB.body)).toBeLessThan(300);
    const bToA = await saveVersion(b, [recipeLine(a)]);
    expect(bToA.status, JSON.stringify(bToA.body)).toBe(422);
    expect(bToA.body.error.code).toBe("RECIPE_CYCLE");
    // The refused save left B at version 1.
    const detail = await admin.client.get(`/api/inventory/recipes/${b}`);
    expect(detail.body.data.recipe.version).toBe(1);
  });

  it("legend-kzn1 A -> B -> C is saved, then C -> A is refused with RECIPE_CYCLE (422)", async () => {
    const leaf = await insertItem("Daun", gramId);
    const a = await createSemiRecipe("Dasar A", leaf);
    const b = await createSemiRecipe("Dasar B", leaf);
    const c = await createSemiRecipe("Dasar C", leaf);
    expect((await saveVersion(a, [recipeLine(b)])).status).toBeLessThan(300);
    expect((await saveVersion(b, [recipeLine(c)])).status).toBeLessThan(300);
    const cToA = await saveVersion(c, [recipeLine(a)]);
    expect(cToA.status, JSON.stringify(cToA.body)).toBe(422);
    expect(cToA.body.error.code).toBe("RECIPE_CYCLE");
  });

  it("legend-kzn1 a recipe that contains itself is refused with RECIPE_CYCLE (422)", async () => {
    const leaf = await insertItem("Daun", gramId);
    const a = await createSemiRecipe("Sendiri", leaf);
    const res = await saveVersion(a, [recipeLine(a)]);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe("RECIPE_CYCLE");
  });

  it("legend-kzn1 a non-cyclic chain and a shared sub-recipe (diamond) are saved", async () => {
    const leaf = await insertItem("Daun", gramId);
    const a = await createSemiRecipe("Atas", leaf);
    const b = await createSemiRecipe("Tengah B", leaf);
    const c = await createSemiRecipe("Tengah C", leaf);
    const d = await createSemiRecipe("Bawah", leaf);
    const bToD = await saveVersion(b, [recipeLine(d)]);
    expect(bToD.status, JSON.stringify(bToD.body)).toBeLessThan(300);
    const cToD = await saveVersion(c, [recipeLine(d)]);
    expect(cToD.status, JSON.stringify(cToD.body)).toBeLessThan(300);
    const aToBC = await saveVersion(a, [recipeLine(b), recipeLine(c)]);
    expect(aToBC.status, JSON.stringify(aToBC.body)).toBeLessThan(300);
    expect(aToBC.body.data.recipe.version).toBe(2);
  });
});
