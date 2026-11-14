// Inventory -> GL bridge: late adjustment instead of parking on a closed period
// (bead legend-tgb3; docs/design/auto-journals.md section 5 + "Risiko desain 4";
// PRD v1.7 section 3.19; INV-01, ACC-01, ACC-02).
//
// Sales auto-journals already roll a fact whose business date is in a closed
// fiscal period to the first day of the period after the latest closed one,
// keep the natural date in `journal_entries.late_adjustment_from` and write an
// `accounting.journal.late_adjusted` audit row (AJ-LATE-*, AJ-SET-08). The
// inventory bridge (stock count, waste, COGS of sales) must do the same, so the
// sale and its COGS land in the same month instead of parking on PERIOD_CLOSED.
//
// Fixtures follow inventory-gl.test.ts: fresh tenant, fresh legal entity +
// outlet per test, real `stock.moved` envelopes from the outbox delivered
// inside `withTenant`.
//
// Assumptions (the card fixes the intent; details are not in the PRD):
// - Target date: first day of the period after the latest closed period of the
//   legal entity (2026-10 closed -> 2026-11-01), same rule as sales
//   (`resolveAutoJournalDate`), even when that month has no fiscal_periods row.
// - Delivery itself posts (status "posted"); there is no parking and no
//   `inventory_gl_blocked` row for a merely closed period any more.
// - The audit row is `accounting.journal.late_adjusted` naming the journal id,
//   found the same way as in accounting-auto-journal.test.ts.
// - The description names the natural date (design section 5.5, as for sales).
// - "Closed and no open day after": under the shared rule the month after the
//   latest closed one is always postable (created on demand, AJ-LATE-03), so a
//   genuinely unpostable target cannot be built from fiscal_periods alone. The
//   "still parks" requirement is covered with the other reason a closed-period
//   fact must not be posted blindly: a missing account mapping parks it, and
//   no journal may exist on ANY date (neither the closed day nor a wrong one)
//   until the mapping exists; the sweep then posts it once, late-flagged.
// - A journal never carries an entry date inside a closed period (invariant
//   checked in every test through `expectNoJournalInClosedPeriod`).

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateSchema,
  createUlid,
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
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createStockBatch,
  recordStockMovement,
} from "../services/inventory.service.ts";
import {
  deliverInventoryGlEvent,
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
/** 2026-10-15 12:00 in Jakarta: business date 2026-10-15 (a closed month below). */
const DAY = "2026-10-15T05:00:00.000Z";
const BEFORE = "2026-10-01T05:00:00.000Z";
/** 2026-11-02 12:00 in Jakarta: a day in an open month. */
const OPEN_DAY = "2026-11-02T05:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

let tenantId: string;
let brandId: string;
let uomId: string;
let wasteUserId: string;

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

type Role = "cogs" | "inventory" | "waste_expense" | "inventory_adjustment";

type World = {
  entity: string;
  outletId: string;
  locationId: string;
  accounts: Record<Role, string>;
};

async function makeWorld(options: { unmapped?: Role[] } = {}): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Entity GL late ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet GL', 'Jl. GL', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletId, tenantId, brandId, entity, `GL-${short()}`.toUpperCase()],
  );
  const chart: [Role, string, string, string, string][] = [
    ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
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
    if (options.unmapped?.includes(role)) continue;
    await mapRole(entity, role, accounts[role]);
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entity, period],
    );
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantId, outletId, `Gudang GL ${short()}`],
  );
  return { entity, outletId, locationId: rows[0]!.id, accounts };
}

async function mapRole(
  entity: string,
  role: Role,
  accountId: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, entity, role, accountId],
  );
}

async function closePeriods(world: World, periods: string[]): Promise<void> {
  for (const period of periods)
    await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $4`,
      [tenantId, world.entity, randomUUID(), period],
    );
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
  batchId: string | null = null,
): Promise<void> {
  await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    batchId,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    occurredAt: at(BEFORE),
    actor: { type: "system" },
  });
}

type Move = {
  movementType: "sale" | "return" | "adjustment" | "waste";
  sourceType: "order" | "stock_count" | "waste_log";
  sourceId: string;
  itemId: string;
  quantity: string;
  batchId?: string;
  occurredAt?: string;
};

/** Writes one ledger row (valued by the ledger at the average); returns its id. */
async function move(world: World, input: Move): Promise<string> {
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: input.itemId,
    movementType: input.movementType,
    quantity: decimal4(input.quantity),
    ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    occurredAt: at(input.occurredAt ?? DAY),
    actor:
      input.movementType === "waste"
        ? { type: "user", id: wasteUserId }
        : { type: "system" },
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

function sweep(n: number) {
  return retryBlockedInventoryGl(
    context(),
    new Date(NOW.getTime() + n * (RETRY_AFTER_MS + 1000)),
  );
}

type Entry = {
  id: string;
  entry_date: string;
  late_adjustment_from: string | null;
  description: string | null;
};

async function journalsOf(world: World, sourceId: string): Promise<Entry[]> {
  const { rows } = await owner.query<Entry>(
    `SELECT id, entry_date::text AS entry_date,
            late_adjustment_from::text AS late_adjustment_from, description
       FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_id = $3
      ORDER BY entry_date, id`,
    [tenantId, world.entity, sourceId],
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

type Line = { role: Role; debit: number; credit: number };

async function linesOf(world: World, entryId: string): Promise<Line[]> {
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

/** ACC-01: debits equal credits and the journal is not empty. */
function expectBalanced(lines: Line[]) {
  const debit = lines.reduce((sum, l) => sum + l.debit, 0);
  const credit = lines.reduce((sum, l) => sum + l.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
}

async function lateAuditCount(journalId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs
      WHERE tenant_id = $1
        AND event->>'action' LIKE '%accounting.journal.late_adjusted'
        AND event::text LIKE '%' || $2 || '%'`,
    [tenantId, journalId],
  );
  return Number(rows[0]!.n);
}

async function trackedJournalIds(sourceUuidOrUlid: string) {
  const { rows } = await owner.query<{ journal_entry_id: string | null }>(
    `SELECT p.journal_entry_id
       FROM inventory_gl_postings p
      WHERE p.tenant_id = $1 AND p.source_id = $2`,
    [tenantId, sourceUuidOrUlid],
  );
  return rows.map((row) => row.journal_entry_id);
}

async function blockedCount(sourceId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM inventory_gl_blocked
      WHERE tenant_id = $1 AND source_id = $2`,
    [tenantId, sourceId],
  );
  return Number(rows[0]!.n);
}

/** No journal of the entity may sit on a day of a closed fiscal period. */
async function expectNoJournalInClosedPeriod(world: World): Promise<void> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM journal_entries j
       JOIN fiscal_periods f
         ON f.tenant_id = j.tenant_id AND f.legal_entity_id = j.legal_entity_id
        AND f.period = to_char(j.entry_date, 'YYYY-MM')
      WHERE j.tenant_id = $1 AND j.legal_entity_id = $2 AND f.status = 'closed'`,
    [tenantId, world.entity],
  );
  expect(Number(rows[0]!.n), "journals inside a closed period").toBe(0);
}

/** A world with one item stocked 10 x 1500 and a 3-unit sale on `occurredAt`. */
async function stockedSale(
  world: World,
  orderId: string,
  occurredAt: string = DAY,
  quantity = "-3.0000",
) {
  const item = await insertItem("Kopi");
  await receive(world, item, "10.0000", "1500.0000");
  const ledgerId = await move(world, {
    movementType: "sale",
    sourceType: "order",
    sourceId: orderId,
    itemId: item,
    quantity,
    occurredAt,
  });
  return { item, ledgerId };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantId = randomUUID();
  brandId = randomUUID();
  const tag = tenantId.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Inventory GL Late', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantId,
      `uji-inv-gl-late-${tag}`,
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
  setAuditWriter(coreAuditWriter);
  wasteUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [wasteUserId, "Inventory GL Late User", `${wasteUserId}@example.com`],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

// ============================================================================

describe("legend-tgb3 inventory GL rolls a closed period to the first open day", () => {
  it("INV-GL-LATE-01 the COGS of a sale in a closed month posts on the first open day, flagged with the sale date, with an audit row", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const { ledgerId } = await stockedSale(world, orderId);
    await closePeriods(world, ["2026-10"]);

    const result = await deliverRow(ledgerId);

    expect(result.status).toBe("posted");
    const entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry!.entry_date).toBe("2026-11-01");
    expect(entry!.late_adjustment_from).toBe("2026-10-15");
    expect(entry!.description ?? "").toContain("2026-10-15");
    const lines = await linesOf(world, entry!.id);
    expect(lines).toEqual([
      { role: "cogs", debit: 4500, credit: 0 },
      { role: "inventory", debit: 0, credit: 4500 },
    ]);
    expectBalanced(lines);
    expect(await lateAuditCount(entry!.id)).toBe(1);
    // Posted, not parked: tracked against the journal, nothing blocked.
    expect(await trackedJournalIds(orderId)).toEqual([entry!.id]);
    expect(await blockedCount(orderId)).toBe(0);
    await expectNoJournalInClosedPeriod(world);
  });

  it("INV-GL-LATE-02 the late amounts equal the non-late case, and an on-time sale keeps its own date with no flag and no audit row", async () => {
    const onTimeWorld = await makeWorld();
    const lateWorld = await makeWorld();
    const [onTimeOrder, lateOrder] = [createUlid(), createUlid()];
    const onTime = await stockedSale(onTimeWorld, onTimeOrder);
    const late = await stockedSale(lateWorld, lateOrder);
    await closePeriods(lateWorld, ["2026-09", "2026-10"]);

    expect((await deliverRow(onTime.ledgerId)).status).toBe("posted");
    expect((await deliverRow(late.ledgerId)).status).toBe("posted");

    const [onTimeEntry] = await journalsOf(onTimeWorld, onTimeOrder);
    const [lateEntry] = await journalsOf(lateWorld, lateOrder);
    expect(onTimeEntry!.entry_date).toBe("2026-10-15");
    expect(onTimeEntry!.late_adjustment_from).toBeNull();
    expect(await lateAuditCount(onTimeEntry!.id)).toBe(0);
    expect(lateEntry!.entry_date).toBe("2026-11-01");
    expect(lateEntry!.late_adjustment_from).toBe("2026-10-15");
    expect(await linesOf(lateWorld, lateEntry!.id)).toEqual(
      await linesOf(onTimeWorld, onTimeEntry!.id),
    );
  });

  it("INV-GL-LATE-03 an opname loss in a closed month posts Dr inventory_adjustment / Cr inventory on the first open day", async () => {
    const world = await makeWorld();
    const countId = randomUUID();
    const item = await insertItem("Gula");
    await receive(world, item, "10.0000", "1500.0000");
    const row = await move(world, {
      movementType: "adjustment",
      sourceType: "stock_count",
      sourceId: countId,
      itemId: item,
      quantity: "-2.0000",
    });
    await closePeriods(world, ["2026-10"]);

    expect((await deliverRow(row)).status).toBe("posted");

    const [entry, ...others] = await journalsOf(world, countId);
    expect(others).toHaveLength(0);
    expect(entry!.entry_date).toBe("2026-11-01");
    expect(entry!.late_adjustment_from).toBe("2026-10-15");
    const lines = await linesOf(world, entry!.id);
    expect(lines).toEqual([
      { role: "inventory", debit: 0, credit: 3000 },
      { role: "inventory_adjustment", debit: 3000, credit: 0 },
    ]);
    expectBalanced(lines);
    expect(await lateAuditCount(entry!.id)).toBe(1);
    await expectNoJournalInClosedPeriod(world);
  });

  it("INV-GL-LATE-04 a waste log in a closed month posts Dr waste_expense / Cr inventory on the first open day", async () => {
    const world = await makeWorld();
    const logId = randomUUID();
    const item = await insertItem("Susu");
    const batch = await createStockBatch(context(), {
      outletId: world.outletId,
      locationId: world.locationId,
      inventoryItemId: item,
      batchCode: `B-${short()}`,
      expiresOn: businessDateSchema.parse("2099-01-05"),
    });
    await receive(world, item, "5.0000", "1500.0000", batch.id);
    const row = await move(world, {
      movementType: "waste",
      sourceType: "waste_log",
      sourceId: logId,
      itemId: item,
      quantity: "-1.0000",
      batchId: batch.id,
    });
    await owner.query(
      `INSERT INTO waste_logs
         (id, tenant_id, outlet_id, location_id, target_type, target_id, quantity,
          reason, value_idr, logged_by, occurred_at)
       VALUES ($1, $2, $3, $4, 'inventory_item', $5, 1, 'spoiled', 1500, $6, $7)`,
      [
        logId,
        tenantId,
        world.outletId,
        world.locationId,
        item,
        wasteUserId,
        DAY,
      ],
    );
    await closePeriods(world, ["2026-10"]);

    expect((await deliverRow(row)).status).toBe("posted");

    const [entry, ...others] = await journalsOf(world, logId);
    expect(others).toHaveLength(0);
    expect(entry!.entry_date).toBe("2026-11-01");
    expect(entry!.late_adjustment_from).toBe("2026-10-15");
    const lines = await linesOf(world, entry!.id);
    expect(lines).toEqual([
      { role: "inventory", debit: 0, credit: 1500 },
      { role: "waste_expense", debit: 1500, credit: 0 },
    ]);
    expectBalanced(lines);
    expect(await lateAuditCount(entry!.id)).toBe(1);
    await expectNoJournalInClosedPeriod(world);
  });

  it("INV-GL-LATE-05 several closed months: the journal lands on the first day after the latest closed month, even if that month does not exist yet", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const { ledgerId } = await stockedSale(world, orderId);
    await closePeriods(world, ["2026-09", "2026-10", "2026-11"]);

    expect((await deliverRow(ledgerId)).status).toBe("posted");

    const [entry, ...others] = await journalsOf(world, orderId);
    expect(others).toHaveLength(0);
    expect(entry!.entry_date).toBe("2026-12-01");
    expect(entry!.late_adjustment_from).toBe("2026-10-15");
    expectBalanced(await linesOf(world, entry!.id));
    await expectNoJournalInClosedPeriod(world);
  });

  it("INV-GL-LATE-06 an order with one row in a closed month and one in an open month posts two journals: one late-flagged, one on its own day", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    await receive(world, item, "10.0000", "1000.0000");
    await closePeriods(world, ["2026-10"]);
    const closedRow = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: item,
      quantity: "-1.0000",
    });
    const openRow = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: item,
      quantity: "-2.0000",
      occurredAt: OPEN_DAY,
    });

    expect((await deliverRow(openRow)).status).toBe("posted");

    const entries = await journalsOf(world, orderId);
    expect(entries.map((e) => e.entry_date)).toEqual([
      "2026-11-01",
      "2026-11-02",
    ]);
    const [late, onTime] = entries;
    expect(late!.late_adjustment_from).toBe("2026-10-15");
    expect(onTime!.late_adjustment_from).toBeNull();
    expect(await linesOf(world, late!.id)).toEqual([
      { role: "cogs", debit: 1000, credit: 0 },
      { role: "inventory", debit: 0, credit: 1000 },
    ]);
    expect(await linesOf(world, onTime!.id)).toEqual([
      { role: "cogs", debit: 2000, credit: 0 },
      { role: "inventory", debit: 0, credit: 2000 },
    ]);
    expect(await lateAuditCount(late!.id)).toBe(1);
    expect(await lateAuditCount(onTime!.id)).toBe(0);
    expect(await deliverRow(closedRow)).toEqual({ status: "already_posted" });
    expect(await journalsOf(world, orderId)).toHaveLength(2);
  });
});

describe("legend-tgb3 a late-adjusted inventory journal is idempotent", () => {
  it("INV-GL-LATE-07 replaying the event, delivering the other row of the order and running the sweep keep one late journal and one audit row", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    const milk = await insertItem("Susu");
    await receive(world, item, "10.0000", "1500.0000");
    await receive(world, milk, "10.0000", "2000.0000");
    const rowA = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: item,
      quantity: "-1.0000",
    });
    const rowB = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: milk,
      quantity: "-1.0000",
    });
    await closePeriods(world, ["2026-10"]);

    const eventA = await eventOf(rowA);
    expect((await deliver(eventA)).status).toBe("posted");
    expect(await deliver(eventA)).toEqual({ status: "already_posted" });
    expect(await deliverRow(rowB)).toEqual({ status: "already_posted" });
    await sweep(1);
    await sweep(2);

    const entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_date).toBe("2026-11-01");
    expect(entries[0]!.late_adjustment_from).toBe("2026-10-15");
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "cogs", debit: 3500, credit: 0 },
      { role: "inventory", debit: 0, credit: 3500 },
    ]);
    expect(await lateAuditCount(entries[0]!.id)).toBe(1);
    expect(await journalCount(world)).toBe(1);
    expect(await blockedCount(orderId)).toBe(0);
    await expectNoJournalInClosedPeriod(world);
  });

  it("INV-GL-LATE-08 two consumers delivering the rows of one late order at the same time post one journal and one audit row", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    const milk = await insertItem("Susu");
    await receive(world, item, "10.0000", "1500.0000");
    await receive(world, milk, "10.0000", "2000.0000");
    const rowA = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: item,
      quantity: "-1.0000",
    });
    const rowB = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: milk,
      quantity: "-1.0000",
    });
    await closePeriods(world, ["2026-10"]);
    const [eventA, eventB] = [await eventOf(rowA), await eventOf(rowB)];

    const results = await Promise.all([deliver(eventA), deliver(eventB)]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "already_posted",
      "posted",
    ]);
    const entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_date).toBe("2026-11-01");
    expect(entries[0]!.late_adjustment_from).toBe("2026-10-15");
    expect(await lateAuditCount(entries[0]!.id)).toBe(1);
    expect(await journalCount(world)).toBe(1);
  });
});

describe("legend-tgb3 a closed period never causes a wrong posting", () => {
  it("INV-GL-LATE-09 a closed-period fact whose account mapping is missing posts nothing on any date; once mapped the sweep posts it once, late-flagged", async () => {
    const world = await makeWorld({ unmapped: ["cogs"] });
    const orderId = createUlid();
    const { ledgerId } = await stockedSale(world, orderId);
    await closePeriods(world, ["2026-10"]);

    const result = await deliverRow(ledgerId);

    // Parked for the real reason (mapping), never posted on the closed day or
    // anywhere else, and not reported as a closed-period block.
    expect(result).toEqual({
      status: "blocked",
      code: "ACCOUNT_MAPPING_MISSING",
    });
    expect(await journalCount(world)).toBe(0);
    expect(await blockedCount(orderId)).toBe(1);

    await mapRole(world.entity, "cogs", world.accounts.cogs);
    await sweep(1);
    await sweep(2);

    const entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_date).toBe("2026-11-01");
    expect(entries[0]!.late_adjustment_from).toBe("2026-10-15");
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "cogs", debit: 4500, credit: 0 },
      { role: "inventory", debit: 0, credit: 4500 },
    ]);
    expect(await lateAuditCount(entries[0]!.id)).toBe(1);
    expect(await blockedCount(orderId)).toBe(0);
    await expectNoJournalInClosedPeriod(world);
  });
});
