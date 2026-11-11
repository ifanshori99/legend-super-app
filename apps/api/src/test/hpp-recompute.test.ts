// Incremental HPP recompute (bead legend-2qq; PRD v1.7 §17 "HPP Menu
// beserta margin kotor", "Kelengkapan Resep", INV-02, INV-03 moving average;
// rule "jangan sampai rugi": a cost is never understated).
//
// Runs against the disposable PostgreSQL test database in a tenant this file
// creates (plus a throwaway second tenant for the isolation case) and removes
// again. Stock is received through the real `recordStockMovement`; the
// recompute runs through the real job tick `runHppRecomputeJob`.
//
// Assumptions where the spec/design is silent:
// - Signatures follow the design: `enqueueHppRecompute(tx, { tenantId,
//   outletId, itemIds })`, `rebuildMenuCostsForOutlet(context, outletId)`
//   (opens its own tenant transaction) and `runHppRecomputeJob(context)` with a
//   tenant context, as `runInventoryParAlertJob` does. One tick drains the
//   whole queue of that tenant (no second tick needed).
// - Tables `menu_costs` and `hpp_recompute_queue` use the column names of the
//   design (menu_item_id, variant_id, modifier_id, recipe_id, recipe_complete,
//   theoretical_cost_idr, price_idr, gross_margin_bp, computed_at; tenant_id,
//   outlet_id, item_id, enqueued_at).
// - Every test runs in its own outlet (own sale location) so tests do not see
//   each other's stock; menu items are tenant-wide, so assertions filter by
//   menu item id.
// - Cost per portion = sum of (gross quantity x avg cost at the outlet's sale
//   location), a recipe line of a recipe WITHOUT an output item is exploded,
//   one WITH an output item is drawn as that semi-finished item (as in the
//   sale deduction, see recipe-bom.test.ts).
// - A component with no stock row or an average cost of 0 makes the recipe
//   incomplete: complete = false, cost NULL, margin NULL, recipe_id kept.
// - Price = outlet price list (channel dine_in) item price; no price found
//   gives price 0 and margin 0.
// - Enqueue happens when a stock write changes `avg_cost_idr` (old != new),
//   including the first receipt into an empty balance.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decimal4,
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  enqueueHppRecompute,
  rebuildMenuCostsForOutlet,
} from "../services/hpp-recompute.service.ts";
import { runHppRecomputeJob } from "../worker/hpp-recompute.job.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createAppPool,
  createSecondTenant,
  expectRowsIsolated,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const slugA = `hpp${randomUUID().slice(0, 8)}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const appPool = createAppPool();
const short = () => randomUUID().slice(0, 6);

let ownerUserId: string;
let gramId: string;
let mlId: string;
let cupId: string;
let portionId: string;
let categoryId: string;
let tenantB: SecondTenant | null = null;

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantA),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

// ------------------------------------------------------------ owner fixtures

/** Owner-side access sets the tenant local: RLS is FORCED on these tables. */
async function ownerTx<T>(
  run: (client: PoolClient) => Promise<T>,
  tenantId: string = tenantA,
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

async function q<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  tenantId: string = tenantA,
): Promise<T[]> {
  return ownerTx(
    async (client) => (await client.query<T>(sql, params)).rows,
    tenantId,
  );
}

async function one<T>(
  sql: string,
  params: unknown[],
  tenantId: string = tenantA,
): Promise<T> {
  const rows = await q<{ id: T }>(sql, params, tenantId);
  return rows[0]!.id;
}

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
  await q(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandA, tenantA, `brand-${slugA}`, `Brand ${slugA}`],
  );
  await q(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityA, tenantA, `Entity ${slugA}`],
  );
}

/** Removes every row a tenant owns (the stock ledger is append-only), then it. */
async function purgeTenant(tenantId: string) {
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
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Outlet = { id: string; location: string };

/** A fresh outlet with its own sale location, configured as the sale location. */
async function newOutlet(): Promise<Outlet> {
  const id = randomUUID();
  await q(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
    [
      id,
      tenantA,
      brandA,
      legalEntityA,
      `H${randomUUID().slice(0, 10)}`.toUpperCase(),
      `Outlet HPP ${short()}`,
      JSON.stringify(cafeLegendPlatformFixtures.outlets[0]!.openingHours),
    ],
  );
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenantA, id, `Bar HPP ${short()}`],
  );
  await q(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)`,
    [tenantA, id, location],
  );
  return { id, location };
}

async function insertItem(
  name: string,
  baseUomId: string,
  type: "raw_material" | "semi_finished" = "raw_material",
): Promise<string> {
  return one<string>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', $3, $4, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, type, baseUomId],
  );
}

/** A goods receipt through the real service; it moves the average cost. */
async function receive(
  outlet: Outlet,
  itemId: string,
  quantity: string,
  unitCost: string,
) {
  await recordStockMovement(tenantContext(), {
    outletId: outletIdSchema.parse(outlet.id) as OutletId,
    locationId: outlet.location,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  } as never);
}

async function avgCostOf(outlet: Outlet, itemId: string): Promise<string> {
  const rows = await q<{ avg: string }>(
    "SELECT avg_cost_idr::text AS avg FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, outlet.location, itemId],
  );
  return rows[0]!.avg;
}

type RecipeLineSeed = {
  type?: "item" | "recipe";
  id: string;
  qty: string;
  uom: string;
};

async function insertRecipe(input: {
  name: string;
  yieldUomId: string;
  yieldQuantity?: string;
  outputItemId?: string | null;
  lines: RecipeLineSeed[];
}): Promise<string> {
  const recipeId = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
    [
      tenantA,
      brandA,
      `${input.name} ${short()}`,
      input.outputItemId ?? null,
      input.yieldQuantity ?? "1.0000",
      input.yieldUomId,
      ownerUserId,
    ],
  );
  for (const [index, line] of input.lines.entries())
    await q(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [
        tenantA,
        recipeId,
        index,
        line.type ?? "item",
        line.id,
        line.qty,
        line.uom,
      ],
    );
  return recipeId;
}

async function insertMenuItem(
  name: string,
  recipeId: string | null,
): Promise<string> {
  return one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantA, brandA, categoryId, `${name} ${short()}`, recipeId],
  );
}

async function insertVariant(
  menuItemId: string,
  name: string,
  recipeId: string | null,
): Promise<string> {
  return one<string>(
    "INSERT INTO item_variants (tenant_id, menu_item_id, name, recipe_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantA, menuItemId, `${name} ${short()}`, recipeId],
  );
}

async function setPrice(outlet: Outlet, menuItemId: string, priceIdr: number) {
  const listId = randomUUID();
  await q(
    `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
     VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
    [listId, tenantA, outlet.id],
  );
  await q(
    `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), tenantA, listId, menuItemId, priceIdr],
  );
}

/**
 * A Latte (18 g beans at Rp100 + 200 ml milk at Rp20 = Rp5.800 per cup) with
 * its stock received into the outlet's sale location.
 */
async function buildKit(outlet: Outlet) {
  const beans = await insertItem("Biji Kopi", gramId);
  const milk = await insertItem("Susu", mlId);
  await receive(outlet, beans, "1000.0000", "100.0000");
  await receive(outlet, milk, "10000.0000", "20.0000");
  const recipe = await insertRecipe({
    name: "Latte",
    yieldUomId: cupId,
    lines: [
      { id: beans, qty: "18.0000", uom: gramId },
      { id: milk, qty: "200.0000", uom: mlId },
    ],
  });
  const menuItem = await insertMenuItem("Latte", recipe);
  return { beans, milk, recipe, menuItem };
}

// ------------------------------------------------------------------- readers

type CostRow = {
  menu_item_id: string;
  variant_id: string | null;
  recipe_id: string | null;
  recipe_complete: boolean;
  cost: string | null;
  price: string;
  gross_margin_bp: number | null;
  computed_at: string;
};

async function costRows(
  outlet: Outlet,
  menuItemId: string,
): Promise<CostRow[]> {
  return q<CostRow>(
    `SELECT menu_item_id::text, variant_id::text, recipe_id::text, recipe_complete,
            theoretical_cost_idr::text AS cost, price_idr::text AS price,
            gross_margin_bp, computed_at::text AS computed_at
       FROM menu_costs
      WHERE tenant_id = $1 AND outlet_id = $2 AND menu_item_id = $3
      ORDER BY variant_id NULLS FIRST`,
    [tenantA, outlet.id, menuItemId],
  );
}

/** The one row of the menu item itself (no variant, no modifier). */
async function costOf(outlet: Outlet, menuItemId: string): Promise<CostRow> {
  const rows = (await costRows(outlet, menuItemId)).filter(
    (row) => row.variant_id === null,
  );
  expect(rows, "one menu_costs row for the menu item").toHaveLength(1);
  return rows[0]!;
}

async function queueOf(outlet: Outlet): Promise<string[]> {
  const rows = await q<{ item_id: string }>(
    "SELECT item_id::text FROM hpp_recompute_queue WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY item_id",
    [tenantA, outlet.id],
  );
  return rows.map((row) => row.item_id);
}

async function clearQueue(outlet: Outlet) {
  await q(
    "DELETE FROM hpp_recompute_queue WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantA, outlet.id],
  );
}

async function tenantQueueSize(): Promise<number> {
  const rows = await q<{ n: number }>(
    "SELECT count(*)::int AS n FROM hpp_recompute_queue WHERE tenant_id = $1",
    [tenantA],
  );
  return rows[0]!.n;
}

/** Full first fill, then an empty queue: the state before an incremental change. */
async function baseline(outlet: Outlet) {
  await rebuildMenuCostsForOutlet(
    tenantContext(),
    outletIdSchema.parse(outlet.id),
  );
  await clearQueue(outlet);
}

async function tick() {
  // `force` skips the 60 s per-tenant throttle so back-to-back ticks in one
  // test all run (the throttle itself is not under test here).
  await runHppRecomputeJob(tenantContext(), new Date(), { force: true });
}

// --------------------------------------------------------------------- setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createOwnTenant();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "HPP Recompute Owner", `${ownerUserId}@example.com`],
  );
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  mlId = await uom("ml");
  cupId = await uom("cup");
  portionId = await uom("porsi");
  categoryId = randomUUID();
  await q(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'HPP Uji', 0)",
    [categoryId, tenantA, brandA],
  );
});

afterAll(async () => {
  if (tenantB) await purgeTenant(tenantB.tenantId);
  await purgeTenant(tenantA);
  await owner.end();
  await appPool.end();
});

// ===========================================================================

describe("HPP-RECOMPUTE enqueue on average cost change", () => {
  it("HPP-RECOMPUTE-enqueue a receipt that moves the average cost queues that item for the outlet", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await clearQueue(outlet);

    // 1.000 g at Rp100 + 1.000 g at Rp300 = average Rp200: changed.
    await receive(outlet, kit.beans, "1000.0000", "300.0000");
    expect(await avgCostOf(outlet, kit.beans)).toBe("200.0000");
    expect(await queueOf(outlet)).toEqual([kit.beans]);
  });

  it("HPP-RECOMPUTE-enqueue a receipt at the current average cost queues nothing", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await clearQueue(outlet);

    await receive(outlet, kit.beans, "500.0000", "100.0000");
    await receive(outlet, kit.milk, "500.0000", "20.0000");
    expect(await avgCostOf(outlet, kit.beans)).toBe("100.0000");
    expect(await queueOf(outlet)).toEqual([]);
  });

  it("HPP-RECOMPUTE-enqueue the first receipt of an item queues it", async () => {
    const outlet = await newOutlet();
    const item = await insertItem("Bahan Baru", gramId);
    await receive(outlet, item, "100.0000", "50.0000");
    expect(await queueOf(outlet)).toEqual([item]);
  });

  it("HPP-RECOMPUTE-enqueue queueing the same item twice keeps one queue row", async () => {
    const outlet = await newOutlet();
    const item = await insertItem("Bahan Dobel", gramId);
    for (let round = 0; round < 2; round += 1)
      await withTenant(db, tenantContext(), (tx) =>
        enqueueHppRecompute(tx, {
          tenantId: tenantIdSchema.parse(tenantA),
          outletId: outletIdSchema.parse(outlet.id),
          itemIds: [item],
        } as never),
      );
    expect(await queueOf(outlet)).toEqual([item]);
  });

  it("HPP-RECOMPUTE-enqueue joins the caller's transaction: a rolled back caller leaves nothing queued", async () => {
    const outlet = await newOutlet();
    const item = await insertItem("Bahan Batal", gramId);
    await expect(
      withTenant(db, tenantContext(), async (tx) => {
        await enqueueHppRecompute(tx, {
          tenantId: tenantIdSchema.parse(tenantA),
          outletId: outletIdSchema.parse(outlet.id),
          itemIds: [item],
        } as never);
        throw new Error("rollback on purpose");
      }),
    ).rejects.toThrow("rollback on purpose");
    expect(await queueOf(outlet)).toEqual([]);
  });
});

describe("HPP-RECOMPUTE job updates the affected menu costs", () => {
  it("HPP-RECOMPUTE-first-fill a full rebuild writes the theoretical cost of a complete recipe", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);

    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_id: kit.recipe,
      recipe_complete: true,
      cost: "5800.0000",
    });
  });

  it("HPP-RECOMPUTE-job an ingredient cost change is reflected in the menu cost after one tick, and the queue is drained", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);

    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // avg 200
    expect(await tenantQueueSize()).toBeGreaterThan(0);
    await tick();

    // 18 x 200 + 200 x 20 = 7.600
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "7600.0000",
    });
    expect(await queueOf(outlet)).toEqual([]);
    expect(await tenantQueueSize()).toBe(0);
  });

  it("HPP-RECOMPUTE-job recomputes only the menu items, variants and recipes that use the changed item", async () => {
    const outlet = await newOutlet();
    const kit1 = await buildKit(outlet);
    const kit2 = await buildKit(outlet);
    // A variant of kit1 with its own recipe that also uses kit1's beans.
    const largeRecipe = await insertRecipe({
      name: "Latte Large",
      yieldUomId: cupId,
      lines: [
        { id: kit1.beans, qty: "18.0000", uom: gramId },
        { id: kit1.milk, qty: "300.0000", uom: mlId },
      ],
    });
    const large = await insertVariant(kit1.menuItem, "Large", largeRecipe);
    await baseline(outlet);
    const untouchedBefore = await costOf(outlet, kit2.menuItem);
    expect(untouchedBefore.cost).toBe("5800.0000");
    const variantBefore = (await costRows(outlet, kit1.menuItem)).find(
      (row) => row.variant_id === large,
    );
    // 18 x 100 + 300 x 20 = 7.800
    expect(variantBefore).toMatchObject({ cost: "7800.0000" });

    await receive(outlet, kit1.beans, "1000.0000", "300.0000"); // avg 200
    await tick();

    expect(await costOf(outlet, kit1.menuItem)).toMatchObject({
      cost: "7600.0000",
    });
    // 18 x 200 + 300 x 20 = 9.600
    expect(
      (await costRows(outlet, kit1.menuItem)).find(
        (row) => row.variant_id === large,
      ),
    ).toMatchObject({ cost: "9600.0000", recipe_complete: true });
    // The other menu item uses other items: same cost, row not rewritten.
    expect(await costOf(outlet, kit2.menuItem)).toEqual(untouchedBefore);
  });

  it("HPP-RECOMPUTE-nested a change deep in nested recipes reaches the menu item (3 levels)", async () => {
    const outlet = await newOutlet();
    const sugar = await insertItem("Gula", gramId);
    const beans = await insertItem("Biji Kopi", gramId);
    await receive(outlet, sugar, "1000.0000", "10.0000");
    await receive(outlet, beans, "1000.0000", "100.0000");
    // Level 3 and 2 have no output item: they are exploded into the menu cost.
    const base = await insertRecipe({
      name: "Dasar Manis",
      yieldUomId: portionId,
      lines: [{ id: sugar, qty: "50.0000", uom: gramId }],
    });
    const mid = await insertRecipe({
      name: "Dasar Kopi",
      yieldUomId: portionId,
      lines: [
        { type: "recipe", id: base, qty: "1.0000", uom: portionId },
        { id: beans, qty: "10.0000", uom: gramId },
      ],
    });
    const top = await insertRecipe({
      name: "Kopi Manis",
      yieldUomId: cupId,
      lines: [{ type: "recipe", id: mid, qty: "1.0000", uom: portionId }],
    });
    const menuItem = await insertMenuItem("Kopi Manis", top);
    await baseline(outlet);
    // 50 x 10 + 10 x 100 = 1.500
    expect((await costOf(outlet, menuItem)).cost).toBe("1500.0000");

    await receive(outlet, sugar, "1000.0000", "30.0000"); // avg 20
    expect(await avgCostOf(outlet, sugar)).toBe("20.0000");
    await tick();

    // 50 x 20 + 10 x 100 = 2.000
    expect(await costOf(outlet, menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "2000.0000",
    });
  });

  it("HPP-RECOMPUTE-nested a semi-finished item that is produced is costed at its own average cost, and a change of it reaches the menu item", async () => {
    const outlet = await newOutlet();
    const beans = await insertItem("Biji Kopi", gramId);
    const sugar = await insertItem("Gula", gramId);
    const syrupItem = await insertItem("Sirup", mlId, "semi_finished");
    await receive(outlet, beans, "1000.0000", "100.0000");
    await receive(outlet, sugar, "1000.0000", "10.0000");
    await receive(outlet, syrupItem, "1000.0000", "80.0000");
    const syrupRecipe = await insertRecipe({
      name: "Sirup",
      outputItemId: syrupItem,
      yieldQuantity: "1000.0000",
      yieldUomId: mlId,
      lines: [{ id: sugar, qty: "500.0000", uom: gramId }],
    });
    const top = await insertRecipe({
      name: "Kopi Sirup",
      yieldUomId: cupId,
      lines: [
        { id: beans, qty: "18.0000", uom: gramId },
        { type: "recipe", id: syrupRecipe, qty: "20.0000", uom: mlId },
      ],
    });
    const menuItem = await insertMenuItem("Kopi Sirup", top);
    await baseline(outlet);
    // 18 x 100 + 20 x 80 = 3.400
    expect((await costOf(outlet, menuItem)).cost).toBe("3400.0000");

    await receive(outlet, syrupItem, "1000.0000", "120.0000"); // avg 100
    await tick();

    // 18 x 100 + 20 x 100 = 3.800
    expect(await costOf(outlet, menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "3800.0000",
    });
  });

  it("HPP-RECOMPUTE-incomplete a component with an average cost of 0 or no stock makes the cost null, never 0; a later cost completes it", async () => {
    const outlet = await newOutlet();
    const beans = await insertItem("Biji Kopi", gramId);
    const free = await insertItem("Bahan Gratis", gramId);
    const neverStocked = await insertItem("Bahan Kosong", gramId);
    await receive(outlet, beans, "1000.0000", "100.0000");
    await receive(outlet, free, "1000.0000", "0.0000");
    const freeRecipe = await insertRecipe({
      name: "Kopi Gratis",
      yieldUomId: cupId,
      lines: [
        { id: beans, qty: "18.0000", uom: gramId },
        { id: free, qty: "10.0000", uom: gramId },
      ],
    });
    const freeMenu = await insertMenuItem("Kopi Gratis", freeRecipe);
    const emptyRecipe = await insertRecipe({
      name: "Kopi Kosong",
      yieldUomId: cupId,
      lines: [
        { id: beans, qty: "18.0000", uom: gramId },
        { id: neverStocked, qty: "5.0000", uom: gramId },
      ],
    });
    const emptyMenu = await insertMenuItem("Kopi Kosong", emptyRecipe);
    await baseline(outlet);

    for (const [menuItem, recipe] of [
      [freeMenu, freeRecipe],
      [emptyMenu, emptyRecipe],
    ] as const) {
      const row = await costOf(outlet, menuItem);
      expect(row.recipe_id).toBe(recipe);
      expect(row.recipe_complete).toBe(false);
      expect(row.cost).toBeNull();
      expect(row.gross_margin_bp).toBeNull();
    }

    // 1.000 g free + 1.000 g at Rp100 = average Rp50: now costed.
    await receive(outlet, free, "1000.0000", "100.0000");
    await tick();
    // 18 x 100 + 10 x 50 = 2.300
    expect(await costOf(outlet, freeMenu)).toMatchObject({
      recipe_complete: true,
      cost: "2300.0000",
    });
    // The item that was never stocked is still unknown.
    expect(await costOf(outlet, emptyMenu)).toMatchObject({
      recipe_complete: false,
      cost: null,
    });
  });

  it("HPP-RECOMPUTE-idempotent running the job again, or queueing the same item again, changes no value and adds no row", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    await receive(outlet, kit.beans, "1000.0000", "300.0000");
    await tick();
    const first = await costOf(outlet, kit.menuItem);

    await tick(); // empty queue: no-op
    await withTenant(db, tenantContext(), (tx) =>
      enqueueHppRecompute(tx, {
        tenantId: tenantIdSchema.parse(tenantA),
        outletId: outletIdSchema.parse(outlet.id),
        itemIds: [kit.beans, kit.beans],
      } as never),
    );
    await tick();

    const rows = await costRows(outlet, kit.menuItem);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cost: first.cost,
      recipe_complete: first.recipe_complete,
      price: first.price,
      gross_margin_bp: first.gross_margin_bp,
      recipe_id: first.recipe_id,
    });
    expect(await queueOf(outlet)).toEqual([]);
  });

  it("HPP-RECOMPUTE-large one job tick finishes a queue far larger than one batch", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    // 450 items that no recipe uses, plus the one change that matters.
    const filler = await q<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       SELECT $1, 'Filler ' || g || ' ' || $3, 'Bahan Baku', 'raw_material', $2, true
         FROM generate_series(1, 450) AS g
       RETURNING id`,
      [tenantA, gramId, short()],
    );
    await withTenant(db, tenantContext(), (tx) =>
      enqueueHppRecompute(tx, {
        tenantId: tenantIdSchema.parse(tenantA),
        outletId: outletIdSchema.parse(outlet.id),
        itemIds: filler.map((row) => row.id),
      } as never),
    );
    await receive(outlet, kit.beans, "1000.0000", "300.0000");
    expect((await queueOf(outlet)).length).toBe(451);

    await tick();

    expect(await queueOf(outlet)).toEqual([]);
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      cost: "7600.0000",
    });
  }, 120_000);
});

describe("HPP-RECOMPUTE price and margin", () => {
  it("HPP-RECOMPUTE-margin gross margin follows price and cost, and moves with the cost", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await setPrice(outlet, kit.menuItem, 25_000);
    await baseline(outlet);

    // (25.000 - 5.800) x 10.000 / 25.000 = 7.680 bp
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      price: "25000",
      cost: "5800.0000",
      gross_margin_bp: 7_680,
    });

    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // cost 7.600
    await tick();
    // (25.000 - 7.600) x 10.000 / 25.000 = 6.960 bp
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      price: "25000",
      cost: "7600.0000",
      gross_margin_bp: 6_960,
    });
  });

  it("HPP-RECOMPUTE-margin a menu item without a price keeps its cost and shows price 0 and margin 0", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);

    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "5800.0000",
      price: "0",
      gross_margin_bp: 0,
    });
  });
});

describe("TEN-01 TEN-03 HPP tables are isolated per tenant", () => {
  it("HPP-RECOMPUTE-isolation hpp_recompute_queue and menu_costs rows of one tenant are invisible and untouchable to another", async () => {
    const outletA = await newOutlet();
    const b = await createSecondTenant(owner, "hpp");
    tenantB = b;

    // Tenant A rows.
    const itemA = await insertItem("Isolasi A", gramId);
    const menuA = await insertMenuItem("Isolasi A", null);
    await q(
      "INSERT INTO hpp_recompute_queue (tenant_id, outlet_id, item_id) VALUES ($1, $2, $3)",
      [tenantA, outletA.id, itemA],
    );
    const costA = randomUUID();
    const insertCost = (
      id: string,
      tenantId: string,
      outletId: string,
      menuItemId: string,
    ) =>
      q(
        `INSERT INTO menu_costs (id, tenant_id, outlet_id, menu_item_id, variant_id, modifier_id, recipe_id,
            recipe_complete, theoretical_cost_idr, price_idr, gross_margin_bp, computed_at)
         VALUES ($1, $2, $3, $4, NULL, NULL, NULL, false, NULL, 0, NULL, now())`,
        [id, tenantId, outletId, menuItemId],
        tenantId,
      );
    await insertCost(costA, tenantA, outletA.id, menuA);

    // Tenant B rows (own uom, item, category and menu item).
    const uomB = await one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [b.tenantId, `g${short()}`.slice(0, 10)],
      b.tenantId,
    );
    const itemB = await one<string>(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
      [b.tenantId, `Isolasi B ${short()}`, uomB],
      b.tenantId,
    );
    const categoryB = randomUUID();
    await q(
      "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'B', 0)",
      [categoryB, b.tenantId, b.brandId],
      b.tenantId,
    );
    const menuB = await one<string>(
      `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id)
       VALUES ($1, $2, $3, $4, NULL) RETURNING id`,
      [b.tenantId, b.brandId, categoryB, `Isolasi B ${short()}`],
      b.tenantId,
    );
    await q(
      "INSERT INTO hpp_recompute_queue (tenant_id, outlet_id, item_id) VALUES ($1, $2, $3)",
      [b.tenantId, b.outletId, itemB],
      b.tenantId,
    );
    const costB = randomUUID();
    await insertCost(costB, b.tenantId, b.outletId, menuB);

    await expectRowsIsolated(
      appPool,
      {
        table: "hpp_recompute_queue",
        idColumn: "item_id",
        updateSet: "enqueued_at = now()",
        tenantA: { tenantId: tenantA, rowId: itemA },
        tenantB: { tenantId: b.tenantId, rowId: itemB },
      },
      owner,
    );
    await expectRowsIsolated(
      appPool,
      {
        table: "menu_costs",
        updateSet: "price_idr = price_idr + 1",
        tenantA: { tenantId: tenantA, rowId: costA },
        tenantB: { tenantId: b.tenantId, rowId: costB },
      },
      owner,
    );
  });
});

// ===========================================================================
// Review defects (bead legend-2qq). These blocks were added after review and
// must fail until the recompute is fixed.
//
// Assumptions where the spec/design is silent:
// - A recipe is edited through the public API (POST
//   /api/inventory/recipes/:recipeId/versions, which runs through
//   recipe.service); one job tick afterwards must show the new cost, without
//   any stock movement in between.
// - An outlet with no menu_costs row at all gets a full first fill from one
//   job tick, even when its queue is empty or holds only unrelated items.
// - A modifier that has an `add` or `replace` rule in modifier_recipe_rules
//   cannot be costed from its own recipe alone: it is recipe_complete = false
//   with a NULL cost (never a partial cost). A modifier without rules keeps
//   the cost of its own recipe. A modifier has its own menu_costs row
//   (modifier_id set) when it is in a group linked to the menu item.

describe("HPP-RECOMPUTE editing a recipe refreshes the menu cost", () => {
  const host = `tenant-${slugA}.legend.test`;
  let editor: ReturnType<typeof agent>;

  beforeAll(async () => {
    const app = createApp();
    await q(
      `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
      [randomUUID(), tenantA, brandA, host],
    );
    const template = ROLE_TEMPLATES.find((t) => t.key === "owner")!;
    const roleId = randomUUID();
    await q(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7)`,
      [
        roleId,
        tenantA,
        template.defaultName,
        template.key,
        JSON.stringify(template.permissions),
        template.mfaRequired,
        JSON.stringify(template.allowedScopeTypes),
      ],
    );
    editor = agent(app);
    await signUp(editor, "HPP Recipe Editor");
    const session = await editor.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    editor.set("Host", host);
    await q(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantA, userId, roleId],
    );
  });

  type ApiLine = {
    type?: "item" | "recipe";
    id: string;
    qty: string;
    uom: string;
  };
  const apiLines = (lines: ApiLine[]) =>
    lines.map((line) => ({
      componentType: line.type ?? "item",
      componentId: line.id,
      quantity: line.qty,
      uomId: line.uom,
      wastePctBp: 0,
    }));

  async function createRecipeViaApi(
    name: string,
    yieldUomId: string,
    lines: ApiLine[],
  ): Promise<string> {
    const response = await editor
      .post("/api/inventory/recipes")
      .set(originHeader)
      .send({
        brandId: brandA,
        name: `${name} ${short()}`,
        outputItemId: null,
        yieldQuantity: "1.0000",
        yieldUomId,
        lines: apiLines(lines),
        idempotencyKey: `recipe-${randomUUID()}`,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.recipe.id as string;
  }

  async function editRecipeLines(recipeId: string, lines: ApiLine[]) {
    const response = await editor
      .post(`/api/inventory/recipes/${recipeId}/versions`)
      .set(originHeader)
      .send({
        lines: apiLines(lines),
        changeNote: "Ubah resep",
        idempotencyKey: `recipe-version-${randomUUID()}`,
      });
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  }

  it("HPP-RECOMPUTE-recipe-edit adding an ingredient to a recipe raises that menu item's cost after one tick", async () => {
    const outlet = await newOutlet();
    const beans = await insertItem("Biji Kopi", gramId);
    const milk = await insertItem("Susu", mlId);
    await receive(outlet, beans, "1000.0000", "100.0000");
    await receive(outlet, milk, "10000.0000", "20.0000");
    const recipe = await createRecipeViaApi("Kopi Edit", cupId, [
      { id: beans, qty: "18.0000", uom: gramId },
    ]);
    const menuItem = await insertMenuItem("Kopi Edit", recipe);
    await baseline(outlet);
    expect(await costOf(outlet, menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "1800.0000",
    });

    await editRecipeLines(recipe, [
      { id: beans, qty: "18.0000", uom: gramId },
      { id: milk, qty: "200.0000", uom: mlId },
    ]);
    await tick();

    // 18 x 100 + 200 x 20 = 5.800: never left at the old, lower cost.
    expect(await costOf(outlet, menuItem)).toMatchObject({
      recipe_id: recipe,
      recipe_complete: true,
      cost: "5800.0000",
    });
  });

  it("HPP-RECOMPUTE-recipe-edit editing a nested recipe reaches the menu item that uses it", async () => {
    const outlet = await newOutlet();
    const beans = await insertItem("Biji Kopi", gramId);
    const sugar = await insertItem("Gula", gramId);
    await receive(outlet, beans, "1000.0000", "100.0000");
    await receive(outlet, sugar, "1000.0000", "10.0000");
    const base = await createRecipeViaApi("Dasar Edit", portionId, [
      { id: sugar, qty: "50.0000", uom: gramId },
    ]);
    const top = await createRecipeViaApi("Kopi Dasar Edit", cupId, [
      { id: beans, qty: "10.0000", uom: gramId },
      { type: "recipe", id: base, qty: "1.0000", uom: portionId },
    ]);
    const menuItem = await insertMenuItem("Kopi Dasar Edit", top);
    await baseline(outlet);
    // 10 x 100 + 50 x 10 = 1.500
    expect((await costOf(outlet, menuItem)).cost).toBe("1500.0000");

    await editRecipeLines(base, [
      { id: sugar, qty: "50.0000", uom: gramId },
      { id: beans, qty: "5.0000", uom: gramId },
    ]);
    await tick();

    // 10 x 100 + (50 x 10 + 5 x 100) = 2.000
    expect(await costOf(outlet, menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "2000.0000",
    });
  });
});

describe("HPP-RECOMPUTE an outlet without any menu cost gets a full first fill", () => {
  it("HPP-RECOMPUTE-first-fill-job one tick fills an outlet with no menu_costs rows even when its queue is empty", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await clearQueue(outlet);
    expect(await costRows(outlet, kit.menuItem)).toEqual([]);

    await tick();

    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_id: kit.recipe,
      recipe_complete: true,
      cost: "5800.0000",
    });
  });

  it("HPP-RECOMPUTE-first-fill-job one tick fills every menu item of an outlet with no menu_costs rows when its queue holds only an unrelated item", async () => {
    const outlet = await newOutlet();
    const kit1 = await buildKit(outlet);
    const kit2 = await buildKit(outlet);
    await clearQueue(outlet);
    const unrelated = await insertItem("Tidak Dipakai", gramId);
    await withTenant(db, tenantContext(), (tx) =>
      enqueueHppRecompute(tx, {
        tenantId: tenantIdSchema.parse(tenantA),
        outletId: outletIdSchema.parse(outlet.id),
        itemIds: [unrelated],
      } as never),
    );

    await tick();

    for (const kit of [kit1, kit2])
      expect(await costOf(outlet, kit.menuItem)).toMatchObject({
        recipe_complete: true,
        cost: "5800.0000",
      });
    expect(await queueOf(outlet)).toEqual([]);
  });
});

describe("HPP-RECOMPUTE a modifier with recipe rules is never costed partially", () => {
  async function modifierFixture(
    outlet: Outlet,
    rule:
      | { action: "add"; item: string; qty: string; uom: string }
      | {
          action: "replace";
          target: string;
          item: string;
          qty: string;
          uom: string;
        }
      | null,
  ) {
    const kit = await buildKit(outlet);
    const extra = await insertItem("Sirup Tambahan", mlId);
    await receive(outlet, extra, "1000.0000", "50.0000");
    const groupId = await one<string>(
      "INSERT INTO modifier_groups (tenant_id, name, min_select, max_select) VALUES ($1, $2, 0, 5) RETURNING id",
      [tenantA, `Tambahan ${short()}`],
    );
    // The modifier's own recipe: 10 ml of the extra syrup = Rp500.
    const modifierRecipe = await insertRecipe({
      name: "Resep Tambahan",
      yieldUomId: portionId,
      lines: [{ id: extra, qty: "10.0000", uom: mlId }],
    });
    const modifierId = await one<string>(
      "INSERT INTO modifiers (tenant_id, group_id, name, recipe_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [tenantA, groupId, `Tambah ${short()}`, modifierRecipe],
    );
    await q(
      `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order)
       VALUES ($1, $2, $3, 0)`,
      [tenantA, kit.menuItem, groupId],
    );
    if (rule)
      await q(
        `INSERT INTO modifier_recipe_rules
           (tenant_id, modifier_id, action, target_component_type, target_component_id,
            component_type, component_id, quantity, uom_id, waste_pct_bp)
         VALUES ($1, $2, $3, $4, $5, 'item', $6, $7, $8, 0)`,
        [
          tenantA,
          modifierId,
          rule.action,
          rule.action === "replace" ? "item" : null,
          rule.action === "replace" ? rule.target : null,
          rule.item,
          rule.qty,
          rule.uom,
        ],
      );
    await baseline(outlet);
    return { kit, extra, modifierId };
  }

  async function modifierCost(outlet: Outlet, modifierId: string) {
    const rows = await q<CostRow>(
      `SELECT menu_item_id::text, variant_id::text, recipe_id::text, recipe_complete,
              theoretical_cost_idr::text AS cost, price_idr::text AS price,
              gross_margin_bp, computed_at::text AS computed_at
         FROM menu_costs
        WHERE tenant_id = $1 AND outlet_id = $2 AND modifier_id = $3`,
      [tenantA, outlet.id, modifierId],
    );
    expect(rows, "one menu_costs row for the modifier").toHaveLength(1);
    return rows[0]!;
  }

  it("HPP-RECOMPUTE-modifier-rules a modifier with an add rule is incomplete with a null cost", async () => {
    const outlet = await newOutlet();
    const probe = await buildKit(outlet);
    const { modifierId } = await modifierFixture(outlet, {
      action: "add",
      item: probe.milk,
      qty: "30.0000",
      uom: mlId,
    });

    const row = await modifierCost(outlet, modifierId);
    expect(row.recipe_complete).toBe(false);
    expect(row.cost).toBeNull();
  });

  it("HPP-RECOMPUTE-modifier-rules a modifier with a replace rule is incomplete with a null cost", async () => {
    const outlet = await newOutlet();
    const probe = await buildKit(outlet);
    const { modifierId } = await modifierFixture(outlet, {
      action: "replace",
      target: probe.milk,
      item: probe.beans,
      qty: "5.0000",
      uom: gramId,
    });

    const row = await modifierCost(outlet, modifierId);
    expect(row.recipe_complete).toBe(false);
    expect(row.cost).toBeNull();
  });

  it("HPP-RECOMPUTE-modifier-rules a modifier without rules keeps the cost of its own recipe", async () => {
    const outlet = await newOutlet();
    const { modifierId } = await modifierFixture(outlet, null);

    // 10 ml x Rp50 = Rp500
    expect(await modifierCost(outlet, modifierId)).toMatchObject({
      recipe_complete: true,
      cost: "500.0000",
    });
  });
});
