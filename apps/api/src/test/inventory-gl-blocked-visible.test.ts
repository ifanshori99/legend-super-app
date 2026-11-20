import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { closeFiscalPeriod } from "../services/accounting-period-close.service.ts";
import { logger } from "../lib/logger.ts";

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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantId = randomUUID();
  brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji GL Terparkir', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantId,
      `uji-gl-parked-${tenantId.slice(0, 8)}`,
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

function close(periodId: string, version = 1) {
  return closeFiscalPeriod(
    context(),
    periodId,
    { expectedVersion: version, idempotencyKey: `close-${randomUUID()}` },
    randomUUID() as never,
  );
}

async function periodOfWorld(world: World, period: string) {
  const { rows } = await owner.query<{ id: string; version: number }>(
    "SELECT id, version FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
    [tenantId, world.entity, period],
  );
  return rows[0]!;
}

async function blockedCountOf(productionId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM inventory_gl_blocked WHERE tenant_id = $1 AND source_id = $2",
    [tenantId, productionId],
  );
  return Number(rows[0]!.n);
}

describe("card 1260: parked inventory GL sources are visible", () => {
  it("[1260-LOG] parking a source writes a structured warning with ids and code only", async () => {
    const world = await makeWorld();
    const raw = await insertItem("Daging");
    await receive(world, raw, "1000", "100", BEFORE);
    const productionId = randomUUID();
    const draw = await drawMaterial(world, raw, "600", productionId, DAY);
    const warn = vi.spyOn(logger, "warn");
    try {
      expect(await deliverRow(draw)).toEqual({
        status: "blocked",
        code: "PRODUCTION_INCOMPLETE",
      });
      const call = warn.mock.calls.find(
        ([fields]) =>
          (fields as { sourceId?: string } | undefined)?.sourceId ===
          productionId,
      );
      expect(call).toBeDefined();
      expect(call![0]).toEqual({
        event: "inventory_gl.parked",
        tenantId,
        outletId: world.outletId,
        sourceType: "production_order",
        sourceId: productionId,
        errorCode: "PRODUCTION_INCOMPLETE",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("[1260-CLOSE] a period with a parked source cannot close; it closes once the source posts", async () => {
    const world = await makeWorld();
    const raw = await insertItem("Tepung");
    const out = await insertItem("Adonan", "semi_finished");
    await receive(world, raw, "1000", "100", BEFORE);
    const productionId = randomUUID();
    const draw = await drawMaterial(world, raw, "1000", productionId, DAY);
    expect((await deliverRow(draw)).status).toBe("blocked");
    expect(await blockedCountOf(productionId)).toBe(1);

    // September has no parked source (it happened in October): closes.
    const september = await periodOfWorld(world, "2026-09");
    await close(september.id);

    const october = await periodOfWorld(world, "2026-10");
    await expect(close(october.id)).rejects.toMatchObject({
      code: "PERIOD_INVENTORY_GL_BLOCKED",
      details: { count: 1 },
    });
    const { rows: stillOpen } = await owner.query<{ status: string }>(
      "SELECT status FROM fiscal_periods WHERE id = $1",
      [october.id],
    );
    expect(stillOpen[0]!.status).toBe("open");

    // The put-away completes the batch; the parked row clears and the close goes.
    const output = await putAwayOutput(
      world,
      out,
      "70000",
      "1.4286",
      productionId,
      DAY,
    );
    expect((await deliverRow(output)).status).toBe("posted");
    expect(await blockedCountOf(productionId)).toBe(0);
    const closed = await close(october.id, october.version);
    expect(closed.status).toBe("closed");
  });
});
