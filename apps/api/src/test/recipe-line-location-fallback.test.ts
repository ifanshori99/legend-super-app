// Multi-outlet fallback for a recipe line's deduction location (bead
// legend-89zm, CTO decision "Opsi 1"; INV-02 recipe deduction, INV-03 stock
// value).
//
// Recipes are brand-wide. A recipe line may carry `deduction_location_id`, a
// stock location of ONE outlet. When another outlet of the same brand sells the
// recipe, a line location that does not belong to the selling outlet is not
// usable there. Decision: per line, a location that belongs to the selling
// outlet is used as-is; any other location falls back to the selling outlet's
// `sale_location_id`. Stock is still deducted, the HPP uses the same resolver,
// and the fallback is visible in the stock movement trail. If the selling
// outlet has no sale location the whole deduction is skipped (`no_sale_location`,
// the old behavior).
//
// Runs against the disposable PostgreSQL test database in a tenant this file
// creates and removes again (same harness as recipe-line-location-routing.test.ts).
//
// Assumptions where the brief is silent:
// - Where the fallback is recorded is not fixed (movement metadata, reason or
//   a recipe_deduction_lines column). The tests therefore look at the JSON of
//   the order's stock_ledger rows, its recipe_deductions rows and, when the
//   table exists, its recipe_deduction_lines rows, and require the literal
//   `location_fallback` plus the id of the original (other outlet's) location.
//   A deduction with no fallback must not carry the literal.
// - `stock_ledger.quantity` may be signed; sums use abs().
// - Unit costs: beans 100/g at A's Bar, 95/g at B's Bar; milk 30/ml in A's
//   Kitchen, 25/ml at B's Bar, so a wrong draw shows in the cost.
// - HPP is read through `computeLineCostSnapshots`, as in
//   recipe-line-location-routing.test.ts.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { orderPaidPayloadSchema } from "@starter/shared/pos";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { deliverRecipeDeductionEvent } from "../services/recipe-deduction.service.ts";
import { computeLineCostSnapshots } from "../services/order-cost-snapshot.service.ts";

const tenantId = randomUUID();
const brandId = randomUUID();
const legalEntityId = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const slug = `fbk${randomUUID().slice(0, 8)}`;
const host = `tenant-${slug}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const short = () => randomUUID().slice(0, 6);
const iso = () => new Date().toISOString();

const ORDER_TOTAL = 50000;

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
}

// Each test sells on its own far-future business date.
let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2031, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

let ownerUserId: string;
let gramId: string;
let mlId: string;
let cupId: string;
let categoryId: string;

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
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

// ------------------------------------------------------------ owner fixtures

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await owner.query<{ id: T }>(sql, params);
  return rows[0]!.id;
}

async function insertItem(name: string, baseUomId: string): Promise<string> {
  return one<string>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantId, `${name} ${short()}`, baseUomId],
  );
}

async function receive(
  outletId: string,
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
) {
  await recordStockMovement(tenantContext(), {
    outletId: outletIdSchema.parse(outletId) as OutletId,
    locationId,
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

async function configureOutlet(
  outletId: string,
  saleLocationId: string | null,
) {
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = EXCLUDED.recipe_deduction_mode,
                   sale_location_id = EXCLUDED.sale_location_id`,
    [tenantId, outletId, saleLocationId],
  );
}

type LineSeed = {
  id: string;
  qty: string;
  uom: string;
  /** `recipe_lines.deduction_location_id`. */
  location?: string | null;
};

async function insertRecipe(name: string, lines: LineSeed[]): Promise<string> {
  const recipe = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, '1.0000', $4, true, $5) RETURNING id`,
    [tenantId, brandId, `${name} ${short()}`, cupId, ownerUserId],
  );
  for (const [index, line] of lines.entries()) {
    const routed = line.location !== undefined && line.location !== null;
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp${routed ? ", deduction_location_id" : ""})
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0${routed ? ", $7" : ""})`,
      [
        tenantId,
        recipe,
        index,
        line.id,
        line.qty,
        line.uom,
        ...(routed ? [line.location] : []),
      ],
    );
  }
  return recipe;
}

async function insertMenuItem(recipeId: string): Promise<string> {
  return one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id)
     VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
    [tenantId, brandId, categoryId, `Latte ${short()}`, recipeId, randomUUID()],
  );
}

type Kit = Awaited<ReturnType<typeof buildKit>>;

/**
 * Two outlets of one brand. Outlet A has a Bar (sale location) and a Kitchen,
 * outlet B has only a Bar (sale location). One Latte recipe, shared by both:
 * 18 g beans (no location) + 200 ml milk routed to A's Kitchen.
 *
 * Costs: A Bar beans 100, A Kitchen milk 30, B Bar beans 95, B Bar milk 25.
 */
async function buildKit(options: { saleLocationB?: boolean } = {}) {
  const location = (outletId: string, name: string) =>
    one<string>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
      [tenantId, outletId, `${name} ${short()}`],
    );
  const barA = await location(outletA, "Bar A");
  const kitchenA = await location(outletA, "Dapur A");
  const barB = await location(outletB, "Bar B");
  const beans = await insertItem("Biji Kopi", gramId);
  const milk = await insertItem("Susu", mlId);
  await receive(outletA, barA, beans, "1000.0000", "100.0000");
  await receive(outletA, kitchenA, milk, "10000.0000", "30.0000");
  await receive(outletB, barB, beans, "1000.0000", "95.0000");
  await receive(outletB, barB, milk, "10000.0000", "25.0000");
  const recipe = await insertRecipe("Latte", [
    { id: beans, qty: "18.0000", uom: gramId },
    { id: milk, qty: "200.0000", uom: mlId, location: kitchenA },
  ]);
  const latte = await insertMenuItem(recipe);
  await configureOutlet(outletA, barA);
  await configureOutlet(
    outletB,
    options.saleLocationB === false ? null : barB,
  );
  return { barA, kitchenA, barB, beans, milk, latte };
}

/** On-hand of every bin of the kit; compared whole so a stray draw shows. */
async function bins(kit: Kit) {
  return {
    barABeans: await onHand(kit.barA, kit.beans),
    barAMilk: await onHand(kit.barA, kit.milk),
    kitchenAMilk: await onHand(kit.kitchenA, kit.milk),
    kitchenABeans: await onHand(kit.kitchenA, kit.beans),
    barBBeans: await onHand(kit.barB, kit.beans),
    barBMilk: await onHand(kit.barB, kit.milk),
  };
}

const FULL = {
  barABeans: "1000.0000",
  barAMilk: "0.0000",
  kitchenAMilk: "10000.0000",
  kitchenABeans: "0.0000",
  barBBeans: "1000.0000",
  barBMilk: "10000.0000",
};

/** A paid order as the POS leaves it, at the given outlet. */
async function seedOrder(
  outletId: string,
  menuItemId: string,
  quantity: number,
  businessDate: string,
): Promise<{ ulid: string; uuid: string }> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $6, 0, 0, 0, 0, $6,
               'completed', $5, now())`,
      [
        uuid,
        tenantId,
        outletId,
        `FBK-${randomUUID().slice(0, 12)}`,
        businessDate,
        ORDER_TOTAL,
      ],
    );
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
          quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, NULL, 'Latte', $6, 0, 0, 0, '[]'::jsonb,
               'fired', 'served', $7)`,
      [randomUUID(), tenantId, outletId, uuid, menuItemId, quantity, businessDate],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
       VALUES ($1, $2, $3, 'pos', false)`,
      [uuid, tenantId, outletId],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider, amount_idr,
          received_idr, change_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now())`,
      [tenantId, outletId, uuid, ORDER_TOTAL],
    );
  });
  return { ulid, uuid };
}

// ------------------------------------------------------------------- events

function paidEvent(
  outletId: string,
  orderUlid: string,
  businessDate: string,
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId,
    outletId,
    name: "order.paid",
    version: 1,
    aggregateType: "order",
    aggregateId: orderUlid,
    sequence: 1,
    occurredAt: iso(),
    actor: { type: "system" },
    idempotencyKey: `order.paid:${orderUlid}`,
    payloadSchemaRef: "order.paid.v1",
    payload: orderPaidPayloadSchema.parse({
      orderId: orderUlid,
      outletId,
      businessDate,
      channel: "qr",
      serviceType: "takeaway",
      grossSalesIdr: ORDER_TOTAL,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      roundingIdr: 0,
      totalIdr: ORDER_TOTAL,
      paidCashIdr: ORDER_TOTAL,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [{ method: "cash", amountIdr: ORDER_TOTAL }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: iso(),
    }),
  });
}

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliver(event: EventEnvelope) {
  const context = tenantContext();
  return withTenant(db, context, (tx) =>
    deliverRecipeDeductionEvent(context, event, tx),
  );
}

async function sell(outletId: string, kit: Kit, quantity: number) {
  const businessDate = nextDate();
  const order = await seedOrder(outletId, kit.latte, quantity, businessDate);
  await deliver(paidEvent(outletId, order.ulid, businessDate));
  return { order, businessDate };
}

// -------------------------------------------------------------- tenant setup

async function createOwnTenant() {
  const fixtures = cafeLegendPlatformFixtures;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      tenantId,
      `tenant-${slug}`,
      `Tenant ${slug}`,
      JSON.stringify({
        modules: ["pos", "inventory", "accounting", "qr_order"],
        integrationProviders: [],
      }),
      JSON.stringify(fixtures.tenant.limits),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandId, tenantId, `brand-${slug}`, `Brand ${slug}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityId, tenantId, `Entity ${slug}`],
  );
  for (const [id, suffix] of [
    [outletA, "A"],
    [outletB, "B"],
  ] as const)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
      [
        id,
        tenantId,
        brandId,
        legalEntityId,
        `F${slug.slice(3)}${suffix}`.toUpperCase(),
        `Outlet ${suffix} ${slug}`,
        JSON.stringify(fixtures.outlets[0]!.openingHours),
      ],
    );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantId, brandId, host],
  );
  for (const [role, code, name, type, group] of [
    ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
    ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
  ] as const) {
    const accountId = await one<string>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, legalEntityId, code, name, type, group],
    );
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, legalEntityId, role, accountId],
    );
  }
  for (const year of [2026, 2027, 2031])
    for (let month = 1; month <= 12; month += 1)
      await owner.query(
        `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
        [tenantId, legalEntityId, `${year}-${String(month).padStart(2, "0")}`],
      );
}

/** Removes everything this file created in its own tenant. */
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createOwnTenant();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "Latihan Owner", `${ownerUserId}@example.com`],
  );
  const uom = async (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantId, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  mlId = await uom("ml");
  cupId = await uom("cup");
  categoryId = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Latihan Uji', 0)",
    [categoryId, tenantId, brandId],
  );
});

beforeEach(async () => {
  await owner.query(
    "DELETE FROM recipe_deductions WHERE tenant_id = $1 AND status = 'pending'",
    [tenantId],
  );
});

afterAll(async () => {
  await dropOwnTenant();
  await owner.end();
});

// ------------------------------------------------------------------ readers

type Deduction = {
  kind: string;
  status: string;
  skip_reason: string | null;
  cost_idr: string | null;
};

async function deductionOf(order: { ulid: string; uuid: string }) {
  const { rows } = await owner.query<Deduction>(
    `SELECT kind, status, skip_reason, cost_idr::text AS cost_idr
       FROM recipe_deductions
      WHERE tenant_id = $1 AND (source_id = $2 OR source_id = $3)
      ORDER BY created_at, id`,
    [tenantId, order.ulid, order.uuid],
  );
  return rows;
}

/** Sum of |quantity| of the order's ledger rows per "<location>:<item>" bin. */
async function ledgerByBin(order: {
  uuid: string;
}): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ bin: string; qty: string }>(
    `SELECT location_id || ':' || inventory_item_id AS bin, sum(abs(quantity))::text AS qty
       FROM stock_ledger
      WHERE tenant_id = $1 AND source_id = $2
      GROUP BY 1`,
    [tenantId, order.uuid],
  );
  return Object.fromEntries(rows.map((row) => [row.bin, row.qty]));
}

/** Sum of |quantity| x unit cost of the order's ledger rows (whole rupiah). */
async function ledgerCost(order: { uuid: string }): Promise<number> {
  const { rows } = await owner.query<{ cost: string }>(
    `SELECT coalesce(sum(abs(quantity) * unit_cost_idr), 0)::text AS cost
       FROM stock_ledger WHERE tenant_id = $1 AND source_id = $2 AND movement_type <> 'return'`,
    [tenantId, order.uuid],
  );
  return Math.round(Number(rows[0]!.cost));
}

/**
 * Everything the movement trail of the order says, as one JSON text: its
 * stock_ledger rows, its recipe_deductions rows and (when the table exists) its
 * recipe_deduction_lines rows. Where the fallback is recorded is left to the
 * implementation (see the assumptions at the top).
 */
async function trailOf(order: { ulid: string; uuid: string }): Promise<string> {
  const parts: string[] = [];
  const ledger = await owner.query<{ row: unknown }>(
    "SELECT to_jsonb(l) AS row FROM stock_ledger l WHERE tenant_id = $1 AND source_id = $2",
    [tenantId, order.uuid],
  );
  parts.push(...ledger.rows.map((r) => JSON.stringify(r.row)));
  const deductions = await owner.query<{ row: unknown }>(
    `SELECT to_jsonb(d) AS row FROM recipe_deductions d
      WHERE tenant_id = $1 AND (source_id = $2 OR source_id = $3)`,
    [tenantId, order.ulid, order.uuid],
  );
  parts.push(...deductions.rows.map((r) => JSON.stringify(r.row)));
  const exists = await owner.query<{ present: boolean }>(
    "SELECT to_regclass('public.recipe_deduction_lines') IS NOT NULL AS present",
  );
  if (exists.rows[0]!.present) {
    const lines = await owner.query<{ row: unknown }>(
      `SELECT to_jsonb(rl) AS row FROM recipe_deduction_lines rl
        WHERE rl.tenant_id = $1 AND rl.deduction_id IN (
          SELECT id FROM recipe_deductions
           WHERE tenant_id = $1 AND (source_id = $2 OR source_id = $3))`,
      [tenantId, order.ulid, order.uuid],
    ).catch(() => ({ rows: [] as { row: unknown }[] }));
    parts.push(...lines.rows.map((r) => JSON.stringify(r.row)));
  }
  return parts.join("\n");
}

async function onHand(locationId: string, itemId: string): Promise<string> {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantId, locationId, itemId],
  );
  return rows[0]?.quantity ?? "0.0000";
}

const bin = (locationId: string, itemId: string) => `${locationId}:${itemId}`;

async function hppOf(outletId: string, kit: Kit, quantity = 1) {
  const context = tenantContext();
  const [snapshot] = await withTenant(db, context, (tx) =>
    computeLineCostSnapshots(
      tx,
      context,
      outletIdSchema.parse(outletId) as OutletId,
      [
        { menuItemId: kit.latte, variantId: null, modifierIds: [], quantity },
      ] as unknown as Parameters<typeof computeLineCostSnapshots>[3],
    ),
  );
  return snapshot;
}

// ===========================================================================

describe("legend-89zm-fb the selling outlet owns the line location (no fallback)", () => {
  it("legend-89zm-fb1 an order at outlet A deducts the milk from the line's location in A and records no fallback", async () => {
    const kit = await buildKit();
    const { order } = await sell(outletA, kit, 2);

    expect(await deductionOf(order)).toMatchObject([
      { kind: "sale", status: "posted" },
    ]);
    expect(await ledgerByBin(order)).toEqual({
      [bin(kit.barA, kit.beans)]: "36.0000",
      [bin(kit.kitchenA, kit.milk)]: "400.0000",
    });
    expect(await bins(kit)).toEqual({
      ...FULL,
      barABeans: "964.0000",
      kitchenAMilk: "9600.0000",
    });
    expect(await trailOf(order)).not.toContain("location_fallback");
  });
});

describe("legend-89zm-fb a line location of another outlet falls back to the sale location", () => {
  it("legend-89zm-fb2 an order at outlet B deducts the milk from B's sale location instead of skipping", async () => {
    const kit = await buildKit();
    const { order } = await sell(outletB, kit, 2);

    // Not skipped as recipe_error: the sale is posted.
    expect(await deductionOf(order)).toMatchObject([
      { kind: "sale", status: "posted", skip_reason: null },
    ]);
    // Beans (no line location) and milk (A's Kitchen -> fallback) both leave B's Bar.
    expect(await ledgerByBin(order)).toEqual({
      [bin(kit.barB, kit.beans)]: "36.0000",
      [bin(kit.barB, kit.milk)]: "400.0000",
    });
    // A's stock is untouched, B's Bar is reduced.
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBBeans: "964.0000",
      barBMilk: "9600.0000",
    });
  });

  it("legend-89zm-fb3 the fallback is visible in the movement trail with the original location", async () => {
    const kit = await buildKit();
    const { order } = await sell(outletB, kit, 1);

    const trail = await trailOf(order);
    expect(trail).toContain("location_fallback");
    expect(trail).toContain(kit.kitchenA);
  });

  it("legend-89zm-fb4 the deduction cost and the ledger equal the HPP snapshot of outlet B, not null and not outlet A's cost", async () => {
    const kit = await buildKit();
    // 2 x (18 g x Rp95 + 200 ml x Rp25) = 13.420; costing the milk at A's
    // Kitchen (Rp30) would give 15.420, the unit cost of outlet A is 7.800.
    const snapshot = await hppOf(outletB, kit, 2);
    const { order } = await sell(outletB, kit, 2);

    const [deduction] = await deductionOf(order);
    expect(snapshot).toBe(13_420);
    expect(Number(deduction!.cost_idr)).toBe(13_420);
    expect(await ledgerCost(order)).toBe(13_420);
    expect(await hppOf(outletA, kit, 1)).toBe(7_800);
  });

  it("legend-89zm-fb5 a replayed order.paid at outlet B deducts nothing twice", async () => {
    const kit = await buildKit();
    const { order, businessDate } = await sell(outletB, kit, 2);
    const expected = {
      [bin(kit.barB, kit.beans)]: "36.0000",
      [bin(kit.barB, kit.milk)]: "400.0000",
    };
    expect(await ledgerByBin(order)).toEqual(expected);

    await deliver(paidEvent(outletB, order.ulid, businessDate));

    expect(await ledgerByBin(order)).toEqual(expected);
    expect(await deductionOf(order)).toHaveLength(1);
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBBeans: "964.0000",
      barBMilk: "9600.0000",
    });
  });

  it("legend-89zm-fb6 outlet B without a sale location is still skipped as no_sale_location and moves no stock", async () => {
    const kit = await buildKit({ saleLocationB: false });
    const { order } = await sell(outletB, kit, 1);

    expect(await deductionOf(order)).toMatchObject([
      { status: "skipped", skip_reason: "no_sale_location" },
    ]);
    expect(await ledgerByBin(order)).toEqual({});
    expect(await bins(kit)).toEqual(FULL);
    expect(await hppOf(outletB, kit, 1)).toBeNull();
  });
});
