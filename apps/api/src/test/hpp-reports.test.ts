// HPP reports (bead legend-2qq; PRD v1.7 §17 "HPP Menu beserta margin kotor",
// "Kelengkapan Resep", "Food cost aktual vs teoritis", "Menu Engineering";
// rule "jangan sampai rugi": a cost is never understated or invented).
//
// Endpoints (shared contracts): GET /api/inventory/menu-costs, /food-cost,
// /menu-engineering, /recipe-coverage. Runs against the disposable PostgreSQL
// test database in a tenant this file creates (plus a second tenant for the
// isolation cases) and removes again. Orders, order lines and cost snapshots
// are seeded as the POS leaves them; stock moves through the real
// `recordStockMovement`; menu_costs is filled by the real full rebuild.
//
// Assumptions where the spec/design is silent:
// - Permission: the three cost reports `food-cost`, `menu-engineering` and
//   `menu-costs` need `recipe.cost.view` (outlet scope; a user scoped to one
//   outlet cannot read another outlet). food-cost and menu-engineering must
//   answer 403 without it. menu-costs and recipe-coverage MAY either answer 403
//   or answer 200 with every cost and margin masked to null (design: "mask to
//   null without recipe.cost.view"); both are accepted, a revealed cost is not.
// - A signed-in user without any assignment gets 403; no session gets 401; a
//   malformed or missing query value gets 422.
// - food-cost answers exactly one row for outlet + period, also for an empty
//   period (all zeros).
// - Today's business date is the Asia/Jakarta calendar date; the period
//   [today - 2, today + 1] contains every ledger row the tests write now,
//   whatever the outlet's business-day cutoff is.
// - A voided order that was already drawn from stock has its stock returned
//   (ledger `return` / source `order`, same quantity and cost), so it adds
//   nothing to the "sale ledger vs theoretical" residual. Training orders draw
//   no stock.
// - Menu engineering: an item with a NULL cost snapshot line in range is not
//   listed. Its single unit does not move any class here (checked for both
//   counting and not counting it).
// - Recipe coverage cost comes from menu_costs; a menu item is complete only
//   when every outlet of the tenant has a complete row (the coverage test
//   fills outletScoped itself).
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
import {
  foodCostComparisonSchema,
  menuCostSchema,
  menuEngineeringRowSchema,
  recipeCoverageRowSchema,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { rebuildMenuCostsForOutlet } from "../services/hpp-recompute.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { agent, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const brandA2 = randomUUID();
const legalEntityA = randomUUID();
const slugA = `hrp${randomUUID().slice(0, 8)}`;
const hostA = `tenant-${slugA}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
let app: Express;
const short = () => randomUUID().slice(0, 6);

// -------------------------------------------------------------------- dates

/** The Asia/Jakarta calendar date of now: the business date of today's sales. */
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
const emptyFrom = "2020-01-01";
const emptyTo = "2020-01-31";

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
let categoryId: string;
let categoryA2: string;
let costRoleId: string;
let noCostRoleId: string;

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
  for (const [id, suffix] of [
    [brandA, "a"],
    [brandA2, "b"],
  ] as const)
    await q(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      [id, tenantA, `brand-${suffix}-${slugA}`, `Brand ${suffix} ${slugA}`],
    );
  await q(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityA, tenantA, `Entity ${slugA}`],
  );
  await q(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantA, brandA, hostA],
  );
  // Custom roles: with and without the cost permission.
  costRoleId = randomUUID();
  noCostRoleId = randomUUID();
  for (const [id, name, permissions] of [
    [
      costRoleId,
      "Biaya HPP",
      ["recipe.cost.view", "recipe.manage", "inventory.stock.view"],
    ],
    [
      noCostRoleId,
      "Tanpa Biaya HPP",
      ["recipe.manage", "inventory.stock.view"],
    ],
  ] as const)
    await q(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","brand","outlet"]')`,
      [id, tenantA, name, JSON.stringify(permissions)],
    );
}

type Outlet = { id: string; location: string };

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

async function insertItem(name: string): Promise<string> {
  return one<string>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, gramId],
  );
}

type Movement =
  "receipt" | "sale" | "return" | "waste" | "duty_meal" | "adjustment";

const SOURCE_OF: Record<Movement, string> = {
  receipt: "goods_receipt",
  sale: "order",
  return: "order",
  waste: "waste_log",
  duty_meal: "duty_meal",
  adjustment: "stock_count",
};

/** One real stock movement at Rp100 per gram (the average cost of the item). */
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

/** An outlet holding 100.000 g of one item at Rp100 per gram. */
async function stockedOutlet(): Promise<{ outlet: Outlet; item: string }> {
  const outlet = await newOutlet();
  const item = await insertItem("Biji Kopi");
  await move(outlet, item, "receipt", "100000.0000");
  return { outlet, item };
}

async function insertRecipe(
  name: string,
  lines: { id: string; qty: string }[],
): Promise<string> {
  const recipeId = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, true, $5) RETURNING id`,
    [tenantA, brandA, `${name} ${short()}`, cupId, ownerUserId],
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
  name: string,
  recipeId: string | null,
  brandId = brandA,
  category = categoryId,
): Promise<string> {
  return one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantA, brandId, category, `${name} ${short()}`, recipeId],
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
  /** Whole-line cost snapshot; null = unknown. */
  costIdr: number | null;
};

/** A POS order with its lines and cost snapshots, as the POS leaves it. */
async function seedOrder(
  outlet: Outlet,
  lines: OrderLine[],
  options: {
    voided?: boolean;
    training?: boolean;
    businessDate?: string;
  } = {},
): Promise<{ ulid: string; uuid: string }> {
  const businessDate = options.businessDate ?? today;
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  const total = lines.reduce((sum, line) => sum + line.lineTotalIdr, 0);
  await q(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
        status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $6, 0, 0, 0, 0, $6,
             $7, $5, now())`,
    [
      uuid,
      tenantA,
      outlet.id,
      `HPPR-${randomUUID().slice(0, 12)}`,
      businessDate,
      total,
      options.voided ? "sent" : "completed",
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
        businessDate,
        line.costIdr,
      ],
    );
  await q(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
     VALUES ($1, $2, $3, 'pos', $4)`,
    [uuid, tenantA, outlet.id, options.training ?? false],
  );
  if (options.voided)
    await q(
      `UPDATE orders SET status = 'voided', voided_at = now(), void_reason = 'Batal di kasir'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA, uuid],
    );
  return { ulid, uuid };
}

/**
 * The posted sale deduction of an order (as the recipe engine leaves it, with
 * the ULID as source id). Food cost only reconciles orders against the sale
 * ledger when their deduction is posted; the others count as pending.
 */
async function seedPostedDeduction(
  outlet: Outlet,
  order: { ulid: string },
  costIdr: number,
) {
  await q(
    `INSERT INTO recipe_deductions
       (tenant_id, outlet_id, kind, status, mode, source_type, source_id, business_date,
        idempotency_key, cost_idr, occurred_at, posted_at)
     VALUES ($1, $2, 'sale', 'posted', 'real_time', 'order', $3, $4, $5, $6, now(), now())`,
    [tenantA, outlet.id, order.ulid, today, `order:${order.ulid}`, costIdr],
  );
}

// ------------------------------------------------------------- users & http

type Session = { client: ReturnType<typeof agent>; userId: string };

async function signedIn(name: string): Promise<Session> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  client.set("Host", hostA);
  return { client, userId };
}

async function assign(
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await q(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantA,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/** Reads every page of a list endpoint. */
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

const menuCostsPath = (outletId: string, extra = "") =>
  `/api/inventory/menu-costs?outletId=${outletId}${extra}`;
const foodCostPath = (outletId: string, from = periodFrom, to = periodTo) =>
  `/api/inventory/food-cost?outletId=${outletId}&fromDate=${from}&toDate=${to}`;
const engineeringPath = (outletId: string, from = periodFrom, to = periodTo) =>
  `/api/inventory/menu-engineering?outletId=${outletId}&fromDate=${from}&toDate=${to}`;
const coveragePath = (extra = "") => `/api/inventory/recipe-coverage${extra}`;

type CostBody = {
  menuItemId: string;
  variantId: string | null;
  recipeId: string | null;
  recipeComplete: boolean;
  theoreticalCostIdr: string | null;
  priceIdr: number;
  grossMarginBp: number | null;
};

// --------------------------------------------------------------------- world

let outletMain: Outlet; // menu_costs filled
let outletScoped: Outlet; // the scoped user's only outlet
let finance: Session; // recipe.cost.view, tenant scope
let scoped: Session; // recipe.cost.view, outletScoped only
let plain: Session; // no recipe.cost.view
let nobody: Session; // no assignment at all
let latteMenu: string;
let lattePrice: number;
let freeMenu: string;
let noRecipeMenu: string;
let brand2Menu: string;
let latteRecipe: string;
let freeRecipe: string;
let beansItem: string;
let milkItem: string;

let tenantB: IsolatedTenant | null = null;
let staffB: Staff;
let hostB: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  await createOwnTenant();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "HPP Reports Owner", `${ownerUserId}@example.com`],
  );
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  cupId = await uom("cup");
  categoryId = randomUUID();
  categoryA2 = randomUUID();
  for (const [id, brand] of [
    [categoryId, brandA],
    [categoryA2, brandA2],
  ] as const)
    await q(
      "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'HPP Uji', 0)",
      [id, tenantA, brand],
    );

  // Main outlet: a complete menu item (price Rp25.000), an incomplete one
  // (an ingredient with average cost 0) and one without a recipe.
  outletMain = await newOutlet();
  outletScoped = await newOutlet();
  const beans = await insertItem("Biji Kopi");
  const milk = await insertItem("Susu");
  beansItem = beans;
  milkItem = milk;
  const free = await insertItem("Bahan Gratis");
  await move(
    outletMain,
    beans,
    "receipt",
    "1000.0000",
    randomUUID(),
    "100.0000",
  );
  await move(
    outletMain,
    milk,
    "receipt",
    "10000.0000",
    randomUUID(),
    "20.0000",
  );
  await move(outletMain, free, "receipt", "1000.0000", randomUUID(), "0.0000");
  // 18 g beans (Rp100) + 200 g milk (Rp20) = Rp5.800 per cup.
  latteRecipe = await insertRecipe("Latte", [
    { id: beans, qty: "18.0000" },
    { id: milk, qty: "200.0000" },
  ]);
  latteMenu = await insertMenuItem("Latte", latteRecipe);
  lattePrice = 25_000;
  await setPrice(outletMain, latteMenu, lattePrice);
  freeRecipe = await insertRecipe("Kopi Gratis", [
    { id: beans, qty: "18.0000" },
    { id: free, qty: "10.0000" },
  ]);
  freeMenu = await insertMenuItem("Kopi Gratis", freeRecipe);
  noRecipeMenu = await insertMenuItem("Tanpa Resep", null);
  brand2Menu = await insertMenuItem("Merek Dua", null, brandA2, categoryA2);
  await rebuildMenuCostsForOutlet(
    tenantContext(),
    outletIdSchema.parse(outletMain.id),
  );

  finance = await signedIn("Keuangan HPP");
  await assign(finance.userId, costRoleId, { type: "tenant" });
  scoped = await signedIn("Outlet HPP");
  await assign(scoped.userId, costRoleId, {
    type: "outlet",
    id: outletScoped.id,
  });
  plain = await signedIn("Dapur HPP");
  await assign(plain.userId, noCostRoleId, { type: "tenant" });
  nobody = await signedIn("Tanpa Peran HPP");

  tenantB = await createIsolatedTenant(`hrp${short()}`);
  hostB = tenantB.hostname;
  await owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenantB.tenantId,
      JSON.stringify(cafeLegendPlatformFixtures.tenant.featureFlags),
    ],
  );
  await owner.query("UPDATE roles SET permissions = $2::jsonb WHERE id = $1", [
    tenantB.roleId,
    JSON.stringify([
      "recipe.cost.view",
      "recipe.manage",
      "inventory.stock.view",
    ]),
  ]);
  staffB = await staffOfIsolatedTenant(app, tenantB);
});

afterAll(async () => {
  if (tenantB) await dropIsolatedTenant(tenantB);
  await purgeTenant(tenantA);
  await owner.end();
});

/** Passes when the answer is a refusal, or every cost and margin is hidden. */
function expectDeniedOrMasked(
  response: { status: number; body: { data?: unknown[] } },
  costFields: string[],
) {
  if (response.status === 200) {
    for (const row of (response.body.data ?? []) as Record<string, unknown>[])
      for (const field of costFields)
        expect(row[field] ?? null, `${field} must stay hidden`).toBeNull();
    return;
  }
  expect(response.status).toBe(403);
}

// ===========================================================================

describe("HPP-REPORT menu-costs (listMenuCosts)", () => {
  it("HPP-REPORT-menu-costs shows theoretical cost, price and gross margin of a complete menu item", async () => {
    const response = await finance.client.get(
      menuCostsPath(outletMain.id, `&menuItemId=${latteMenu}`),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = response.body.data as CostBody[];
    expect(rows).toHaveLength(1);
    const row = menuCostSchema.parse(rows[0]);
    expect(row).toMatchObject({
      tenantId: tenantA,
      outletId: outletMain.id,
      menuItemId: latteMenu,
      variantId: null,
      modifierId: null,
      recipeId: latteRecipe,
      recipeComplete: true,
      theoreticalCostIdr: "5800.0000",
      priceIdr: lattePrice,
      // (25.000 - 5.800) x 10.000 / 25.000
      grossMarginBp: 7_680,
    });
  });

  it("HPP-REPORT-menu-costs an incomplete recipe has no cost and no margin, never 0", async () => {
    const response = await finance.client.get(
      menuCostsPath(outletMain.id, `&menuItemId=${freeMenu}`),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = response.body.data as CostBody[];
    expect(rows).toHaveLength(1);
    const row = menuCostSchema.parse(rows[0]);
    expect(row).toMatchObject({
      menuItemId: freeMenu,
      recipeId: freeRecipe,
      recipeComplete: false,
      theoreticalCostIdr: null,
      grossMarginBp: null,
    });
  });

  it("HPP-REPORT-menu-costs without a menu item filter lists the outlet's menu items across pages", async () => {
    const all = await readAll<CostBody>(finance, menuCostsPath(outletMain.id));
    expect(all.status).toBe(200);
    const ids = all.rows.map((row) => row.menuItemId);
    expect(ids).toContain(latteMenu);
    expect(ids).toContain(freeMenu);

    // One row per page: the cursor walks the same rows without repeats.
    const paged = await readAll<CostBody>(
      finance,
      menuCostsPath(outletMain.id, "&limit=1"),
    );
    expect(paged.rows.map((row) => row.menuItemId).sort()).toEqual(
      [...ids].sort(),
    );
    const first = await finance.client.get(
      menuCostsPath(outletMain.id, "&limit=1"),
    );
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.nextCursor).not.toBeNull();
  });

  it("HPP-REPORT-menu-costs an outlet with no costs yet answers an empty page", async () => {
    const response = await finance.client.get(menuCostsPath(outletScoped.id));
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta.nextCursor).toBeNull();
  });

  it("HPP-REPORT-menu-costs needs a session and a valid outlet id", async () => {
    expect(
      (await agent(app).get(menuCostsPath(outletMain.id)).set("Host", hostA))
        .status,
    ).toBe(401);
    expect((await finance.client.get(menuCostsPath("nope"))).status).toBe(422);
    expect((await finance.client.get("/api/inventory/menu-costs")).status).toBe(
      422,
    );
  });

  it("HPP-REPORT-menu-costs hides cost and margin from a user without recipe.cost.view", async () => {
    expectDeniedOrMasked(
      await plain.client.get(
        menuCostsPath(outletMain.id, `&menuItemId=${latteMenu}`),
      ),
      ["theoreticalCostIdr", "grossMarginBp"],
    );
    expect((await nobody.client.get(menuCostsPath(outletMain.id))).status).toBe(
      403,
    );
  });

  it("HPP-REPORT-menu-costs a user scoped to one outlet cannot read another outlet", async () => {
    expect(
      (await scoped.client.get(menuCostsPath(outletScoped.id))).status,
    ).toBe(200);
    expect((await scoped.client.get(menuCostsPath(outletMain.id))).status).toBe(
      403,
    );
  });
});

describe("HPP-REPORT recipe-coverage (listRecipeCoverage)", () => {
  type CoverageBody = {
    menuItemId: string;
    variantId: string | null;
    status: string;
    recipeId: string | null;
    theoreticalCostIdr: string | null;
  };

  const rowOf = (rows: CoverageBody[], menuItemId: string) =>
    rows.find((row) => row.menuItemId === menuItemId && row.variantId === null);

  it("HPP-REPORT-coverage marks every menu item complete, incomplete or no_recipe", async () => {
    // Complete needs a complete cost row in EVERY outlet: fill the scoped one
    // here (not in beforeAll, the menu-costs test needs it empty).
    await move(
      outletScoped,
      beansItem,
      "receipt",
      "1000.0000",
      randomUUID(),
      "100.0000",
    );
    await move(
      outletScoped,
      milkItem,
      "receipt",
      "10000.0000",
      randomUUID(),
      "20.0000",
    );
    await rebuildMenuCostsForOutlet(
      tenantContext(),
      outletIdSchema.parse(outletScoped.id),
    );
    const all = await readAll<CoverageBody>(finance, coveragePath());
    expect(all.status).toBe(200);
    for (const row of all.rows) recipeCoverageRowSchema.parse(row);

    expect(rowOf(all.rows, latteMenu)).toMatchObject({
      status: "complete",
      recipeId: latteRecipe,
      theoreticalCostIdr: "5800.0000",
    });
    expect(rowOf(all.rows, freeMenu)).toMatchObject({
      status: "incomplete",
      recipeId: freeRecipe,
      theoreticalCostIdr: null,
    });
    expect(rowOf(all.rows, noRecipeMenu)).toMatchObject({
      status: "no_recipe",
      recipeId: null,
      theoreticalCostIdr: null,
    });
  });

  it("HPP-REPORT-coverage can be limited to one brand", async () => {
    const brand2 = await readAll<CoverageBody>(
      finance,
      coveragePath(`?brandId=${brandA2}`),
    );
    expect(brand2.status).toBe(200);
    expect(brand2.rows.map((row) => row.menuItemId)).toEqual([brand2Menu]);

    const brand1 = await readAll<CoverageBody>(
      finance,
      coveragePath(`?brandId=${brandA}`),
    );
    const ids = brand1.rows.map((row) => row.menuItemId);
    expect(ids).toContain(latteMenu);
    expect(ids).not.toContain(brand2Menu);
  });

  it("HPP-REPORT-coverage a brand without menu items answers an empty page", async () => {
    const emptyBrand = randomUUID();
    await q(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      [emptyBrand, tenantA, `brand-e-${short()}`, "Merek Kosong"],
    );
    const response = await finance.client.get(
      coveragePath(`?brandId=${emptyBrand}`),
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it("HPP-REPORT-coverage needs a session and a valid brand id", async () => {
    expect(
      (await agent(app).get(coveragePath()).set("Host", hostA)).status,
    ).toBe(401);
    expect(
      (await finance.client.get(coveragePath("?brandId=nope"))).status,
    ).toBe(422);
    expect((await nobody.client.get(coveragePath())).status).toBe(403);
  });

  it("HPP-REPORT-coverage hides cost from a user without recipe.cost.view", async () => {
    expectDeniedOrMasked(await plain.client.get(coveragePath()), [
      "theoreticalCostIdr",
    ]);
  });
});

describe("HPP-REPORT food-cost (listFoodCostComparisons)", () => {
  type FoodBody = {
    tenantId: string;
    outletId: string;
    fromDate: string;
    toDate: string;
    theoreticalCostIdr: number;
    actualCostIdr: number;
    varianceIdr: number;
    varianceBp: number;
    wasteIdr: number;
    adjustmentIdr: number;
    offRecipeUsageIdr: number;
  };

  async function foodCost(
    outletId: string,
    from = periodFrom,
    to = periodTo,
  ): Promise<FoodBody> {
    const response = await finance.client.get(foodCostPath(outletId, from, to));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toHaveLength(1);
    return foodCostComparisonSchema.parse(response.body.data[0]) as FoodBody;
  }

  it("HPP-REPORT-food actual cost = theoretical + waste + adjustment + off-recipe usage", async () => {
    const { outlet, item } = await stockedOutlet();
    const plainMenu = await insertMenuItem("Umum", null);
    // Completed orders: Rp11.600 + Rp5.800 = theoretical Rp17.400 ...
    const order1 = await seedOrder(outlet, [
      {
        menuItemId: plainMenu,
        quantity: 2,
        lineTotalIdr: 50_000,
        costIdr: 11_600,
      },
    ]);
    const order2 = await seedOrder(outlet, [
      {
        menuItemId: plainMenu,
        quantity: 1,
        lineTotalIdr: 25_000,
        costIdr: 5_800,
      },
    ]);
    await seedPostedDeduction(outlet, order1, 11_600);
    await seedPostedDeduction(outlet, order2, 5_800);
    // ... drawn from stock as 174 g at Rp100 (the sale ledger agrees).
    await move(outlet, item, "sale", "-116.0000", order1.ulid);
    await move(outlet, item, "sale", "-58.0000", order2.ulid);
    // Waste 10 g + 2,5 g = Rp1.250; duty meal 20 g = Rp2.000.
    await move(outlet, item, "waste", "-10.0000");
    await move(outlet, item, "waste", "-2.5000");
    await move(outlet, item, "duty_meal", "-20.0000");
    // Count correction: 5 g short (+Rp500 loss), 2 g surplus (-Rp200).
    await move(outlet, item, "adjustment", "-5.0000");
    await move(outlet, item, "adjustment", "2.0000");
    // Noise that must not count: a voided order, a training order, an order
    // outside the period and an order of another outlet.
    await seedOrder(
      outlet,
      [
        {
          menuItemId: plainMenu,
          quantity: 1,
          lineTotalIdr: 25_000,
          costIdr: 99_999,
        },
      ],
      { voided: true },
    );
    await seedOrder(
      outlet,
      [
        {
          menuItemId: plainMenu,
          quantity: 1,
          lineTotalIdr: 25_000,
          costIdr: 77_777,
        },
      ],
      { training: true },
    );
    await seedOrder(
      outlet,
      [
        {
          menuItemId: plainMenu,
          quantity: 1,
          lineTotalIdr: 25_000,
          costIdr: 88_888,
        },
      ],
      { businessDate: "2031-01-01" },
    );
    await seedOrder(await newOutlet(), [
      {
        menuItemId: plainMenu,
        quantity: 1,
        lineTotalIdr: 25_000,
        costIdr: 66_666,
      },
    ]);

    const row = await foodCost(outlet.id);
    expect(row).toMatchObject({
      tenantId: tenantA,
      outletId: outlet.id,
      fromDate: periodFrom,
      toDate: periodTo,
      theoreticalCostIdr: 17_400,
      wasteIdr: 1_250,
      offRecipeUsageIdr: 2_000,
      adjustmentIdr: 300,
      varianceIdr: 3_550,
      actualCostIdr: 20_950,
      // 3.550 x 10.000 / 17.400 = 2.040,23
      varianceBp: 2_040,
    });
    // The identity the contract promises.
    expect(row.varianceIdr).toBe(
      row.wasteIdr + row.adjustmentIdr + row.offRecipeUsageIdr,
    );
    expect(row.actualCostIdr).toBe(row.theoreticalCostIdr + row.varianceIdr);
  });

  it("HPP-REPORT-food a voided order counts for neither theoretical cost nor variance", async () => {
    const { outlet, item } = await stockedOutlet();
    const plainMenu = await insertMenuItem("Umum", null);
    const sold = await seedOrder(outlet, [
      {
        menuItemId: plainMenu,
        quantity: 1,
        lineTotalIdr: 25_000,
        costIdr: 5_800,
      },
    ]);
    await seedPostedDeduction(outlet, sold, 5_800);
    await move(outlet, item, "sale", "-58.0000", sold.ulid);
    // The voided order drew 58 g, then the void returned them.
    const voided = await seedOrder(
      outlet,
      [
        {
          menuItemId: plainMenu,
          quantity: 1,
          lineTotalIdr: 25_000,
          costIdr: 5_800,
        },
      ],
      { voided: true },
    );
    await move(outlet, item, "sale", "-58.0000", voided.ulid);
    await move(outlet, item, "return", "58.0000", voided.ulid);

    expect(await foodCost(outlet.id)).toMatchObject({
      theoreticalCostIdr: 5_800,
      actualCostIdr: 5_800,
      varianceIdr: 0,
      varianceBp: 0,
      wasteIdr: 0,
      adjustmentIdr: 0,
      offRecipeUsageIdr: 0,
    });
  });

  it("HPP-REPORT-food actual cost never goes below zero (a large surplus is clamped)", async () => {
    const { outlet, item } = await stockedOutlet();
    const plainMenu = await insertMenuItem("Umum", null);
    const sold = await seedOrder(outlet, [
      {
        menuItemId: plainMenu,
        quantity: 1,
        lineTotalIdr: 5_000,
        costIdr: 1_000,
      },
    ]);
    await seedPostedDeduction(outlet, sold, 1_000);
    await move(outlet, item, "sale", "-10.0000", sold.ulid);
    // 100 g surplus = Rp10.000 less loss than a perfect count.
    await move(outlet, item, "adjustment", "100.0000");

    const row = await foodCost(outlet.id);
    expect(row.theoreticalCostIdr).toBe(1_000);
    expect(row.actualCostIdr).toBe(0);
    expect(row.varianceIdr).toBe(-1_000);
    expect(row.varianceBp).toBe(-10_000);
  });

  it("HPP-REPORT-food a period without sales or stock movement answers one all-zero row", async () => {
    const { outlet, item } = await stockedOutlet();
    await move(outlet, item, "waste", "-10.0000"); // today, outside 2020
    expect(await foodCost(outlet.id, emptyFrom, emptyTo)).toMatchObject({
      fromDate: emptyFrom,
      toDate: emptyTo,
      theoreticalCostIdr: 0,
      actualCostIdr: 0,
      varianceIdr: 0,
      varianceBp: 0,
      wasteIdr: 0,
      adjustmentIdr: 0,
      offRecipeUsageIdr: 0,
    });
  });

  it("HPP-REPORT-food needs recipe.cost.view, a session, outlet scope and a valid period", async () => {
    const { outlet } = await stockedOutlet();
    expect(
      (await agent(app).get(foodCostPath(outlet.id)).set("Host", hostA)).status,
    ).toBe(401);
    expect((await plain.client.get(foodCostPath(outlet.id))).status).toBe(403);
    expect((await nobody.client.get(foodCostPath(outlet.id))).status).toBe(403);
    expect(
      (await scoped.client.get(foodCostPath(outletScoped.id))).status,
    ).toBe(200);
    expect((await scoped.client.get(foodCostPath(outlet.id))).status).toBe(403);
    expect(
      (
        await finance.client.get(
          `/api/inventory/food-cost?outletId=${outlet.id}&toDate=${periodTo}`,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await finance.client.get(
          `/api/inventory/food-cost?outletId=${outlet.id}&fromDate=31-12-2026&toDate=${periodTo}`,
        )
      ).status,
    ).toBe(422);
  });
});

describe("HPP-REPORT menu-engineering (listMenuEngineering)", () => {
  type EngineeringBody = {
    tenantId: string;
    outletId: string;
    menuItemId: string;
    unitsSold: number;
    grossMarginIdr: number;
    classification: string;
  };

  const menu = async (name: string) => insertMenuItem(name, null);

  it("HPP-REPORT-engineering classifies items by popularity and margin; void, training, other periods and unknown costs stay out", async () => {
    const outlet = await newOutlet();
    const star = await menu("Bintang");
    const plowhorse = await menu("Kuda Beban");
    const puzzle = await menu("Teka-teki");
    const dog = await menu("Anjing");
    const unknown = await menu("Biaya Tak Diketahui");
    const line = (
      menuItemId: string,
      quantity: number,
      lineTotalIdr: number,
      costIdr: number | null,
    ): OrderLine => ({ menuItemId, quantity, lineTotalIdr, costIdr });

    // Star: 40 units, Rp15.000 margin per unit. Plowhorse: 40 units, Rp2.000.
    // Puzzle: 5 units, Rp20.000. Dog: 5 units, Rp1.000.
    await seedOrder(outlet, [
      line(star, 20, 500_000, 200_000),
      line(plowhorse, 40, 480_000, 400_000),
      line(puzzle, 5, 150_000, 50_000),
    ]);
    await seedOrder(outlet, [
      line(star, 20, 500_000, 200_000),
      line(dog, 5, 55_000, 50_000),
      line(unknown, 1, 20_000, null),
    ]);
    // Noise: voided and training orders, and one outside the period.
    await seedOrder(outlet, [line(dog, 99, 1_089_000, 1_000_000)], {
      voided: true,
    });
    await seedOrder(outlet, [line(plowhorse, 99, 1_188_000, 1_000_000)], {
      training: true,
    });
    await seedOrder(outlet, [line(puzzle, 99, 2_970_000, 1_000_000)], {
      businessDate: "2031-01-01",
    });

    const all = await readAll<EngineeringBody>(
      finance,
      engineeringPath(outlet.id),
    );
    expect(all.status).toBe(200);
    for (const row of all.rows) menuEngineeringRowSchema.parse(row);
    const byItem = new Map(all.rows.map((row) => [row.menuItemId, row]));

    expect(byItem.get(star)).toMatchObject({
      tenantId: tenantA,
      outletId: outlet.id,
      unitsSold: 40,
      grossMarginIdr: 600_000,
      classification: "star",
    });
    expect(byItem.get(plowhorse)).toMatchObject({
      unitsSold: 40,
      grossMarginIdr: 80_000,
      classification: "plowhorse",
    });
    expect(byItem.get(puzzle)).toMatchObject({
      unitsSold: 5,
      grossMarginIdr: 100_000,
      classification: "puzzle",
    });
    expect(byItem.get(dog)).toMatchObject({
      unitsSold: 5,
      grossMarginIdr: 5_000,
      classification: "dog",
    });
    expect(byItem.has(unknown)).toBe(false);
    expect(all.rows).toHaveLength(4);
  });

  it("HPP-REPORT-engineering a period without sales answers an empty page", async () => {
    const outlet = await newOutlet();
    const response = await finance.client.get(
      engineeringPath(outlet.id, emptyFrom, emptyTo),
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta.nextCursor).toBeNull();
  });

  it("HPP-REPORT-engineering needs recipe.cost.view, a session, outlet scope and a valid period", async () => {
    const outlet = await newOutlet();
    expect(
      (await agent(app).get(engineeringPath(outlet.id)).set("Host", hostA))
        .status,
    ).toBe(401);
    expect((await plain.client.get(engineeringPath(outlet.id))).status).toBe(
      403,
    );
    expect((await nobody.client.get(engineeringPath(outlet.id))).status).toBe(
      403,
    );
    expect(
      (await scoped.client.get(engineeringPath(outletScoped.id))).status,
    ).toBe(200);
    expect((await scoped.client.get(engineeringPath(outlet.id))).status).toBe(
      403,
    );
    expect(
      (
        await finance.client.get(
          `/api/inventory/menu-engineering?outletId=${outlet.id}&fromDate=${periodFrom}`,
        )
      ).status,
    ).toBe(422);
  });
});

describe("TEN-01 TEN-03 HPP reports never cross tenants", () => {
  it("HPP-REPORT-isolation tenant B cannot read tenant A's outlet reports", async () => {
    const asB = (path: string) => staffB.client.get(path).set("Host", hostB);
    for (const path of [
      menuCostsPath(outletMain.id),
      foodCostPath(outletMain.id),
      engineeringPath(outletMain.id),
    ]) {
      const response = await asB(path);
      expect([403, 404], path).toContain(response.status);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(latteMenu);
      expect(text).not.toContain(latteRecipe);
    }
  });

  it("HPP-REPORT-isolation tenant B's recipe coverage lists none of tenant A's menu items", async () => {
    const response = await staffB.client.get(coveragePath()).set("Host", hostB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain(latteMenu);
  });
});

// ===========================================================================
// Review defects (bead legend-2qq). These blocks were added after review and
// must fail until the coverage report is fixed.
//
// Assumptions where the spec/design is silent:
// - Coverage is tenant-wide, one row per menu item, per variant and per
//   modifier; a variant or modifier row carries `variantId` / `modifierId`.
// - A variant WITHOUT its own recipe is costed with its menu item's recipe, so
//   its coverage status is the menu item's status (complete or incomplete),
//   never `no_recipe`, and its `recipeId` is not null (the row schema ties
//   `recipeId` to the status).
// - A modifier of a soft-deleted modifier group is not sold, so it is not
//   listed, whether or not it had a cost row before the group was deleted.
// - Coverage of a menu item is `complete` only when EVERY outlet of the tenant
//   has a complete menu_costs row for it; an outlet without a complete row
//   (no row, no stock, an average cost of 0) makes it `incomplete`.
// - Because the status depends on every outlet of the tenant, these tests
//   stock the item they check in the outlets they want complete and rebuild
//   menu_costs for ALL outlets of the tenant before they read the report.
describe("HPP-REPORT recipe-coverage defects found in review", () => {
  type CoverageBody = {
    menuItemId: string;
    variantId: string | null;
    modifierId: string | null;
    status: string;
    recipeId: string | null;
    theoreticalCostIdr: string | null;
  };

  async function outletsOfTenant(): Promise<Outlet[]> {
    return q<Outlet>(
      `SELECT o.id::text AS id, s.sale_location_id::text AS location
         FROM outlets o
         JOIN outlet_inventory_settings s
           ON s.tenant_id = o.tenant_id AND s.outlet_id = o.id
        WHERE o.tenant_id = $1
        ORDER BY o.id`,
      [tenantA],
    );
  }

  /** Receives the item (1.000 g) in each given outlet at the given unit cost. */
  async function stock(
    itemId: string,
    outlets: Outlet[],
    unitCost = "100.0000",
  ) {
    for (const outlet of outlets)
      await move(
        outlet,
        itemId,
        "receipt",
        "1000.0000",
        randomUUID(),
        unitCost,
      );
  }

  async function refreshAllOutlets() {
    for (const outlet of await outletsOfTenant())
      await rebuildMenuCostsForOutlet(
        tenantContext(),
        outletIdSchema.parse(outlet.id),
      );
  }

  async function coverageRows(): Promise<CoverageBody[]> {
    const all = await readAll<CoverageBody>(finance, coveragePath());
    expect(all.status).toBe(200);
    return all.rows;
  }

  const rowOf = (rows: CoverageBody[], menuItemId: string) =>
    rows.find(
      (row) =>
        row.menuItemId === menuItemId &&
        row.variantId === null &&
        row.modifierId === null,
    );

  it("HPP-REPORT-coverage-variant a variant without its own recipe takes the status of its menu item, not no_recipe", async () => {
    const outlets = await outletsOfTenant();
    const beans = await insertItem("Biji Varian");
    const free = await insertItem("Bahan Gratis Varian");
    await stock(beans, outlets);
    await stock(free, outlets, "0.0000");
    const completeRecipe = await insertRecipe("Kopi Varian", [
      { id: beans, qty: "10.0000" },
    ]);
    const completeMenu = await insertMenuItem("Kopi Varian", completeRecipe);
    const incompleteRecipe = await insertRecipe("Kopi Varian Gratis", [
      { id: beans, qty: "10.0000" },
      { id: free, qty: "5.0000" },
    ]);
    const incompleteMenu = await insertMenuItem(
      "Kopi Varian Gratis",
      incompleteRecipe,
    );
    const variantOfComplete = await one<string>(
      "INSERT INTO item_variants (tenant_id, menu_item_id, name, recipe_id) VALUES ($1, $2, $3, NULL) RETURNING id",
      [tenantA, completeMenu, `Besar ${short()}`],
    );
    const variantOfIncomplete = await one<string>(
      "INSERT INTO item_variants (tenant_id, menu_item_id, name, recipe_id) VALUES ($1, $2, $3, NULL) RETURNING id",
      [tenantA, incompleteMenu, `Besar ${short()}`],
    );
    await refreshAllOutlets();

    const rows = await coverageRows();
    expect(rowOf(rows, completeMenu)).toMatchObject({ status: "complete" });
    expect(rowOf(rows, incompleteMenu)).toMatchObject({
      status: "incomplete",
    });
    const complete = rows.find((row) => row.variantId === variantOfComplete);
    expect(complete, "coverage row of the variant").toBeDefined();
    expect(complete!.status).toBe("complete");
    expect(complete!.recipeId).not.toBeNull();
    const incomplete = rows.find(
      (row) => row.variantId === variantOfIncomplete,
    );
    expect(incomplete, "coverage row of the variant").toBeDefined();
    expect(incomplete!.status).toBe("incomplete");
    expect(incomplete!.recipeId).not.toBeNull();
  });

  it("HPP-REPORT-coverage-modifier modifiers of a soft-deleted modifier group are not listed", async () => {
    const outlets = await outletsOfTenant();
    const beans = await insertItem("Biji Modifier");
    await stock(beans, outlets);
    const menu = await insertMenuItem(
      "Kopi Modifier",
      await insertRecipe("Kopi Modifier", [{ id: beans, qty: "10.0000" }]),
    );

    const addGroup = async (name: string, deleted: boolean) => {
      const groupId = await one<string>(
        `INSERT INTO modifier_groups (tenant_id, name, min_select, max_select, deleted_at)
         VALUES ($1, $2, 0, 5, ${deleted ? "now()" : "NULL"}) RETURNING id`,
        [tenantA, `${name} ${short()}`],
      );
      const modifierId = await one<string>(
        `INSERT INTO modifiers (tenant_id, group_id, name, recipe_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          tenantA,
          groupId,
          `${name} ${short()}`,
          await insertRecipe(`Resep ${name}`, [{ id: beans, qty: "2.0000" }]),
        ],
      );
      await q(
        `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order)
         VALUES ($1, $2, $3, 0)`,
        [tenantA, menu, groupId],
      );
      return { groupId, modifierId };
    };
    const live = await addGroup("Tambahan Aktif", false);
    const willBeDeleted = await addGroup("Tambahan Dihapus", false);
    const alreadyDeleted = await addGroup("Tambahan Lama", true);
    await refreshAllOutlets();

    // Control: a live group's modifier is listed, so "not listed" means something.
    const before = await coverageRows();
    expect(
      before.some((row) => row.modifierId === live.modifierId),
      "modifier of a live group is listed",
    ).toBe(true);
    expect(
      before.some((row) => row.modifierId === willBeDeleted.modifierId),
    ).toBe(true);
    expect(
      before.some((row) => row.modifierId === alreadyDeleted.modifierId),
      "modifier of a group deleted before the first cost run",
    ).toBe(false);

    // The group is deleted after its modifier was costed.
    await q(
      "UPDATE modifier_groups SET deleted_at = now() WHERE tenant_id = $1 AND id = $2",
      [tenantA, willBeDeleted.groupId],
    );
    await refreshAllOutlets();

    const after = await coverageRows();
    expect(after.some((row) => row.modifierId === live.modifierId)).toBe(true);
    expect(
      after.some((row) => row.modifierId === willBeDeleted.modifierId),
      "modifier of a group deleted after it was costed",
    ).toBe(false);
    expect(
      after.some((row) => row.modifierId === alreadyDeleted.modifierId),
    ).toBe(false);
  });

  it("HPP-REPORT-coverage-outlets a menu item is complete only when every outlet of the tenant has a complete cost", async () => {
    const outlets = await outletsOfTenant();
    expect(
      outlets.length,
      "the tenant has at least two outlets",
    ).toBeGreaterThanOrEqual(2);
    const first = outlets[0]!;
    const last = outlets[outlets.length - 1]!;

    const menuFor = async (name: string, outletsWithStock: Outlet[]) => {
      const item = await insertItem(`Biji ${name}`);
      await stock(item, outletsWithStock);
      return insertMenuItem(
        name,
        await insertRecipe(name, [{ id: item, qty: "10.0000" }]),
      );
    };
    const everywhere = await menuFor("Semua Outlet", outlets);
    const missingAtFirst = await menuFor(
      "Tanpa Stok Pertama",
      outlets.filter((outlet) => outlet.id !== first.id),
    );
    const missingAtLast = await menuFor(
      "Tanpa Stok Terakhir",
      outlets.filter((outlet) => outlet.id !== last.id),
    );
    await refreshAllOutlets();

    const rows = await coverageRows();
    expect(rowOf(rows, everywhere)).toMatchObject({ status: "complete" });
    expect(rowOf(rows, missingAtFirst)).toMatchObject({ status: "incomplete" });
    expect(rowOf(rows, missingAtLast)).toMatchObject({ status: "incomplete" });
  });
});
