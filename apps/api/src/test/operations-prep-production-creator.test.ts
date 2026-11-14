// legend-qq4k: WS-06 production-order creator for the daily prep list (PRD v1.7
// §3 F41 "Daftar Prep Harian", §17 "Produksi Batch"; WS-14 + WS-06).
//
// Contract under test (written fail-first, before the implementation exists):
//   - apps/api/src/services/operations-prep-production.ts exports the default
//     WS-06 creator. This test accepts either of the proposed public shapes:
//       `installProductionOrderCreator()`  installs it itself, or
//       `productionOrderPrepCreator`       a PrepProductionOrderCreator that is
//                                          installed with
//                                          `setPrepProductionOrderCreator`.
//   - Completing a prep list (transitionPrepList action "complete") creates ONE
//     production order per line whose inventory item is the `output_item_id` of
//     an ACTIVE recipe, in the same transaction, and writes the id to
//     `prep_list_items.production_order_id`.
//   - Orders are created as `draft`: no actual quantity, no cost, and no
//     stock_ledger or journal row (nothing here touches money).
//   - Replay or re-linking never creates a second order for a line.
//   - A line without an active recipe is skipped (production_order_id stays
//     null) and the completion still succeeds.
//   - `setPrepProductionOrderCreator(null)` keeps the old no-op behaviour.
//   - Other tenants are untouched (TEN-01..03).
//
// Assumption: the creator picks a stock location of the prep list's outlet for
// `production_orders.location_id`; the spec does not say which, so the test only
// requires that it belongs to the same outlet.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { positiveDecimal4Schema } from "@starter/shared/operations";
import {
  inventoryItemIdSchema,
  type InventoryItemId,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createPrepList,
  transitionPrepList,
} from "../services/operations-food-safety.service.ts";
import * as prepProduction from "../services/operations-prep-production.ts";
import {
  linkProductionOrdersForPrepList,
  setPrepProductionOrderCreator,
  type PrepProductionOrderCreator,
} from "../services/operations-prep-production.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const fixtureOutlet = outletIdSchema.parse(
  cafeLegendPlatformFixtures.outlets[0].id,
);
// The creator requires exactly one active kitchen. Other inventory suites leave
// stock locations in the shared fixture outlet, so use an outlet owned here.
const outletA = outletIdSchema.parse(randomUUID());
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutletRaw = randomUUID();
const otherOutlet = outletIdSchema.parse(otherOutletRaw);

/** 2030-03-15 10:00 in Asia/Jakarta (UTC+7). */
const NOW = new Date("2030-03-15T03:00:00.000Z");

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdUomIds: string[] = [];
const createdItemIds: string[] = [];
const createdLocationIds: string[] = [];
const createdRecipeIds: string[] = [];
const createdPrepListIds: string[] = [];

let operator = "";
let otherOperator = "";
let brandA = "";
let kitchenLocationA = "";
let kitchenLocationOther = "";

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const outletScope = (outletId: string, tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

/** Owner connection with the tenant settings FORCE RLS requires. */
async function asOwner<T>(
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

async function seedActor(
  permissions: string[],
  tenant: string = tenantId,
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Prep production sdet', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  if (tenant === tenantId) createdRoles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `Prep prod sdet ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant, userId, roleId],
    );
  });
  return userId;
}

async function seedKitchenLocation(
  tenant: string,
  outletId: string,
): Promise<string> {
  const id = randomUUID();
  createdLocationIds.push(id);
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4, 'kitchen')`,
      [id, tenant, outletId, `Dapur ${id.slice(0, 8)}`],
    ),
  );
  return id;
}

type SeededItem = { id: InventoryItemId; uomId: string };

async function seedItem(
  name: string,
  type: "raw_material" | "semi_finished",
  tenant: string = tenantId,
): Promise<SeededItem> {
  const uomId = randomUUID();
  createdUomIds.push(uomId);
  const itemId = randomUUID();
  createdItemIds.push(itemId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)`,
      [uomId, tenant, `U${uomId.slice(0, 8)}`, `Unit ${uomId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id)
       VALUES ($1, $2, $3, 'Bahan Baku', $4, $5)`,
      [itemId, tenant, name, type, uomId],
    );
  });
  return { id: inventoryItemIdSchema.parse(itemId), uomId };
}

/** A recipe whose output is `output`, with one raw-material component line. */
async function seedRecipe(options: {
  output: SeededItem;
  component: SeededItem;
  isActive: boolean;
  tenant?: string;
  brandId?: string;
}): Promise<string> {
  const tenant = options.tenant ?? tenantId;
  const recipeId = randomUUID();
  createdRecipeIds.push(recipeId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO recipes
         (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id,
          version, is_active, theoretical_cost_idr, updated_by)
       VALUES ($1, $2, $3, $4, $5, '10.0000', $6, 1, $7, '0', $8)`,
      [
        recipeId,
        tenant,
        options.brandId ?? brandA,
        `Resep ${recipeId.slice(0, 8)}`,
        options.output.id,
        options.output.uomId,
        options.isActive,
        operator,
      ],
    );
    await client.query(
      `INSERT INTO recipe_lines
         (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id)
       VALUES ($1, $2, 0, 'item', $3, '2.0000', $4)`,
      [tenant, recipeId, options.component.id, options.component.uomId],
    );
  });
  return recipeId;
}

let keySequence = 0;
const nextKey = (label: string) =>
  `qq4k-${label}-${(keySequence += 1)}-${randomUUID().slice(0, 8)}`;
const qty = (value: string) => positiveDecimal4Schema.parse(value);

type Line = { itemId: InventoryItemId; quantity: string };

/** Creates, starts and (optionally) completes a prep list; returns its id. */
async function prepList(options: {
  outletId?: string;
  tenant?: string;
  prepDate: string;
  lines: Line[];
  complete?: boolean;
}): Promise<{ id: string; context: ReturnType<typeof outletScope> }> {
  const tenant = options.tenant ?? tenantId;
  const outletId = options.outletId ?? outletA;
  const context = outletScope(outletId, tenant);
  const actor = tenant === tenantId ? operator : otherOperator;
  const list = await createPrepList(
    context,
    actor,
    {
      outletId: outletIdSchema.parse(outletId),
      prepDate: options.prepDate,
      lines: options.lines.map((line) => ({
        inventoryItemId: line.itemId,
        plannedQuantity: qty(line.quantity),
      })),
      idempotencyKey: nextKey("list"),
    },
    NOW,
  );
  createdPrepListIds.push(list.id);
  await transitionPrepList(
    context,
    actor,
    list.id,
    { action: "start", idempotencyKey: nextKey("start") },
    NOW,
  );
  if (options.complete !== false)
    await complete(context, list.id, undefined, actor);
  return { id: list.id, context };
}

async function complete(
  context: ReturnType<typeof outletScope>,
  listId: string,
  key: string = nextKey("complete"),
  actor: string = operator,
) {
  return transitionPrepList(
    context,
    actor,
    listId,
    { action: "complete", idempotencyKey: key },
    NOW,
  );
}

type LineRow = {
  inventory_item_id: string;
  planned_quantity: string;
  production_order_id: string | null;
};

async function lineRows(listId: string, tenant: string = tenantId) {
  const { rows } = await asOwner(tenant, (client) =>
    client.query<LineRow>(
      `SELECT inventory_item_id, planned_quantity, production_order_id
         FROM prep_list_items
        WHERE tenant_id = $1 AND prep_list_id = $2
        ORDER BY id`,
      [tenant, listId],
    ),
  );
  return rows;
}

type OrderRow = {
  id: string;
  outlet_id: string;
  location_id: string;
  recipe_id: string;
  output_item_id: string;
  planned_qty: string;
  actual_qty: string | null;
  status: string;
  cost_idr: string | null;
  created_by: string;
  started_at: Date | null;
  completed_at: Date | null;
};

async function ordersForItems(
  itemIds: readonly string[],
  tenant: string = tenantId,
) {
  const { rows } = await asOwner(tenant, (client) =>
    client.query<OrderRow>(
      `SELECT id, outlet_id, location_id, recipe_id, output_item_id, planned_qty,
              actual_qty, status, cost_idr, created_by, started_at, completed_at
         FROM production_orders
        WHERE tenant_id = $1 AND output_item_id = ANY($2::uuid[])
        ORDER BY output_item_id`,
      [tenant, [...itemIds]],
    ),
  );
  return rows;
}

/** Stock-ledger and journal rows that reference any of these production orders. */
async function moneyRowsFor(orderIds: readonly string[], tenant = tenantId) {
  return asOwner(tenant, async (client) => {
    const ledger = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stock_ledger
        WHERE tenant_id = $1 AND source_type = 'production_order'
          AND source_id = ANY($2::uuid[])`,
      [tenant, [...orderIds]],
    );
    const journals = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE tenant_id = $1 AND source_id = ANY($2::text[])`,
      [tenant, [...orderIds]],
    );
    return { ledger: ledger.rows[0]!.n, journals: journals.rows[0]!.n };
  });
}

/** Installs the WS-06 creator through whichever public shape the module has. */
function installCreator() {
  const exported = prepProduction as Record<string, unknown>;
  if (typeof exported.installProductionOrderCreator === "function") {
    (exported.installProductionOrderCreator as () => void)();
    return;
  }
  if (typeof exported.productionOrderPrepCreator === "function") {
    setPrepProductionOrderCreator(
      exported.productionOrderPrepCreator as PrepProductionOrderCreator,
    );
    return;
  }
  throw new Error(
    "operations-prep-production.ts exports neither installProductionOrderCreator nor productionOrderPrepCreator (legend-qq4k)",
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // CTO decision: the creator checks `inventory.production.record` of the actor
  // at the outlet, so the main operator holds it next to ops.prep.manage.
  operator = await seedActor([
    "ops.prep.manage",
    "inventory.production.record",
  ]);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Prep production isolated', address, timezone, opening_hours, status
         FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        outletA,
        `PP-${outletA.slice(0, 8).toUpperCase()}`,
        tenantId,
        fixtureOutlet,
      ],
    ),
  );
  const { rows } = await owner.query<{ brand_id: string }>(
    "SELECT brand_id FROM outlets WHERE id = $1",
    [outletA],
  );
  brandA = rows[0]!.brand_id;
  kitchenLocationA = await seedKitchenLocation(tenantId, outletA);

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Prep prod sdet other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `prep-prod-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'pp-b', 'Brand PP B')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT PP B', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'PP-B-01', 'Outlet PP B', 'Jl. PP B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutletRaw, otherTenant, otherBrand, otherEntity],
    );
  });
  kitchenLocationOther = await seedKitchenLocation(otherTenant, otherOutletRaw);
  // A user of the other tenant: it needs its own role assignment there.
  otherOperator = await seedActor(
    ["ops.prep.manage", "inventory.production.record"],
    otherTenant,
  );
});

afterEach(() => {
  setPrepProductionOrderCreator(null);
});

afterAll(async () => {
  setPrepProductionOrderCreator(null);
  for (const tenant of [tenantId, otherTenant]) {
    await asOwner(tenant, async (client) => {
      const scope =
        tenant === tenantId
          ? { lists: createdPrepListIds, items: createdItemIds }
          : null;
      if (scope) {
        await client.query(
          `DELETE FROM prep_list_items WHERE tenant_id = $1 AND prep_list_id = ANY($2::uuid[])`,
          [tenant, scope.lists],
        );
        await client.query(
          `DELETE FROM prep_lists WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
          [tenant, scope.lists],
        );
        await client.query(
          `DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'qq4k-%'`,
          [tenant],
        );
        await client.query(
          `DELETE FROM production_orders WHERE tenant_id = $1 AND recipe_id = ANY($2::uuid[])`,
          [tenant, createdRecipeIds],
        );
        await client.query(
          `DELETE FROM recipe_lines WHERE tenant_id = $1 AND recipe_id = ANY($2::uuid[])`,
          [tenant, createdRecipeIds],
        );
        await client.query(
          `DELETE FROM recipes WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
          [tenant, createdRecipeIds],
        );
      } else {
        for (const table of [
          "prep_list_items",
          "prep_lists",
          "operations_idempotency",
          "production_orders",
          "recipe_lines",
          "recipes",
        ])
          await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
            tenant,
          ]);
      }
    });
  }
  await asOwner(tenantId, async (client) => {
    await client.query(
      `DELETE FROM stock_locations WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, createdLocationIds],
    );
    await client.query(
      `DELETE FROM inventory_items WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, createdItemIds],
    );
    await client.query(
      `DELETE FROM uoms WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, createdUomIds],
    );
  });
  // audit_logs is append-only (trigger) and its (tenant_id, outlet_id) FK blocks
  // the outlet deletes below (the creator audits each order), so the owner
  // suspends the trigger for this one purge, as floor-test-helpers does.
  for (const [tenant, outlet] of [
    [tenantId, outletA],
    [otherTenant, otherOutletRaw],
  ] as const) {
    await asOwner(tenant, async (client) => {
      await client.query(
        "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only",
      );
      await client.query(
        "DELETE FROM audit_logs WHERE tenant_id = $1 AND outlet_id = $2",
        [tenant, outlet],
      );
      await client.query(
        "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only",
      );
    });
  }
  await asOwner(tenantId, (client) =>
    client.query("DELETE FROM outlets WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      outletA,
    ]),
  );
  await asOwner(otherTenant, async (client) => {
    for (const table of [
      "role_assignments",
      "roles",
      "stock_locations",
      "inventory_items",
      "uoms",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        otherTenant,
      ]);
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
    createdUsers,
  ]);
  if (createdRoles.length > 0)
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdRoles],
    );
  if (createdUsers.length > 0)
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("legend-qq4k prep list completion creates WS-06 production orders", () => {
  it("[legend-qq4k] completing creates one draft order per line with an active recipe and links it on the line", async () => {
    installCreator();
    const flour = await seedItem(
      `Tepung ${randomUUID().slice(0, 6)}`,
      "raw_material",
    );
    const dough = await seedItem(
      `Adonan ${randomUUID().slice(0, 6)}`,
      "semi_finished",
    );
    const sauce = await seedItem(
      `Saus ${randomUUID().slice(0, 6)}`,
      "semi_finished",
    );
    const doughRecipe = await seedRecipe({
      output: dough,
      component: flour,
      isActive: true,
    });
    const sauceRecipe = await seedRecipe({
      output: sauce,
      component: flour,
      isActive: true,
    });

    const list = await prepList({
      prepDate: "2030-03-20",
      lines: [
        { itemId: dough.id, quantity: "3.0000" },
        { itemId: sauce.id, quantity: "0.7500" },
      ],
      complete: false,
    });
    // An in-progress list has not produced anything yet.
    expect(await ordersForItems([dough.id, sauce.id])).toHaveLength(0);

    await complete(list.context, list.id);

    const orders = await ordersForItems([dough.id, sauce.id]);
    expect(orders).toHaveLength(2);
    const byItem = new Map(
      orders.map((order) => [order.output_item_id, order]),
    );
    const doughOrder = byItem.get(dough.id)!;
    const sauceOrder = byItem.get(sauce.id)!;

    expect(doughOrder).toMatchObject({
      outlet_id: outletA,
      recipe_id: doughRecipe,
      planned_qty: "3.0000",
      status: "draft",
      created_by: operator,
    });
    expect(sauceOrder).toMatchObject({
      outlet_id: outletA,
      recipe_id: sauceRecipe,
      planned_qty: "0.7500",
      status: "draft",
    });
    expect(doughOrder.id).not.toBe(sauceOrder.id);

    // The order sits in a stock location of the prep list's own outlet.
    for (const order of orders) {
      const { rows } = await asOwner(tenantId, (client) =>
        client.query<{ outlet_id: string }>(
          "SELECT outlet_id FROM stock_locations WHERE tenant_id = $1 AND id = $2",
          [tenantId, order.location_id],
        ),
      );
      expect(rows[0]?.outlet_id).toBe(outletA);
    }
    expect(kitchenLocationA).not.toBe("");

    // Each prep line carries the id of its own order.
    const lines = await lineRows(list.id);
    expect(lines).toHaveLength(2);
    const lineByItem = new Map(
      lines.map((line) => [line.inventory_item_id, line]),
    );
    expect(lineByItem.get(dough.id)!.production_order_id).toBe(doughOrder.id);
    expect(lineByItem.get(sauce.id)!.production_order_id).toBe(sauceOrder.id);
  });

  it("[legend-qq4k] a draft order carries no quantity, cost, stock movement or journal (no money touched)", async () => {
    installCreator();
    const flour = await seedItem(
      `Tepung ${randomUUID().slice(0, 6)}`,
      "raw_material",
    );
    const cream = await seedItem(
      `Krim ${randomUUID().slice(0, 6)}`,
      "semi_finished",
    );
    await seedRecipe({ output: cream, component: flour, isActive: true });

    await prepList({
      prepDate: "2030-03-21",
      lines: [{ itemId: cream.id, quantity: "5.0000" }],
    });

    const [order] = await ordersForItems([cream.id]);
    expect(order).toBeDefined();
    expect(order!.status).toBe("draft");
    expect(order!.actual_qty).toBeNull();
    expect(order!.cost_idr).toBeNull();
    expect(order!.started_at).toBeNull();
    expect(order!.completed_at).toBeNull();
    expect(await moneyRowsFor([order!.id])).toEqual({ ledger: 0, journals: 0 });
    // Neither the output nor the component item moved in the stock ledger.
    const { rows } = await asOwner(tenantId, (client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM stock_ledger
          WHERE tenant_id = $1 AND inventory_item_id = ANY($2::uuid[])`,
        [tenantId, [cream.id, flour.id]],
      ),
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("[legend-qq4k] replaying the completion or re-linking never creates a second order", async () => {
    installCreator();
    const flour = await seedItem(
      `Tepung ${randomUUID().slice(0, 6)}`,
      "raw_material",
    );
    const batter = await seedItem(
      `Batter ${randomUUID().slice(0, 6)}`,
      "semi_finished",
    );
    await seedRecipe({ output: batter, component: flour, isActive: true });

    const list = await prepList({
      prepDate: "2030-03-22",
      lines: [{ itemId: batter.id, quantity: "2.0000" }],
      complete: false,
    });
    const completeKey = nextKey("complete-replay");
    await complete(list.context, list.id, completeKey);
    const [first] = await ordersForItems([batter.id]);
    expect(first).toBeDefined();

    // Same idempotency key: replay of the finished list.
    const replayed = await complete(list.context, list.id, completeKey);
    expect(replayed.status).toBe("completed");

    // The WS-06 hand-off itself, run again on the completed list.
    await withTenant(db, list.context, (tx) =>
      linkProductionOrdersForPrepList(tx, list.context, list.id, NOW),
    );
    await withTenant(db, list.context, (tx) =>
      linkProductionOrdersForPrepList(tx, list.context, list.id, NOW),
    );

    const orders = await ordersForItems([batter.id]);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.id).toBe(first!.id);
    const lines = await lineRows(list.id);
    expect(lines.map((line) => line.production_order_id)).toEqual([first!.id]);
  });

  it("[legend-qq4k] a line without an active recipe is skipped and completion still succeeds", async () => {
    installCreator();
    const flour = await seedItem(
      `Tepung ${randomUUID().slice(0, 6)}`,
      "raw_material",
    );
    const withRecipe = await seedItem(
      `Roti ${randomUUID().slice(0, 6)}`,
      "semi_finished",
    );
    const noRecipe = await seedItem(
      `Garam ${randomUUID().slice(0, 6)}`,
      "raw_material",
    );
    const inactive = await seedItem(
      `Kuah ${randomUUID().slice(0, 6)}`,
      "semi_finished",
    );
    await seedRecipe({ output: withRecipe, component: flour, isActive: true });
    await seedRecipe({ output: inactive, component: flour, isActive: false });

    const list = await prepList({
      prepDate: "2030-03-23",
      lines: [
        { itemId: withRecipe.id, quantity: "1.5000" },
        { itemId: noRecipe.id, quantity: "4.0000" },
        { itemId: inactive.id, quantity: "6.0000" },
      ],
      complete: false,
    });
    const completed = await complete(list.context, list.id);
    expect(completed.status).toBe("completed");

    const lines = await lineRows(list.id);
    const lineByItem = new Map(
      lines.map((line) => [line.inventory_item_id, line]),
    );
    expect(lineByItem.get(withRecipe.id)!.production_order_id).not.toBeNull();
    expect(lineByItem.get(noRecipe.id)!.production_order_id).toBeNull();
    expect(lineByItem.get(inactive.id)!.production_order_id).toBeNull();

    expect(await ordersForItems([withRecipe.id])).toHaveLength(1);
    expect(await ordersForItems([noRecipe.id, inactive.id])).toHaveLength(0);
  });

  it("[legend-qq4k] without an installed creator completion stays a no-op for production", async () => {
    // Never installed here; afterEach and an explicit reset both restore the no-op.
    setPrepProductionOrderCreator(null);
    const flour = await seedItem(
      `Tepung ${randomUUID().slice(0, 6)}`,
      "raw_material",
    );
    const bun = await seedItem(
      `Bun ${randomUUID().slice(0, 6)}`,
      "semi_finished",
    );
    await seedRecipe({ output: bun, component: flour, isActive: true });

    const list = await prepList({
      prepDate: "2030-03-24",
      lines: [{ itemId: bun.id, quantity: "2.0000" }],
    });

    expect(await ordersForItems([bun.id])).toHaveLength(0);
    const lines = await lineRows(list.id);
    expect(lines.map((line) => line.production_order_id)).toEqual([null]);
  });

  it("[legend-qq4k] another tenant is untouched and keeps its own orders", async () => {
    installCreator();
    const flour = await seedItem(
      `Tepung ${randomUUID().slice(0, 6)}`,
      "raw_material",
    );
    const dough = await seedItem(
      `Adonan ${randomUUID().slice(0, 6)}`,
      "semi_finished",
    );
    await seedRecipe({ output: dough, component: flour, isActive: true });

    const otherFlour = await seedItem(
      `Tepung O ${randomUUID().slice(0, 6)}`,
      "raw_material",
      otherTenant,
    );
    const otherDough = await seedItem(
      `Adonan O ${randomUUID().slice(0, 6)}`,
      "semi_finished",
      otherTenant,
    );
    const otherRecipe = await seedRecipe({
      output: otherDough,
      component: otherFlour,
      isActive: true,
      tenant: otherTenant,
      brandId: otherBrand,
    });
    expect(kitchenLocationOther).not.toBe("");

    const { rows: before } = await asOwner(otherTenant, (client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM production_orders WHERE tenant_id = $1",
        [otherTenant],
      ),
    );
    expect(before[0]!.n).toBe(0);

    // Completing this tenant's list creates nothing in the other tenant.
    const mine = await prepList({
      prepDate: "2030-03-25",
      lines: [{ itemId: dough.id, quantity: "3.0000" }],
    });
    const { rows: afterMine } = await asOwner(otherTenant, (client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM production_orders WHERE tenant_id = $1",
        [otherTenant],
      ),
    );
    expect(afterMine[0]!.n).toBe(0);
    expect(await ordersForItems([dough.id])).toHaveLength(1);

    // The other tenant completes its own list: one order, its own recipe, its own outlet.
    const theirs = await prepList({
      tenant: otherTenant,
      outletId: otherOutlet,
      prepDate: "2030-03-25",
      lines: [{ itemId: otherDough.id, quantity: "8.0000" }],
    });
    const otherOrders = await ordersForItems([otherDough.id], otherTenant);
    expect(otherOrders).toHaveLength(1);
    expect(otherOrders[0]).toMatchObject({
      outlet_id: otherOutletRaw,
      recipe_id: otherRecipe,
      status: "draft",
      planned_qty: "8.0000",
    });
    expect(
      (await lineRows(theirs.id, otherTenant))[0]!.production_order_id,
    ).toBe(otherOrders[0]!.id);

    // This tenant's orders are still exactly one and do not point at the other tenant's recipe.
    const mineOrders = await ordersForItems([dough.id]);
    expect(mineOrders).toHaveLength(1);
    expect(mineOrders[0]!.recipe_id).not.toBe(otherRecipe);
    expect((await lineRows(mine.id))[0]!.production_order_id).toBe(
      mineOrders[0]!.id,
    );
  });

  it("[legend-qq4k] actor tanpa inventory.production.record tidak membuat production order", async () => {
    installCreator();
    // Assumption (CTO decision): without the production permission the creator
    // creates nothing, leaves production_order_id null and does not fail the
    // prep list completion.
    const prepOnly = await seedActor(["ops.prep.manage"]);
    const flour = await seedItem(
      `Tepung ${randomUUID().slice(0, 6)}`,
      "raw_material",
    );
    const dough = await seedItem(
      `Adonan ${randomUUID().slice(0, 6)}`,
      "semi_finished",
    );
    await seedRecipe({ output: dough, component: flour, isActive: true });

    const context = outletScope(outletA);
    const list = await createPrepList(
      context,
      prepOnly,
      {
        outletId: outletIdSchema.parse(outletA),
        prepDate: "2030-03-26",
        lines: [{ inventoryItemId: dough.id, plannedQuantity: qty("3.0000") }],
        idempotencyKey: nextKey("list"),
      },
      NOW,
    );
    createdPrepListIds.push(list.id);
    await transitionPrepList(
      context,
      prepOnly,
      list.id,
      { action: "start", idempotencyKey: nextKey("start") },
      NOW,
    );
    const completed = await complete(context, list.id, undefined, prepOnly);
    expect(completed.status).toBe("completed");

    expect(await ordersForItems([dough.id])).toHaveLength(0);
    const lines = await lineRows(list.id);
    expect(lines.map((line) => line.production_order_id)).toEqual([null]);
    const { rows } = await asOwner(tenantId, (client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM stock_ledger
          WHERE tenant_id = $1 AND inventory_item_id = ANY($2::uuid[])`,
        [tenantId, [dough.id, flour.id]],
      ),
    );
    expect(rows[0]!.n).toBe(0);
    const { rows: journals } = await asOwner(tenantId, (client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM journal_entries
          WHERE tenant_id = $1 AND source_id = $2`,
        [tenantId, list.id],
      ),
    );
    expect(journals[0]!.n).toBe(0);
  });
});
