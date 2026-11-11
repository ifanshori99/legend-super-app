// Per-line deduction location routing (bead legend-89zm; INV-02 recipe
// deduction, INV-03 stock value; design decision in the WS-06 brief).
//
// A recipe line may carry its own `recipe_lines.deduction_location_id`. The
// location a leaf line draws from is `line.deduction_location_id ??
// outlet_inventory_settings.sale_location_id`. Stock is read and deducted per
// resolved location, and the HPP snapshot uses the same resolver.
//
// Runs against the disposable PostgreSQL test database in a tenant this file
// creates and removes again (same harness as recipe-deduction-training.test.ts).
//
// Assumptions where the brief is silent:
// - A deduction with any leaf line that resolves to no location is skipped as a
//   whole (`no_sale_location`): nothing is posted for its other lines, because
//   a half-posted sale would break "HPP = sum of the deductions".
// - `stock_ledger.quantity` may be signed; sums use abs().
// - Unit costs: beans 100/g at the Bar and 90/g in the Kitchen, milk 20/ml at
//   the Bar and 30/ml in the Kitchen, syrup 80/ml at the Bar and 70/ml in the
//   Kitchen, so the costs differ per location and a wrong draw is visible.
// - The HPP snapshot is read through `computeLineCostSnapshots`, called as in
//   order-cost-snapshot.test.ts.
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
import {
  dayClosedPayloadSchema,
  orderPaidPayloadSchema,
  orderVoidedPayloadSchema,
} from "@starter/shared/pos";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { deliverRecipeDeductionEvent } from "../services/recipe-deduction.service.ts";
import { computeLineCostSnapshots } from "../services/order-cost-snapshot.service.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const slugA = `loc${randomUUID().slice(0, 8)}`;
const hostA = `tenant-${slugA}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const short = () => randomUUID().slice(0, 6);
const iso = () => new Date().toISOString();

const ORDER_TOTAL = 50000;

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

// Each test sells on its own far-future business date so that a `day.closed`
// in one test can never touch another test's pending rows.
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
      [tenantA],
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
    [tenantA, `${name} ${short()}`, baseUomId],
  );
}

async function receive(
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
) {
  await recordStockMovement(tenantContext(), {
    outletId: outletIdSchema.parse(outletA) as OutletId,
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

let modifierGroupId: string;

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

type LineSeed = {
  type?: "item" | "recipe";
  id: string;
  qty: string;
  uom: string;
  /** `recipe_lines.deduction_location_id` (the column under test). */
  location?: string | null;
};

async function insertRecipe(input: {
  name: string;
  yieldQuantity?: string;
  lines: LineSeed[];
}): Promise<string> {
  const recipe = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, $4, $5, true, $6) RETURNING id`,
    [
      tenantA,
      brandA,
      `${input.name} ${short()}`,
      input.yieldQuantity ?? "1.0000",
      cupId,
      ownerUserId,
    ],
  );
  // The column is only named when a line uses it, so recipes without per-line
  // locations keep inserting on a schema that does not have it yet.
  for (const [index, line] of input.lines.entries()) {
    const routed = line.location !== undefined && line.location !== null;
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp${routed ? ", deduction_location_id" : ""})
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0${routed ? ", $8" : ""})`,
      [
        tenantA,
        recipe,
        index,
        line.type ?? "item",
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
    [tenantA, brandA, categoryId, `Latte ${short()}`, recipeId, randomUUID()],
  );
}

type Kit = Awaited<ReturnType<typeof buildKit>>;

/**
 * Two locations of the outlet, the Bar (sale location) and the Kitchen, both
 * stocking beans, milk and syrup at different unit costs, and a Latte recipe
 * (18 g beans from the sale location + 200 ml milk routed to the Kitchen).
 */
async function buildKit(
  mode: "real_time" | "close_of_day" = "real_time",
  routeMilk = true,
) {
  const location = (name: string) =>
    one<string>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
      [tenantA, outletA, `${name} ${short()}`],
    );
  const bar = await location("Bar");
  const kitchen = await location("Dapur");
  const beans = await insertItem("Biji Kopi", gramId);
  const milk = await insertItem("Susu", mlId);
  const syrup = await insertItem("Sirup", mlId);
  for (const [where, item, cost] of [
    [bar, beans, "100.0000"],
    [kitchen, beans, "90.0000"],
    [bar, milk, "20.0000"],
    [kitchen, milk, "30.0000"],
    [bar, syrup, "80.0000"],
    [kitchen, syrup, "70.0000"],
  ] as const)
    await receive(
      where,
      item,
      item === beans || item === syrup ? "1000.0000" : "10000.0000",
      cost,
    );
  const latteRecipe = await insertRecipe({
    name: "Latte",
    lines: [
      { id: beans, qty: "18.0000", uom: gramId },
      {
        id: milk,
        qty: "200.0000",
        uom: mlId,
        location: routeMilk ? kitchen : null,
      },
    ],
  });
  const latte = await insertMenuItem(latteRecipe);
  await configureOutlet(mode, bar);
  return { bar, kitchen, beans, milk, syrup, latte };
}

/** On-hand of every bin of the kit; compared whole so a stray draw shows. */
async function bins(kit: Kit) {
  return {
    barBeans: await onHand(kit.bar, kit.beans),
    kitchenBeans: await onHand(kit.kitchen, kit.beans),
    barMilk: await onHand(kit.bar, kit.milk),
    kitchenMilk: await onHand(kit.kitchen, kit.milk),
    barSyrup: await onHand(kit.bar, kit.syrup),
    kitchenSyrup: await onHand(kit.kitchen, kit.syrup),
  };
}

const FULL = {
  barBeans: "1000.0000",
  kitchenBeans: "1000.0000",
  barMilk: "10000.0000",
  kitchenMilk: "10000.0000",
  barSyrup: "1000.0000",
  kitchenSyrup: "1000.0000",
};

type OrderLine = {
  menuItemId: string;
  variantId?: string | null;
  modifierIds?: string[];
  quantity: number;
};

/** A paid order as the POS leaves it, with the given lines. */
async function seedOrder(
  lines: OrderLine[],
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
        tenantA,
        outletA,
        `LOC-${randomUUID().slice(0, 12)}`,
        businessDate,
        ORDER_TOTAL,
      ],
    );
    for (const line of lines)
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
            quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
            fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, $6, 'Latte', $7, 0, 0, 0, $8::jsonb,
                 'fired', 'served', $9)`,
        [
          randomUUID(),
          tenantA,
          outletA,
          uuid,
          line.menuItemId,
          line.variantId ?? null,
          line.quantity,
          JSON.stringify(
            (line.modifierIds ?? []).map((modifierId) => ({
              modifierId,
              groupId: modifierGroupId,
              name: "Modifier",
              priceIdr: 0,
            })),
          ),
          businessDate,
        ],
      );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
       VALUES ($1, $2, $3, 'pos', false)`,
      [uuid, tenantA, outletA],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider, amount_idr,
          received_idr, change_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now())`,
      [tenantA, outletA, uuid, ORDER_TOTAL],
    );
  });
  return { ulid, uuid };
}

// ------------------------------------------------------------------- events

function envelope(input: {
  name: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: tenantA,
    outletId: outletA,
    name: input.name,
    version: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: iso(),
    actor: { type: "system" },
    idempotencyKey: input.idempotencyKey,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paidEvent(orderUlid: string, businessDate: string) {
  return envelope({
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    idempotencyKey: `order.paid:${orderUlid}`,
    payload: orderPaidPayloadSchema.parse({
      orderId: orderUlid,
      outletId: outletA,
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

/** A linked void of a completed sale (carries a voidId). */
function voidedEvent(orderUlid: string, businessDate: string) {
  const voidId = randomUUID();
  return envelope({
    name: "order.voided",
    aggregateType: "order",
    aggregateId: orderUlid,
    idempotencyKey: `order.voided:${voidId}`,
    payload: orderVoidedPayloadSchema.parse({
      orderId: orderUlid,
      outletId: outletA,
      businessDate,
      amountIdr: ORDER_TOTAL,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      approvedBy: ownerUserId,
      overrideId: null,
      approvalRequestId: null,
      voidedFinalOrder: true,
      voidId,
      receiptNumber: "POS1-000001",
      voidedAt: iso(),
    }),
  });
}

function dayClosedEvent(businessDate: string) {
  return envelope({
    name: "day.closed",
    aggregateType: "day",
    aggregateId: createUlid(),
    idempotencyKey: `day.closed:${randomUUID()}`,
    payload: dayClosedPayloadSchema.parse({
      outletId: outletA,
      businessDate,
      orderCount: 2,
      totalSalesIdr: 2 * ORDER_TOTAL,
      totalRefundsIdr: 0,
      totalVoidsIdr: 0,
      totalVarianceIdr: 0,
      inventoryDeductionApplied: false,
      accountingSyncStatus: "pending",
      closedBy: ownerUserId,
      closedAt: iso(),
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

async function createOwnTenant() {
  const fixtures = cafeLegendPlatformFixtures;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      tenantA,
      `tenant-${slugA}`,
      `Tenant ${slugA}`,
      JSON.stringify({
        modules: ["pos", "inventory", "accounting", "qr_order"],
        integrationProviders: [],
      }),
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
      `T${slugA.slice(3)}`.toUpperCase(),
      `Outlet ${slugA}`,
      JSON.stringify(fixtures.outlets[0]!.openingHours),
    ],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantA, brandA, hostA],
  );
  // Chart of accounts with the two posting roles stock movements use.
  for (const [role, code, name, type, group] of [
    ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
    ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
  ] as const) {
    const accountId = await one<string>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantA, legalEntityA, code, name, type, group],
    );
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantA, legalEntityA, role, accountId],
    );
  }
  for (const year of [2026, 2027, 2031])
    for (let month = 1; month <= 12; month += 1)
      await owner.query(
        `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
        [tenantA, legalEntityA, `${year}-${String(month).padStart(2, "0")}`],
      );
}

/** Removes everything this file created in its own tenant (see recipe-bom). */
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
    [ownerUserId, "Latihan Owner", `${ownerUserId}@example.com`],
  );
  const uom = async (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  mlId = await uom("ml");
  cupId = await uom("cup");
  modifierGroupId = randomUUID();
  await owner.query(
    "INSERT INTO modifier_groups (id, tenant_id, name, min_select, max_select) VALUES ($1, $2, 'Tambahan Uji', 0, 10)",
    [modifierGroupId, tenantA],
  );
  categoryId = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Latihan Uji', 0)",
    [categoryId, tenantA, brandA],
  );
});

beforeEach(async () => {
  // Pending rows from an earlier test must not be posted by this test's
  // `day.closed`.
  await owner.query(
    "DELETE FROM recipe_deductions WHERE tenant_id = $1 AND status = 'pending'",
    [tenantA],
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
    [tenantA, order.ulid, order.uuid],
  );
  return rows;
}

/** Sum of |quantity| of the order's ledger rows per "<location>:<item>" bin. */
async function ledgerByBin(
  order: { uuid: string },
  movementType?: string,
): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ bin: string; qty: string }>(
    `SELECT location_id || ':' || inventory_item_id AS bin, sum(abs(quantity))::text AS qty
       FROM stock_ledger
      WHERE tenant_id = $1 AND source_id = $2 AND ($3::text IS NULL OR movement_type = $3)
      GROUP BY 1`,
    [tenantA, order.uuid, movementType ?? null],
  );
  return Object.fromEntries(rows.map((row) => [row.bin, row.qty]));
}

/** Sum of |quantity| x unit cost of the order's ledger rows (whole rupiah). */
async function ledgerCost(order: { uuid: string }): Promise<number> {
  const { rows } = await owner.query<{ cost: string }>(
    `SELECT coalesce(sum(abs(quantity) * unit_cost_idr), 0)::text AS cost
       FROM stock_ledger WHERE tenant_id = $1 AND source_id = $2 AND movement_type <> 'return'`,
    [tenantA, order.uuid],
  );
  return Math.round(Number(rows[0]!.cost));
}

async function onHand(locationId: string, itemId: string): Promise<string> {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return rows[0]?.quantity ?? "0.0000";
}

const bin = (locationId: string, itemId: string) => `${locationId}:${itemId}`;

async function hppOf(kit: { latte: string }, line: Partial<OrderLine> = {}) {
  const context = tenantContext();
  const [snapshot] = await withTenant(db, context, (tx) =>
    computeLineCostSnapshots(
      tx,
      context,
      outletIdSchema.parse(outletA) as OutletId,
      [
        {
          menuItemId: kit.latte,
          variantId: null,
          modifierIds: [],
          quantity: 1,
          ...line,
        },
      ] as unknown as Parameters<typeof computeLineCostSnapshots>[3],
    ),
  );
  return snapshot;
}

async function sell(kit: Kit, lines: OrderLine[]) {
  const businessDate = nextDate();
  const order = await seedOrder(lines, businessDate);
  await deliver(paidEvent(order.ulid, businessDate));
  return { order, businessDate };
}

// ===========================================================================

describe("legend-89zm routing of a recipe line's stock location", () => {
  it("legend-89zm-a1 a line with its own location is deducted there, the other lines from the sale location", async () => {
    const kit = await buildKit();
    const { order } = await sell(kit, [{ menuItemId: kit.latte, quantity: 2 }]);

    expect(await deductionOf(order)).toMatchObject([
      { kind: "sale", status: "posted" },
    ]);
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBeans: "964.0000", // 2 x 18 g at the sale location
      kitchenMilk: "9600.0000", // 2 x 200 ml in the Kitchen, not at the Bar
    });
  });

  it("legend-89zm-a2 the ledger holds exactly the recipe amount per location and a replayed event deducts nothing twice", async () => {
    const kit = await buildKit();
    const { order, businessDate } = await sell(kit, [
      { menuItemId: kit.latte, quantity: 2 },
    ]);
    const expected = {
      [bin(kit.bar, kit.beans)]: "36.0000",
      [bin(kit.kitchen, kit.milk)]: "400.0000",
    };
    expect(await ledgerByBin(order)).toEqual(expected);

    await deliver(paidEvent(order.ulid, businessDate));

    expect(await ledgerByBin(order)).toEqual(expected);
    expect(await deductionOf(order)).toHaveLength(1);
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBeans: "964.0000",
      kitchenMilk: "9600.0000",
    });
  });

  it("legend-89zm-a3 close_of_day: the pending deduction posts per location when the day closes", async () => {
    const kit = await buildKit("close_of_day");
    const { order, businessDate } = await sell(kit, [
      { menuItemId: kit.latte, quantity: 2 },
    ]);
    expect(await deductionOf(order)).toMatchObject([{ status: "pending" }]);
    expect(await bins(kit)).toEqual(FULL);

    await deliver(dayClosedEvent(businessDate));

    expect(await deductionOf(order)).toMatchObject([{ status: "posted" }]);
    expect(await ledgerByBin(order)).toEqual({
      [bin(kit.bar, kit.beans)]: "36.0000",
      [bin(kit.kitchen, kit.milk)]: "400.0000",
    });
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBeans: "964.0000",
      kitchenMilk: "9600.0000",
    });
  });

  it("legend-89zm-b1 a recipe without per-line locations still draws everything from the sale location", async () => {
    // Control: the same Latte with the milk line left at the sale location.
    const kit = await buildKit("real_time", false);
    const { order } = await sell(kit, [{ menuItemId: kit.latte, quantity: 1 }]);

    expect(await deductionOf(order)).toMatchObject([{ status: "posted" }]);
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBeans: "982.0000",
      barMilk: "9800.0000",
    });
  });

  it("legend-89zm-b2 without a sale location, a recipe whose every line names a location is still deducted", async () => {
    const kit = await buildKit();
    const routed = await insertMenuItem(
      await insertRecipe({
        name: "Latte Semua Lokasi",
        lines: [
          { id: kit.beans, qty: "18.0000", uom: gramId, location: kit.bar },
          { id: kit.milk, qty: "200.0000", uom: mlId, location: kit.kitchen },
        ],
      }),
    );
    await configureOutlet("real_time", null);
    const { order } = await sell(kit, [{ menuItemId: routed, quantity: 1 }]);

    expect(await deductionOf(order)).toMatchObject([
      { kind: "sale", status: "posted", skip_reason: null },
    ]);
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBeans: "982.0000",
      kitchenMilk: "9800.0000",
    });
  });

  it("legend-89zm-b3 without a sale location, a line that names no location makes the whole deduction skipped as no_sale_location and moves no stock", async () => {
    const kit = await buildKit();
    await configureOutlet("real_time", null);
    const { order } = await sell(kit, [{ menuItemId: kit.latte, quantity: 1 }]);

    expect(await deductionOf(order)).toMatchObject([
      { kind: "sale", status: "skipped", skip_reason: "no_sale_location" },
    ]);
    expect(await ledgerByBin(order)).toEqual({});
    expect(await bins(kit)).toEqual(FULL);
  });

  it("legend-89zm-c1 a modifier's own recipe line draws from its own location", async () => {
    const kit = await buildKit();
    const syrupRecipe = await insertRecipe({
      name: "Tambah Sirup",
      lines: [
        { id: kit.syrup, qty: "15.0000", uom: mlId, location: kit.kitchen },
      ],
    });
    const modifier = await one<string>(
      "INSERT INTO modifiers (tenant_id, group_id, name, recipe_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [tenantA, modifierGroupId, `Sirup ${short()}`, syrupRecipe],
    );
    const { order } = await sell(kit, [
      { menuItemId: kit.latte, modifierIds: [modifier], quantity: 3 },
    ]);

    expect(await deductionOf(order)).toMatchObject([{ status: "posted" }]);
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBeans: "946.0000", // 3 x 18 g
      kitchenMilk: "9400.0000", // 3 x 200 ml
      kitchenSyrup: "955.0000", // 3 x 15 ml from the Kitchen, not the Bar
    });
  });

  it("legend-89zm-c2 a variant recipe line draws from its own location", async () => {
    const kit = await buildKit();
    const largeRecipe = await insertRecipe({
      name: "Latte Large",
      lines: [
        { id: kit.beans, qty: "18.0000", uom: gramId, location: kit.kitchen },
        { id: kit.milk, qty: "300.0000", uom: mlId },
      ],
    });
    const large = await one<string>(
      "INSERT INTO item_variants (tenant_id, menu_item_id, name, recipe_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [tenantA, kit.latte, `Large ${short()}`, largeRecipe],
    );
    const { order } = await sell(kit, [
      { menuItemId: kit.latte, variantId: large, quantity: 1 },
    ]);

    expect(await deductionOf(order)).toMatchObject([{ status: "posted" }]);
    expect(await bins(kit)).toEqual({
      ...FULL,
      kitchenBeans: "982.0000",
      barMilk: "9700.0000",
    });
  });

  it("legend-89zm-c3 a leaf line inside a sub-recipe draws from its own location", async () => {
    const kit = await buildKit();
    // Inline sub-recipe: 2 portions per batch, 400 ml milk from the Kitchen.
    const milkBase = await insertRecipe({
      name: "Dasar Susu",
      yieldQuantity: "2.0000",
      lines: [
        { id: kit.milk, qty: "400.0000", uom: mlId, location: kit.kitchen },
      ],
    });
    const parent = await insertMenuItem(
      await insertRecipe({
        name: "Latte Bertingkat",
        lines: [
          { id: kit.beans, qty: "18.0000", uom: gramId },
          { type: "recipe", id: milkBase, qty: "1.0000", uom: cupId },
        ],
      }),
    );
    const { order } = await sell(kit, [{ menuItemId: parent, quantity: 2 }]);

    expect(await deductionOf(order)).toMatchObject([{ status: "posted" }]);
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBeans: "964.0000",
      kitchenMilk: "9600.0000", // 2 x 400 / 2
    });
  });

  it("legend-89zm-d1 a void gives the stock back to the same locations it was taken from", async () => {
    const kit = await buildKit();
    const { order, businessDate } = await sell(kit, [
      { menuItemId: kit.latte, quantity: 2 },
    ]);
    expect(await bins(kit)).toEqual({
      ...FULL,
      barBeans: "964.0000",
      kitchenMilk: "9600.0000",
    });

    await deliver(voidedEvent(order.ulid, businessDate));

    expect(await deductionOf(order)).toMatchObject([{ status: "reversed" }]);
    expect(await ledgerByBin(order, "return")).toEqual({
      [bin(kit.bar, kit.beans)]: "36.0000",
      [bin(kit.kitchen, kit.milk)]: "400.0000",
    });
    expect(await bins(kit)).toEqual(FULL);
  });
});

describe("legend-89zm HPP follows the same routing", () => {
  it("legend-89zm-e1 the HPP snapshot costs a line at the location it is deducted from", async () => {
    const kit = await buildKit();
    // 18 g x Rp100 (Bar) + 200 ml x Rp30 (Kitchen) = Rp7.800; costing the
    // milk at the Bar (Rp20) would give Rp5.800.
    expect(await hppOf(kit)).toBe(7_800);
    expect(await hppOf(kit, { quantity: 2 })).toBe(15_600);
  });

  it("legend-89zm-e2 the posted deduction cost equals the HPP snapshot and the sum of the ledger rows", async () => {
    const kit = await buildKit();
    const snapshot = await hppOf(kit, { quantity: 2 });
    const { order } = await sell(kit, [{ menuItemId: kit.latte, quantity: 2 }]);

    const [deduction] = await deductionOf(order);
    expect(snapshot).toBe(15_600);
    expect(Number(deduction!.cost_idr)).toBe(15_600);
    expect(await ledgerCost(order)).toBe(15_600);
  });

  it("legend-89zm-e3 a line that resolves to no location has an unknown HPP (null, never 0)", async () => {
    const kit = await buildKit();
    await configureOutlet("real_time", null);
    expect(await hppOf(kit)).toBeNull();
  });
});

describe("legend-89zm the column itself", () => {
  it("legend-89zm-f1 a recipe line can reference a stock location of the tenant and defaults to NULL", async () => {
    const kit = await buildKit();
    const recipe = await insertRecipe({
      name: "Kolom",
      lines: [
        { id: kit.beans, qty: "1.0000", uom: gramId },
        { id: kit.milk, qty: "1.0000", uom: mlId, location: kit.kitchen },
      ],
    });
    const { rows } = await owner.query<{ loc: string | null }>(
      "SELECT deduction_location_id AS loc FROM recipe_lines WHERE tenant_id = $1 AND recipe_id = $2 ORDER BY sort_order",
      [tenantA, recipe],
    );
    expect(rows.map((row) => row.loc)).toEqual([null, kit.kitchen]);
  });

  it("legend-89zm-f2 a recipe line cannot point at a location that does not exist (foreign key)", async () => {
    const kit = await buildKit();
    await expect(
      insertRecipe({
        name: "Lokasi Hilang",
        lines: [
          {
            id: kit.beans,
            qty: "1.0000",
            uom: gramId,
            location: randomUUID(),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
