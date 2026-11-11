// Two regressions in recipe-deduction.service.ts found in the legend-89zm
// review (WS-06 bundle):
//
// B1 `returnSwappedLine`: a recipe that holds the same item on two lines, one
//    of which was re-routed to another location after the sale, plans two draws
//    (item X at S and at A) that both map to the ONE sale line (X at S). The
//    swap must return the sum once: a posted sale gets one `return` row with
//    the whole quantity (not a second row under the same ledger key), a pending
//    sale loses the whole line (not a half-overwritten quantity).
// B2 `planDeduction`: a stock location that was deactivated (a named recipe
//    line location or the outlet sale location) is not drawable: the deduction
//    is skipped (`recipe_error` / `no_sale_location`) and no stock moves.
//
// Runs against the disposable PostgreSQL test database in a tenant this file
// creates and removes again (same harness as recipe-deduction-repost.test.ts).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  decimal4,
  outletIdSchema,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { orderPaidPayloadSchema } from "@starter/shared/pos";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  applySwapStockAdjustment,
  deliverRecipeDeductionEvent,
} from "../services/recipe-deduction.service.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const slugA = `rsl${randomUUID().slice(0, 8)}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const short = () => randomUUID().slice(0, 6);
const iso = () => new Date().toISOString();

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2033, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

let ownerUserId: string;
let gramId: string;
let portionId: string;
let categoryId: string;

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await owner.query<{ id: T }>(sql, params);
  return rows[0]!.id;
}

async function receive(locationId: string, itemId: string, quantity: string) {
  await recordStockMovement(tenantContext(), {
    outletId: outletIdSchema.parse(outletA) as OutletId,
    locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4("10.0000"),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  } as never);
}

async function configureOutlet(
  mode: "real_time" | "close_of_day",
  saleLocationId: string | null,
) {
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = EXCLUDED.recipe_deduction_mode,
                   sale_location_id = EXCLUDED.sale_location_id`,
    [tenantA, outletA, mode, saleLocationId],
  );
}

async function insertRecipe(
  lines: { id: string; qty: string; location?: string }[],
): Promise<{ recipeId: string; lineIds: string[] }> {
  const recipeId = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, true, $5) RETURNING id`,
    [tenantA, brandA, `Resep ${short()}`, portionId, ownerUserId],
  );
  const lineIds: string[] = [];
  for (const [index, line] of lines.entries())
    lineIds.push(
      await one<string>(
        `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp, deduction_location_id)
         VALUES ($1, $2, $3, 'item', $4, $5, $6, 0, $7) RETURNING id`,
        [
          tenantA,
          recipeId,
          index,
          line.id,
          line.qty,
          gramId,
          line.location ?? null,
        ],
      ),
    );
  return { recipeId, lineIds };
}

async function insertMenuItem(recipeId: string): Promise<string> {
  return one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id)
     VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
    [tenantA, brandA, categoryId, `Menu ${short()}`, recipeId, randomUUID()],
  );
}

async function newLocation(name: string): Promise<string> {
  return one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenantA, outletA, `${name} ${short()}`],
  );
}

async function newItem(name: string): Promise<string> {
  return one<string>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, gramId],
  );
}

async function seedPaidOrder(menuItemId: string, businessDate: string) {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
        status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 0, 0, 0, 0, 0, 0, 'completed', $5, now())`,
    [uuid, tenantA, outletA, `RSL-${randomUUID().slice(0, 12)}`, businessDate],
  );
  await owner.query(
    `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
        quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
        fire_status, status, reserved_business_date)
     VALUES ($1, $2, $3, $4, $5, NULL, 'Item', 1, 0, 0, 0, '[]'::jsonb, 'fired', 'served', $6)`,
    [randomUUID(), tenantA, outletA, uuid, menuItemId, businessDate],
  );
  return { ulid, uuid };
}

/** Delivers `order.paid` of one unit of `menuItemId` and returns the order. */
async function sell(menuItemId: string) {
  const businessDate = nextDate();
  const order = await seedPaidOrder(menuItemId, businessDate);
  const event = eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: tenantA,
    outletId: outletA,
    name: "order.paid",
    version: 1,
    aggregateType: "order",
    aggregateId: order.ulid,
    sequence: 1,
    occurredAt: iso(),
    actor: { type: "system" },
    idempotencyKey: `order.paid:${order.ulid}`,
    payloadSchemaRef: "order.paid.v1",
    payload: orderPaidPayloadSchema.parse({
      orderId: order.ulid,
      outletId: outletA,
      businessDate,
      channel: "qr",
      serviceType: "takeaway",
      grossSalesIdr: 50000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      roundingIdr: 0,
      totalIdr: 50000,
      paidCashIdr: 50000,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [{ method: "cash", amountIdr: 50000 }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: iso(),
    }),
  });
  const context = tenantContext();
  await withTenant(db, context, (tx) =>
    deliverRecipeDeductionEvent(context, event, tx),
  );
  return { ...order, businessDate };
}

async function saleRow(orderUlid: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    skip_reason: string | null;
  }>(
    "SELECT id, status, skip_reason FROM recipe_deductions WHERE tenant_id = $1 AND idempotency_key = $2",
    [tenantA, `sale:order:${orderUlid}`],
  );
  return rows[0]!;
}

async function saleLines(deductionId: string) {
  const { rows } = await owner.query<{
    inventory_item_id: string;
    location_id: string;
    quantity: string;
  }>(
    `SELECT inventory_item_id, location_id, quantity::text AS quantity
       FROM recipe_deduction_lines WHERE tenant_id = $1 AND deduction_id = $2`,
    [tenantA, deductionId],
  );
  return rows;
}

async function onHand(locationId: string, itemId: string): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return Number(rows[0]?.quantity ?? 0);
}

async function ledgerRows(locationId: string, itemId: string, type: string) {
  const { rows } = await owner.query<{ q: string }>(
    `SELECT abs(quantity)::text AS q FROM stock_ledger
      WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3 AND movement_type = $4`,
    [tenantA, locationId, itemId, type],
  );
  return rows.map((row) => Number(row.q));
}

function swap(
  order: { ulid: string; businessDate: string },
  old: string,
  replacement: string,
) {
  const context = tenantContext();
  const input = {
    outletId: outletA,
    orderId: order.ulid,
    issueId: randomUUID(),
    businessDate: order.businessDate,
    oldLineId: createUlid(),
    oldLine: { menuItemId: old, variantId: null, modifierIds: [], quantity: 1 },
    replacement: {
      menuItemId: replacement,
      variantId: null,
      modifierIds: [],
      quantity: 1,
    },
    recordedBy: ownerUserId,
    occurredAt: iso(),
  };
  return withTenant(db, context, (tx) =>
    applySwapStockAdjustment(tx, context, input),
  );
}

// --------------------------------------------------------------------- setup

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
      `S${slugA.slice(3)}`.toUpperCase(),
      `Outlet ${slugA}`,
      JSON.stringify(fixtures.outlets[0]!.openingHours),
    ],
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
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "Swap Owner", `${ownerUserId}@example.com`],
  );
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  portionId = await uom("porsi");
  categoryId = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Swap Uji', 0)",
    [categoryId, tenantA, brandA],
  );
});

beforeEach(async () => {
  await owner.query(
    "DELETE FROM recipe_deductions WHERE tenant_id = $1 AND status = 'pending'",
    [tenantA],
  );
});

afterAll(async () => {
  await dropOwnTenant();
  await owner.end();
});

// ===========================================================================

/**
 * Item X on two recipe lines (10 g + 5 g) at the sale location S; item Y on a
 * replacement dish. After the sale, line 2 is re-routed to location A.
 */
async function sameLineKit(mode: "real_time" | "close_of_day") {
  const s = await newLocation("Bar");
  const a = await newLocation("Dapur");
  const x = await newItem("Gula");
  const y = await newItem("Teh");
  for (const location of [s, a]) await receive(location, x, "1000.0000");
  await receive(s, y, "1000.0000");
  const { recipeId, lineIds } = await insertRecipe([
    { id: x, qty: "10.0000" },
    { id: x, qty: "5.0000" },
  ]);
  const dish = await insertMenuItem(recipeId);
  const replacement = await insertMenuItem(
    (await insertRecipe([{ id: y, qty: "1.0000" }])).recipeId,
  );
  await configureOutlet(mode, s);
  const order = await sell(dish);
  await owner.query(
    "UPDATE recipe_lines SET deduction_location_id = $3 WHERE tenant_id = $1 AND id = $2",
    [tenantA, lineIds[1], a],
  );
  return { s, a, x, dish, replacement, order };
}

describe("INV-02 swap returns a line once when two planned draws map to it", () => {
  it("INV-02 a posted sale gets one return of the whole quantity, not a clash on the ledger key", async () => {
    const kit = await sameLineKit("real_time");
    const sale = await saleRow(kit.order.ulid);
    expect(sale.status).toBe("posted");
    expect(await saleLines(sale.id)).toEqual([
      expect.objectContaining({
        inventory_item_id: kit.x,
        location_id: kit.s,
        quantity: "15.0000",
      }),
    ]);
    expect(await onHand(kit.s, kit.x)).toBe(985);

    await swap(kit.order, kit.dish, kit.replacement);

    // All 15 g go back to S in ONE return row; A was never drawn.
    expect(await ledgerRows(kit.s, kit.x, "return")).toEqual([15]);
    expect(await onHand(kit.s, kit.x)).toBe(1000);
    expect(await onHand(kit.a, kit.x)).toBe(1000);
    // The swap is not parked: nothing was refused.
    const { rows } = await owner.query<{ parked: string }>(
      `SELECT count(*)::text AS parked FROM recipe_deductions
        WHERE tenant_id = $1 AND reversal_failed_at IS NOT NULL`,
      [tenantA],
    );
    expect(Number(rows[0]!.parked)).toBe(0);
  });

  it("INV-02 a pending sale loses the whole line, not a half-overwritten quantity", async () => {
    const kit = await sameLineKit("close_of_day");
    const sale = await saleRow(kit.order.ulid);
    expect(sale.status).toBe("pending");
    expect(await saleLines(sale.id)).toEqual([
      expect.objectContaining({ location_id: kit.s, quantity: "15.0000" }),
    ]);

    await swap(kit.order, kit.dish, kit.replacement);

    expect(await saleLines(sale.id)).toEqual([]);
    expect(await onHand(kit.s, kit.x)).toBe(1000);
    expect(await onHand(kit.a, kit.x)).toBe(1000);
  });
});

describe("INV-02 a deactivated stock location is not drawable", () => {
  it("INV-02 a recipe line routed to an inactive location skips the sale as recipe_error", async () => {
    const s = await newLocation("Bar");
    const off = await newLocation("Gudang Tutup");
    const x = await newItem("Kopi");
    await receive(s, x, "1000.0000");
    await receive(off, x, "1000.0000");
    const { recipeId } = await insertRecipe([
      { id: x, qty: "10.0000", location: off },
    ]);
    const dish = await insertMenuItem(recipeId);
    await configureOutlet("real_time", s);
    await owner.query(
      "UPDATE stock_locations SET is_active = false WHERE tenant_id = $1 AND id = $2",
      [tenantA, off],
    );

    const order = await sell(dish);

    expect(await saleRow(order.ulid)).toMatchObject({
      status: "skipped",
      skip_reason: "recipe_error",
    });
    expect(await onHand(off, x)).toBe(1000);
    expect(await onHand(s, x)).toBe(1000);
  });

  it("INV-02 an inactive outlet sale location skips the sale as no_sale_location", async () => {
    const s = await newLocation("Bar Tutup");
    const x = await newItem("Susu");
    await receive(s, x, "1000.0000");
    const { recipeId } = await insertRecipe([{ id: x, qty: "10.0000" }]);
    const dish = await insertMenuItem(recipeId);
    await configureOutlet("real_time", s);
    await owner.query(
      "UPDATE stock_locations SET is_active = false WHERE tenant_id = $1 AND id = $2",
      [tenantA, s],
    );

    const order = await sell(dish);

    expect(await saleRow(order.ulid)).toMatchObject({
      status: "skipped",
      skip_reason: "no_sale_location",
    });
    expect(await onHand(s, x)).toBe(1000);
  });
});

describe("INV-02 a swap still returns stock to a location that was deactivated", () => {
  it("INV-02 the return goes to the sale's own location even when it is inactive now", async () => {
    const s = await newLocation("Bar");
    const off = await newLocation("Gudang Nanti Tutup");
    const x = await newItem("Kopi");
    const y = await newItem("Teh");
    await receive(s, x, "1000.0000");
    await receive(off, x, "1000.0000");
    await receive(s, y, "1000.0000");
    const dish = await insertMenuItem(
      (await insertRecipe([{ id: x, qty: "10.0000", location: off }])).recipeId,
    );
    const replacement = await insertMenuItem(
      (await insertRecipe([{ id: y, qty: "1.0000" }])).recipeId,
    );
    await configureOutlet("real_time", s);
    const order = await sell(dish);
    expect((await saleRow(order.ulid)).status).toBe("posted");
    expect(await onHand(off, x)).toBe(990);
    await owner.query(
      "UPDATE stock_locations SET is_active = false WHERE tenant_id = $1 AND id = $2",
      [tenantA, off],
    );

    await swap(order, dish, replacement);

    expect(await ledgerRows(off, x, "return")).toEqual([10]);
    expect(await onHand(off, x)).toBe(1000);
    expect(await onHand(s, x)).toBe(1000);
  });
});
