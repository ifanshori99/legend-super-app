// HPP report fixes (bead legend-2qq, findings 4 and 6 of
// scratchpad/hpp-fix-design.md; rule "jangan sampai rugi": an unknown cost is
// never shown as Rp0 and a report never looks better than reality).
//
// Finding 4 - GET /api/inventory/food-cost: a completed order whose stock
// deduction is not posted yet must not count as "Rp0 actual". Its theoretical
// cost stays in theoretical AND actual cost, the report says how many orders
// (`pendingOrderCount`) and how much theoretical cost (`pendingTheoreticalIdr`)
// are still unconfirmed. Orders with a posted deduction reconcile against the
// sale ledger as before.
//
// Finding 6 - GET /api/inventory/recipe-coverage: a menu item is `complete`
// only when every outlet of ITS OWN brand that the caller may reach has a
// complete cost row. Outlets of other brands and outlets the caller has no
// grant for never make an item incomplete.
//
// Assumptions where the design is silent:
// - Seeds follow the existing hpp-reports.test.ts patterns (own tenant, real
//   `recordStockMovement`, real `rebuildMenuCostsForOutlet`). Helpers are
//   copied, not imported.
// - A sale deduction is linked to its order by `source_type = 'order'` and
//   `source_id = <order uuid>`; the sale ledger rows of the same order use the
//   same `source_id` (as the POS leaves them).
// - An order whose deduction was skipped with `no_recipe` has nothing to draw
//   from stock: it is not "pending" and adds no cost (seeded with cost 0).
// - An order with NO deduction row at all is treated as unknown (pending),
//   like a pending deduction (design: "pending/skipped(non-no_recipe)/missing
//   = unknown").
// - Coverage for a brand with no outlet the caller can reach: the menu row is
//   either not listed or listed as `incomplete`, never `complete`.
// - Today's business date is the Asia/Jakarta calendar date; the period
//   [today - 2, today + 1] contains every row written now.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  decimal4,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { rebuildMenuCostsForOutlet } from "../services/hpp-recompute.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { agent, signUp } from "./helpers.ts";

const tenantA = randomUUID();
const legalEntityA = randomUUID();
const slugA = `hrf${randomUUID().slice(0, 8)}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
let app: Express;
const short = () => randomUUID().slice(0, 6);

// -------------------------------------------------------------------- dates

const today = new Date().toLocaleDateString("en-CA", {
  timeZone: "Asia/Jakarta",
});

function shiftDate(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

const periodFrom = shiftDate(today, -2);
const periodTo = shiftDate(today, 1);

// ------------------------------------------------------------ owner fixtures

async function q<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  tenantId = tenantA,
): Promise<T[]> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const rows = await q<{ id: T }>(sql, params);
  return rows[0]!.id;
}

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

let ownerUserId: string;
let gramId: string;
let cupId: string;
let costRoleId: string;

type Brand = { id: string; categoryId: string; host: string };

async function newBrand(label: string): Promise<Brand> {
  const id = randomUUID();
  await q(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [id, tenantA, `brand-${label}-${slugA}`, `Brand ${label} ${slugA}`],
  );
  const categoryId = randomUUID();
  await q(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'HPP Uji', 0)",
    [categoryId, tenantA, id],
  );
  // One brand-pinned host per brand (tenant_domains.brand_id is NOT NULL). The
  // permission resolver filters the org index to the host's brand, so a caller
  // granted on an outlet must call on the host of the brand owning that outlet.
  const host = `h-${label}-${slugA}.legend.test`;
  await q(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantA, id, host],
  );
  return { id, categoryId, host };
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
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityA, tenantA, `Entity ${slugA}`],
  );
  costRoleId = randomUUID();
  await q(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Biaya HPP', false, NULL, $3, false, '["tenant","brand","outlet"]')`,
    [
      costRoleId,
      tenantA,
      JSON.stringify([
        "recipe.cost.view",
        "recipe.manage",
        "inventory.stock.view",
      ]),
    ],
  );
}

type Outlet = { id: string; location: string; brandId: string };

async function newOutlet(brand: Brand): Promise<Outlet> {
  const id = randomUUID();
  await q(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
    [
      id,
      tenantA,
      brand.id,
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
  return { id, location, brandId: brand.id };
}

async function insertItem(name: string): Promise<string> {
  return one<string>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, gramId],
  );
}

type Movement = "receipt" | "sale" | "return" | "waste";

const SOURCE_OF: Record<Movement, string> = {
  receipt: "goods_receipt",
  sale: "order",
  return: "order",
  waste: "waste_log",
};

/** One real stock movement; the unit cost defaults to Rp100 per gram. */
async function move(
  outlet: Outlet,
  itemId: string,
  type: Movement,
  quantity: string,
  sourceId: string = randomUUID(),
  unitCost = "100.0000",
) {
  await recordStockMovement(tenantContext(), {
    outletId: outletIdSchema.parse(outlet.id) as OutletId,
    locationId: outlet.location,
    inventoryItemId: itemId,
    movementType: type,
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    batchId: null,
    sourceType: SOURCE_OF[type],
    sourceId,
    actor: { type: "system" },
  } as never);
}

async function rebuild(outlet: Outlet) {
  await rebuildMenuCostsForOutlet(
    tenantContext(),
    outletIdSchema.parse(outlet.id),
  );
}

async function insertRecipe(
  brand: Brand,
  name: string,
  lines: { id: string; qty: string }[],
): Promise<string> {
  const recipeId = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, true, $5) RETURNING id`,
    [tenantA, brand.id, `${name} ${short()}`, cupId, ownerUserId],
  );
  for (const [index, line] of lines.entries())
    await q(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenantA, recipeId, index, line.id, line.qty, gramId],
    );
  return recipeId;
}

async function insertMenuItem(
  brand: Brand,
  name: string,
  recipeId: string | null,
): Promise<string> {
  return one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantA, brand.id, brand.categoryId, `${name} ${short()}`, recipeId],
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

type OrderLine = {
  menuItemId: string;
  quantity: number;
  lineTotalIdr: number;
  /** Whole-line cost snapshot. */
  costIdr: number | null;
};

/** A completed POS order with its lines and cost snapshots. */
async function seedOrder(
  outlet: Outlet,
  lines: OrderLine[],
): Promise<{ ulid: string; uuid: string }> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  const total = lines.reduce((sum, line) => sum + line.lineTotalIdr, 0);
  await q(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
        status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $6, 0, 0, 0, 0, $6,
             'completed', $5, now())`,
    [
      uuid,
      tenantA,
      outlet.id,
      `HPPF-${randomUUID().slice(0, 12)}`,
      today,
      total,
    ],
  );
  for (const line of lines)
    await q(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
          quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date, cost_snapshot_idr)
       VALUES ($1, $2, $3, $4, $5, NULL, 'Item', $6, $7, 0, $8, '[]'::jsonb,
               'fired', 'served', $9, $10)`,
      [
        randomUUID(),
        tenantA,
        outlet.id,
        uuid,
        line.menuItemId,
        line.quantity,
        Math.round(line.lineTotalIdr / line.quantity),
        line.lineTotalIdr,
        today,
        line.costIdr,
      ],
    );
  await q(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
     VALUES ($1, $2, $3, 'pos', false)`,
    [uuid, tenantA, outlet.id],
  );
  return { ulid, uuid };
}

type DeductionState =
  | { status: "pending" }
  | { status: "posted"; costIdr: number }
  | { status: "skipped"; skipReason: "no_recipe" | "no_sale_location" };

/** The sale deduction the recipe engine keeps for an order. */
async function seedDeduction(
  outlet: Outlet,
  order: { ulid: string },
  state: DeductionState,
) {
  await q(
    `INSERT INTO recipe_deductions
       (tenant_id, outlet_id, kind, status, mode, source_type, source_id, business_date,
        idempotency_key, cost_idr, skip_reason, occurred_at, posted_at)
     VALUES ($1, $2, 'sale', $3, 'real_time', 'order', $4, $5, $6, $7, $8, now(), $9)`,
    [
      tenantA,
      outlet.id,
      state.status,
      order.ulid,
      today,
      `order:${order.ulid}`,
      state.status === "posted" ? state.costIdr : null,
      state.status === "skipped" ? state.skipReason : null,
      state.status === "posted" ? new Date() : null,
    ],
  );
}

// ------------------------------------------------------------- users & http

type Session = { client: ReturnType<typeof agent>; userId: string };

async function signedIn(name: string, brand: Brand): Promise<Session> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  client.set("Host", brand.host);
  return { client, userId };
}

async function assign(
  userId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await q(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantA,
      userId,
      costRoleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

async function readAll<T>(
  session: Session,
  path: string,
): Promise<{ status: number; rows: T[] }> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await session.client.get(
      cursor === null
        ? path
        : `${path}${separator}cursor=${encodeURIComponent(cursor)}`,
    );
    if (response.status !== 200) return { status: response.status, rows };
    const body = response.body as Page<T>;
    rows.push(...body.data);
    cursor = body.meta.nextCursor;
    if (cursor === null) return { status: 200, rows };
  }
  throw new Error("list endpoint never ended");
}

const foodCostPath = (outletId: string) =>
  `/api/inventory/food-cost?outletId=${outletId}&fromDate=${periodFrom}&toDate=${periodTo}`;

type FoodBody = {
  theoreticalCostIdr: number;
  actualCostIdr: number;
  varianceIdr: number;
  varianceBp: number;
  wasteIdr: number;
  adjustmentIdr: number;
  offRecipeUsageIdr: number;
  pendingOrderCount?: number;
  pendingTheoreticalIdr?: number;
};

// --------------------------------------------------------------------- world

let finance: Session; // recipe.cost.view, tenant scope, brandFood host
let financeP: Session; // same, brand P host
let financeR: Session; // same, brand R host
let financeS: Session; // same, brand S host
let beansItem: string;

// Finding 4 uses brandFood. Finding 6 uses brands P/Q (grants) and R/S
// (cross-brand), all in the same tenant.
let brandFood: Brand;
let brandP: Brand;
let brandR: Brand;
let brandS: Brand;

let outletP1: Outlet; // costs built
let outletP2: Outlet; // never built, no stock
let outletR1: Outlet; // costs built
let menuP: string;
let menuR: string;
let menuS: string;
let userP1: Session; // grant on P1 only
let userP2: Session; // grant on P2 only
let userR1: Session; // grant on R1 only

/** An outlet holding 100.000 g of the shared item at Rp100 per gram. */
async function stockedOutlet(brand: Brand): Promise<Outlet> {
  const outlet = await newOutlet(brand);
  await move(outlet, beansItem, "receipt", "100000.0000");
  return outlet;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  await createOwnTenant();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "HPP Fixes Owner", `${ownerUserId}@example.com`],
  );
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  cupId = await uom("cup");
  beansItem = await insertItem("Biji Kopi");

  brandFood = await newBrand("f");
  brandP = await newBrand("p");
  brandR = await newBrand("r");
  brandS = await newBrand("s");

  // Brand P: two outlets, only P1 has stock and a cost row.
  outletP1 = await stockedOutlet(brandP);
  outletP2 = await newOutlet(brandP);
  const recipeP = await insertRecipe(brandP, "Latte P", [
    { id: beansItem, qty: "18.0000" },
  ]);
  menuP = await insertMenuItem(brandP, "Latte P", recipeP);
  await setPrice(outletP1, menuP, 25_000);
  await rebuild(outletP1);

  // Brand R: one outlet, complete. Brand S: one outlet, never built.
  outletR1 = await stockedOutlet(brandR);
  const recipeR = await insertRecipe(brandR, "Latte R", [
    { id: beansItem, qty: "18.0000" },
  ]);
  menuR = await insertMenuItem(brandR, "Latte R", recipeR);
  await setPrice(outletR1, menuR, 25_000);
  await rebuild(outletR1);
  await newOutlet(brandS); // never built, no stock
  const recipeS = await insertRecipe(brandS, "Latte S", [
    { id: beansItem, qty: "18.0000" },
  ]);
  menuS = await insertMenuItem(brandS, "Latte S", recipeS);

  // Tenant-wide users: one per brand host (each host is pinned to one brand).
  finance = await signedIn("Keuangan HPP Fix", brandFood);
  await assign(finance.userId, { type: "tenant" });
  financeP = await signedIn("Keuangan HPP P", brandP);
  await assign(financeP.userId, { type: "tenant" });
  financeR = await signedIn("Keuangan HPP R", brandR);
  await assign(financeR.userId, { type: "tenant" });
  financeS = await signedIn("Keuangan HPP S", brandS);
  await assign(financeS.userId, { type: "tenant" });
  // Outlet-granted users call on the host of the brand owning their outlet.
  userP1 = await signedIn("Outlet P1", brandP);
  await assign(userP1.userId, { type: "outlet", id: outletP1.id });
  userP2 = await signedIn("Outlet P2", brandP);
  await assign(userP2.userId, { type: "outlet", id: outletP2.id });
  userR1 = await signedIn("Outlet R1", brandR);
  await assign(userR1.userId, { type: "outlet", id: outletR1.id });
});

afterAll(async () => {
  await purgeTenant(tenantA);
  await owner.end();
});

// ===========================================================================

describe("HPP-REPORT-FIX-4 food-cost with pending or unknown stock deductions", () => {
  async function foodCost(outlet: Outlet): Promise<FoodBody> {
    const response = await finance.client.get(foodCostPath(outlet.id));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toHaveLength(1);
    return response.body.data[0] as FoodBody;
  }

  it("HPP-REPORT-FIX-4a a completed order with a pending deduction counts its theoretical cost as actual, not Rp0", async () => {
    const outlet = await stockedOutlet(brandFood);
    const menu = await insertMenuItem(brandFood, "Umum", null);
    const order = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 25_000, costIdr: 5_800 },
    ]);
    await seedDeduction(outlet, order, { status: "pending" });
    // 10 g waste = Rp1.000 on top.
    await move(outlet, beansItem, "waste", "-10.0000");

    const row = await foodCost(outlet);
    expect(row).toMatchObject({
      theoreticalCostIdr: 5_800,
      wasteIdr: 1_000,
      adjustmentIdr: 0,
      offRecipeUsageIdr: 0,
      // Nothing was drawn from stock yet: the order is assumed to cost its
      // theoretical amount, so actual = 5.800 + 1.000 waste.
      actualCostIdr: 6_800,
      varianceIdr: 1_000,
      pendingOrderCount: 1,
      pendingTheoreticalIdr: 5_800,
    });
    expect(row.actualCostIdr).toBe(row.theoreticalCostIdr + row.varianceIdr);
  });

  it("HPP-REPORT-FIX-4b a pending order next to a posted one: only the posted order reconciles against the ledger", async () => {
    const outlet = await stockedOutlet(brandFood);
    const menu = await insertMenuItem(brandFood, "Umum", null);
    // Posted: theoretical Rp5.800, the ledger drew 60 g = Rp6.000 (+Rp200).
    const posted = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 25_000, costIdr: 5_800 },
    ]);
    await seedDeduction(outlet, posted, { status: "posted", costIdr: 6_000 });
    await move(outlet, beansItem, "sale", "-60.0000", posted.ulid);
    // Pending: theoretical Rp4.000, no ledger rows at all.
    const pending = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 20_000, costIdr: 4_000 },
    ]);
    await seedDeduction(outlet, pending, { status: "pending" });
    // Skipped for lack of a recipe: not pending, nothing to draw.
    const noRecipe = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 10_000, costIdr: 0 },
    ]);
    await seedDeduction(outlet, noRecipe, {
      status: "skipped",
      skipReason: "no_recipe",
    });

    const row = await foodCost(outlet);
    expect(row).toMatchObject({
      theoreticalCostIdr: 9_800,
      wasteIdr: 0,
      offRecipeUsageIdr: 0,
      // The posted order's residual (+200) is the only adjustment; the
      // pending order's missing ledger rows must not become a -4.000 surplus.
      adjustmentIdr: 200,
      varianceIdr: 200,
      actualCostIdr: 10_000,
      // 200 x 10.000 / 9.800 = 204,08
      varianceBp: 204,
      pendingOrderCount: 1,
      pendingTheoreticalIdr: 4_000,
    });
    expect(row.varianceIdr).toBe(
      row.wasteIdr + row.adjustmentIdr + row.offRecipeUsageIdr,
    );
  });

  it("HPP-REPORT-FIX-4c orders whose deductions are all posted reconcile as before and report nothing pending", async () => {
    const outlet = await stockedOutlet(brandFood);
    const menu = await insertMenuItem(brandFood, "Umum", null);
    const order = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 2, lineTotalIdr: 50_000, costIdr: 11_600 },
    ]);
    await seedDeduction(outlet, order, { status: "posted", costIdr: 11_600 });
    await move(outlet, beansItem, "sale", "-116.0000", order.ulid);

    const row = await foodCost(outlet);
    expect(row).toMatchObject({
      theoreticalCostIdr: 11_600,
      actualCostIdr: 11_600,
      adjustmentIdr: 0,
      varianceIdr: 0,
      varianceBp: 0,
      pendingOrderCount: 0,
      pendingTheoreticalIdr: 0,
    });
  });

  it("HPP-REPORT-FIX-4d an order with no deduction record at all is unknown, not Rp0", async () => {
    const outlet = await stockedOutlet(brandFood);
    const menu = await insertMenuItem(brandFood, "Umum", null);
    await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 25_000, costIdr: 5_000 },
    ]);

    const row = await foodCost(outlet);
    expect(row).toMatchObject({
      theoreticalCostIdr: 5_000,
      actualCostIdr: 5_000,
      varianceIdr: 0,
      pendingOrderCount: 1,
      pendingTheoreticalIdr: 5_000,
    });
  });

  it("HPP-REPORT-FIX-4e an outlet without sales answers zero pending orders", async () => {
    const outlet = await stockedOutlet(brandFood);
    const row = await foodCost(outlet);
    expect(row).toMatchObject({
      theoreticalCostIdr: 0,
      actualCostIdr: 0,
      pendingOrderCount: 0,
      pendingTheoreticalIdr: 0,
    });
  });
});

describe("HPP-REPORT-FIX-6 recipe-coverage denominator per brand and caller", () => {
  type CoverageBody = {
    menuItemId: string;
    variantId: string | null;
    status: string;
  };

  async function statusOf(
    session: Session,
    brand: Brand,
    menuItemId: string,
    // Assumption: a caller with no reach into the asked brand may be answered
    // with 403 instead of an empty/incomplete list; only the cross-brand cases
    // (6f) accept that, the rest require 200.
    allowForbidden = false,
  ): Promise<string | "absent" | "forbidden"> {
    const result = await readAll<CoverageBody>(
      session,
      `/api/inventory/recipe-coverage?brandId=${brand.id}`,
    );
    if (allowForbidden && result.status === 403) return "forbidden";
    expect(result.status).toBe(200);
    const row = result.rows.find(
      (candidate) =>
        candidate.menuItemId === menuItemId && candidate.variantId === null,
    );
    return row?.status ?? "absent";
  }

  it("HPP-REPORT-FIX-6a a user granted only an outlet with a complete cost row sees the item complete, an unreachable outlet does not count", async () => {
    // P2 (same brand) has no cost row but this user cannot reach it.
    expect(await statusOf(userP1, brandP, menuP)).toBe("complete");
  });

  it("HPP-REPORT-FIX-6b a user granted only an outlet without a complete cost row sees the item incomplete", async () => {
    expect(await statusOf(userP2, brandP, menuP)).toBe("incomplete");
  });

  it("HPP-REPORT-FIX-6c a tenant-wide user still needs every outlet of the brand: the item stays incomplete while one outlet has no cost", async () => {
    expect(await statusOf(financeP, brandP, menuP)).toBe("incomplete");
  });

  it("HPP-REPORT-FIX-6d outlets of another brand never count: a brand whose own outlets are all complete is complete tenant-wide", async () => {
    // Brand S (other brand) has an outlet without costs; brand P too.
    expect(await statusOf(financeR, brandR, menuR)).toBe("complete");
  });

  it("HPP-REPORT-FIX-6e a brand whose own outlet has no cost row stays incomplete", async () => {
    expect(await statusOf(financeS, brandS, menuS)).toBe("incomplete");
  });

  it("HPP-REPORT-FIX-6f a user without any outlet of the item's brand never sees it complete", async () => {
    // R1's user reaches no brand S outlet: incomplete, not listed, or refused.
    expect(await statusOf(userR1, brandS, menuS, true)).not.toBe("complete");
    // And a user of brand P reaches no brand R outlet.
    expect(await statusOf(userP1, brandR, menuR, true)).not.toBe("complete");
  });

  it("HPP-REPORT-FIX-6g the unfiltered list gives each row the status of its own brand", async () => {
    // Each brand host lists at least its own brand. A row of another brand, if
    // the list ever includes one, must still carry that brand's own status.
    const expected = [
      { menu: menuP, status: "incomplete" },
      { menu: menuR, status: "complete" },
      { menu: menuS, status: "incomplete" },
    ];
    const callers = [
      { session: financeP, own: menuP },
      { session: financeR, own: menuR },
      { session: financeS, own: menuS },
    ];
    for (const { session, own } of callers) {
      const all = await readAll<CoverageBody>(
        session,
        "/api/inventory/recipe-coverage",
      );
      expect(all.status).toBe(200);
      const statusFor = (id: string) =>
        all.rows.find((row) => row.menuItemId === id && row.variantId === null)
          ?.status;
      for (const { menu, status } of expected) {
        if (menu === own) expect(statusFor(menu)).toBe(status);
        else if (statusFor(menu) !== undefined)
          expect(statusFor(menu)).toBe(status);
      }
    }
  });
});

// ===========================================================================

/**
 * Remake/comp deduction the recipe engine keeps for an order issue. Seed shape
 * (assumption, taken from the brief): kind 'remake', source_type 'order_issue',
 * source_id = the same order ULID as the sale deduction, its own idempotency key.
 */
async function seedRemakeDeduction(
  outlet: Outlet,
  order: { ulid: string },
  state: { status: "pending" } | { status: "posted"; costIdr: number },
) {
  await q(
    `INSERT INTO recipe_deductions
       (tenant_id, outlet_id, kind, status, mode, source_type, source_id, business_date,
        idempotency_key, cost_idr, skip_reason, occurred_at, posted_at)
     VALUES ($1, $2, 'remake', $3, 'real_time', 'order_issue', $4, $5, $6, $7, NULL, now(), $8)`,
    [
      tenantA,
      outlet.id,
      state.status,
      order.ulid,
      today,
      `order_issue:${order.ulid}:remake`,
      state.status === "posted" ? state.costIdr : null,
      state.status === "posted" ? new Date() : null,
    ],
  );
}

describe("HPP-REPORT-FIX-7 food-cost unknown line costs and pending remake deductions", () => {
  type Body = FoodBody & { pendingUnknownLineCount?: number };

  async function foodCost(outlet: Outlet): Promise<Body> {
    const response = await finance.client.get(foodCostPath(outlet.id));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toHaveLength(1);
    return response.body.data[0] as Body;
  }

  it("HPP-REPORT-FIX-7a a pending order whose lines have no cost snapshot reports how many lines are unknown", async () => {
    const outlet = await stockedOutlet(brandFood);
    const menu = await insertMenuItem(brandFood, "Umum", null);
    // Matched order: costed, reconciles; its lines never count as unknown.
    const posted = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 25_000, costIdr: 5_800 },
    ]);
    await seedDeduction(outlet, posted, { status: "posted", costIdr: 5_800 });
    await move(outlet, beansItem, "sale", "-58.0000", posted.ulid);
    // Pending order: two lines, neither has a cost snapshot.
    const pending = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 20_000, costIdr: null },
      { menuItemId: menu, quantity: 2, lineTotalIdr: 30_000, costIdr: null },
    ]);
    await seedDeduction(outlet, pending, { status: "pending" });

    const row = await foodCost(outlet);
    expect(row.pendingOrderCount).toBe(1);
    // The Rp0 estimate for the pending order is not the real cost: the
    // response must say so instead of presenting the figure as complete.
    expect(row.pendingUnknownLineCount).toBe(2);
    // Matched order unaffected.
    expect(row.theoreticalCostIdr).toBe(5_800);
    expect(row.adjustmentIdr).toBe(0);
  });

  it("HPP-REPORT-FIX-7b a skipped order with an uncosted line is flagged unknown too", async () => {
    const outlet = await stockedOutlet(brandFood);
    const menu = await insertMenuItem(brandFood, "Umum", null);
    const skipped = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 10_000, costIdr: null },
    ]);
    await seedDeduction(outlet, skipped, {
      status: "skipped",
      skipReason: "no_sale_location",
    });

    const row = await foodCost(outlet);
    expect(row.pendingUnknownLineCount).toBeGreaterThan(0);
  });

  it("HPP-REPORT-FIX-7c orders whose lines all have a cost snapshot report zero unknown lines", async () => {
    const outlet = await stockedOutlet(brandFood);
    const menu = await insertMenuItem(brandFood, "Umum", null);
    const pending = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 25_000, costIdr: 5_800 },
    ]);
    await seedDeduction(outlet, pending, { status: "pending" });

    const row = await foodCost(outlet);
    expect(row.pendingOrderCount).toBe(1);
    // Assumption: the field is always present (0 when nothing is unknown).
    expect(row.pendingUnknownLineCount).toBe(0);
  });

  it("HPP-REPORT-FIX-7d sale posted but remake pending: the order counts as pending, actual stays at least theoretical, residual not negative", async () => {
    const outlet = await stockedOutlet(brandFood);
    const menu = await insertMenuItem(brandFood, "Umum", null);
    const order = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 25_000, costIdr: 5_800 },
    ]);
    // The ledger drew only 50 g = Rp5.000 so far (< theoretical Rp5.800); the
    // remake draw is still missing. Treated as matched this would show a
    // -Rp800 residual and an actual below theoretical.
    await seedDeduction(outlet, order, { status: "posted", costIdr: 5_000 });
    await move(outlet, beansItem, "sale", "-50.0000", order.ulid);
    await seedRemakeDeduction(outlet, order, { status: "pending" });

    const row = await foodCost(outlet);
    expect(row.pendingOrderCount).toBe(1);
    expect(row.pendingTheoreticalIdr).toBe(5_800);
    expect(row.theoreticalCostIdr).toBe(5_800);
    expect(row.actualCostIdr).toBeGreaterThanOrEqual(row.theoreticalCostIdr);
    expect(row.adjustmentIdr).toBeGreaterThanOrEqual(0);
    expect(row.varianceIdr).toBeGreaterThanOrEqual(0);
  });

  it("HPP-REPORT-FIX-7e sale posted and remake posted: the order stays matched and reconciles against the ledger", async () => {
    const outlet = await stockedOutlet(brandFood);
    const menu = await insertMenuItem(brandFood, "Umum", null);
    const order = await seedOrder(outlet, [
      { menuItemId: menu, quantity: 1, lineTotalIdr: 25_000, costIdr: 5_800 },
    ]);
    await seedDeduction(outlet, order, { status: "posted", costIdr: 5_800 });
    await move(outlet, beansItem, "sale", "-58.0000", order.ulid);
    await seedRemakeDeduction(outlet, order, { status: "posted", costIdr: 0 });

    const row = await foodCost(outlet);
    expect(row).toMatchObject({
      theoreticalCostIdr: 5_800,
      actualCostIdr: 5_800,
      adjustmentIdr: 0,
      varianceIdr: 0,
      pendingOrderCount: 0,
      pendingTheoreticalIdr: 0,
    });
  });
});
