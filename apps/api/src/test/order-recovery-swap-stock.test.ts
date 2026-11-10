// legend-v51rh: stock side of an order_issue swap (unfulfillable -> swap).
// Production code under test: `applySwapStockAdjustment` and the swap-aware
// `paidOrderLines` / `reverseOrderSaleDeduction` of services/recipe-deduction.service.ts,
// reached through the real swap consumer (`deliverSwapKitchenEvent`) and the real
// recipe consumer (`deliverRecipeDeductionEvent`), each delivered by hand inside
// a tenant transaction as the worker does.
//
// Fixture (own sale location per test, so every balance starts at a known value):
//   roti  = 50 g tepung  (Rp20/g)            quantity 1 on the standard order
//   kopi  = 18 g biji    (Rp50/g) per cup    quantity 2 on the standard order
//   teh   = 10 g daun teh (Rp100/g)          the swap replacement
//   start = 1.000 g of each ingredient
//
// Assumptions where the brief is silent:
// - The paid order's `order.paid` event is the one the QR payment wrote to the
//   outbox; it is NOT consumed until a test delivers it (the worker is off).
// - "Order terbuka" = the order is not `completed` (the swap consumer voids the
//   old line); "order completed" = orders.status set to 'completed' before the
//   swap is delivered (old line is then kept, frozen and non-voided).
// - A swap replacement is drawn as a `remake` deduction keyed `swap:issue:<id>`
//   with ledger movement type `sale`; the old line returns as ledger `return`
//   rows on `source_type = order` at the sale row's unit cost.
// - Scenario 7: "tanpa resep" = the old menu item has no recipe; "lokasi jual
//   null" = outlet_inventory_settings.sale_location_id is NULL. Expected: no
//   throw, no return of anything, the replacement deduction is recorded
//   (`posted` with the old line unmapped, `skipped` without a sale location).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  decimal4,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
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
  orderVoidedPayloadSchema,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import {
  applySwapStockAdjustment,
  deliverRecipeDeductionEvent,
} from "../services/recipe-deduction.service.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const t = () => w.tenant.tenantId;

const fx = {
  gram: randomUUID(),
  flour: randomUUID(), // roti ingredient
  beans: randomUUID(), // kopi ingredient
  tea: randomUUID(), // teh ingredient
  recipe: {
    roti: randomUUID(),
    kopi: randomUUID(),
    teh: randomUUID(),
    rotiLain: randomUUID(),
  },
};

const FLOUR_PER_ROTI = "50.0000";
const TEA_PER_TEH = "10.0000";
const BEANS_PER_KOPI = "18.0000";
const FLOUR_PER_ROTI_LAIN = "30.0000"; // shares flour with roti
const START = "1000.0000";

beforeAll(async () => {
  w = await createWorld();
  const tag = randomUUID().slice(0, 4);
  await owner.query(
    "INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)",
    [fx.gram, t(), `g${tag}`],
  );
  for (const [id, name] of [
    [fx.flour, "Tepung"],
    [fx.beans, "Biji Kopi"],
    [fx.tea, "Daun Teh"],
  ] as const)
    await owner.query(
      `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, $2, $3, 'Bahan Baku', 'raw_material', $4, true)`,
      [id, t(), `${name} ${tag}`, fx.gram],
    );
  for (const [menuItemId, recipeId, itemId, qty] of [
    [w.ids.roti, fx.recipe.roti, fx.flour, FLOUR_PER_ROTI],
    [w.ids.kopi, fx.recipe.kopi, fx.beans, BEANS_PER_KOPI],
    [w.ids.teh, fx.recipe.teh, fx.tea, TEA_PER_TEH],
    [w.ids.rotiLain, fx.recipe.rotiLain, fx.flour, FLOUR_PER_ROTI_LAIN],
  ] as const) {
    await owner.query(
      `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
       VALUES ($1, $2, $3, $4, NULL, 1, $5, true, $6)`,
      [
        recipeId,
        t(),
        w.tenant.brandId,
        `Resep ${recipeId.slice(0, 6)}`,
        fx.gram,
        w.supervisor.userId,
      ],
    );
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, 0, 'item', $3, $4, $5, 0)`,
      [t(), recipeId, itemId, qty, fx.gram],
    );
    await owner.query(
      "UPDATE menu_items SET recipe_id = $3 WHERE tenant_id = $1 AND id = $2",
      [t(), menuItemId, recipeId],
    );
  }
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

beforeEach(async () => {
  // A pending deduction of an earlier test must not be posted by this test's
  // `day.closed`.
  await owner.query(
    "DELETE FROM recipe_deductions WHERE tenant_id = $1 AND status = 'pending'",
    [t()],
  );
});

// ---- helpers ---------------------------------------------------------------

function contextOf(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(t()),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

async function deliverSwap(event: EventEnvelope) {
  const context = contextOf();
  return withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, event, tx),
  );
}

async function deliverRecipe(event: EventEnvelope) {
  const context = contextOf();
  return withTenant(db, context, (tx) =>
    deliverRecipeDeductionEvent(context, event, tx),
  );
}

async function setOrderCompleted(orderId: string) {
  await owner.query(
    "UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2",
    [t(), toUuid(orderId)],
  );
}

async function receive(
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
) {
  await recordStockMovement(contextOf(), {
    outletId: outletIdSchema.parse(w.tenant.outletId),
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

async function setSettings(
  mode: "real_time" | "close_of_day",
  locationId: string | null,
) {
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = EXCLUDED.recipe_deduction_mode,
                   sale_location_id = EXCLUDED.sale_location_id`,
    [t(), w.tenant.outletId, mode, locationId],
  );
}

/** A fresh sale location with 1.000 g of every ingredient (flour Rp20, beans Rp50, tea Rp100). */
async function freshStock(mode: "real_time" | "close_of_day" = "real_time") {
  const location = randomUUID();
  await owner.query(
    "INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, 'bar')",
    [location, t(), w.tenant.outletId, `Bar ${location.slice(0, 6)}`],
  );
  await receive(location, fx.flour, START, "20");
  await receive(location, fx.beans, START, "50");
  await receive(location, fx.tea, START, "100");
  await setSettings(mode, location);
  return { location };
}

async function onHand(location: string, itemId: string): Promise<string> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT quantity::text AS quantity FROM stock_balances
     WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
    [t(), location, itemId],
  );
  return rows[0]?.quantity ?? "0.0000";
}

type LedgerRow = {
  movement_type: string;
  quantity: string;
  unit_cost_idr: string;
  idempotency_key: string | null;
  source_type: string;
};

/** Ledger rows of one item at one location, without the opening receipt. */
async function ledger(location: string, itemId: string): Promise<LedgerRow[]> {
  const { rows } = await owner.query<LedgerRow>(
    `SELECT movement_type, quantity::text AS quantity, unit_cost_idr::text AS unit_cost_idr,
            idempotency_key, source_type
     FROM stock_ledger
     WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3
       AND movement_type <> 'receipt'
     ORDER BY posting_seq`,
    [t(), location, itemId],
  );
  return rows;
}

async function ledgerCount(location: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM stock_ledger
     WHERE tenant_id = $1 AND location_id = $2 AND movement_type <> 'receipt'`,
    [t(), location],
  );
  return Number(rows[0]!.n);
}

type Deduction = { id: string; kind: string; status: string };

async function deduction(key: string): Promise<Deduction | undefined> {
  const { rows } = await owner.query<Deduction>(
    `SELECT id, kind, status FROM recipe_deductions
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [t(), key],
  );
  return rows[0];
}

async function deductionLines(key: string): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ item: string; quantity: string }>(
    `SELECT l.inventory_item_id AS item, l.quantity::text AS quantity
     FROM recipe_deduction_lines l
     JOIN recipe_deductions d ON d.tenant_id = l.tenant_id AND d.id = l.deduction_id
     WHERE d.tenant_id = $1 AND d.idempotency_key = $2`,
    [t(), key],
  );
  return Object.fromEntries(rows.map((row) => [row.item, row.quantity]));
}

async function swapDeductionCount(orderUlid: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM recipe_deductions
     WHERE tenant_id = $1 AND idempotency_key LIKE 'swap:issue:%'
       AND source_id = $2`,
    [t(), orderUlid],
  );
  return Number(rows[0]!.n);
}

/** The `order.paid` event the QR payment wrote to the outbox (not yet consumed). */
async function paidEventOf(orderId: string): Promise<EventEnvelope> {
  const rows = await w.outboxRows("order.paid", orderId);
  expect(rows, "order.paid event in the outbox").toHaveLength(1);
  return rows[0]!.event;
}

function envelope(
  name: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: t(),
    outletId: w.tenant.outletId,
    name,
    version: 1,
    aggregateType,
    aggregateId,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "system" },
    idempotencyKey,
    payloadSchemaRef: `${name}.v1`,
    payload,
  });
}

function voidedFinalEvent(orderUlid: string, businessDate: string) {
  const voidId = randomUUID();
  return envelope(
    "order.voided",
    "order",
    orderUlid,
    orderVoidedPayloadSchema.parse({
      orderId: orderUlid,
      outletId: w.tenant.outletId,
      businessDate,
      amountIdr: 90_090,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      approvedBy: w.supervisor.userId,
      overrideId: null,
      approvalRequestId: null,
      voidedFinalOrder: true,
      voidId,
      receiptNumber: "POS1-000001",
      voidedAt: new Date().toISOString(),
    }),
    `order.voided:${voidId}`,
  );
}

function dayClosedEvent(businessDate: string) {
  return envelope(
    "day.closed",
    "day",
    createUlid(),
    dayClosedPayloadSchema.parse({
      outletId: w.tenant.outletId,
      businessDate,
      orderCount: 1,
      totalSalesIdr: 90_090,
      totalRefundsIdr: 0,
      totalVoidsIdr: 0,
      totalVarianceIdr: 0,
      inventoryDeductionApplied: false,
      accountingSyncStatus: "pending",
      closedBy: w.supervisor.userId,
      closedAt: new Date().toISOString(),
    }),
    `day.closed:${randomUUID()}`,
  );
}

/**
 * A paid standard order (kopi x2, roti x1) whose roti failed and was swapped
 * for teh by the supervisor. Neither the swap nor `order.paid` is consumed yet.
 */
async function swappedOrder() {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    { resolution: "swap", replacementItemId: w.ids.teh },
  );
  expect(resolved.status).toBe(200);
  const resolvedRows = await w.outboxRows("order_issue.resolved", issueId);
  expect(resolvedRows).toHaveLength(1);
  const paidEvent = await paidEventOf(paid.order.id);
  return {
    ...paid,
    issueId,
    swapEvent: resolvedRows[0]!.event,
    paidEvent,
    orderUlid: (paidEvent.payload as { orderId: string }).orderId,
    businessDate: (paidEvent.payload as { businessDate: string }).businessDate,
  };
}

/**
 * Calls `applySwapStockAdjustment` directly with a fixed issue id, swapping one
 * unit of `oldMenuItemId` for one teh. Returns the runner and the remake key.
 */
function directSwap(
  o: { orderUlid: string; businessDate: string },
  oldMenuItemId: string,
) {
  const issueId = randomUUID();
  const input = {
    outletId: w.tenant.outletId,
    orderId: o.orderUlid,
    issueId,
    businessDate: o.businessDate,
    oldLineId: createUlid(),
    oldLine: {
      menuItemId: oldMenuItemId,
      variantId: null,
      modifierIds: [],
      quantity: 1,
    },
    replacement: {
      menuItemId: w.ids.teh,
      variantId: null,
      modifierIds: [],
      quantity: 1,
    },
    recordedBy: w.supervisor.userId,
    occurredAt: new Date().toISOString(),
  };
  const context = contextOf();
  const run = () =>
    withTenant(db, context, (tx) =>
      applySwapStockAdjustment(tx, context, input),
    );
  return { run, key: `swap:issue:${issueId}` };
}

/** Standard-order draw of the two untouched/other lines: 2 x 18 g beans. */
const BEANS_FOR_TWO_KOPI = "964.0000";

// ---- tests -----------------------------------------------------------------

describe("legend-v51rh swap dan stok", () => {
  it("1. order terbuka: swap lalu order.paid memotong hanya resep pengganti, tanpa remake", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder();

    await deliverSwap(o.swapEvent);
    await deliverRecipe(o.paidEvent);

    // Sale deduction counts kopi x2 and the teh replacement, never the roti.
    expect(await deductionLines(`sale:order:${o.orderUlid}`)).toEqual({
      [fx.beans]: "36.0000",
      [fx.tea]: TEA_PER_TEH,
    });
    expect(await onHand(location, fx.flour)).toBe(START);
    expect(await onHand(location, fx.tea)).toBe("990.0000");
    expect(await onHand(location, fx.beans)).toBe(BEANS_FOR_TWO_KOPI);
    // Nothing was drawn a second time for the swap.
    expect(await swapDeductionCount(o.orderUlid)).toBe(0);
    expect(await deduction(`swap:issue:${o.issueId}`)).toBeUndefined();
    expect(await ledger(location, fx.flour)).toEqual([]);
    expect(await ledger(location, fx.tea)).toHaveLength(1);
  });

  it("2. order completed dengan sale posted: swap mengembalikan bahan lama (harga unit asli) dan memotong bahan pengganti", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder();
    await deliverRecipe(o.paidEvent);
    // Sale covered the old roti line (never cooked).
    expect(await onHand(location, fx.flour)).toBe("950.0000");
    // The flour price moves after the sale: the return must use Rp20, not the new average.
    await receive(location, fx.flour, START, "60");
    expect(await onHand(location, fx.flour)).toBe("1950.0000");
    await setOrderCompleted(o.order.id);

    await deliverSwap(o.swapEvent);

    // Flour of the old line is back, valued at the original unit cost.
    expect(await onHand(location, fx.flour)).toBe("2000.0000");
    const flourRows = await ledger(location, fx.flour);
    const returns = flourRows.filter((row) => row.movement_type === "return");
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({
      quantity: FLOUR_PER_ROTI,
      unit_cost_idr: "20.0000",
      source_type: "order",
    });
    // The replacement is drawn as a posted remake keyed by the issue.
    expect(await deduction(`swap:issue:${o.issueId}`)).toMatchObject({
      kind: "remake",
      status: "posted",
    });
    expect(await deductionLines(`swap:issue:${o.issueId}`)).toEqual({
      [fx.tea]: TEA_PER_TEH,
    });
    expect(await onHand(location, fx.tea)).toBe("990.0000");
    // Kopi was not touched by the swap.
    expect(await onHand(location, fx.beans)).toBe(BEANS_FOR_TWO_KOPI);
  });

  it("2b. saldo akhir = awal - bahan pengganti untuk bahan yang disentuh swap", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder();
    await deliverRecipe(o.paidEvent);
    await setOrderCompleted(o.order.id);

    await deliverSwap(o.swapEvent);

    expect(await onHand(location, fx.flour)).toBe(START);
    expect(await onHand(location, fx.tea)).toBe("990.0000");
  });

  it("3. event swap yang sama diputar ulang tidak menulis baris ledger atau deduction baru", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder();
    await deliverRecipe(o.paidEvent);
    await setOrderCompleted(o.order.id);
    await deliverSwap(o.swapEvent);
    const ledgerBefore = await ledgerCount(location);
    const balances = [
      await onHand(location, fx.flour),
      await onHand(location, fx.tea),
      await onHand(location, fx.beans),
    ];

    await deliverSwap(o.swapEvent);
    await deliverSwap(o.swapEvent);
    await deliverRecipe(o.paidEvent);

    expect(await ledgerCount(location)).toBe(ledgerBefore);
    expect(await swapDeductionCount(o.orderUlid)).toBe(1);
    expect([
      await onHand(location, fx.flour),
      await onHand(location, fx.tea),
      await onHand(location, fx.beans),
    ]).toEqual(balances);
  });

  it("3b. real_time (posted): applySwapStockAdjustment dua kali untuk issue yang sama tidak menggandakan stok", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder();
    await deliverRecipe(o.paidEvent);
    await setOrderCompleted(o.order.id);
    const { run } = directSwap(o, w.ids.roti);

    await run();
    const after = [
      await onHand(location, fx.flour),
      await onHand(location, fx.tea),
    ];
    await run();

    expect(after).toEqual([START, "990.0000"]);
    expect([
      await onHand(location, fx.flour),
      await onHand(location, fx.tea),
    ]).toEqual(after);
  });

  it("3c. close_of_day (pending): dua panggilan untuk issue yang sama tidak mengecilkan baris sale dua kali", async () => {
    const { location } = await freshStock("close_of_day");
    const o = await swappedOrder();
    await deliverRecipe(o.paidEvent);
    expect(await deductionLines(`sale:order:${o.orderUlid}`)).toMatchObject({
      [fx.beans]: "36.0000",
    });
    // One of the two kopi cups is swapped away: the beans line must shrink
    // 36 -> 18 once. A second shrink would leave 0 (line deleted).
    const { run, key } = directSwap(o, w.ids.kopi);

    await run();
    await run();

    const saleLines = await deductionLines(`sale:order:${o.orderUlid}`);
    expect(saleLines[fx.beans]).toBe("18.0000");
    expect(saleLines[fx.flour]).toBe(FLOUR_PER_ROTI);
    expect(await deduction(key)).toMatchObject({
      kind: "remake",
      status: "pending",
    });
    expect(await ledgerCount(location)).toBe(0);
  });

  it("4. order completed, swap diproses sebelum order.paid: potong hanya pengganti, lini lama dikecualikan", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder();
    await setOrderCompleted(o.order.id);

    await deliverSwap(o.swapEvent);
    // Old line stays on the completed order (not voided); the swap must still
    // keep it out of the sale deduction.
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM order_items WHERE tenant_id = $1 AND id = $2",
      [t(), toUuid(o.roti.id)],
    );
    expect(rows[0]!.status).not.toBe("voided");
    await deliverRecipe(o.paidEvent);

    expect(await deductionLines(`sale:order:${o.orderUlid}`)).toEqual({
      [fx.beans]: "36.0000",
      [fx.tea]: TEA_PER_TEH,
    });
    expect(await onHand(location, fx.flour)).toBe(START);
    expect(await onHand(location, fx.tea)).toBe("990.0000");
    expect(await swapDeductionCount(o.orderUlid)).toBe(0);
  });

  it("5. close_of_day: swap mengurangi baris sale yang pending dan day.closed memotong benar", async () => {
    const { location } = await freshStock("close_of_day");
    const o = await swappedOrder();
    await deliverRecipe(o.paidEvent);
    expect(await deduction(`sale:order:${o.orderUlid}`)).toMatchObject({
      status: "pending",
    });
    expect(await deductionLines(`sale:order:${o.orderUlid}`)).toMatchObject({
      [fx.flour]: FLOUR_PER_ROTI,
    });
    await setOrderCompleted(o.order.id);

    await deliverSwap(o.swapEvent);

    // Pending sale lost the old line's flour and kept the kopi beans; the
    // replacement waits as its own pending remake. Nothing has left stock yet.
    const saleLines = await deductionLines(`sale:order:${o.orderUlid}`);
    expect(saleLines[fx.flour]).toBeUndefined();
    expect(saleLines[fx.beans]).toBe("36.0000");
    expect(await deduction(`swap:issue:${o.issueId}`)).toMatchObject({
      kind: "remake",
      status: "pending",
    });
    expect(await ledgerCount(location)).toBe(0);

    await deliverRecipe(dayClosedEvent(o.businessDate));

    expect(await onHand(location, fx.flour)).toBe(START);
    expect(await onHand(location, fx.tea)).toBe("990.0000");
    expect(await onHand(location, fx.beans)).toBe(BEANS_FOR_TWO_KOPI);
    expect(await deduction(`sale:order:${o.orderUlid}`)).toMatchObject({
      status: "posted",
    });
    expect(await deduction(`swap:issue:${o.issueId}`)).toMatchObject({
      status: "posted",
    });
  });

  it("6. void akhir setelah swap: total return = sale dikurangi yang sudah dikembalikan swap, tanpa over-return", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder();
    await deliverRecipe(o.paidEvent);
    await setOrderCompleted(o.order.id);
    await deliverSwap(o.swapEvent);
    expect(await onHand(location, fx.flour)).toBe(START);

    await deliverRecipe(voidedFinalEvent(o.orderUlid, o.businessDate));

    // Flour: returned once by the swap, never a second time by the void.
    const flourReturns = (await ledger(location, fx.flour)).filter(
      (row) => row.movement_type === "return",
    );
    expect(
      flourReturns.reduce((sum, row) => sum + Number(row.quantity), 0),
    ).toBe(50);
    expect(await onHand(location, fx.flour)).toBe(START);
    // Beans of the untouched kopi lines come back in full via the void.
    expect(await onHand(location, fx.beans)).toBe(START);
    // The replacement remake is not reversed by the void.
    expect(await onHand(location, fx.tea)).toBe("990.0000");
    expect(await deduction(`swap:issue:${o.issueId}`)).toMatchObject({
      status: "posted",
    });
    expect(await deduction(`sale:order:${o.orderUlid}`)).toMatchObject({
      status: "reversed",
    });
  });

  it("6b. swap berantai A->B lalu B->C: swap kedua mengembalikan dari remake swap pertama, void akhir tanpa over/under-return", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder(); // issue 1: roti (A) -> teh (B)
    await deliverRecipe(o.paidEvent);
    await setOrderCompleted(o.order.id);
    await deliverSwap(o.swapEvent);
    // After swap 1: flour of A back, tea of B drawn as the remake of issue 1.
    expect(await onHand(location, fx.flour)).toBe(START);
    expect(await onHand(location, fx.tea)).toBe("990.0000");

    // Issue 2: the replacement line B itself fails and is swapped for
    // roti-lain (C), which shares flour with A.
    const { rows } = await owner.query<{ id: string }>(
      "SELECT replacement_order_item_id AS id FROM order_issues WHERE tenant_id = $1 AND id = $2",
      [t(), o.issueId],
    );
    const lineB = rows[0]!.id;
    const reported = await w.report(uuidToUlid(lineB));
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const issue2 = reported.body.data.id as string;
    // Assumption: B was created on a completed order, so its line value is 0
    // and C (Rp18.000) counts as dearer by the whole 18.000: the swap needs an
    // approved price correction (as in order-recovery-swap-kitchen.test.ts).
    const approvalRequestId = await w.insertApproval({
      actionType: "price_correction",
      objectType: "order_issue",
      objectId: issue2,
      amountIdr: PRICES.rotiLain,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const resolved = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issue2}/resolve`,
      {
        resolution: "swap",
        replacementItemId: w.ids.rotiLain,
        approvalRequestId,
      },
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const swap2 = (await w.outboxRows("order_issue.resolved", issue2))[0]!
      .event;

    await deliverSwap(swap2);

    // Swap 2 returned the tea from the remake of issue 1 (never from the sale,
    // which holds no tea) at the unit cost of that draw, and drew C's flour.
    const teaReturns = (await ledger(location, fx.tea)).filter(
      (row) => row.movement_type === "return",
    );
    expect(teaReturns).toHaveLength(1);
    expect(teaReturns[0]).toMatchObject({
      quantity: TEA_PER_TEH,
      unit_cost_idr: "100.0000",
      source_type: "order",
    });
    expect(teaReturns[0]!.idempotency_key).toContain(
      (await deduction(`swap:issue:${o.issueId}`))!.id,
    );
    expect(await deduction(`swap:issue:${issue2}`)).toMatchObject({
      kind: "remake",
      status: "posted",
    });
    expect(await deductionLines(`swap:issue:${issue2}`)).toEqual({
      [fx.flour]: FLOUR_PER_ROTI_LAIN,
    });
    expect(await onHand(location, fx.tea)).toBe(START);
    expect(await onHand(location, fx.flour)).toBe("970.0000");
    expect(await onHand(location, fx.beans)).toBe(BEANS_FOR_TWO_KOPI);

    // Replaying swap 2 changes nothing.
    const ledgerBefore = await ledgerCount(location);
    await deliverSwap(swap2);
    expect(await ledgerCount(location)).toBe(ledgerBefore);

    await deliverRecipe(voidedFinalEvent(o.orderUlid, o.businessDate));

    // The void returns what the sale still holds: kopi beans in full; flour of
    // A was already returned by swap 1 (0 left), the sale never held tea.
    // Remakes of both swaps stay drawn (never reversed): flour of C is gone.
    const sum = async (item: string) =>
      (await ledger(location, item))
        .filter((row) => row.movement_type === "return")
        .reduce((total, row) => total + Number(row.quantity), 0);
    expect(await sum(fx.flour)).toBe(50);
    expect(await sum(fx.tea)).toBe(10);
    expect(await sum(fx.beans)).toBe(36);
    expect(await onHand(location, fx.flour)).toBe("970.0000");
    expect(await onHand(location, fx.tea)).toBe(START);
    expect(await onHand(location, fx.beans)).toBe(START);
    expect(await deduction(`sale:order:${o.orderUlid}`)).toMatchObject({
      status: "reversed",
    });
    for (const issue of [o.issueId, issue2])
      expect(await deduction(`swap:issue:${issue}`)).toMatchObject({
        status: "posted",
      });
  });

  it("7a. lini lama tanpa resep: tidak melempar, tidak ada yang dikembalikan, pengganti tetap terpotong", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder();
    await owner.query(
      "UPDATE menu_items SET recipe_id = NULL WHERE tenant_id = $1 AND id = $2",
      [t(), w.ids.roti],
    );
    try {
      await deliverRecipe(o.paidEvent);
      expect(await onHand(location, fx.flour)).toBe(START);
      await setOrderCompleted(o.order.id);

      await expect(deliverSwap(o.swapEvent)).resolves.not.toThrow();

      expect(await onHand(location, fx.flour)).toBe(START);
      expect(await ledger(location, fx.flour)).toEqual([]);
      expect(await deduction(`swap:issue:${o.issueId}`)).toMatchObject({
        kind: "remake",
        status: "posted",
      });
      expect(await onHand(location, fx.tea)).toBe("990.0000");
    } finally {
      await owner.query(
        "UPDATE menu_items SET recipe_id = $3 WHERE tenant_id = $1 AND id = $2",
        [t(), w.ids.roti, fx.recipe.roti],
      );
    }
  });

  it("7b. lokasi jual null: tidak melempar, tidak ada stok bergerak, swap tetap tercatat", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder();
    await setSettings("real_time", null);
    try {
      await deliverRecipe(o.paidEvent);
      await setOrderCompleted(o.order.id);

      await expect(deliverSwap(o.swapEvent)).resolves.not.toThrow();

      expect(await ledgerCount(location)).toBe(0);
      expect(await onHand(location, fx.flour)).toBe(START);
      expect(await onHand(location, fx.tea)).toBe(START);
      // The swap itself is applied: replacement line exists, issue is marked.
      const { rows } = await owner.query<{
        replacement_order_item_id: string | null;
      }>(
        "SELECT replacement_order_item_id FROM order_issues WHERE tenant_id = $1 AND id = $2",
        [t(), o.issueId],
      );
      expect(rows[0]!.replacement_order_item_id).not.toBeNull();
      expect(await deduction(`swap:issue:${o.issueId}`)).toMatchObject({
        status: "skipped",
      });
    } finally {
      await setSettings("real_time", location);
    }
  });
});

// legend-nzbi8: a swap return refused by a stock rule is parked on the remake
// row (`reversal_failed_at`, reason `swap`, source = issue id) and retried on
// `day.closed`, like a parked void reversal. The refusal is forced by planting a
// foreign ledger row that owns the return's idempotency key (HTTP 409).
describe("legend-nzbi8 swap: pengembalian stok ditolak diparkir dan di-retry saat day.closed", () => {
  type Parked = {
    id: string;
    status: string;
    reversal_reason: string | null;
    reversal_source_id: string | null;
    reversal_failed_at: string | null;
    reversal_failed_epoch: number | null;
  };

  async function parkedRow(issueId: string): Promise<Parked> {
    const { rows } = await owner.query<Parked>(
      `SELECT id, status, reversal_reason, reversal_source_id,
              reversal_failed_at::text AS reversal_failed_at,
              extract(epoch FROM reversal_failed_at)::float8 AS reversal_failed_epoch
       FROM recipe_deductions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [t(), `swap:issue:${issueId}`],
    );
    return rows[0]!;
  }

  /** A foreign ledger row owns a swap return key: the stock service refuses it. */
  async function blockReturn(
    location: string,
    drawId: string,
    issueId: string,
    itemId: string,
  ): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO stock_ledger (id, tenant_id, outlet_id, location_id, inventory_item_id,
          movement_type, quantity, unit_cost_idr, source_type, source_id,
          idempotency_key, request_fingerprint, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'receipt', 1, 1, 'goods_receipt', $6, $7, 'not-the-same-request', now())`,
      [
        id,
        t(),
        w.tenant.outletId,
        location,
        itemId,
        randomUUID(),
        `recipe-swap-return:${drawId}:${issueId}:${itemId}`,
      ],
    );
    return id;
  }

  async function unblock(ledgerId: string) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM stock_ledger WHERE tenant_id = $1 AND id = $2",
        [t(), ledgerId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function flourReturns(location: string) {
    return (await ledger(location, fx.flour)).filter(
      (row) => row.movement_type === "return",
    );
  }

  async function failedAudits(remakeId: string): Promise<number> {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' = 'recipe_deduction.swap_return_failed'
         AND event->>'objectId' = $2`,
      [t(), remakeId],
    );
    return Number(rows[0]!.n);
  }

  /** Paid + completed order, swap delivered while the flour return is refused. */
  async function parkedSwap() {
    const { location } = await freshStock();
    const o = await swappedOrder();
    await deliverRecipe(o.paidEvent);
    await setOrderCompleted(o.order.id);
    const sale = (await deduction(`sale:order:${o.orderUlid}`))!;
    const poison = await blockReturn(location, sale.id, o.issueId, fx.flour);
    await deliverSwap(o.swapEvent); // must not throw
    return { location, o, poison };
  }

  it("8a. return ditolak: swap tetap jalan, return diparkir di baris remake", async () => {
    const { location, o } = await parkedSwap();

    expect(await flourReturns(location)).toEqual([]);
    expect(await onHand(location, fx.flour)).toBe("950.0000");
    // The replacement is still drawn.
    expect(await onHand(location, fx.tea)).toBe("990.0000");
    const parked = await parkedRow(o.issueId);
    expect(parked).toMatchObject({
      status: "posted",
      reversal_reason: "swap",
      reversal_source_id: o.issueId,
    });
    expect(parked.reversal_failed_at).not.toBeNull();
  });

  it("8b. day.closed menerapkan ulang return; gagal lagi hanya menaikkan reversal_failed_at dan tercatat di audit; berhasil sekali, tidak ganda", async () => {
    const { location, o, poison } = await parkedSwap();
    const first = await parkedRow(o.issueId);

    // Cause still there: no return, parked again, failure audited.
    await deliverRecipe(dayClosedEvent(o.businessDate));
    const again = await parkedRow(o.issueId);
    expect(again).toMatchObject({
      reversal_reason: "swap",
      reversal_source_id: o.issueId,
    });
    expect(again.reversal_failed_epoch!).toBeGreaterThanOrEqual(
      first.reversal_failed_epoch!,
    );
    expect(await flourReturns(location)).toEqual([]);
    expect(await failedAudits(first.id)).toBeGreaterThanOrEqual(1);

    // Cause fixed (the flour average moved meanwhile): returned at the sale cost.
    await unblock(poison);
    await receive(location, fx.flour, START, "60");
    await deliverRecipe(dayClosedEvent(o.businessDate));
    const returns = await flourReturns(location);
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({
      quantity: FLOUR_PER_ROTI,
      unit_cost_idr: "20.0000",
      source_type: "order",
    });
    expect(await onHand(location, fx.flour)).toBe("2000.0000");
    expect(await parkedRow(o.issueId)).toMatchObject({
      status: "posted",
      reversal_reason: null,
      reversal_source_id: null,
      reversal_failed_at: null,
    });

    // More day closes and a replay of the swap change nothing.
    await deliverRecipe(dayClosedEvent(o.businessDate));
    await deliverRecipe(dayClosedEvent(o.businessDate));
    await deliverSwap(o.swapEvent);
    expect(await flourReturns(location)).toHaveLength(1);
    expect(await onHand(location, fx.flour)).toBe("2000.0000");
  }, 30_000);

  it("8c. order di-void final sesudah swap diparkir: void mengembalikan semuanya, retry swap tidak mengembalikan lagi", async () => {
    const { location, o, poison } = await parkedSwap();

    await deliverRecipe(voidedFinalEvent(o.orderUlid, o.businessDate));
    // The void returned the whole sale, the refused swap return included.
    expect(await onHand(location, fx.flour)).toBe(START);

    await unblock(poison);
    await deliverRecipe(dayClosedEvent(o.businessDate));
    expect(await onHand(location, fx.flour)).toBe(START);
    expect(await parkedRow(o.issueId)).toMatchObject({
      reversal_reason: null,
      reversal_source_id: null,
      reversal_failed_at: null,
    });
  }, 30_000);
  it("8d. swap berantai B->C diparkir lalu order di-void final: void tidak mengembalikan remake, retry tetap mengembalikan bahan B", async () => {
    const { location } = await freshStock();
    const o = await swappedOrder(); // issue 1: roti (A) -> teh (B)
    await deliverRecipe(o.paidEvent);
    await setOrderCompleted(o.order.id);
    await deliverSwap(o.swapEvent);
    const remake1 = (await deduction(`swap:issue:${o.issueId}`))!;

    // Issue 2: B itself fails and is swapped for roti-lain (C).
    const { rows } = await owner.query<{ id: string }>(
      "SELECT replacement_order_item_id AS id FROM order_issues WHERE tenant_id = $1 AND id = $2",
      [t(), o.issueId],
    );
    const reported = await w.report(uuidToUlid(rows[0]!.id));
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const issue2 = reported.body.data.id as string;
    const approvalRequestId = await w.insertApproval({
      actionType: "price_correction",
      objectType: "order_issue",
      objectId: issue2,
      amountIdr: PRICES.rotiLain,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const resolved = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issue2}/resolve`,
      {
        resolution: "swap",
        replacementItemId: w.ids.rotiLain,
        approvalRequestId,
      },
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const swap2 = (await w.outboxRows("order_issue.resolved", issue2))[0]!
      .event;

    // The tea return of swap 2 (drawn by the remake of issue 1) is refused.
    const poison = await blockReturn(location, remake1.id, issue2, fx.tea);
    await deliverSwap(swap2); // must not throw
    expect(await onHand(location, fx.tea)).toBe("990.0000");
    expect(await parkedRow(issue2)).toMatchObject({
      reversal_reason: "swap",
      reversal_source_id: issue2,
    });

    // The void reverses the sale only; the remake of issue 1 stays drawn.
    await deliverRecipe(voidedFinalEvent(o.orderUlid, o.businessDate));
    expect(await onHand(location, fx.tea)).toBe("990.0000");

    await unblock(poison);
    await deliverRecipe(dayClosedEvent(o.businessDate));
    expect(await onHand(location, fx.tea)).toBe(START);
    expect(await parkedRow(issue2)).toMatchObject({
      reversal_reason: null,
      reversal_source_id: null,
      reversal_failed_at: null,
    });
    await deliverRecipe(dayClosedEvent(o.businessDate));
    expect(await onHand(location, fx.tea)).toBe(START);
  }, 30_000);
});
