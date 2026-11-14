// Inventory -> GL bridge (bead legend-w1vo; PRD v1.7 §3.19 "Jurnal Otomatis",
// Alur J.4; INV-01, INV-03, ACC-01, ACC-02). `stock.moved` events of the
// stock ledger become GL journals for stock-count differences, waste and the
// COGS (HPP) of sales, through `deliverInventoryGlEvent`.
//
// Runs the real services against the disposable PostgreSQL test database in
// a fresh isolated tenant. Every test owns a fresh legal entity + outlet
// (journals and ledger rows are append-only), so nothing leaks between tests.
// Events are the real `stock.moved` envelopes read back from
// `domain_event_outbox`, delivered inside `withTenant` like the worker does.
//
// Assumptions (the brief fixes the contract, the PRD is loose on details):
// - The ledger rows of one source document (count, waste log, order) post as
//   ONE journal; later rows of the same source (a return after a sale) form a
//   second journal.
// - Opname rows are written straight to the ledger (`adjustment` /
//   `stock_count`), not through the count approval flow; the expected value is
//   the sum of the per-row `qty x unit cost`, each rounded half up.
// - Waste is valued rounded once over the whole log (= `wasteLogs.valueIdr`).
// - A sale `unitCostIdr` left out is valued by the ledger at the moving
//   average of that moment; the journal must keep that value afterwards.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  businessDateSchema,
  createUlid,
  decimal4,
  isoDateTimeSchema,
  tenantIdSchema,
  ulidSchema,
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
import {
  createStockCountInputSchema,
  createWasteLogInputSchema,
  transitionStockCountInputSchema,
  updateStockCountLineInputSchema,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createStockBatch,
  recordStockMovement,
} from "../services/inventory.service.ts";
import {
  createStockCount,
  transitionStockCount,
  updateStockCountLine,
} from "../services/inventory-count.service.ts";
import { createWasteLog } from "../services/inventory-waste.service.ts";
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
const key = (prefix: string) => `${prefix}-${randomUUID()}`;
const at = (iso: string) => isoDateTimeSchema.parse(iso);
/** Fixed "now" for the consumer; every ledger instant below is in the past. */
const NOW = new Date("2026-11-08T03:00:00Z");
/** 2026-10-15 12:00 in Jakarta: a plain mid-day instant, business date 10-15. */
const DAY = "2026-10-15T05:00:00.000Z";
const BEFORE = "2026-10-01T05:00:00.000Z";
const AFTER = "2026-10-16T05:00:00.000Z";

/** TEN-05: the bridge only runs for tenants with the accounting module on. */
const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});
const FLAGS_OFF = JSON.stringify({ modules: [], integrationProviders: [] });

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

async function openPeriod(entity: string, period: string): Promise<void> {
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
    [tenantId, entity, period],
  );
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

async function setModules(flags: string): Promise<void> {
  await owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [tenantId, flags],
  );
}

/** A legal entity + outlet + CoA with the four posting roles + open periods. */
async function makeWorld(
  outlet: { timezone?: string; cutoff?: string; unmapped?: Role[] } = {},
): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Entity GL ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet GL', 'Jl. GL', $6, $7, '{}', 'active')`,
    [
      outletId,
      tenantId,
      brandId,
      entity,
      `GL-${short()}`.toUpperCase(),
      outlet.timezone ?? "Asia/Jakarta",
      outlet.cutoff ?? "04:00",
    ],
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
    if (outlet.unmapped?.includes(role)) continue;
    await mapRole(entity, role, accounts[role]);
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await openPeriod(entity, period);
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantId, outletId, `Gudang GL ${short()}`],
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

async function receive(
  world: World,
  itemId: string,
  quantity: string,
  unitCost: string,
  options: { occurredAt?: string; expiresOn?: string } = {},
): Promise<void> {
  const batchId =
    options.expiresOn === undefined
      ? null
      : (
          await createStockBatch(context(), {
            outletId: world.outletId,
            locationId: world.locationId,
            inventoryItemId: itemId,
            batchCode: `B-${short()}`,
            expiresOn: businessDateSchema.parse(options.expiresOn),
          })
        ).id;
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
    occurredAt: at(options.occurredAt ?? BEFORE),
    actor: { type: "system" },
  });
}

type Move = {
  movementType: "sale" | "return" | "adjustment";
  sourceType: "order" | "stock_count";
  sourceId: string;
  itemId: string;
  quantity: string;
  /** Omitted: the ledger values an outflow at the moving average. */
  unitCost?: string;
  occurredAt?: string;
};

/** Writes one ledger row; returns the ledger entry id (ULID). */
async function move(world: World, input: Move): Promise<string> {
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: input.itemId,
    movementType: input.movementType,
    quantity: decimal4(input.quantity),
    ...(input.unitCost === undefined
      ? {}
      : { unitCostIdr: decimal4(input.unitCost) }),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
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

type Entry = {
  id: string;
  entry_date: string;
  outlet_id: string | null;
  source_id: string | null;
};

/** Journals of one source document in posting order. */
async function journalsOf(world: World, sourceId: string): Promise<Entry[]> {
  const { rows } = await owner.query<Entry>(
    `SELECT id, entry_date::text AS entry_date, outlet_id, source_id
       FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_id = $3
      ORDER BY created_at, id`,
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

/** The journal's lines by posting role, sorted by role for stable asserts. */
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

/** Tracking rows of the ledger rows of one source (joined by ledger id). */
async function trackingOf(sourceId: string) {
  // The ledger keeps an order's ULID as uuid text (D-CORE-1).
  const ledgerSourceId = ulidSchema.safeParse(sourceId).success
    ? ulidToUuid(sourceId)
    : sourceId;
  const { rows } = await owner.query<{
    journal_entry_id: string | null;
    value_idr: string;
  }>(
    `SELECT p.journal_entry_id, p.value_idr::text AS value_idr
       FROM inventory_gl_postings p
       JOIN stock_ledger l ON l.tenant_id = p.tenant_id AND l.id = p.ledger_entry_id
      WHERE p.tenant_id = $1 AND l.source_id = $2`,
    [tenantId, ledgerSourceId],
  );
  return rows;
}

function expectNoNegativeAmounts(lines: Line[]) {
  for (const line of lines) {
    expect(line.debit).toBeGreaterThanOrEqual(0);
    expect(line.credit).toBeGreaterThanOrEqual(0);
    // Each line carries exactly one positive side (ACC-01).
    expect(line.debit > 0 !== line.credit > 0).toBe(true);
  }
}

/**
 * Runs the retry sweep `n` retry windows from now: a block is only retried
 * once it is RETRY_AFTER_MS old, so each call uses a later clock.
 */
function sweep(n: number) {
  return retryBlockedInventoryGl(
    context(),
    new Date(NOW.getTime() + n * (RETRY_AFTER_MS + 1000)),
  );
}

/** The blocked-posting row of a source (domain source id form). */
async function blockedOf(sourceType: string, sourceId: string) {
  const { rows } = await owner.query<{ error_code: string; attempts: number }>(
    `SELECT error_code, attempts FROM inventory_gl_blocked
      WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
    [tenantId, sourceType, sourceId],
  );
  return rows;
}

async function markerExists(code: string): Promise<boolean> {
  const { rowCount } = await owner.query(
    "SELECT 1 FROM uoms WHERE tenant_id = $1 AND code = $2",
    [tenantId, code],
  );
  return (rowCount ?? 0) === 1;
}

/** One sale row of `itemId`, valued at the average; returns row + event. */
async function sellOrder(
  world: World,
  orderId: string,
  itemId: string,
  quantity: string,
  occurredAt: string = DAY,
) {
  const ledgerId = await move(world, {
    movementType: "sale",
    sourceType: "order",
    sourceId: orderId,
    itemId,
    quantity,
    occurredAt,
  });
  return { ledgerId, event: await eventOf(ledgerId) };
}

async function insertUser(name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, name, `${id}@example.com`],
  );
  return id;
}

/** Copies a shared role template into the isolated tenant and assigns it. */
async function grantRole(
  userId: string,
  templateKey: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<string> {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $2 AND template_key = $3
     ON CONFLICT DO NOTHING`,
    [tenantId, cafeLegendPlatformFixtures.tenant.id, templateKey],
  );
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  expect(rows, `${templateKey} role template`).toHaveLength(1);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      rows[0]!.id,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantId = randomUUID();
  brandId = randomUUID();
  const tag = tenantId.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Inventory GL', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantId,
      `uji-inv-gl-${tag}`,
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
  // The waste service needs the stock permissions; the owner template holds
  // them tenant-wide (same as inventory-ops.test.ts).
  wasteUserId = await insertUser("Inventory GL Waste User");
  await grantRole(wasteUserId, "owner", { type: "tenant" });
});

afterAll(async () => {
  setAuditWriter(null);
  // Ledger, journals, users and the tenant stay (append-only, random names,
  // foreign keys from waste logs and approvals).
  await owner.end();
});

// ============================================================================

describe("§3.19 stock count differences post to the GL (opname)", () => {
  it("INV-GL-COUNT-01 an opname gain posts Dr inventory / Cr inventory_adjustment", async () => {
    const world = await makeWorld();
    const sourceId = randomUUID();
    const itemA = await insertItem("Kopi");
    const itemB = await insertItem("Susu");
    // 1 x 1000.5 per row: each row rounds half up to 1001, so the document is
    // 2002 (per-row rounding), not 2001.
    const rowA = await move(world, {
      movementType: "adjustment",
      sourceType: "stock_count",
      sourceId,
      itemId: itemA,
      quantity: "1.0000",
      unitCost: "1000.5000",
    });
    const rowB = await move(world, {
      movementType: "adjustment",
      sourceType: "stock_count",
      sourceId,
      itemId: itemB,
      quantity: "1.0000",
      unitCost: "1000.5000",
    });

    const result = await deliverRow(rowA);
    expect(result.status).toBe("posted");

    const [entry, ...others] = await journalsOf(world, sourceId);
    expect(others).toHaveLength(0);
    expect(entry!.outlet_id).toBe(world.outletId);
    const lines = await linesOf(world, entry!.id);
    expect(lines).toEqual([
      { role: "inventory", debit: 2002, credit: 0 },
      { role: "inventory_adjustment", debit: 0, credit: 2002 },
    ]);
    expectNoNegativeAmounts(lines);
    // Both rows of the document are tracked against the one journal.
    const tracking = await trackingOf(sourceId);
    expect(tracking).toHaveLength(2);
    expect(tracking.every((row) => row.journal_entry_id === entry!.id)).toBe(
      true,
    );
    expect(tracking.reduce((sum, row) => sum + Number(row.value_idr), 0)).toBe(
      2002,
    );
    // The second row's own event finds nothing left to post.
    expect(await deliverRow(rowB)).toEqual({ status: "already_posted" });
  });

  it("INV-GL-COUNT-02 an opname loss posts Dr inventory_adjustment / Cr inventory with positive amounts", async () => {
    const world = await makeWorld();
    const sourceId = randomUUID();
    const itemA = await insertItem("Gula");
    const itemB = await insertItem("Teh");
    await receive(world, itemA, "10.0000", "1500.0000");
    await receive(world, itemB, "4.0000", "2500.0000");
    const rowA = await move(world, {
      movementType: "adjustment",
      sourceType: "stock_count",
      sourceId,
      itemId: itemA,
      quantity: "-2.0000",
    });
    await move(world, {
      movementType: "adjustment",
      sourceType: "stock_count",
      sourceId,
      itemId: itemB,
      quantity: "-1.0000",
    });

    expect((await deliverRow(rowA)).status).toBe("posted");

    const entries = await journalsOf(world, sourceId);
    expect(entries).toHaveLength(1);
    // 2 x 1500 + 1 x 2500 = 5500 lost.
    const lines = await linesOf(world, entries[0]!.id);
    expect(lines).toEqual([
      { role: "inventory", debit: 0, credit: 5500 },
      { role: "inventory_adjustment", debit: 5500, credit: 0 },
    ]);
    expectNoNegativeAmounts(lines);
  });

  it("INV-GL-COUNT-03 gains and losses of one count net into one journal", async () => {
    const world = await makeWorld();
    const sourceId = randomUUID();
    const gain = await insertItem("Lebih");
    const loss = await insertItem("Kurang");
    await receive(world, loss, "5.0000", "1500.0000");
    const gainRow = await move(world, {
      movementType: "adjustment",
      sourceType: "stock_count",
      sourceId,
      itemId: gain,
      quantity: "3.0000",
      unitCost: "1500.0000",
    });
    await move(world, {
      movementType: "adjustment",
      sourceType: "stock_count",
      sourceId,
      itemId: loss,
      quantity: "-1.0000",
    });

    expect((await deliverRow(gainRow)).status).toBe("posted");

    const entries = await journalsOf(world, sourceId);
    expect(entries).toHaveLength(1);
    // +4500 - 1500 = net gain of 3000.
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "inventory", debit: 3000, credit: 0 },
      { role: "inventory_adjustment", debit: 0, credit: 3000 },
    ]);
  });
});

describe("§3.19 waste posts to the GL", () => {
  it("INV-GL-WASTE-01 a multi-batch waste posts Dr waste_expense / Cr inventory = the waste log value", async () => {
    const world = await makeWorld();
    const item = await insertItem("Susu UHT");
    // Two batches at 1000.5: 5 x 1000.5 + 1 x 1000.5 = 6003.0. Rounded per
    // ledger row it would be 6004; the log value is rounded once.
    await receive(world, item, "5.0000", "1000.5000", {
      expiresOn: "2099-01-05",
    });
    await receive(world, item, "5.0000", "1000.5000", {
      expiresOn: "2099-01-10",
    });
    const log = await createWasteLog(
      context(),
      wasteUserId,
      createWasteLogInputSchema.parse({
        outletId: world.outletId,
        locationId: world.locationId,
        targetType: "inventory_item",
        targetId: item,
        quantity: "6.0000",
        reason: "spoiled",
        occurredAt: DAY,
        idempotencyKey: key("waste"),
      }),
    );

    const { rows: ledger } = await owner.query<{ id: string }>(
      `SELECT id::text AS id FROM stock_ledger
        WHERE tenant_id = $1 AND source_id = $2 ORDER BY id`,
      [tenantId, log.id],
    );
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    const events = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'
          AND event->'payload'->>'sourceId' = $2`,
      [tenantId, log.id],
    );
    expect(events.rows).toHaveLength(ledger.length);

    // Deliver every row's event: one journal for the whole log.
    const results = [];
    for (const row of events.rows)
      results.push(await deliver(eventEnvelopeSchema.parse(row.event)));
    expect(results.filter((r) => r.status === "posted")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_posted")).toHaveLength(
      ledger.length - 1,
    );

    const entries = await journalsOf(world, log.id);
    expect(entries).toHaveLength(1);
    expect(log.valueIdr).toBeGreaterThan(0);
    const lines = await linesOf(world, entries[0]!.id);
    expect(lines).toEqual([
      { role: "inventory", debit: 0, credit: log.valueIdr },
      { role: "waste_expense", debit: log.valueIdr, credit: 0 },
    ]);
    expectNoNegativeAmounts(lines);
    expect(await trackingOf(log.id)).toHaveLength(ledger.length);
  });
});

/**
 * A waste log whose two FEFO batch rows straddle the 04:00 business-day
 * cutoff, on the month border: 2026-10-01 03:59 Jakarta is business date
 * 2026-09-30 (period 2026-09), 04:00 is 2026-10-01 (period 2026-10).
 * Two rows of 1 x Rp0,4: each date alone rounds to 0, the log value is 1.
 * `createWasteLog` stamps every row with one instant, so the straddle is
 * written the way a replayed/synced log would be: ledger rows + waste_logs row.
 */
const LATE_DAY1 = "2026-09-30T20:59:00.000Z";
const EARLY_DAY2 = "2026-09-30T21:00:00.000Z";

async function straddlingWasteLog(world: World) {
  const item = await insertItem("Garam");
  const batchIds: string[] = [];
  for (const expiresOn of ["2099-01-05", "2099-01-10"]) {
    const batch = await createStockBatch(context(), {
      outletId: world.outletId,
      locationId: world.locationId,
      inventoryItemId: item,
      batchCode: `B-${short()}`,
      expiresOn: businessDateSchema.parse(expiresOn),
    });
    batchIds.push(batch.id);
    await recordStockMovement(context(), {
      outletId: world.outletId,
      locationId: world.locationId,
      inventoryItemId: item,
      movementType: "receipt",
      quantity: decimal4("1.0000"),
      unitCostIdr: decimal4("0.4000"),
      batchId: batch.id,
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      occurredAt: at("2026-09-01T05:00:00.000Z"),
      actor: { type: "system" },
    });
  }
  const logId = randomUUID();
  const rowIds: string[] = [];
  for (const [index, occurredAt] of [LATE_DAY1, EARLY_DAY2].entries()) {
    const entry = await recordStockMovement(context(), {
      outletId: world.outletId,
      locationId: world.locationId,
      inventoryItemId: item,
      movementType: "waste",
      quantity: decimal4("-1.0000"),
      batchId: batchIds[index]!,
      sourceType: "waste_log",
      sourceId: logId,
      occurredAt: at(occurredAt),
      actor: { type: "user", id: wasteUserId },
    });
    rowIds.push(entry.id);
  }
  // The log value is rounded once over the whole log: 0,4 + 0,4 = 0,8 -> 1.
  await owner.query(
    `INSERT INTO waste_logs
       (id, tenant_id, outlet_id, location_id, target_type, target_id, quantity,
        reason, value_idr, logged_by, occurred_at)
     VALUES ($1, $2, $3, $4, 'inventory_item', $5, 2, 'spoiled', 1, $6, $7)`,
    [
      logId,
      tenantId,
      world.outletId,
      world.locationId,
      item,
      wasteUserId,
      LATE_DAY1,
    ],
  );
  return { logId, rowIds, valueIdr: 1 };
}

/** Σ waste_expense debit over every journal of the source, by entry date. */
async function wasteByDate(world: World, sourceId: string) {
  const byDate = new Map<string, number>();
  for (const entry of await journalsOf(world, sourceId)) {
    const lines = await linesOf(world, entry.id);
    const expense = lines.find((line) => line.role === "waste_expense")!;
    byDate.set(
      entry.entry_date,
      (byDate.get(entry.entry_date) ?? 0) + expense.debit,
    );
  }
  return byDate;
}

/** The late-adjustment marker of each journal of a source, by entry date. */
async function lateFromByDate(world: World, sourceId: string) {
  const { rows } = await owner.query<{
    entry_date: string;
    late_adjustment_from: string | null;
  }>(
    `SELECT entry_date::text AS entry_date, late_adjustment_from::text AS late_adjustment_from
       FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_id = $3`,
    [tenantId, world.entity, sourceId],
  );
  return new Map(rows.map((row) => [row.entry_date, row.late_adjustment_from]));
}

describe("§3.19 a waste log across two business dates keeps its rupiah (IT-68)", () => {
  it("INV-GL-WASTE-02 rows of Rp0,4 + Rp0,4 on two business dates journal exactly the log value of Rp1, once, on one date", async () => {
    const world = await makeWorld();
    const log = await straddlingWasteLog(world);
    const { rows: valueRow } = await owner.query<{ value_idr: string }>(
      "SELECT value_idr::text AS value_idr FROM waste_logs WHERE tenant_id = $1 AND id = $2",
      [tenantId, log.logId],
    );
    expect(Number(valueRow[0]!.value_idr)).toBe(log.valueIdr);

    expect((await deliverRow(log.rowIds[0]!)).status).toBe("posted");

    const byDate = await wasteByDate(world, log.logId);
    const posted = [...byDate.values()].reduce((sum, v) => sum + v, 0);
    expect(posted).toBe(log.valueIdr);
    // Exactly one date carries the rupiah; the tie goes to the oldest date.
    expect([...byDate.entries()]).toEqual([["2026-09-30", 1]]);
    const entries = await journalsOf(world, log.logId);
    expect(entries).toHaveLength(1);
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "inventory", debit: 0, credit: 1 },
      { role: "waste_expense", debit: 1, credit: 0 },
    ]);
    // Both rows are marked done, including the date that got Rp0.
    expect(await trackingOf(log.logId)).toHaveLength(2);

    // A replay of either row's event posts nothing more.
    expect(await deliverRow(log.rowIds[1]!)).toEqual({
      status: "already_posted",
    });
    expect(await deliverRow(log.rowIds[0]!)).toEqual({
      status: "already_posted",
    });
    expect(await journalsOf(world, log.logId)).toHaveLength(1);
  });

  it("INV-GL-WASTE-03 a closed period posts the waste on the first open day as a late adjustment; the journals still add up to the log value", async () => {
    const world = await makeWorld();
    const log = await straddlingWasteLog(world);
    // 2026-09 holds the date that is allocated the rupiah: close it.
    await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-09'`,
      [tenantId, world.entity, randomUUID()],
    );

    const result = await deliverRow(log.rowIds[0]!);
    expect(result.status).toBe("posted");
    expect(await blockedOf("waste_log", log.logId)).toHaveLength(0);

    // Nothing lands in the closed period; the rupiah sits on the first open
    // day, flagged with its natural date, and adds up to the log value.
    const byDate = await wasteByDate(world, log.logId);
    expect([...byDate.entries()]).toEqual([["2026-10-01", 1]]);
    expect([...byDate.values()].reduce((sum, v) => sum + v, 0)).toBe(
      log.valueIdr,
    );
    expect([...(await lateFromByDate(world, log.logId)).entries()]).toEqual([
      ["2026-10-01", "2026-09-30"],
    ]);
    const entries = await journalsOf(world, log.logId);
    expect(entries).toHaveLength(1);
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "inventory", debit: 0, credit: 1 },
      { role: "waste_expense", debit: 1, credit: 0 },
    ]);
    expect(await trackingOf(log.logId)).toHaveLength(2);

    // A replay of either row's event and a sweep post nothing more.
    await sweep(1);
    expect(await deliverRow(log.rowIds[1]!)).toEqual({
      status: "already_posted",
    });
    expect(await deliverRow(log.rowIds[0]!)).toEqual({
      status: "already_posted",
    });
    expect(await journalsOf(world, log.logId)).toHaveLength(1);
  });
});

describe("§3.19 HPP (COGS) of sales posts to the GL", () => {
  it("INV-GL-COGS-01 a sale posts Dr cogs / Cr inventory; a restocked return reverses the sides", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const coffee = await insertItem("Biji kopi");
    const milk = await insertItem("Susu");
    await receive(world, coffee, "10.0000", "1500.0000");
    await receive(world, milk, "10.0000", "2000.0000");
    const coffeeRow = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: coffee,
      quantity: "-3.0000",
    });
    await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: milk,
      quantity: "-2.0000",
    });

    expect((await deliverRow(coffeeRow)).status).toBe("posted");
    let entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    const saleEntryId = entries[0]!.id;
    // 3 x 1500 + 2 x 2000 = 8500 cost of goods sold.
    const saleLines = await linesOf(world, entries[0]!.id);
    expect(saleLines).toEqual([
      { role: "cogs", debit: 8500, credit: 0 },
      { role: "inventory", debit: 0, credit: 8500 },
    ]);
    expectNoNegativeAmounts(saleLines);
    expect(entries[0]!.outlet_id).toBe(world.outletId);

    // One coffee portion comes back to stock at its cost.
    const returnRow = await move(world, {
      movementType: "return",
      sourceType: "order",
      sourceId: orderId,
      itemId: coffee,
      quantity: "1.0000",
      unitCost: "1500.0000",
      occurredAt: AFTER,
    });
    const returned = await deliverRow(returnRow);
    expect(returned.status).toBe("posted");

    entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(2);
    // By id, not created_at order: that default follows the DB clock.
    const returnEntry = entries.find((entry) => entry.id !== saleEntryId)!;
    const returnLines = await linesOf(world, returnEntry.id);
    expect(returnLines).toEqual([
      { role: "cogs", debit: 0, credit: 1500 },
      { role: "inventory", debit: 1500, credit: 0 },
    ]);
    expectNoNegativeAmounts(returnLines);
    // The first journal is untouched (append-only).
    expect(await linesOf(world, saleEntryId)).toEqual(saleLines);
  });
});

describe("§3.19 the journal keeps the value the ledger row posted", () => {
  it("INV-GL-VALUE-01 a later change of the average cost does not change the journal", async () => {
    const world = await makeWorld();
    const saleOrder = createUlid();
    const countId = randomUUID();
    const item = await insertItem("Kopi");
    await receive(world, item, "10.0000", "1000.0000");
    const saleRow = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: saleOrder,
      itemId: item,
      quantity: "-2.0000",
    });
    const countRow = await move(world, {
      movementType: "adjustment",
      sourceType: "stock_count",
      sourceId: countId,
      itemId: item,
      quantity: "-1.0000",
    });
    // A new, dearer receipt moves the average from 1000 to 2000 before the
    // bridge consumes the events.
    await receive(world, item, "7.0000", "3000.0000", { occurredAt: AFTER });
    const { rows } = await owner.query<{ avg: string }>(
      `SELECT avg_cost_idr::text AS avg FROM stock_balances
        WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
      [tenantId, world.locationId, item],
    );
    expect(Number(rows[0]!.avg)).toBeGreaterThan(1000);

    await deliverRow(saleRow);
    await deliverRow(countRow);

    const sale = await journalsOf(world, saleOrder);
    expect(await linesOf(world, sale[0]!.id)).toEqual([
      { role: "cogs", debit: 2000, credit: 0 },
      { role: "inventory", debit: 0, credit: 2000 },
    ]);
    const count = await journalsOf(world, countId);
    expect(await linesOf(world, count[0]!.id)).toEqual([
      { role: "inventory", debit: 0, credit: 1000 },
      { role: "inventory_adjustment", debit: 1000, credit: 0 },
    ]);
  });

  it("INV-GL-VALUE-02 the entry date is the outlet business date of the movement", async () => {
    // 2026-10-31 20:30 UTC = 2026-11-01 03:30 in Jakarta: before the 04:00
    // cutoff, so the business day is still 2026-10-31 (owner Q39).
    const world = await makeWorld({
      timezone: "Asia/Jakarta",
      cutoff: "04:00",
    });
    const instant = "2026-10-31T20:30:00.000Z";
    const expected = businessDateOf(instant, {
      timeZone: "Asia/Jakarta",
      cutoff: "04:00",
    });
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    await receive(world, item, "5.0000", "1000.0000");
    const row = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: item,
      quantity: "-1.0000",
      occurredAt: instant,
    });

    expect((await deliverRow(row)).status).toBe("posted");

    const entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_date).toBe(expected);
  });
});

describe("§3.19 delivery is idempotent", () => {
  it("INV-GL-REPLAY-01 the same event twice, and every row's event of one source, post exactly once", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const coffee = await insertItem("Kopi");
    const milk = await insertItem("Susu");
    await receive(world, coffee, "10.0000", "1500.0000");
    await receive(world, milk, "10.0000", "2000.0000");
    const rowA = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: coffee,
      quantity: "-1.0000",
    });
    const rowB = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: milk,
      quantity: "-1.0000",
    });
    const eventA = await eventOf(rowA);
    const eventB = await eventOf(rowB);

    const first = await deliver(eventA);
    expect(first.status).toBe("posted");
    expect(await deliver(eventA)).toEqual({ status: "already_posted" });
    expect(await deliver(eventB)).toEqual({ status: "already_posted" });

    const entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "cogs", debit: 3500, credit: 0 },
      { role: "inventory", debit: 0, credit: 3500 },
    ]);
    const tracking = await trackingOf(orderId);
    expect(tracking).toHaveLength(2);
    expect(
      tracking.every((row) => row.journal_entry_id === entries[0]!.id),
    ).toBe(true);
  });

  it("INV-GL-REPLAY-02 two consumers delivering the rows of one source at the same time post one journal", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const coffee = await insertItem("Kopi");
    const milk = await insertItem("Susu");
    await receive(world, coffee, "10.0000", "1500.0000");
    await receive(world, milk, "10.0000", "2000.0000");
    const rowA = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: coffee,
      quantity: "-1.0000",
    });
    const rowB = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: milk,
      quantity: "-1.0000",
    });
    const [eventA, eventB] = [await eventOf(rowA), await eventOf(rowB)];

    const results = await Promise.all([deliver(eventA), deliver(eventB)]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "already_posted",
      "posted",
    ]);
    expect(await journalsOf(world, orderId)).toHaveLength(1);
    expect(await trackingOf(orderId)).toHaveLength(2);
  });
});

describe("§3.19 a posting that cannot happen is blocked, not lost (ACC-02)", () => {
  it("INV-GL-PERIOD-01 a closed period no longer parks; a blocked delivery (missing mapping) does not throw, the outer transaction commits, and after mapping the sweep posts once on the first open day", async () => {
    const world = await makeWorld({ unmapped: ["inventory"] });
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    await receive(world, item, "5.0000", "1000.0000");
    const { event } = await sellOrder(world, orderId, item, "-2.0000");
    const closer = randomUUID();
    await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId, world.entity, closer],
    );

    // The consumer must not poison the surrounding transaction (it shares it
    // with the cloud-sync consumption): work before and after still commits.
    const [before, after] = [`m${short()}`, `m${short()}`];
    const result = await withTenant(db, context(), async (tx) => {
      await tx.execute(
        sql`INSERT INTO uoms (tenant_id, code, name) VALUES (${tenantId}, ${before}, ${before})`,
      );
      const outcome = await deliverInventoryGlEvent(context(), event, tx, NOW);
      await tx.execute(
        sql`INSERT INTO uoms (tenant_id, code, name) VALUES (${tenantId}, ${after}, ${after})`,
      );
      return outcome;
    });
    expect(result).toEqual({
      status: "blocked",
      code: "ACCOUNT_MAPPING_MISSING",
    });
    expect(await markerExists(before)).toBe(true);
    expect(await markerExists(after)).toBe(true);
    expect(await journalCount(world)).toBe(0);
    expect(await trackingOf(orderId)).toHaveLength(0);
    const blocked = await blockedOf("order", orderId);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.error_code).toBe("ACCOUNT_MAPPING_MISSING");
    const attempts = blocked[0]!.attempts;

    // A sweep right now skips the fresh block: nothing is counted.
    await retryBlockedInventoryGl(context(), NOW);
    expect((await blockedOf("order", orderId))[0]!.attempts).toBe(attempts);

    // Still unmapped after the retry window: the sweep keeps it blocked and
    // counts the attempt.
    await sweep(1);
    const stillBlocked = await blockedOf("order", orderId);
    expect(stillBlocked).toHaveLength(1);
    expect(stillBlocked[0]!.attempts).toBeGreaterThan(attempts);
    expect(await journalCount(world)).toBe(0);

    await mapRole(world.entity, "inventory", world.accounts.inventory);
    await sweep(2);
    await sweep(3);

    // Posted once, on the first open day, flagged with the sale date; nothing
    // in the closed period.
    const entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_date).toBe("2026-11-01");
    expect([...(await lateFromByDate(world, orderId)).entries()]).toEqual([
      ["2026-11-01", "2026-10-15"],
    ]);
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "cogs", debit: 2000, credit: 0 },
      { role: "inventory", debit: 0, credit: 2000 },
    ]);
    expect(await trackingOf(orderId)).toHaveLength(1);
    expect(await blockedOf("order", orderId)).toHaveLength(0);
    // The event delivered again finds nothing left to post.
    expect(await deliver(event)).toEqual({ status: "already_posted" });
    expect(await journalsOf(world, orderId)).toHaveLength(1);
  });

  it("INV-GL-BLOCKED-01 a missing account mapping blocks the delivery; once the mapping exists the sweep posts", async () => {
    const world = await makeWorld({ unmapped: ["inventory"] });
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    await receive(world, item, "5.0000", "1000.0000");
    const { event } = await sellOrder(world, orderId, item, "-3.0000");

    expect(await deliver(event)).toEqual({
      status: "blocked",
      code: "ACCOUNT_MAPPING_MISSING",
    });
    expect(await journalCount(world)).toBe(0);
    expect(await trackingOf(orderId)).toHaveLength(0);
    const blocked = await blockedOf("order", orderId);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.error_code).toBe("ACCOUNT_MAPPING_MISSING");

    await mapRole(world.entity, "inventory", world.accounts.inventory);
    // Too early: the fresh block is not retried yet, even with the cause gone.
    await retryBlockedInventoryGl(context(), NOW);
    expect(await journalCount(world)).toBe(0);
    expect(await blockedOf("order", orderId)).toHaveLength(1);
    await sweep(1);

    const entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "cogs", debit: 3000, credit: 0 },
      { role: "inventory", debit: 0, credit: 3000 },
    ]);
    expect(await blockedOf("order", orderId)).toHaveLength(0);
    expect(await trackingOf(orderId)).toHaveLength(1);
  });

  it("INV-GL-BLOCKED-02 a blocked posting is posted by the delivery itself once the cause is gone, and its blocked row is cleared", async () => {
    const world = await makeWorld({ unmapped: ["cogs"] });
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    await receive(world, item, "5.0000", "1000.0000");
    const { event } = await sellOrder(world, orderId, item, "-1.0000");

    expect((await deliver(event)).status).toBe("blocked");
    expect(await blockedOf("order", orderId)).toHaveLength(1);

    await mapRole(world.entity, "cogs", world.accounts.cogs);
    expect((await deliver(event)).status).toBe("posted");
    expect(await journalsOf(world, orderId)).toHaveLength(1);
    expect(await blockedOf("order", orderId)).toHaveLength(0);
  });
});

describe("§3.19 the accounting module gate (TEN-05)", () => {
  it("INV-GL-MODULE-01 with accounting off the delivery and the sweep ignore the tenant and write nothing; switched on again they post", async () => {
    const world = await makeWorld({ unmapped: ["inventory"] });
    const item = await insertItem("Kopi");
    await receive(world, item, "9.0000", "1000.0000");
    const blockedOrder = createUlid();
    const freshOrder = createUlid();
    const first = await sellOrder(world, blockedOrder, item, "-1.0000");
    expect((await deliver(first.event)).status).toBe("blocked");
    await mapRole(world.entity, "inventory", world.accounts.inventory);
    const second = await sellOrder(world, freshOrder, item, "-2.0000");
    const attempts = (await blockedOf("order", blockedOrder))[0]!.attempts;

    await setModules(FLAGS_OFF);
    try {
      expect(await deliver(second.event)).toEqual({ status: "ignored" });
      await sweep(1);
      expect(await journalCount(world)).toBe(0);
      expect(await trackingOf(freshOrder)).toHaveLength(0);
      expect(await blockedOf("order", freshOrder)).toHaveLength(0);
      // The sweep skipped the tenant: the blocked row is untouched.
      const untouched = await blockedOf("order", blockedOrder);
      expect(untouched).toHaveLength(1);
      expect(untouched[0]!.attempts).toBe(attempts);
    } finally {
      await setModules(FLAGS_ON);
    }

    expect((await deliver(second.event)).status).toBe("posted");
    await sweep(2);
    expect(await journalsOf(world, freshOrder)).toHaveLength(1);
    expect(await journalsOf(world, blockedOrder)).toHaveLength(1);
    expect(await blockedOf("order", blockedOrder)).toHaveLength(0);
  });
});

describe("§3.19 one journal per business date, ULID order ids", () => {
  it("INV-GL-DATE-01 rows of one order on two business dates post two journals, each on its own entry date", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    await receive(world, item, "10.0000", "1000.0000");
    const day1 = await sellOrder(world, orderId, item, "-1.0000", DAY);
    const day2 = await sellOrder(world, orderId, item, "-2.0000", AFTER);

    // Neither row is tracked yet (a backlog): one delivery handles both days.
    const posted = await deliver(day2.event);
    expect(posted.status).toBe("posted");

    const entries = (await journalsOf(world, orderId)).sort((a, b) =>
      a.entry_date.localeCompare(b.entry_date),
    );
    expect(entries.map((entry) => entry.entry_date)).toEqual([
      "2026-10-15",
      "2026-10-16",
    ]);
    expect(await linesOf(world, entries[0]!.id)).toEqual([
      { role: "cogs", debit: 1000, credit: 0 },
      { role: "inventory", debit: 0, credit: 1000 },
    ]);
    expect(await linesOf(world, entries[1]!.id)).toEqual([
      { role: "cogs", debit: 2000, credit: 0 },
      { role: "inventory", debit: 0, credit: 2000 },
    ]);
    const tracking = await trackingOf(orderId);
    expect(tracking).toHaveLength(2);
    expect(new Set(tracking.map((row) => row.journal_entry_id))).toEqual(
      new Set(entries.map((entry) => entry.id)),
    );
    // The result names one journal per business date.
    const { journalEntryIds } = posted as { journalEntryIds: string[] };
    expect(new Set(journalEntryIds)).toEqual(
      new Set(entries.map((entry) => entry.id)),
    );
    // Replays post nothing more.
    expect(await deliver(day1.event)).toEqual({ status: "already_posted" });
    expect(await deliver(day2.event)).toEqual({ status: "already_posted" });
    expect(await journalsOf(world, orderId)).toHaveLength(2);
  });

  it("INV-GL-SOURCE-01 an order journal and its tracking rows carry the order id as ULID text", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    await receive(world, item, "5.0000", "1000.0000");
    const { event } = await sellOrder(world, orderId, item, "-1.0000");

    expect((await deliver(event)).status).toBe("posted");

    const entries = await journalsOf(world, orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source_id).toBe(orderId);
    expect(entries[0]!.source_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const { rows } = await owner.query<{ source_id: string }>(
      `SELECT p.source_id FROM inventory_gl_postings p
         JOIN stock_ledger l ON l.tenant_id = p.tenant_id AND l.id = p.ledger_entry_id
        WHERE p.tenant_id = $1 AND l.source_id = $2`,
      [tenantId, ulidToUuid(orderId)],
    );
    expect(rows.map((row) => row.source_id)).toEqual([orderId]);
  });
});

describe("§3.19 events the bridge does not handle", () => {
  it("INV-GL-IGNORE-01 other event names, other tenants and unmapped movements post nothing", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const item = await insertItem("Kopi");
    await receive(world, item, "5.0000", "1000.0000");
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id::text AS id FROM stock_ledger
        WHERE tenant_id = $1 AND location_id = $2`,
      [tenantId, world.locationId],
    );
    expect(rows).toHaveLength(1);
    const saleRow = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: item,
      quantity: "-1.0000",
    });
    const sale = await eventOf(saleRow);

    // A goods receipt moves stock but is outside this bridge.
    const receiptEvents = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'
          AND event->'payload'->>'movementType' = 'receipt'
          AND event->'payload'->>'inventoryItemId' = $2`,
      [tenantId, item],
    );
    expect(receiptEvents.rows).toHaveLength(1);
    expect(
      await deliver(eventEnvelopeSchema.parse(receiptEvents.rows[0]!.event)),
    ).toEqual({ status: "ignored" });

    // Another event name carrying a sale payload.
    expect(
      await deliver({ ...sale, name: "stock.critical" } as EventEnvelope),
    ).toEqual({ status: "ignored" });
    // An event of another tenant.
    expect(
      await deliver({
        ...sale,
        tenantId: tenantIdSchema.parse(randomUUID()),
      } as EventEnvelope),
    ).toEqual({ status: "ignored" });

    expect(await journalCount(world)).toBe(0);
    expect(await trackingOf(orderId)).toHaveLength(0);
    // The real event is still untouched by the ignored ones and posts.
    expect((await deliver(sale)).status).toBe("posted");
    expect(await journalsOf(world, orderId)).toHaveLength(1);
  });

  it("INV-GL-ZERO-01 a zero-cost movement posts no journal but is tracked, and is not retried", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const item = await insertItem("Sampel gratis");
    await receive(world, item, "5.0000", "0.0000");
    const row = await move(world, {
      movementType: "sale",
      sourceType: "order",
      sourceId: orderId,
      itemId: item,
      quantity: "-1.0000",
    });

    const result = await deliverRow(row);
    expect(result.status).toBe("zero_value");
    expect(await journalCount(world)).toBe(0);
    const tracking = await trackingOf(orderId);
    expect(tracking).toHaveLength(1);
    expect(tracking[0]!.journal_entry_id).toBeNull();
    expect(Number(tracking[0]!.value_idr)).toBe(0);

    expect(await deliverRow(row)).toEqual({ status: "already_posted" });
    expect(await journalCount(world)).toBe(0);
  });
});

// ============================================================================

describe("§3.19 a real stock count posts to the GL", () => {
  it("INV-GL-COUNT-04 create, count, submit, approve and post; the journal equals the sum of posted_value_idr", async () => {
    const world = await makeWorld();
    // The count posts "now": make sure the current month is open too.
    const today = businessDateOf(new Date(), {
      timeZone: "Asia/Jakarta",
      cutoff: "04:00",
    });
    await openPeriod(world.entity, today.slice(0, 7));

    // Counter and approver are two people (INV-03); one approval level routes
    // every stock adjustment to the outlet manager.
    const counter = await insertUser("GL Counter");
    const approver = await insertUser("GL Approver");
    await grantRole(counter, "warehouse", {
      type: "outlet",
      id: world.outletId,
    });
    const managerRole = await grantRole(approver, "outlet_manager", {
      type: "outlet",
      id: world.outletId,
    });
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'stock_adjustment', NULL, $2, 1)`,
      [tenantId, managerRole],
    );

    // Gain item: system 10, counted 13 at 1500 = +4500.
    // Loss item: system 10, counted 9 at 2000 = -2000. Net +2500.
    const gain = await insertItem("Lebih");
    const loss = await insertItem("Kurang");
    await receive(world, gain, "10.0000", "1500.0000");
    await receive(world, loss, "10.0000", "2000.0000");

    const created = await createStockCount(
      context(),
      counter,
      createStockCountInputSchema.parse({
        outletId: world.outletId,
        locationId: world.locationId,
        type: "cycle",
        blind: false,
        businessDate: today,
        inventoryItemIds: [gain, loss],
        idempotencyKey: key("sc"),
      }),
    );
    const countId = created.count.id as string;
    await transitionStockCount(
      context(),
      counter,
      countId as never,
      transitionStockCountInputSchema.parse({
        action: "start",
        idempotencyKey: key("start"),
      }),
      { mfaVerified: false },
    );
    const counted = new Map([
      [gain as string, "13.0000"],
      [loss as string, "9.0000"],
    ]);
    for (const line of created.lines)
      await updateStockCountLine(
        context(),
        counter,
        countId as never,
        line.id as never,
        updateStockCountLineInputSchema.parse({
          countedQty: counted.get(line.inventoryItemId as string),
        }),
      );
    const step = (userId: string, action: string, mfaVerified: boolean) =>
      transitionStockCount(
        context(),
        userId,
        countId as never,
        transitionStockCountInputSchema.parse({
          action,
          idempotencyKey: key(action),
        }),
        { mfaVerified },
      );
    expect((await step(counter, "submit", false)).status).toBe(
      "pending_approval",
    );
    await step(approver, "approve", true);
    expect((await step(approver, "post", true)).status).toBe("posted");

    // The count wrote one adjustment row per line, valued by the service.
    const { rows: posted } = await owner.query<{
      posted: string;
      variance_qty: string;
    }>(
      `SELECT posted_value_idr::text AS posted, variance_qty::text AS variance_qty
         FROM stock_count_lines WHERE stock_count_id = $1`,
      [countId],
    );
    expect(posted).toHaveLength(2);
    expect(
      posted.map((row) => Number(row.posted)).sort((a, b) => a - b),
    ).toEqual([-2000, 4500]);
    const postedTotal = posted.reduce(
      (sum, row) => sum + Number(row.posted),
      0,
    );
    expect(postedTotal).toBe(2500);

    // Deliver the real stock.moved events of the count, in outbox order.
    const outbox = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'
          AND event->'payload'->>'sourceId' = $2
        ORDER BY event->'payload'->>'ledgerEntryId'`,
      [tenantId, countId],
    );
    expect(outbox.rows).toHaveLength(2);
    const results = [];
    for (const row of outbox.rows)
      results.push(await deliver(eventEnvelopeSchema.parse(row.event)));
    expect(results.map((result) => result.status).sort()).toEqual([
      "already_posted",
      "posted",
    ]);

    const entries = await journalsOf(world, countId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outlet_id).toBe(world.outletId);
    // Net gain: Dr inventory / Cr inventory_adjustment, both = Σ posted_value.
    const lines = await linesOf(world, entries[0]!.id);
    expect(lines).toEqual([
      { role: "inventory", debit: postedTotal, credit: 0 },
      { role: "inventory_adjustment", debit: 0, credit: postedTotal },
    ]);
    expectNoNegativeAmounts(lines);
    const tracking = await trackingOf(countId);
    expect(tracking).toHaveLength(2);
    expect(tracking.reduce((sum, row) => sum + Number(row.value_idr), 0)).toBe(
      postedTotal,
    );
  });
});
