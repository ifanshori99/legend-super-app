// Inventory -> GL bridge: production batches (bead legend-29vw, card 1252 r2).
//
// Completing a production batch writes `production_out` rows (raw material
// drawn at its moving average) and one `production_in` row (the output at
// cost / actual qty) under source `production_order`. Release 1 keeps every
// stock item, raw and semi-finished, on inventory (1301): the batch moves no
// value between accounts. Its only journal is the rounding difference between
// the output card value and the material cost, Dr/Cr 1301 against
// inventory_price_variance (5106). The books must equal the stock card after
// the batch and after every later sale, waste and count of its output. One
// journal per batch, replay is a no-op, and a closed period is never written
// into (late adjustment, as the other stock sources).

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decimal4,
  isoDateTimeSchema,
  tenantIdSchema,
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  deliverInventoryGlEvent,
  retryBlockedInventoryGl,
  type InventoryGlResult,
} from "../services/inventory-gl-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
const at = (iso: string) => isoDateTimeSchema.parse(iso);
const NOW = new Date("2026-11-08T03:00:00Z");
/** Past the retry backoff of every parked source. */
const LATER = new Date("2026-11-09T03:00:00Z");
const BEFORE = "2026-10-01T05:00:00.000Z";
const DAY = "2026-10-15T05:00:00.000Z";

let tenantId: string;
let brandId: string;
let uomId: string;

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

type Role =
  | "cogs"
  | "inventory"
  | "inventory_semi_finished"
  | "waste_expense"
  | "inventory_adjustment"
  | "inventory_price_variance";
type World = {
  entity: string;
  outletId: string;
  locationId: string;
  accounts: Record<Role, string>;
};

async function makeWorld(): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Entity Reval ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Reval', 'Jl. Reval', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletId, tenantId, brandId, entity, `RV-${short()}`.toUpperCase()],
  );
  const chart: [Role, string, string, string, string][] = [
    ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
    [
      "inventory_semi_finished",
      "1302",
      "Persediaan Barang Setengah Jadi",
      "asset",
      "current_asset",
    ],
    ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
    ["waste_expense", "5102", "Waste dan Spoilage", "expense", "cogs"],
    ["inventory_adjustment", "5103", "Selisih Stok Opname", "expense", "cogs"],
    [
      "inventory_price_variance",
      "5106",
      "Selisih Harga Persediaan",
      "expense",
      "cogs",
    ],
  ];
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of chart) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entity, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, accounts[role]],
    );
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entity, period],
    );
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantId, outletId, `Gudang Reval ${short()}`],
  );
  return { entity, outletId, locationId: rows[0]!.id, accounts };
}

async function insertItem(
  name: string,
  type: "raw_material" | "semi_finished" = "raw_material",
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', $4, $3, true) RETURNING id`,
    [tenantId, `${name} ${short()}`, uomId, type],
  );
  return rows[0]!.id;
}

type Receipt = { ledgerId: string; receiptId: string; valueIdr: number };

/** One goods receipt row; `valueIdr` is what the receipt journal books. */
async function receive(
  world: World,
  itemId: string,
  quantity: string,
  unitCost: string,
  occurredAt: string,
  options: { receiptId?: string; idempotencyKey?: string } = {},
): Promise<Receipt> {
  const receiptId = options.receiptId ?? randomUUID();
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    sourceType: "goods_receipt",
    sourceId: receiptId,
    occurredAt: at(occurredAt),
    ...(options.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: options.idempotencyKey }),
    actor: { type: "system" },
  });
  return {
    ledgerId: entry.id,
    receiptId,
    valueIdr: Number(quantity) * Number(unitCost),
  };
}

/** One `production_out` row valued at the moving average; returns its id. */
async function drawMaterial(
  world: World,
  itemId: string,
  quantity: string,
  productionId: string,
  occurredAt: string,
): Promise<string> {
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType: "production_out",
    quantity: decimal4(`-${quantity}`),
    sourceType: "production_order",
    sourceId: productionId,
    occurredAt: at(occurredAt),
    actor: { type: "system" },
  });
  return entry.id;
}

/** The `production_in` row of the output at `unitCost`; returns its id. */
async function putAwayOutput(
  world: World,
  itemId: string,
  quantity: string,
  unitCost: string,
  productionId: string,
  occurredAt: string,
): Promise<string> {
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType: "production_in",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    sourceType: "production_order",
    sourceId: productionId,
    occurredAt: at(occurredAt),
    actor: { type: "system" },
  });
  return entry.id;
}

async function eventOf(ledgerEntryId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'
        AND event->'payload'->>'ledgerEntryId' = $2`,
    [tenantId, ledgerEntryId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

async function deliverRow(ledgerEntryId: string): Promise<InventoryGlResult> {
  const event = await eventOf(ledgerEntryId);
  return withTenant(db, context(), (tx) =>
    deliverInventoryGlEvent(context(), event, tx, NOW),
  );
}

/** Net debit of one posting role over every journal of the world. */
async function netDebit(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ net: string }>(
    `SELECT COALESCE(sum(l.debit_idr - l.credit_idr), 0)::text AS net
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, world.entity, world.accounts[role]],
  );
  return Number(rows[0]!.net);
}

/** Stock card value of every item at the world's location (qty x average). */
async function stockValue(world: World): Promise<number> {
  const { rows } = await owner.query<{ value: string }>(
    `SELECT COALESCE(sum(quantity * avg_cost_idr), 0)::text AS value
       FROM stock_balances WHERE tenant_id = $1 AND location_id = $2`,
    [tenantId, world.locationId],
  );
  return Number(rows[0]!.value);
}

/**
 * INV-01: GL inventory (1301) equals the stock card. Receipts are booked by
 * the AP side (not this bridge), so their value is added to the GL side.
 */
async function expectBooksMatchCard(world: World, receiptsIdr: number) {
  expect((await netDebit(world, "inventory")) + receiptsIdr).toBe(
    await stockValue(world),
  );
  expect(await netDebit(world, "inventory_semi_finished")).toBe(0);
}

/** One outflow of `itemId` (sale, waste or count), delivered to the GL. */
async function outflow(
  world: World,
  kind: "sale" | "waste" | "count",
  itemId: string,
  quantity: string,
): Promise<InventoryGlResult> {
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType:
      kind === "sale" ? "sale" : kind === "waste" ? "waste" : "adjustment",
    quantity: decimal4(`-${quantity}`),
    sourceType:
      kind === "sale"
        ? "order"
        : kind === "waste"
          ? "waste_log"
          : "stock_count",
    sourceId: randomUUID(),
    occurredAt: at(DAY),
    actor: { type: "system" },
  });
  return deliverRow(entry.id);
}

type Journal = {
  id: string;
  entry_date: string;
  late_adjustment_from: string | null;
};

async function journalsOf(world: World, sourceId: string): Promise<Journal[]> {
  const { rows } = await owner.query<Journal>(
    `SELECT id, entry_date::text AS entry_date, late_adjustment_from::text AS late_adjustment_from
       FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_id = $3
      ORDER BY created_at, id`,
    [tenantId, world.entity, sourceId],
  );
  return rows;
}

async function balanceOf(entryId: string) {
  const { rows } = await owner.query<{ debit: string; credit: string }>(
    `SELECT sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2`,
    [tenantId, entryId],
  );
  return { debit: Number(rows[0]!.debit), credit: Number(rows[0]!.credit) };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantId = randomUUID();
  brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Revaluasi Stok', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantId,
      `uji-inv-reval-${tenantId.slice(0, 8)}`,
      JSON.stringify({ modules: ["accounting"], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, tenantId],
  );
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'g', 'g') RETURNING id",
    [tenantId],
  );
  uomId = uom.rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
});

type Batch = {
  productionId: string;
  rows: string[];
  outputItem: string;
  rawItems: string[];
};

/**
 * Raw A 10 @100 and raw B 20 @50 in stock; a batch draws 4 A (400) and 10 B
 * (500) and puts 3 units of the output away at 300 (cost 900).
 */
async function runBatch(world: World, occurredAt = DAY): Promise<Batch> {
  const a = await insertItem("Tepung");
  const b = await insertItem("Gula");
  const out = await insertItem("Adonan", "semi_finished");
  await receive(world, a, "10", "100", BEFORE);
  await receive(world, b, "20", "50", BEFORE);
  const productionId = randomUUID();
  const rows = [
    await drawMaterial(world, a, "4", productionId, occurredAt),
    await drawMaterial(world, b, "10", productionId, occurredAt),
    await putAwayOutput(world, out, "3", "300", productionId, occurredAt),
  ];
  return { productionId, rows, outputItem: out, rawItems: [a, b] };
}

/**
 * Raw 1000 g @100 (100.000) drawn whole; the output's unit cost is rounded to
 * 4 decimals, so its card value differs from the material cost: 70.000 g @
 * 1,4286 = 100.002 (+2), 30.000 g @ 3,3333 = 99.999 (-1).
 */
async function runRoundingBatch(
  world: World,
  outputQty: "70000" | "30000",
  occurredAt = DAY,
) {
  const raw = await insertItem("Daging");
  const out = await insertItem("Rendang", "semi_finished");
  await receive(world, raw, "1000", "100", BEFORE);
  const productionId = randomUUID();
  const unitCost = outputQty === "70000" ? "1.4286" : "3.3333";
  const rows = [
    await drawMaterial(world, raw, "1000", productionId, occurredAt),
    await putAwayOutput(
      world,
      out,
      outputQty,
      unitCost,
      productionId,
      occurredAt,
    ),
  ];
  return { productionId, rows, outputItem: out, receiptsIdr: 100000 };
}

/** Error code of the batch parked in `inventory_gl_blocked`, if any. */
async function blockedCodeOf(productionId: string): Promise<string | null> {
  const { rows } = await owner.query<{ error_code: string }>(
    `SELECT error_code FROM inventory_gl_blocked
      WHERE tenant_id = $1 AND source_type = 'production_order' AND source_id = $2`,
    [tenantId, productionId],
  );
  return rows[0]?.error_code ?? null;
}

/** Tracking rows (`inventory_gl_postings`) of a batch. */
async function trackedRowsOf(productionId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM inventory_gl_postings
      WHERE tenant_id = $1 AND source_type = 'production_order' AND source_id = $2`,
    [tenantId, productionId],
  );
  return Number(rows[0]!.n);
}

describe("1252 production batch journal", () => {
  it("[1252-NET] a batch moves no value between accounts: no journal, 1301 nets to zero", async () => {
    const world = await makeWorld();
    const batch = await runBatch(world);
    expect((await deliverRow(batch.rows[0]!)).status).toBe("zero_value");
    expect(await journalsOf(world, batch.productionId)).toEqual([]);
    expect(await netDebit(world, "inventory")).toBe(0);
    expect(await netDebit(world, "inventory_semi_finished")).toBe(0);
    expect(await netDebit(world, "cogs")).toBe(0);
    expect(await netDebit(world, "waste_expense")).toBe(0);
    expect(await netDebit(world, "inventory_adjustment")).toBe(0);
    expect(await netDebit(world, "inventory_price_variance")).toBe(0);
    await expectBooksMatchCard(world, 2000);
  });

  it("[1252-FLOW] produce, then sell, waste and count the output: 1301 equals the stock card at every step", async () => {
    const world = await makeWorld();
    const batch = await runBatch(world);
    await deliverRow(batch.rows[0]!);
    await expectBooksMatchCard(world, 2000);
    expect((await outflow(world, "sale", batch.outputItem, "1")).status).toBe(
      "posted",
    );
    await expectBooksMatchCard(world, 2000);
    expect(await netDebit(world, "cogs")).toBe(300);
    expect((await outflow(world, "waste", batch.outputItem, "1")).status).toBe(
      "posted",
    );
    await expectBooksMatchCard(world, 2000);
    expect(await netDebit(world, "waste_expense")).toBe(300);
    expect(
      (await outflow(world, "count", batch.outputItem, "0.5")).status,
    ).toBe("posted");
    await expectBooksMatchCard(world, 2000);
    expect(await netDebit(world, "inventory_adjustment")).toBe(150);
    // 2000 received - 300 sold - 300 wasted - 150 counted short.
    expect(await stockValue(world)).toBe(1250);
    expect(await netDebit(world, "inventory")).toBe(-750);
  });

  it("[1252-CHAIN] a batch that draws a semi-finished output keeps 1301 equal to the card", async () => {
    const world = await makeWorld();
    const first = await runBatch(world);
    await deliverRow(first.rows[0]!);
    // Second batch: 2 of the 3 semi-finished units (600) + 1 raw A (100)
    // become 4 units of a new output at 175 (700).
    const finished = await insertItem("Roti", "semi_finished");
    const productionId = randomUUID();
    const rows = [
      await drawMaterial(world, first.outputItem, "2", productionId, DAY),
      await drawMaterial(world, first.rawItems[0]!, "1", productionId, DAY),
      await putAwayOutput(world, finished, "4", "175", productionId, DAY),
    ];
    expect((await deliverRow(rows[0]!)).status).toBe("zero_value");
    expect(await journalsOf(world, productionId)).toEqual([]);
    await expectBooksMatchCard(world, 2000);
    expect((await outflow(world, "sale", finished, "4")).status).toBe("posted");
    await expectBooksMatchCard(world, 2000);
    expect(await netDebit(world, "cogs")).toBe(700);
  });

  it("[1252-ROUND] 70.000 g output: the +2 rounding goes Dr 1301 / Cr 5106, and the card sells out to zero", async () => {
    const world = await makeWorld();
    const batch = await runRoundingBatch(world, "70000");
    expect((await deliverRow(batch.rows[0]!)).status).toBe("posted");
    const journals = await journalsOf(world, batch.productionId);
    expect(journals).toHaveLength(1);
    expect(await balanceOf(journals[0]!.id)).toEqual({ debit: 2, credit: 2 });
    expect(await netDebit(world, "inventory")).toBe(2);
    expect(await netDebit(world, "inventory_price_variance")).toBe(-2);
    await expectBooksMatchCard(world, batch.receiptsIdr);
    await outflow(world, "sale", batch.outputItem, "70000");
    expect(await netDebit(world, "cogs")).toBe(100002);
    expect(await stockValue(world)).toBe(0);
    await expectBooksMatchCard(world, batch.receiptsIdr);
  });

  it("[1252-ROUND-DOWN] 30.000 g output: the -1 rounding goes Dr 5106 / Cr 1301", async () => {
    const world = await makeWorld();
    const batch = await runRoundingBatch(world, "30000");
    expect((await deliverRow(batch.rows[1]!)).status).toBe("posted");
    expect(await netDebit(world, "inventory")).toBe(-1);
    expect(await netDebit(world, "inventory_price_variance")).toBe(1);
    await expectBooksMatchCard(world, batch.receiptsIdr);
  });

  it("[1252-REPLAY] every row of the batch can be delivered again: still one journal", async () => {
    const world = await makeWorld();
    const batch = await runRoundingBatch(world, "70000");
    expect((await deliverRow(batch.rows[0]!)).status).toBe("posted");
    for (const row of batch.rows)
      expect((await deliverRow(row)).status).toBe("already_posted");
    expect(await journalsOf(world, batch.productionId)).toHaveLength(1);
    expect(await netDebit(world, "inventory")).toBe(2);
    const plain = await runBatch(world);
    expect((await deliverRow(plain.rows[0]!)).status).toBe("zero_value");
    for (const row of plain.rows)
      expect((await deliverRow(row)).status).toBe("already_posted");
    expect(await journalsOf(world, plain.productionId)).toEqual([]);
  });

  it("[1252-CLOSED] a closed period is not posted into: the rounding lands late in the open period", async () => {
    const world = await makeWorld();
    const batch = await runRoundingBatch(world, "70000");
    await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId, world.entity, randomUUID()],
    );
    expect((await deliverRow(batch.rows[1]!)).status).toBe("posted");
    const journals = await journalsOf(world, batch.productionId);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.entry_date).toBe("2026-11-01");
    expect(journals[0]!.late_adjustment_from).toBe("2026-10-15");
    expect(await netDebit(world, "inventory")).toBe(2);
  });

  it("[1252-SPLIT] an edge batch arriving draws first, output later: parked, nothing booked or tracked, then one rounding journal", async () => {
    const world = await makeWorld();
    const raw = await insertItem("Daging");
    const out = await insertItem("Rendang", "semi_finished");
    await receive(world, raw, "1000", "100", BEFORE);
    const productionId = randomUUID();
    // Delivery 1 carries only the first draw, delivery 2 the second draw.
    const draw1 = await drawMaterial(world, raw, "600", productionId, DAY);
    expect(await deliverRow(draw1)).toEqual({
      status: "blocked",
      code: "PRODUCTION_INCOMPLETE",
    });
    expect(await journalsOf(world, productionId)).toEqual([]);
    expect(await trackedRowsOf(productionId)).toBe(0);
    expect(await blockedCodeOf(productionId)).toBe("PRODUCTION_INCOMPLETE");
    expect(await netDebit(world, "inventory")).toBe(0);
    const draw2 = await drawMaterial(world, raw, "400", productionId, DAY);
    expect((await deliverRow(draw2)).status).toBe("blocked");
    expect(await trackedRowsOf(productionId)).toBe(0);
    expect(await netDebit(world, "inventory_price_variance")).toBe(0);
    // Delivery 3: the put-away completes the batch.
    const output = await putAwayOutput(
      world,
      out,
      "70000",
      "1.4286",
      productionId,
      DAY,
    );
    expect((await deliverRow(output)).status).toBe("posted");
    const journals = await journalsOf(world, productionId);
    expect(journals).toHaveLength(1);
    expect(await balanceOf(journals[0]!.id)).toEqual({ debit: 2, credit: 2 });
    expect(await trackedRowsOf(productionId)).toBe(3);
    expect(await blockedCodeOf(productionId)).toBeNull();
    await expectBooksMatchCard(world, 100000);
    for (const row of [draw1, draw2, output])
      expect((await deliverRow(row)).status).toBe("already_posted");
    expect(await journalsOf(world, productionId)).toHaveLength(1);
    await expectBooksMatchCard(world, 100000);
  });

  it("[1252-LATE-DRAW] output before its last draw: parked (5106 never holds the material cost), the sweep books one rounding journal once the draw lands", async () => {
    const world = await makeWorld();
    const raw = await insertItem("Daging");
    const out = await insertItem("Rendang", "semi_finished");
    await receive(world, raw, "1000", "100", BEFORE);
    const productionId = randomUUID();
    const draw1 = await drawMaterial(world, raw, "600", productionId, DAY);
    await putAwayOutput(world, out, "70000", "1.4286", productionId, DAY);
    expect((await deliverRow(draw1)).status).toBe("blocked");
    expect(await journalsOf(world, productionId)).toEqual([]);
    expect(await trackedRowsOf(productionId)).toBe(0);
    expect(await netDebit(world, "inventory_price_variance")).toBe(0);
    await drawMaterial(world, raw, "400", productionId, DAY);
    const swept = await retryBlockedInventoryGl(context(), LATER);
    expect(swept).toEqual({ posted: 1, stillBlocked: 0, failed: 0 });
    const journals = await journalsOf(world, productionId);
    expect(journals).toHaveLength(1);
    expect(await balanceOf(journals[0]!.id)).toEqual({ debit: 2, credit: 2 });
    expect(await netDebit(world, "inventory")).toBe(2);
    expect(await netDebit(world, "inventory_price_variance")).toBe(-2);
    expect(await blockedCodeOf(productionId)).toBeNull();
    await expectBooksMatchCard(world, 100000);
  });

  it("[1252-LOST-DRAW] a draw lost for good (dead letter): the batch stays parked, no journal, no 5106 gain", async () => {
    const world = await makeWorld();
    const raw = await insertItem("Daging");
    const out = await insertItem("Rendang", "semi_finished");
    await receive(world, raw, "1000", "100", BEFORE);
    const productionId = randomUUID();
    const draw1 = await drawMaterial(world, raw, "600", productionId, DAY);
    await putAwayOutput(world, out, "70000", "1.4286", productionId, DAY);
    expect((await deliverRow(draw1)).status).toBe("blocked");
    expect(await retryBlockedInventoryGl(context(), LATER)).toEqual({
      posted: 0,
      stillBlocked: 1,
      failed: 0,
    });
    expect(await journalsOf(world, productionId)).toEqual([]);
    expect(await trackedRowsOf(productionId)).toBe(0);
    expect(await blockedCodeOf(productionId)).toBe("PRODUCTION_INCOMPLETE");
    expect(await netDebit(world, "inventory")).toBe(0);
    expect(await netDebit(world, "inventory_price_variance")).toBe(0);
  });

  it("[1252-ZERO] a batch of free materials posts no journal", async () => {
    const world = await makeWorld();
    const a = await insertItem("Air");
    const out = await insertItem("Kaldu", "semi_finished");
    await receive(world, a, "10", "0", BEFORE);
    const productionId = randomUUID();
    const first = await drawMaterial(world, a, "4", productionId, DAY);
    await putAwayOutput(world, out, "2", "0", productionId, DAY);
    expect((await deliverRow(first)).status).toBe("zero_value");
    expect(await journalsOf(world, productionId)).toEqual([]);
  });
});
