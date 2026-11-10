// Training orders do not deduct stock (bead legend-13avp; founder decision
// Q63: "pesanan latihan tidak memotong stok"; INV-02 recipe deduction).
//
// Runs against the disposable PostgreSQL test database in a tenant this file
// creates and removes again. The recipe consumer runs through `withTenant`
// exactly as the worker delivers a cloud-sync event (same harness as
// recipe-pos-hpp.test.ts). A training order is flagged at INSERT
// (`pos_orders.is_training = true`); an order that was completed before the
// rule existed is modelled with `session_replication_role = replica` (POS-04
// freezes `pos_orders` of a final order).
//
// Assumptions where the brief is silent:
// - "No deduction" means no `recipe_deductions` row of any status, no
//   `stock_ledger` row, no `stock.moved` outbox event and an unchanged
//   on-hand balance.
// - `day.closed` leaves a pre-rule pending deduction of a training order
//   `pending` (not posted, not failed, not deleted) and posts the regular
//   orders of the same day normally.
// - A void of a training order that already has a deduction reverses it
//   exactly like a regular order (status `reversed`, `return` ledger rows).
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
  orderIssueRecordedPayloadSchema,
  type OrderIssueType,
} from "@starter/shared/inventory";
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

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const slugA = `trn${randomUUID().slice(0, 8)}`;
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

async function configureOutlet(
  mode: "real_time" | "close_of_day",
  saleLocationId: string,
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

type Kit = Awaited<ReturnType<typeof buildKit>>;

/**
 * A fresh sale location holding 1.000 g beans (Rp100/g) and 10.000 ml milk
 * (Rp20/ml), and a Latte (18 g beans + 200 ml milk, Rp5.800 per cup).
 */
async function buildKit(mode: "real_time" | "close_of_day" = "real_time") {
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenantA, outletA, `Bar Latihan ${short()}`],
  );
  const beans = await insertItem("Biji Kopi", gramId);
  const milk = await insertItem("Susu", mlId);
  await receive(location, beans, "1000.0000", "100.0000");
  await receive(location, milk, "10000.0000", "20.0000");
  const recipe = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, true, $5) RETURNING id`,
    [tenantA, brandA, `Latte ${short()}`, cupId, ownerUserId],
  );
  for (const [index, [item, qty, uom]] of (
    [
      [beans, "18.0000", gramId],
      [milk, "200.0000", mlId],
    ] as const
  ).entries())
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenantA, recipe, index, item, qty, uom],
    );
  const menuItem = await one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id)
     VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
    [tenantA, brandA, categoryId, `Latte ${short()}`, recipe, randomUUID()],
  );
  await configureOutlet(mode, location);
  return { location, beans, milk, menuItem };
}

/**
 * A paid order as the POS leaves it. `training` stamps `pos_orders.is_training`
 * at INSERT (a trigger refuses a later UPDATE of a final order).
 */
async function seedOrder(
  menuItemId: string,
  businessDate: string,
  options: { training?: boolean; quantity?: number } = {},
): Promise<{ ulid: string; uuid: string }> {
  const quantity = options.quantity ?? 2;
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
        `TRN-${randomUUID().slice(0, 12)}`,
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
      [
        randomUUID(),
        tenantA,
        outletA,
        uuid,
        menuItemId,
        quantity,
        businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
       VALUES ($1, $2, $3, 'pos', $4)`,
      [uuid, tenantA, outletA, options.training ?? false],
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

/**
 * Flags an already-completed order as training, like an operator backfill: it
 * models an order that was deducted before the training rule existed.
 */
async function markTraining(order: { uuid: string }): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "UPDATE pos_orders SET is_training = true WHERE tenant_id = $1 AND order_id = $2",
      [tenantA, order.uuid],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

function issueEvent(input: {
  issueId: string;
  orderUlid: string;
  businessDate: string;
  type: OrderIssueType;
  menuItemId: string;
}) {
  return envelope({
    name: "order_issue.recorded",
    aggregateType: "order_issue",
    aggregateId: input.issueId,
    idempotencyKey: `order_issue.recorded:${input.issueId}`,
    payload: orderIssueRecordedPayloadSchema.parse({
      issueId: input.issueId,
      orderId: input.orderUlid,
      orderItemId: randomUUID(),
      outletId: outletA,
      businessDate: input.businessDate,
      type: input.type,
      reason: "quality",
      stationId: null,
      recordedBy: ownerUserId,
      menuItemId: input.menuItemId,
      variantId: null,
      modifierIds: [],
      quantity: 1,
      occurredAt: iso(),
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

// ------------------------------------------------------------------ readers

type Deduction = { kind: string; status: string; source_id: string };

async function deductionsOf(...sourceIds: string[]): Promise<Deduction[]> {
  const { rows } = await owner.query<Deduction>(
    `SELECT kind, status, source_id FROM recipe_deductions WHERE tenant_id = $1
       AND (source_id = ANY($2::text[]) OR idempotency_key = ANY($3::text[]))
     ORDER BY created_at, id`,
    [tenantA, sourceIds, sourceIds.map((id) => `order_issue:${id}`)],
  );
  return rows;
}

const deductionsOfOrder = (order: { ulid: string; uuid: string }) =>
  deductionsOf(order.ulid, order.uuid);

type LedgerRow = { movement_type: string; quantity: string };

async function orderLedger(order: { uuid: string }): Promise<LedgerRow[]> {
  const { rows } = await owner.query<LedgerRow>(
    `SELECT movement_type, quantity::text AS quantity FROM stock_ledger
      WHERE tenant_id = $1 AND source_id = $2 ORDER BY posting_seq`,
    [tenantA, order.uuid],
  );
  return rows;
}

async function onHand(locationId: string, itemId: string): Promise<string> {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return rows[0]?.quantity ?? "0.0000";
}

async function stockMovedCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'`,
    [tenantA],
  );
  return Number(rows[0]!.n);
}

/** Nothing left a bin: no deduction, no ledger row, no stock.moved, full stock. */
async function expectNoStockEffect(
  kit: Kit,
  order: { ulid: string; uuid: string },
  movedBefore: number,
) {
  expect(await deductionsOfOrder(order)).toHaveLength(0);
  expect(await orderLedger(order)).toHaveLength(0);
  expect(await stockMovedCount()).toBe(movedBefore);
  expect(await onHand(kit.location, kit.beans)).toBe("1000.0000");
  expect(await onHand(kit.location, kit.milk)).toBe("10000.0000");
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

// ===========================================================================

describe("order.paid of a training order (TRAIN-STOCK-a)", () => {
  it("TRAIN-STOCK-a1 real_time: a paid training order makes no deduction, no ledger row, no stock.moved", async () => {
    const kit = await buildKit("real_time");
    const businessDate = nextDate();
    const order = await seedOrder(kit.menuItem, businessDate, {
      training: true,
    });
    const movedBefore = await stockMovedCount();

    await deliver(paidEvent(order.ulid, businessDate));

    await expectNoStockEffect(kit, order, movedBefore);
  });

  it("TRAIN-STOCK-a2 close_of_day: a paid training order leaves no pending deduction either", async () => {
    const kit = await buildKit("close_of_day");
    const businessDate = nextDate();
    const order = await seedOrder(kit.menuItem, businessDate, {
      training: true,
    });
    const movedBefore = await stockMovedCount();

    await deliver(paidEvent(order.ulid, businessDate));
    await deliver(dayClosedEvent(businessDate));

    await expectNoStockEffect(kit, order, movedBefore);
  });

  it("TRAIN-STOCK-a3 control: a regular order paid the same way still deducts 2 cups", async () => {
    const kit = await buildKit("real_time");
    const businessDate = nextDate();
    const order = await seedOrder(kit.menuItem, businessDate);

    await deliver(paidEvent(order.ulid, businessDate));

    expect(await deductionsOfOrder(order)).toMatchObject([
      { kind: "sale", status: "posted" },
    ]);
    expect(await orderLedger(order)).toHaveLength(2);
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("9600.0000");
  });

  it("TRAIN-STOCK-a4 a training order does not change what a regular order of the same location deducts", async () => {
    const kit = await buildKit("real_time");
    const businessDate = nextDate();
    const training = await seedOrder(kit.menuItem, businessDate, {
      training: true,
    });
    const regular = await seedOrder(kit.menuItem, businessDate);

    await deliver(paidEvent(training.ulid, businessDate));
    await deliver(paidEvent(regular.ulid, businessDate));

    expect(await deductionsOfOrder(training)).toHaveLength(0);
    expect(await deductionsOfOrder(regular)).toMatchObject([
      { kind: "sale", status: "posted" },
    ]);
    // Only the regular order's 2 cups (36 g beans, 400 ml milk) left stock.
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("9600.0000");
  });
});

describe("order_issue.recorded of a training order (TRAIN-STOCK-b)", () => {
  for (const type of ["remake", "comp"] as const) {
    it(`TRAIN-STOCK-b-${type} a ${type} on a training order draws no stock`, async () => {
      const kit = await buildKit("real_time");
      const businessDate = nextDate();
      const order = await seedOrder(kit.menuItem, businessDate, {
        training: true,
      });
      const issueId = randomUUID();
      const movedBefore = await stockMovedCount();

      await deliver(
        issueEvent({
          issueId,
          orderUlid: order.ulid,
          businessDate,
          type,
          menuItemId: kit.menuItem,
        }),
      );

      expect(await deductionsOf(issueId)).toHaveLength(0);
      await expectNoStockEffect(kit, order, movedBefore);
    });

    it(`TRAIN-STOCK-b-${type}-control a ${type} on a regular order still draws 1 cup`, async () => {
      const kit = await buildKit("real_time");
      const businessDate = nextDate();
      const order = await seedOrder(kit.menuItem, businessDate);
      const issueId = randomUUID();

      await deliver(
        issueEvent({
          issueId,
          orderUlid: order.ulid,
          businessDate,
          type,
          menuItemId: kit.menuItem,
        }),
      );

      expect(await deductionsOf(issueId)).toMatchObject([
        { kind: type, status: "posted" },
      ]);
      expect(await onHand(kit.location, kit.beans)).toBe("982.0000");
      expect(await onHand(kit.location, kit.milk)).toBe("9800.0000");
    });
  }
});

describe("order.voided of a training order (TRAIN-STOCK-c)", () => {
  it("TRAIN-STOCK-c1 a void of a training order that never had a deduction writes no tombstone and no return", async () => {
    const kit = await buildKit("real_time");
    const businessDate = nextDate();
    const order = await seedOrder(kit.menuItem, businessDate, {
      training: true,
    });
    const movedBefore = await stockMovedCount();

    await deliver(paidEvent(order.ulid, businessDate));
    await deliver(voidedEvent(order.ulid, businessDate));

    await expectNoStockEffect(kit, order, movedBefore);
  });

  it("TRAIN-STOCK-c2 control: a void of a regular order that was never paid still leaves a reversed tombstone", async () => {
    const kit = await buildKit("real_time");
    const businessDate = nextDate();
    const order = await seedOrder(kit.menuItem, businessDate);

    await deliver(voidedEvent(order.ulid, businessDate));

    expect(await deductionsOfOrder(order)).toMatchObject([
      { kind: "sale", status: "reversed" },
    ]);
    expect(await orderLedger(order)).toHaveLength(0);
  });

  it("TRAIN-STOCK-c3 a training order that already has a deduction (made before the rule) is still reversed by its void", async () => {
    const kit = await buildKit("real_time");
    const businessDate = nextDate();
    const order = await seedOrder(kit.menuItem, businessDate);
    await deliver(paidEvent(order.ulid, businessDate));
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");
    await markTraining(order);

    await deliver(voidedEvent(order.ulid, businessDate));

    expect(await deductionsOfOrder(order)).toMatchObject([
      { kind: "sale", status: "reversed" },
    ]);
    const ledger = await orderLedger(order);
    expect(ledger.filter((row) => row.movement_type === "return")).toHaveLength(
      2,
    );
    expect(await onHand(kit.location, kit.beans)).toBe("1000.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("10000.0000");
  });
});

describe("day.closed with pending deductions of a training order (TRAIN-STOCK-d)", () => {
  it("TRAIN-STOCK-d1 day.closed does not post the pending deduction of a training order, and still posts the regular order of the day", async () => {
    const kit = await buildKit("close_of_day");
    const businessDate = nextDate();
    // Both orders get a pending deduction while still regular; one is then
    // flagged training, as a row left over from before the rule.
    const pendingTraining = await seedOrder(kit.menuItem, businessDate);
    const regular = await seedOrder(kit.menuItem, businessDate);
    await deliver(paidEvent(pendingTraining.ulid, businessDate));
    await deliver(paidEvent(regular.ulid, businessDate));
    expect(await deductionsOfOrder(pendingTraining)).toMatchObject([
      { status: "pending" },
    ]);
    await markTraining(pendingTraining);

    await deliver(dayClosedEvent(businessDate));

    expect(await deductionsOfOrder(pendingTraining)).toMatchObject([
      { kind: "sale", status: "pending" },
    ]);
    expect(await orderLedger(pendingTraining)).toHaveLength(0);
    // The training row does not block the batch: the regular order posts.
    expect(await deductionsOfOrder(regular)).toMatchObject([
      { kind: "sale", status: "posted" },
    ]);
    expect(await orderLedger(regular)).toHaveLength(2);
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("9600.0000");
  });

  it("TRAIN-STOCK-d2 control: with no training order, day.closed posts every pending deduction", async () => {
    const kit = await buildKit("close_of_day");
    const businessDate = nextDate();
    const first = await seedOrder(kit.menuItem, businessDate);
    const second = await seedOrder(kit.menuItem, businessDate);
    await deliver(paidEvent(first.ulid, businessDate));
    await deliver(paidEvent(second.ulid, businessDate));

    await deliver(dayClosedEvent(businessDate));

    for (const order of [first, second])
      expect(await deductionsOfOrder(order)).toMatchObject([
        { kind: "sale", status: "posted" },
      ]);
    expect(await onHand(kit.location, kit.beans)).toBe("928.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("9200.0000");
  });
});
