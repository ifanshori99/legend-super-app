// Training orders never reach the GL through the stock bridge (bead
// legend-gkc6b, case 5 of docs/briefs/sub-training-no-journal.md; PRD v1.7
// §3.19 "Jurnal Otomatis", Alur J.4; legend-2lp.8 training mode: a sale made
// on a device in training mode is not real and must not touch accounting).
//
// A stock ledger `sale` / `return` row whose source order has
// `pos_orders.is_training = true` must post NO journal, NO
// `inventory_gl_postings` tracking row and NO `inventory_gl_blocked` row, both
// through the event path (`deliverInventoryGlEvent`) and through the direct
// path (`postStockSourceToGl`). A regular order with identical data keeps
// posting exactly as before.
//
// Runs the real services against the disposable PostgreSQL test database in a
// fresh isolated tenant; every test owns a fresh legal entity + outlet.
//
// Assumptions (the brief fixes the contract):
// - Stock still leaves / returns to the ledger for a training order (only the
//   GL is skipped), so the ledger rows are asserted to exist.
// - The bridge answers `{ status: "ignored" }` for a training source.
// - The sweep may or may not delete a planted blocked row of a training order;
//   only "no journal, no tracking row" is asserted for it.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  decimal4,
  isoDateTimeSchema,
  tenantIdSchema,
  ulidToUuid,
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
  postStockSourceToGl,
  retryBlockedInventoryGl,
  RETRY_AFTER_MS,
  type InventoryGlResult,
} from "../services/inventory-gl-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
const at = (iso: string) => isoDateTimeSchema.parse(iso);
/** Fixed "now" for the consumer; every ledger instant below is in the past. */
const NOW = new Date("2026-11-08T03:00:00Z");
/** 2026-10-15 12:00 in Jakarta: business date 2026-10-15. */
const DAY = "2026-10-15T05:00:00.000Z";
const BEFORE = "2026-10-01T05:00:00.000Z";
const AFTER = "2026-10-16T05:00:00.000Z";
const ORDER_TOTAL = 50000;

/** TEN-05: the bridge only runs for tenants with the accounting module on. */
const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

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

/** A legal entity + outlet + CoA with the posting roles + open periods. */
async function makeWorld(options: { unmapped?: Role[] } = {}): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Entity GLT ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet GLT', 'Jl. GLT', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletId, tenantId, brandId, entity, `GT-${short()}`.toUpperCase()],
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
    if (options.unmapped?.includes(role)) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, accounts[role]],
    );
  }
  for (const period of ["2026-09", "2026-10", "2026-11"]) {
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entity, period],
    );
  }
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantId, outletId, `Gudang GLT ${short()}`],
  );
  return { entity, outletId, locationId: rows[0]!.id, accounts };
}

/**
 * A completed POS order (`orders` + `pos_orders`); returns its ULID.
 */
async function seedOrder(
  world: World,
  options: { training: boolean },
): Promise<string> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
               'completed', '2026-10-15', now())`,
      [
        uuid,
        tenantId,
        world.outletId,
        `GLT-${randomUUID().slice(0, 12)}`,
        ORDER_TOTAL,
      ],
    );
    // POS-04 forbids changing pos_orders of a final order, so the training
    // stamp is written at INSERT (the brief's UPDATE is refused by a trigger).
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
       VALUES ($1, $2, $3, 'pos', $4)`,
      [uuid, tenantId, world.outletId, options.training],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return ulid;
}

async function insertItem(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantId, `${name} ${short()}`, uomId],
  );
  return rows[0]!.id;
}

async function receive(
  world: World,
  itemId: string,
  quantity: string,
  unitCost: string,
): Promise<void> {
  await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    occurredAt: at(BEFORE),
    actor: { type: "system" },
  });
}

/** Writes one order ledger row; returns the ledger entry id (ULID). */
async function moveOrder(
  world: World,
  input: {
    movementType: "sale" | "return";
    orderId: string;
    itemId: string;
    quantity: string;
    unitCost?: string;
    occurredAt?: string;
  },
): Promise<string> {
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: input.itemId,
    movementType: input.movementType,
    quantity: decimal4(input.quantity),
    ...(input.unitCost === undefined
      ? {}
      : { unitCostIdr: decimal4(input.unitCost) }),
    sourceType: "order",
    sourceId: input.orderId,
    occurredAt: at(input.occurredAt ?? DAY),
    actor: { type: "system" },
  });
  return entry.id;
}

/** The real `stock.moved` envelope the ledger row wrote to the outbox. */
async function eventOf(ledgerEntryId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'
        AND event->'payload'->>'ledgerEntryId' = $2`,
    [tenantId, ledgerEntryId],
  );
  expect(rows, `stock.moved outbox row of ${ledgerEntryId}`).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

function deliver(event: EventEnvelope): Promise<InventoryGlResult> {
  return withTenant(db, context(), (tx) =>
    deliverInventoryGlEvent(context(), event, tx, NOW),
  );
}

async function deliverRow(ledgerEntryId: string): Promise<InventoryGlResult> {
  return deliver(await eventOf(ledgerEntryId));
}

function postDirect(orderId: string): Promise<InventoryGlResult> {
  return withTenant(db, context(), (tx) =>
    postStockSourceToGl(
      tx,
      context(),
      { sourceType: "order", sourceId: orderId },
      NOW,
    ),
  );
}

async function journalsOf(world: World, orderId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_id = $3
      ORDER BY created_at, id`,
    [tenantId, world.entity, orderId],
  );
  return rows;
}

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, world.entity],
  );
  return Number(rows[0]!.n);
}

async function linesOf(world: World, entryId: string) {
  const { rows } = await owner.query<{
    account_id: string;
    debit_idr: string;
    credit_idr: string;
  }>(
    `SELECT account_id, debit_idr::text AS debit_idr, credit_idr::text AS credit_idr
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2`,
    [tenantId, entryId],
  );
  const roleOf = new Map(
    (Object.entries(world.accounts) as [Role, string][]).map(([role, id]) => [
      id,
      role,
    ]),
  );
  return rows
    .map((row) => ({
      role: roleOf.get(row.account_id)!,
      debit: Number(row.debit_idr),
      credit: Number(row.credit_idr),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

/** `inventory_gl_postings` rows of the ledger rows of one order. */
async function trackingOf(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM inventory_gl_postings p
       JOIN stock_ledger l ON l.tenant_id = p.tenant_id AND l.id = p.ledger_entry_id
      WHERE p.tenant_id = $1 AND l.source_id = $2`,
    [tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]!.n);
}

/** Blocked (parked) rows of one order (domain source id = ULID). */
async function blockedOf(orderId: string) {
  const { rows } = await owner.query<{ error_code: string }>(
    `SELECT error_code FROM inventory_gl_blocked
      WHERE tenant_id = $1 AND source_type = 'order' AND source_id = $2`,
    [tenantId, orderId],
  );
  return rows;
}

async function ledgerRowCount(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM stock_ledger WHERE tenant_id = $1 AND source_type = 'order' AND source_id = $2",
    [tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]!.n);
}

async function expectNothingPosted(world: World, orderId: string) {
  expect(await journalsOf(world, orderId)).toHaveLength(0);
  expect(await trackingOf(orderId)).toBe(0);
  expect(await blockedOf(orderId)).toHaveLength(0);
}

/**
 * Flags an already-completed order as training. `pos_orders` of a final order
 * is frozen by a trigger (POS-04), so this bypasses it with
 * session_replication_role = replica, like an operator backfill (same pattern
 * as AJ-TRAIN-04): it models an order posted before the training rule existed.
 */
async function markTraining(orderId: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "UPDATE pos_orders SET is_training = true WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, ulidToUuid(orderId)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Net (debit - credit) per role over every journal line of the world. */
async function netByRole(world: World): Promise<Record<Role, number>> {
  const { rows } = await owner.query<{ account_id: string; net: string }>(
    `SELECT l.account_id, sum(l.debit_idr - l.credit_idr)::text AS net
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2
      GROUP BY l.account_id`,
    [tenantId, world.entity],
  );
  const net: Record<Role, number> = { cogs: 0, inventory: 0 };
  for (const row of rows) {
    for (const role of ["cogs", "inventory"] as Role[]) {
      if (world.accounts[role] === row.account_id) net[role] = Number(row.net);
    }
  }
  return net;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantId = randomUUID();
  brandId = randomUUID();
  const tag = tenantId.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Inventory GL Latihan', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantId,
      `uji-inv-gl-trn-${tag}`,
      FLAGS_ON,
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
  // Ledger, journals and the tenant stay (append-only, random names).
  await owner.end();
});

// ============================================================================

describe("§3.19 HPP of a training order does not post to the GL", () => {
  it("INV-GL-TRAINING-01 sale rows of a training order post no journal, no tracking row, no blocked row; a regular order with the same data still posts Dr cogs / Cr inventory", async () => {
    const world = await makeWorld();
    const coffee = await insertItem("Biji kopi");
    const milk = await insertItem("Susu");
    await receive(world, coffee, "20.0000", "1500.0000");
    await receive(world, milk, "20.0000", "2000.0000");

    const training = await seedOrder(world, { training: true });
    const trainingRows = [
      await moveOrder(world, {
        movementType: "sale",
        orderId: training,
        itemId: coffee,
        quantity: "-3.0000",
      }),
      await moveOrder(world, {
        movementType: "sale",
        orderId: training,
        itemId: milk,
        quantity: "-2.0000",
      }),
    ];
    // Stock still moved: only the GL is skipped.
    expect(await ledgerRowCount(training)).toBe(2);

    for (const row of trainingRows) {
      expect(await deliverRow(row)).toEqual({ status: "ignored" });
    }
    await expectNothingPosted(world, training);
    expect(await journalCount(world)).toBe(0);

    // Control: a regular order with identical movements posts as before.
    const regular = await seedOrder(world, { training: false });
    const regularRow = await moveOrder(world, {
      movementType: "sale",
      orderId: regular,
      itemId: coffee,
      quantity: "-3.0000",
    });
    await moveOrder(world, {
      movementType: "sale",
      orderId: regular,
      itemId: milk,
      quantity: "-2.0000",
    });
    expect((await deliverRow(regularRow)).status).toBe("posted");
    const entries = await journalsOf(world, regular);
    expect(entries).toHaveLength(1);
    // 3 x 1500 + 2 x 2000 = 8500.
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "cogs", debit: 8500, credit: 0 },
      { role: "inventory", debit: 0, credit: 8500 },
    ]);
    expect(await trackingOf(regular)).toBe(2);
    // The training order still has nothing, and only the regular journal exists.
    await expectNothingPosted(world, training);
    expect(await journalCount(world)).toBe(1);
  });

  it("INV-GL-TRAINING-02 a return row of a training order, and the direct postStockSourceToGl path, also post nothing; the regular order's return still posts", async () => {
    const world = await makeWorld();
    const item = await insertItem("Kopi");
    await receive(world, item, "20.0000", "1500.0000");

    const training = await seedOrder(world, { training: true });
    await moveOrder(world, {
      movementType: "sale",
      orderId: training,
      itemId: item,
      quantity: "-3.0000",
    });
    const trainingReturn = await moveOrder(world, {
      movementType: "return",
      orderId: training,
      itemId: item,
      quantity: "1.0000",
      unitCost: "1500.0000",
      occurredAt: AFTER,
    });

    expect(await deliverRow(trainingReturn)).toEqual({ status: "ignored" });
    expect(await postDirect(training)).toEqual({ status: "ignored" });
    await expectNothingPosted(world, training);
    expect(await journalCount(world)).toBe(0);

    // Control: the same sale + return on a regular order, posted directly.
    const regular = await seedOrder(world, { training: false });
    await moveOrder(world, {
      movementType: "sale",
      orderId: regular,
      itemId: item,
      quantity: "-3.0000",
    });
    await moveOrder(world, {
      movementType: "return",
      orderId: regular,
      itemId: item,
      quantity: "1.0000",
      unitCost: "1500.0000",
      occurredAt: AFTER,
    });
    expect((await postDirect(regular)).status).toBe("posted");
    const entries = await journalsOf(world, regular);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(await trackingOf(regular)).toBe(2);
    await expectNothingPosted(world, training);
  });

  it("INV-GL-TRAINING-03 a training order is ignored, not parked, where a regular order would be blocked (cogs account unmapped)", async () => {
    const world = await makeWorld({ unmapped: ["cogs"] });
    const item = await insertItem("Kopi");
    await receive(world, item, "20.0000", "1500.0000");

    const training = await seedOrder(world, { training: true });
    const trainingRow = await moveOrder(world, {
      movementType: "sale",
      orderId: training,
      itemId: item,
      quantity: "-2.0000",
    });
    expect(await deliverRow(trainingRow)).toEqual({ status: "ignored" });
    await expectNothingPosted(world, training);

    // Control: the same world blocks a regular order, proving the setup.
    const regular = await seedOrder(world, { training: false });
    const regularRow = await moveOrder(world, {
      movementType: "sale",
      orderId: regular,
      itemId: item,
      quantity: "-2.0000",
    });
    expect(await deliverRow(regularRow)).toEqual({
      status: "blocked",
      code: "ACCOUNT_MAPPING_MISSING",
    });
    expect(await blockedOf(regular)).toHaveLength(1);
    expect(await blockedOf(training)).toHaveLength(0);
  });

  it("INV-GL-TRAINING-04 the retry sweep does not post a parked row of a training order, and still posts the regular one", async () => {
    const world = await makeWorld();
    const item = await insertItem("Kopi");
    await receive(world, item, "20.0000", "1500.0000");

    const training = await seedOrder(world, { training: true });
    await moveOrder(world, {
      movementType: "sale",
      orderId: training,
      itemId: item,
      quantity: "-2.0000",
    });
    const regular = await seedOrder(world, { training: false });
    await moveOrder(world, {
      movementType: "sale",
      orderId: regular,
      itemId: item,
      quantity: "-2.0000",
    });
    // Park both as an older delivery would have (period closed at the time).
    const failedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    for (const orderId of [training, regular]) {
      await owner.query(
        `INSERT INTO inventory_gl_blocked
           (tenant_id, outlet_id, source_type, source_id, error_code, first_failed_at, last_failed_at)
         VALUES ($1, $2, 'order', $3, 'PERIOD_CLOSED', $4, $4)`,
        [tenantId, world.outletId, orderId, failedAt],
      );
    }

    await retryBlockedInventoryGl(
      context(),
      new Date(NOW.getTime() + RETRY_AFTER_MS + 1000),
    );

    expect(await journalsOf(world, training)).toHaveLength(0);
    expect(await trackingOf(training)).toBe(0);
    expect(await journalsOf(world, regular)).toHaveLength(1);
    expect(await trackingOf(regular)).toBe(1);
  });
});

describe("§3.19 training rule against rows that predate it (round 2)", () => {
  it("INV-GL-TRAINING-05 an old blocked row of a training source is deleted by the sweep and is not retried; the regular blocked row is still retried", async () => {
    const world = await makeWorld();
    const item = await insertItem("Kopi");
    await receive(world, item, "20.0000", "1500.0000");

    const training = await seedOrder(world, { training: true });
    await moveOrder(world, {
      movementType: "sale",
      orderId: training,
      itemId: item,
      quantity: "-2.0000",
    });
    const regular = await seedOrder(world, { training: false });
    await moveOrder(world, {
      movementType: "sale",
      orderId: regular,
      itemId: item,
      quantity: "-2.0000",
    });
    const failedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    for (const orderId of [training, regular]) {
      await owner.query(
        `INSERT INTO inventory_gl_blocked
           (tenant_id, outlet_id, source_type, source_id, error_code, first_failed_at, last_failed_at)
         VALUES ($1, $2, 'order', $3, 'PERIOD_CLOSED', $4, $4)`,
        [tenantId, world.outletId, orderId, failedAt],
      );
    }
    expect(await blockedOf(training)).toHaveLength(1);

    const sweepAt = new Date(NOW.getTime() + RETRY_AFTER_MS + 1000);
    await retryBlockedInventoryGl(context(), sweepAt);

    // The stale parked row of the training source is gone, nothing posted.
    await expectNothingPosted(world, training);
    // The regular order was retried and posted (its parked row is cleared).
    expect(await journalsOf(world, regular)).toHaveLength(1);
    expect(await blockedOf(regular)).toHaveLength(0);

    // A later sweep still finds nothing to retry for the training order.
    await retryBlockedInventoryGl(
      context(),
      new Date(sweepAt.getTime() + RETRY_AFTER_MS + 1000),
    );
    await expectNothingPosted(world, training);
    expect(await journalCount(world)).toBe(1);
  });

  it("INV-GL-TRAINING-06 a sale already posted, then the order flagged training: its return is still posted and reverses the cost", async () => {
    const world = await makeWorld();
    const item = await insertItem("Kopi");
    await receive(world, item, "20.0000", "1500.0000");

    const orderId = await seedOrder(world, { training: false });
    const saleRow = await moveOrder(world, {
      movementType: "sale",
      orderId,
      itemId: item,
      quantity: "-3.0000",
    });
    expect((await deliverRow(saleRow)).status).toBe("posted");
    expect(await trackingOf(orderId)).toBe(1);
    expect(await netByRole(world)).toEqual({ cogs: 4500, inventory: -4500 });
    const journalsBefore = await journalCount(world);

    // The order is flagged training after its sale was already journalled.
    await markTraining(orderId);
    const returnRow = await moveOrder(world, {
      movementType: "return",
      orderId,
      itemId: item,
      quantity: "1.0000",
      unitCost: "1500.0000",
      occurredAt: AFTER,
    });

    // Not ignored: the old journal must be reversed by the return.
    expect((await deliverRow(returnRow)).status).toBe("posted");
    expect(await trackingOf(orderId)).toBe(2);
    expect(await journalCount(world)).toBeGreaterThan(journalsBefore);
    expect(await blockedOf(orderId)).toHaveLength(0);
    // 3 sold, 1 returned at 1500: net cost 3000 stays.
    expect(await netByRole(world)).toEqual({ cogs: 3000, inventory: -3000 });
  });
});

// Card 1232 review P3-1: a training order's return onto a negative balance
// posts its revaluation (a real card change) on the return's ledger row. That
// posting is not an order posting, so a redelivered event still finds the
// training order unposted and the sale and return stay out of the books.
describe("1232 a training order's revaluation does not unlock its order rows", () => {
  it("INV-GL-TRAINING-07 return onto a negative balance: only the revaluation posts, redelivery keeps the order out", async () => {
    const world = await makeWorld();
    const item = await insertItem("Gula aren");
    await receive(world, item, "10.0000", "100.0000");
    const training = await seedOrder(world, { training: true });
    const sale = await moveOrder(world, {
      movementType: "sale",
      orderId: training,
      itemId: item,
      quantity: "-15.0000",
    });
    // -5 at avg 100; 2 back at 120 revalues the deficit by -5 x 20 = -100.
    const back = await moveOrder(world, {
      movementType: "return",
      orderId: training,
      itemId: item,
      quantity: "2.0000",
      unitCost: "120.0000",
    });
    expect(await deliverRow(sale)).toEqual({ status: "ignored" });
    expect((await deliverRow(back)).status).toBe("posted");
    expect((await deliverRow(back)).status).toBe("already_posted");
    expect(await deliverRow(sale)).toEqual({ status: "ignored" });
    expect(await netByRole(world)).toEqual({ cogs: 100, inventory: -100 });
  });
});
