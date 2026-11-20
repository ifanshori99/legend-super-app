// Inventory -> GL bridge: production batches (bead legend-29vw, card 1252).
//
// Completing a production batch writes `production_out` rows (raw material
// drawn at its moving average) and one `production_in` row (the output at
// cost / actual qty) under source `production_order`. The books must follow
// the stock card: the cost of the materials moves from inventory (1301) to
// semi-finished inventory (1302). It is not HPP and not waste (a yield
// shortfall raises the unit cost of the output, the card never loses it), so
// no profit changes. One balanced journal per batch, replay is a no-op, and a
// closed period is never written into (late adjustment, as the other stock
// sources).

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
  type InventoryGlResult,
} from "../services/inventory-gl-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
const at = (iso: string) => isoDateTimeSchema.parse(iso);
const NOW = new Date("2026-11-08T03:00:00Z");
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
  | "inventory_adjustment";
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

/** Stock card value of the item: quantity x moving average. */
async function cardValue(world: World, itemId: string): Promise<number> {
  const { rows } = await owner.query<{ value: string }>(
    `SELECT (quantity * avg_cost_idr)::text AS value FROM stock_balances
      WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
    [tenantId, world.locationId, itemId],
  );
  return Number(rows[0]!.value);
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

describe("1252 production batch journal", () => {
  it("[1252-MOVE] the cost of the materials moves from 1301 to 1302: balanced, no HPP, no waste", async () => {
    const world = await makeWorld();
    const batch = await runBatch(world);
    const result = await deliverRow(batch.rows[0]!);
    expect(result.status).toBe("posted");
    const journals = await journalsOf(world, batch.productionId);
    expect(journals).toHaveLength(1);
    expect(await balanceOf(journals[0]!.id)).toEqual({
      debit: 900,
      credit: 900,
    });
    expect(await netDebit(world, "inventory_semi_finished")).toBe(900);
    expect(await netDebit(world, "inventory")).toBe(-900);
    expect(await netDebit(world, "cogs")).toBe(0);
    expect(await netDebit(world, "waste_expense")).toBe(0);
    expect(await netDebit(world, "inventory_adjustment")).toBe(0);
  });

  it("[1252-CARD] the books follow the stock card after the batch", async () => {
    const world = await makeWorld();
    const batch = await runBatch(world);
    await deliverRow(batch.rows[0]!);
    expect(await cardValue(world, batch.outputItem)).toBe(900);
    expect(await netDebit(world, "inventory_semi_finished")).toBe(
      await cardValue(world, batch.outputItem),
    );
    let consumed = 0;
    for (const item of batch.rawItems) consumed += await cardValue(world, item);
    // Receipts (1000 + 1000) are the AP side's; the batch took 900 of them.
    expect(consumed).toBe(2000 - 900);
    expect(await netDebit(world, "inventory")).toBe(consumed - 2000);
  });

  it("[1252-REPLAY] every row of the batch can be delivered again: still one journal", async () => {
    const world = await makeWorld();
    const batch = await runBatch(world);
    expect((await deliverRow(batch.rows[0]!)).status).toBe("posted");
    for (const row of batch.rows)
      expect((await deliverRow(row)).status).toBe("already_posted");
    expect(await journalsOf(world, batch.productionId)).toHaveLength(1);
    expect(await netDebit(world, "inventory_semi_finished")).toBe(900);
  });

  it("[1252-ROUND] fractional costs round once over the batch and stay balanced", async () => {
    const world = await makeWorld();
    const a = await insertItem("Santan");
    const out = await insertItem("Bumbu", "semi_finished");
    await receive(world, a, "10", "33.3333", BEFORE);
    const productionId = randomUUID();
    // 3 x 33.3333 = 99.9999 -> 100
    const first = await drawMaterial(world, a, "3", productionId, DAY);
    await putAwayOutput(world, out, "7", "14.2857", productionId, DAY);
    expect((await deliverRow(first)).status).toBe("posted");
    const [journal] = await journalsOf(world, productionId);
    expect(await balanceOf(journal!.id)).toEqual({ debit: 100, credit: 100 });
  });

  it("[1252-CLOSED] a closed period is not posted into: the batch lands late in the open period", async () => {
    const world = await makeWorld();
    const batch = await runBatch(world);
    await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId, world.entity, randomUUID()],
    );
    expect((await deliverRow(batch.rows[2]!)).status).toBe("posted");
    const [journal] = await journalsOf(world, batch.productionId);
    expect(journal!.entry_date).toBe("2026-11-01");
    expect(journal!.late_adjustment_from).toBe("2026-10-15");
    expect(await netDebit(world, "inventory_semi_finished")).toBe(900);
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
