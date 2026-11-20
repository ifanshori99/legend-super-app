// Inventory -> GL bridge: revaluation of a receipt that lands on a negative
// balance (bead 1214, second opinion inventori 1208 P2, CTO decision 20 Nov
// option 1).
//
// A real-time sale can run ahead of a receipt: the balance goes negative at
// the old average, and the receipt then resets the average to its own cost
// (applyStockMovement). The receipt journal books the full receipt value, so
// without a correction the GL inventory stays above the stock card by
// negativeQty x (new cost - old average) and HPP stays short by the same
// amount (profit too high, profit share paid too much). The bridge posts that
// difference as its own `negative_stock_revaluation` source: Dr HPP / Cr
// inventory (reversed when the new cost is lower).

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
const AFTER = "2026-10-16T05:00:00.000Z";

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

type Role = "cogs" | "inventory";
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
    ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
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

async function insertItem(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantId, `${name} ${short()}`, uomId],
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

/** One sale row valued at the moving average; returns the ledger id. */
async function sell(
  world: World,
  itemId: string,
  quantity: string,
  occurredAt: string,
): Promise<string> {
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType: "sale",
    quantity: decimal4(`-${quantity}`),
    sourceType: "order",
    sourceId: randomUUID(),
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

describe("1214 receipt onto a negative balance revalues the units sold short", () => {
  it("REVAL-01 avg 0, sell 5, receive 10 @100: HPP +500 and GL inventory = stock card", async () => {
    const world = await makeWorld();
    const item = await insertItem("Gula");
    const sale = await sell(world, item, "5", BEFORE);
    const receipt = await receive(world, item, "10", "100", DAY);
    expect((await deliverRow(sale)).status).toBe("zero_value");
    expect((await deliverRow(receipt.ledgerId)).status).toBe("posted");

    const [journal, ...rest] = await journalsOf(world, receipt.receiptId);
    expect(rest).toEqual([]);
    expect(journal!.entry_date).toBe("2026-10-15");
    expect(await balanceOf(journal!.id)).toEqual({ debit: 500, credit: 500 });
    expect(await netDebit(world, "cogs")).toBe(500);
    // GL inventory = the receipt journal (full value) + the bridge journals.
    const glInventory = receipt.valueIdr + (await netDebit(world, "inventory"));
    expect(await cardValue(world, item)).toBe(500);
    expect(glInventory).toBe(500);
  });

  it("REVAL-02 sell 5 at avg 100 past zero, receive 10 @120: HPP +100", async () => {
    const world = await makeWorld();
    const item = await insertItem("Kopi");
    const first = await receive(world, item, "5", "100", BEFORE);
    const sale = await sell(world, item, "10", DAY);
    const receipt = await receive(world, item, "10", "120", AFTER);
    expect((await deliverRow(first.ledgerId)).status).toBe("ignored");
    expect((await deliverRow(sale)).status).toBe("posted");
    expect((await deliverRow(receipt.ledgerId)).status).toBe("posted");

    expect(await netDebit(world, "cogs")).toBe(1000 + 100);
    const glInventory =
      first.valueIdr + receipt.valueIdr + (await netDebit(world, "inventory"));
    expect(await cardValue(world, item)).toBe(600);
    expect(glInventory).toBe(600);
  });

  it("REVAL-03 a cheaper receipt credits HPP back (Dr inventory / Cr HPP)", async () => {
    const world = await makeWorld();
    const item = await insertItem("Susu");
    await receive(world, item, "5", "100", BEFORE);
    const sale = await sell(world, item, "10", DAY);
    const receipt = await receive(world, item, "10", "80", AFTER);
    await deliverRow(sale);
    expect((await deliverRow(receipt.ledgerId)).status).toBe("posted");
    expect(await netDebit(world, "cogs")).toBe(1000 - 100);
    expect(500 + 800 + (await netDebit(world, "inventory"))).toBe(
      await cardValue(world, item),
    );
  });

  it("REVAL-04 replayed receipt and redelivered event post once", async () => {
    const world = await makeWorld();
    const item = await insertItem("Teh");
    await sell(world, item, "5", BEFORE);
    const receiptId = randomUUID();
    const idempotencyKey = `reval-${randomUUID()}`;
    const receipt = await receive(world, item, "10", "100", DAY, {
      receiptId,
      idempotencyKey,
    });
    const replay = await receive(world, item, "10", "100", DAY, {
      receiptId,
      idempotencyKey,
    });
    expect(replay.ledgerId).toBe(receipt.ledgerId);
    expect((await deliverRow(receipt.ledgerId)).status).toBe("posted");
    expect((await deliverRow(receipt.ledgerId)).status).toBe("already_posted");
    expect(await journalsOf(world, receiptId)).toHaveLength(1);
    expect(await netDebit(world, "cogs")).toBe(500);
  });

  it("REVAL-05 a receipt onto a positive balance posts no revaluation", async () => {
    const world = await makeWorld();
    const item = await insertItem("Beras");
    await receive(world, item, "5", "100", BEFORE);
    const receipt = await receive(world, item, "5", "120", DAY);
    expect((await deliverRow(receipt.ledgerId)).status).toBe("ignored");
    expect(await journalsOf(world, receipt.receiptId)).toEqual([]);
  });

  it("REVAL-06 a closed period is not posted into: the revaluation lands late in the open period", async () => {
    const world = await makeWorld();
    const item = await insertItem("Garam");
    await sell(world, item, "5", BEFORE);
    const receipt = await receive(world, item, "10", "100", DAY);
    await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId, world.entity, randomUUID()],
    );
    expect((await deliverRow(receipt.ledgerId)).status).toBe("posted");
    const [journal] = await journalsOf(world, receipt.receiptId);
    expect(journal!.entry_date).toBe("2026-11-01");
    expect(journal!.late_adjustment_from).toBe("2026-10-15");
    expect(await netDebit(world, "cogs")).toBe(500);
  });
});
