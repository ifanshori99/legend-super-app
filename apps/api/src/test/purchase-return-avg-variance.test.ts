// Purchase return vs moving average (card legend-uloj6, CTO decision B).
//
// A purchase return takes stock out at the RECEIPT cost c_r of the returned
// receipt line, but the moving average `a` of the stock balance is unchanged.
// The GL inventory therefore drifts from qty x avg by q x (c_r - a) per line.
// The fix is an extra self-balancing pair inside the return journal:
//   D = sum over lines (lineValueIdr - round(q x avg_before_return))
//   D > 0: Dr inventory, Cr `inventory_price_variance` (5106 Selisih Harga
//          Persediaan); D < 0: the sides flip. Avg and HPP are not touched.
// The event `purchase_return.recorded` carries the signed integer D in the new
// optional payload field `movingAvgVarianceIdr` (absent on old events = 0);
// the posting rule reads it as amount key `returnMovingAvgVarianceIdr`.
//
// Runs on the disposable PostgreSQL test database against the same consumer as
// `accounting-purchase-return-journal.test.ts` (`deliverAutoJournalEvent`),
// with synthetic `purchase_return.recorded` envelopes. Stock (receipts, the
// return movement, the moving average) is REAL: it goes through
// `recordStockMovement`, so `stock_balances` is the oracle for "GL inventory
// == qty x avg". The GL side of the receipts is seeded by hand (Dr inventory /
// Cr grni at the lot values), because the goods-receipt posting is not under
// test here.
//
// Assumptions (the card fixes the formula, a few details are open):
// - The variance pair is posted inside the same journal entry as the return
//   (rule lines of the one `purchase_return` rule), not in a second entry.
// - Lines are compared per role NET (debit - credit) so an implementation that
//   books `Dr inventory 500 + Cr inventory 5000` or one `Cr inventory 4500`
//   line passes alike; the variance role itself must sit on the right side.
// - The return movement is recorded with unit cost = c_r (the receipt cost)
//   and is the moving average's to leave unchanged (asserted below).
// - `movingAvgVarianceIdr` is a signed integer rupiah value like
//   `returnPriceVarianceIdr`.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  decimal4,
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
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
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { recordSupplierInvoicePayableInTransaction } from "../services/accounting-ap.service.ts";
import {
  deliverAutoJournalEvent,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
const NOW = new Date("2026-11-08T03:00:00Z");
/** 2026-10-15 12:00 in Jakarta: business date 2026-10-15. */
const DAY = "2026-10-15T05:00:00.000Z";
const RECEIPT_DAY = "2026-10-01T05:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

type Role =
  | "grni"
  | "accounts_payable"
  | "inventory"
  | "ppn_input"
  | "cogs"
  | "purchase_price_variance"
  | "inventory_price_variance";

const CHART: [Role, string, string, string, string][] = [
  ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
  ["ppn_input", "1401", "PPN Masukan", "asset", "current_asset"],
  ["accounts_payable", "2101", "Utang Usaha", "liability", "current_liability"],
  [
    "grni",
    "2102",
    "Barang Diterima Belum Ditagih",
    "liability",
    "current_liability",
  ],
  ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
  [
    "purchase_price_variance",
    "5105",
    "Selisih Harga Pembelian",
    "expense",
    "cogs",
  ],
  [
    "inventory_price_variance",
    "5106",
    "Selisih Harga Persediaan",
    "expense",
    "cogs",
  ],
];

type Tenant = { id: string; brandId: string };

type World = {
  tenant: Tenant;
  entity: string;
  outletId: string;
  accounts: Record<Role, string>;
};

function contextOf(tenant: Tenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Selisih Rata-rata Retur', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-prav-${id.slice(0, 8)}`,
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
    [brandId, id],
  );
  return { id, brandId };
}

/** Entity + outlet + CoA (incl. 5106 + its role mapping) + open periods. */
async function makeWorld(
  tenant: Tenant,
  options: { mapInventoryVariance?: boolean } = {},
): Promise<World> {
  const mapVariance = options.mapInventoryVariance ?? true;
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
    [entity, tenant.id, `Entity PRAV ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet PRAV', 'Jl. PRAV', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `AV-${short()}`.toUpperCase(),
    ],
  );
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    // `mapInventoryVariance: false` = a chart that predates 5106: the account
    // exists but has no role mapping (the old-event test below).
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.id, entity, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    if (role === "inventory_price_variance" && !mapVariance) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.id, entity, role, accounts[role]],
    );
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.id, entity, period],
    );
  return { tenant, entity, outletId, accounts };
}

const creator = randomUUID();
const actor = userIdSchema.parse(creator);

/** Inserts a balanced two-line journal of source type `supplier_invoice` (seed). */
async function seedJournal(
  world: World,
  debitRole: Role,
  creditRole: Role,
  amountIdr: number,
): Promise<string> {
  const { rows: period } = await owner.query<{ id: string }>(
    "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'",
    [world.tenant.id, world.entity],
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, NULL, '2026-10-01', $3, 'supplier_invoice', $4, 'Seed uji', $5, $6)
       RETURNING id`,
      [
        world.tenant.id,
        world.entity,
        period[0]!.id,
        randomUUID(),
        `prav-seed-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    const lines: [string, number, number][] = [
      [world.accounts[debitRole], amountIdr, 0],
      [world.accounts[creditRole], 0, amountIdr],
    ];
    for (const [index, [accountId, debit, credit]] of lines.entries())
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, outlet_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
        [world.tenant.id, entryId, accountId, index + 1, debit, credit],
      );
    await client.query("COMMIT");
    return entryId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A supplier whose AP card holds `payableIdr` (a debit note needs it). */
async function seedSupplierPayable(
  world: World,
  payableIdr: number,
): Promise<string> {
  const supplierId = randomUUID();
  await owner.query(
    `INSERT INTO suppliers (id, tenant_id, name, payment_terms_days, created_by)
     VALUES ($1, $2, $3, 30, $4)`,
    [supplierId, world.tenant.id, `Pemasok ${short()}`, creator],
  );
  const journalEntryId = await seedJournal(
    world,
    "inventory",
    "accounts_payable",
    payableIdr,
  );
  const context = contextOf(world.tenant);
  await withTenant(db, context, (tx) =>
    recordSupplierInvoicePayableInTransaction(
      tx,
      context,
      {
        supplierInvoiceId: randomUUID(),
        legalEntityId: world.entity,
        outletId: world.outletId,
        supplierId,
        supplierName: "Pemasok Uji",
        invoiceNumber: `INV-${short()}`,
        invoiceDate: "2026-10-01",
        dueOn: "2026-10-31",
        dppIdr: payableIdr,
        ppnIdr: 0,
        pph23Idr: 0,
        payableIdr,
        journalEntryId,
        idempotencyKey: `prav-ap-${randomUUID()}`,
      },
      actor,
    ),
  );
  return supplierId;
}

// ---- real stock (receipts, avg) ----------------------------------------------

type Stock = { locationId: string; itemId: string };
type Lot = { quantity: string; unitCost: string };

/** Integer rupiah of q x c, half up, on decimal strings of any scale. */
function roundIdr(quantity: string, unitCost: string): number {
  const parse = (value: string): [bigint, bigint] => {
    const [whole, fraction = ""] = value.split(".");
    return [BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length)];
  };
  const [q, qScale] = parse(quantity);
  const [c, cScale] = parse(unitCost);
  const denominator = qScale * cScale;
  return Number((q * c * 2n + denominator) / (2n * denominator));
}

/**
 * Receives the lots through the real ledger (moving average) and seeds the GL
 * inventory with the same lot values (Dr inventory / Cr grni), so before any
 * return GL inventory == qty x avg up to the lots' own exact values.
 */
async function seedStock(world: World, lots: Lot[]): Promise<Stock> {
  const context = contextOf(world.tenant);
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'g', 'g') RETURNING id",
    [world.tenant.id],
  );
  const location = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [world.tenant.id, world.outletId, `Gudang AV ${short()}`],
  );
  const item = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [world.tenant.id, `Kopi ${short()}`, uom.rows[0]!.id],
  );
  const stock = { locationId: location.rows[0]!.id, itemId: item.rows[0]!.id };
  let glValue = 0;
  for (const lot of lots) {
    await recordStockMovement(context, {
      outletId: world.outletId,
      locationId: stock.locationId,
      inventoryItemId: stock.itemId,
      actor: { type: "system" as const },
      movementType: "receipt",
      quantity: decimal4(lot.quantity),
      unitCostIdr: decimal4(lot.unitCost),
      batchId: null,
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      occurredAt: isoDateTimeSchema.parse(RECEIPT_DAY),
    });
    glValue += roundIdr(lot.quantity, lot.unitCost);
  }
  await seedJournal(world, "inventory", "grni", glValue);
  return stock;
}

async function balanceOf(
  world: World,
  stock: Stock,
): Promise<{ quantity: string; avg: string }> {
  const { rows } = await owner.query<{ quantity: string; avg: string }>(
    `SELECT quantity::text AS quantity, avg_cost_idr::text AS avg FROM stock_balances
      WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
    [world.tenant.id, stock.locationId, stock.itemId],
  );
  expect(rows, "stock_balances row").toHaveLength(1);
  return rows[0]!;
}

/** Numeric text without trailing zeros, to compare 4 dp with any scale. */
const num = (value: string) => Number(value);

// ---- events and delivery -----------------------------------------------------

function envelope(
  world: World,
  returnId: string,
  payload: Record<string, unknown>,
  id: string = createUlid(),
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: "purchase_return.recorded",
    version: 1,
    aggregateType: "purchase_return",
    aggregateId: returnId,
    sequence: 1,
    occurredAt: DAY,
    actor: { type: "system" },
    idempotencyKey: `prav-test-${id}`,
    payloadSchemaRef: "purchase_return.recorded.v1",
    payload,
  });
}

type ReturnSpec = {
  /** Value of the line at the receipt cost: round(q x c_r). */
  lineValueIdr: number;
  /** Part of the line already on a supplier invoice (debit note). */
  invoicedValueIdr?: number;
  ppnIdr?: number;
  supplierId?: string;
  /** `undefined` = field absent (an old event). */
  movingAvgVarianceIdr?: number;
};

function returnEvent(
  world: World,
  returnId: string,
  spec: ReturnSpec,
  id?: string,
): EventEnvelope {
  const invoiced = spec.invoicedValueIdr ?? 0;
  return envelope(
    world,
    returnId,
    {
      purchaseReturnId: returnId,
      supplierId: spec.supplierId ?? randomUUID(),
      outletId: world.outletId,
      number: `KN/2026/10/${short()}`,
      valueIdr: spec.lineValueIdr,
      uninvoicedValueIdr: spec.lineValueIdr - invoiced,
      invoicedValueIdr: invoiced,
      ppnIdr: spec.ppnIdr ?? 0,
      returnedBy: randomUUID(),
      returnedAt: DAY,
      ...(spec.movingAvgVarianceIdr === undefined
        ? {}
        : { movingAvgVarianceIdr: spec.movingAvgVarianceIdr }),
    },
    id,
  );
}

function deliver(
  tenant: Tenant,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  const context = contextOf(tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

async function post(world: World, event: EventEnvelope) {
  const result = await deliver(world.tenant, event);
  // A well-formed return carrying `movingAvgVarianceIdr` must post.
  expect(
    result,
    `return event must post: ${JSON.stringify(result)}`,
  ).toMatchObject({
    status: "posted",
  });
  if (result.status !== "posted") throw new Error("not posted");
  return result;
}

/**
 * One real return of `quantity` taken from a receipt line of cost `receiptCost`:
 * moves the stock out at c_r, computes D from the moving average read BEFORE the
 * movement (the card's formula) and posts the event. Returns the numbers.
 */
async function returnFromReceipt(
  world: World,
  stock: Stock,
  input: {
    quantity: string;
    receiptCost: string;
    invoicedValueIdr?: number;
    ppnIdr?: number;
    supplierId?: string;
    withField?: boolean;
  },
) {
  const before = await balanceOf(world, stock);
  const lineValueIdr = roundIdr(input.quantity, input.receiptCost);
  const variance = lineValueIdr - roundIdr(input.quantity, before.avg);
  const returnId = randomUUID();
  await recordStockMovement(contextOf(world.tenant), {
    outletId: world.outletId,
    locationId: stock.locationId,
    inventoryItemId: stock.itemId,
    actor: { type: "system" as const },
    movementType: "return",
    quantity: decimal4(`-${input.quantity}`),
    unitCostIdr: decimal4(input.receiptCost),
    batchId: null,
    sourceType: "purchase_return",
    sourceId: returnId,
    occurredAt: isoDateTimeSchema.parse(DAY),
  });
  const event = returnEvent(world, returnId, {
    lineValueIdr,
    ...(input.invoicedValueIdr === undefined
      ? {}
      : { invoicedValueIdr: input.invoicedValueIdr }),
    ...(input.ppnIdr === undefined ? {} : { ppnIdr: input.ppnIdr }),
    ...(input.supplierId === undefined ? {} : { supplierId: input.supplierId }),
    ...(input.withField === false ? {} : { movingAvgVarianceIdr: variance }),
  });
  const result = await post(world, event);
  return { result, event, returnId, lineValueIdr, variance, before };
}

// ---- reads ------------------------------------------------------------------

type Net = Partial<Record<Role, number>>;

/** Net (debit - credit) per role of one journal; zero-net roles are dropped. */
async function netOf(world: World, entryId: string): Promise<Net> {
  const { rows } = await owner.query<{ account_id: string; net: string }>(
    `SELECT account_id, sum(debit_idr - credit_idr)::text AS net
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [world.tenant.id, entryId],
  );
  const roleOf = new Map(
    (Object.entries(world.accounts) as [Role, string][]).map(([role, id]) => [
      id,
      role,
    ]),
  );
  const net: Net = {};
  for (const row of rows)
    if (Number(row.net) !== 0)
      net[roleOf.get(row.account_id)!] = Number(row.net);
  return net;
}

async function expectBalanced(world: World, entryId: string): Promise<void> {
  const { rows } = await owner.query<{ debit: string; credit: string }>(
    `SELECT sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2`,
    [world.tenant.id, entryId],
  );
  expect(Number(rows[0]!.debit)).toBeGreaterThan(0);
  expect(Number(rows[0]!.debit)).toBe(Number(rows[0]!.credit));
}

/** Net balance (debit - credit) of one role over every journal of the entity. */
async function glNet(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ net: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS net
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.net ?? 0);
}

async function returnJournalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = 'purchase_return'",
    [world.tenant.id, world.entity],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [creator, "Purchase return avg variance test", `${creator}@example.com`],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

// ============================================================================

describe("purchase return leaves at receipt cost, GL inventory follows qty x avg", () => {
  it("PRAV-01 receipt cost above avg: partial return posts Dr inventory / Cr 5106 by q x (c_r - a), GL inventory == qty x avg", async () => {
    const world = await makeWorld(await makeTenant());
    // 10 g @ 1000 then 10 g @ 800: avg 900, qty 20, GL inventory 18000.
    const stock = await seedStock(world, [
      { quantity: "10.0000", unitCost: "1000.0000" },
      { quantity: "10.0000", unitCost: "800.0000" },
    ]);
    expect(num((await balanceOf(world, stock)).avg)).toBe(900);
    expect(await glNet(world, "inventory")).toBe(18_000);

    // Return 5 g of the 1000 lot: value 5000, q x avg = 4500, D = +500.
    const done = await returnFromReceipt(world, stock, {
      quantity: "5.0000",
      receiptCost: "1000.0000",
    });
    expect(done.lineValueIdr).toBe(5_000);
    expect(done.variance).toBe(500);

    // Journal: Dr grni 5000; inventory leaves at round(q x avg) = 4500 net;
    // the 500 over-credit is taken back against 5106 (credit = q x (c_r - a)).
    expect(await netOf(world, done.result.journalEntryId)).toEqual({
      grni: 5_000,
      inventory: -4_500,
      inventory_price_variance: -500,
    });
    await expectBalanced(world, done.result.journalEntryId);

    // Avg and qty: moving average unchanged, 15 g left.
    const after = await balanceOf(world, stock);
    expect(num(after.quantity)).toBe(15);
    expect(num(after.avg)).toBe(900);
    // GL inventory == qty x avg == 13500, exactly (no drift).
    expect(await glNet(world, "inventory")).toBe(13_500);
    expect(await glNet(world, "inventory")).toBe(
      roundIdr(after.quantity, after.avg),
    );
    expect(await glNet(world, "inventory_price_variance")).toBe(-500);
    // HPP untouched.
    expect(await glNet(world, "cogs")).toBe(0);
  });

  it("PRAV-02 receipt cost below avg: sides flip (Dr 5106 / Cr inventory), still balanced, GL inventory == qty x avg", async () => {
    const world = await makeWorld(await makeTenant());
    // 10 g @ 600 then 10 g @ 1000: avg 800, qty 20, GL inventory 16000.
    const stock = await seedStock(world, [
      { quantity: "10.0000", unitCost: "600.0000" },
      { quantity: "10.0000", unitCost: "1000.0000" },
    ]);
    expect(num((await balanceOf(world, stock)).avg)).toBe(800);

    // Return 5 g of the 600 lot: value 3000, q x avg = 4000, D = -1000.
    const done = await returnFromReceipt(world, stock, {
      quantity: "5.0000",
      receiptCost: "600.0000",
    });
    expect(done.lineValueIdr).toBe(3_000);
    expect(done.variance).toBe(-1_000);

    expect(await netOf(world, done.result.journalEntryId)).toEqual({
      grni: 3_000,
      inventory: -4_000,
      inventory_price_variance: 1_000,
    });
    await expectBalanced(world, done.result.journalEntryId);

    const after = await balanceOf(world, stock);
    expect(num(after.quantity)).toBe(15);
    expect(num(after.avg)).toBe(800);
    expect(await glNet(world, "inventory")).toBe(12_000);
    expect(await glNet(world, "inventory")).toBe(
      roundIdr(after.quantity, after.avg),
    );
    expect(await glNet(world, "inventory_price_variance")).toBe(1_000);
    expect(await glNet(world, "cogs")).toBe(0);
  });

  it("PRAV-03 receipt cost equals avg: no variance, the journal is the plain Dr grni / Cr inventory and no 5106 line exists", async () => {
    const world = await makeWorld(await makeTenant());
    const stock = await seedStock(world, [
      { quantity: "10.0000", unitCost: "1000.0000" },
    ]);

    const done = await returnFromReceipt(world, stock, {
      quantity: "4.0000",
      receiptCost: "1000.0000",
    });
    expect(done.variance).toBe(0);

    expect(await netOf(world, done.result.journalEntryId)).toEqual({
      grni: 4_000,
      inventory: -4_000,
    });
    const { rows } = await owner.query(
      "SELECT 1 FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 AND account_id = $3",
      [
        world.tenant.id,
        done.result.journalEntryId,
        world.accounts.inventory_price_variance,
      ],
    );
    expect(rows, "no variance line when D = 0").toHaveLength(0);
    expect(await glNet(world, "inventory")).toBe(6_000);
  });
});

describe("supplier side is unchanged by the variance", () => {
  it("PRAV-04 an invoiced return credits the supplier (AP debit note) the same with and without a variance; the variance never reaches AP, GRNI or PPN", async () => {
    // Two identical worlds; only the variance field differs. Setup per world:
    // 10 g @ 1000 + 10 g @ 800 (avg 900), return 5 g of the 1000 lot, invoiced.
    const run = async (withField: boolean) => {
      const world = await makeWorld(await makeTenant());
      const stock = await seedStock(world, [
        { quantity: "10.0000", unitCost: "1000.0000" },
        { quantity: "10.0000", unitCost: "800.0000" },
      ]);
      const supplierId = await seedSupplierPayable(world, 500_000);
      const done = await returnFromReceipt(world, stock, {
        quantity: "5.0000",
        receiptCost: "1000.0000",
        invoicedValueIdr: 5_000,
        ppnIdr: 550,
        supplierId,
        withField,
      });
      return { world, done };
    };
    const without = await run(false);
    const withVariance = await run(true);
    expect(withVariance.done.variance).toBe(500);

    const plain = await netOf(
      without.world,
      without.done.result.journalEntryId,
    );
    const adjusted = await netOf(
      withVariance.world,
      withVariance.done.result.journalEntryId,
    );

    // Same supplier-facing amounts: AP debit 5000 + 550 PPN, PPN credit 550,
    // no GRNI. (Old behaviour: inventory credit of the full line value.)
    expect(plain).toEqual({
      accounts_payable: 5_550,
      inventory: -5_000,
      ppn_input: -550,
    });
    expect(adjusted.accounts_payable).toBe(plain.accounts_payable);
    expect(adjusted.grni).toBe(plain.grni);
    expect(adjusted.ppn_input).toBe(plain.ppn_input);
    // Only inventory and 5106 differ, and they offset each other.
    expect(adjusted).toEqual({
      accounts_payable: 5_550,
      inventory: -4_500,
      inventory_price_variance: -500,
      ppn_input: -550,
    });
    await expectBalanced(
      withVariance.world,
      withVariance.done.result.journalEntryId,
    );
  });

  it("PRAV-05 a full return in two parts with rounding: supplier value adds up to the receipts exactly, GL inventory is 0 at qty 0, variance sides flip per part", async () => {
    const world = await makeWorld(await makeTenant());
    // 1 g @ 1000 + 2 g @ 1001: value 3002, avg 1000.6667, GL inventory 3002.
    const stock = await seedStock(world, [
      { quantity: "1.0000", unitCost: "1000.0000" },
      { quantity: "2.0000", unitCost: "1001.0000" },
    ]);

    // Part 1: 1 g of the 1000 lot: value 1000, round(1 x 1000.6667) = 1001, D = -1.
    const first = await returnFromReceipt(world, stock, {
      quantity: "1.0000",
      receiptCost: "1000.0000",
    });
    expect(first.variance).toBe(-1);
    expect(await netOf(world, first.result.journalEntryId)).toEqual({
      grni: 1_000,
      inventory: -1_001,
      inventory_price_variance: 1,
    });

    // Part 2: the 2 g of the 1001 lot: value 2002, round(2 x 1000.6667) = 2001, D = +1.
    const second = await returnFromReceipt(world, stock, {
      quantity: "2.0000",
      receiptCost: "1001.0000",
    });
    expect(second.variance).toBe(1);
    expect(await netOf(world, second.result.journalEntryId)).toEqual({
      grni: 2_002,
      inventory: -2_001,
      inventory_price_variance: -1,
    });
    await expectBalanced(world, second.result.journalEntryId);

    // Supplier side: the GRNI debited in the parts is the receipts' value
    // exactly (3002), as before the variance existed.
    // (Seed credited grni 3002; the two returns debited 1000 + 2002.)
    expect(await glNet(world, "grni")).toBe(0);
    // Stock is empty and so is the GL inventory; the variance nets to 0.
    expect(num((await balanceOf(world, stock)).quantity)).toBe(0);
    expect(await glNet(world, "inventory")).toBe(0);
    expect(await glNet(world, "inventory_price_variance")).toBe(0);
  });
});

describe("delivery is idempotent and old events still post", () => {
  it("PRAV-06 replaying the event (same envelope and a re-sent one) does not post the variance twice", async () => {
    const world = await makeWorld(await makeTenant());
    const stock = await seedStock(world, [
      { quantity: "10.0000", unitCost: "1000.0000" },
      { quantity: "10.0000", unitCost: "800.0000" },
    ]);
    const done = await returnFromReceipt(world, stock, {
      quantity: "5.0000",
      receiptCost: "1000.0000",
    });
    expect(await returnJournalCount(world)).toBe(1);

    expect(await deliver(world.tenant, done.event)).toEqual({
      status: "already_posted",
      journalEntryId: done.result.journalEntryId,
    });
    // A re-sent envelope of the same return (new event id) is the same fact.
    expect(
      await deliver(
        world.tenant,
        returnEvent(
          world,
          done.returnId,
          {
            lineValueIdr: done.lineValueIdr,
            movingAvgVarianceIdr: done.variance,
          },
          createUlid(),
        ),
      ),
    ).toMatchObject({
      status: "already_posted",
      journalEntryId: done.result.journalEntryId,
    });

    expect(await returnJournalCount(world)).toBe(1);
    expect(await glNet(world, "inventory")).toBe(13_500);
    expect(await glNet(world, "inventory_price_variance")).toBe(-500);
  });

  it("PRAV-07 an old event payload without movingAvgVarianceIdr posts as before (variance 0, no 5106 line)", async () => {
    // The chart predates 5106 (no inventory_price_variance mapping): an old
    // event has variance 0, so it must post without that mapping.
    const world = await makeWorld(await makeTenant(), {
      mapInventoryVariance: false,
    });
    const returnId = randomUUID();
    const result = await post(
      world,
      returnEvent(world, returnId, { lineValueIdr: 185_000 }),
    );

    expect(await netOf(world, result.journalEntryId)).toEqual({
      grni: 185_000,
      inventory: -185_000,
    });
    await expectBalanced(world, result.journalEntryId);
    expect(await glNet(world, "inventory_price_variance")).toBe(0);
  });

  it("PRAV-08 a zero-price receipt line returned at avg 5000 still posts the variance pair (Cr inventory / Dr 5106), supplier side 0", async () => {
    const world = await makeWorld(await makeTenant());
    // 10 g @ 5000: avg 5000, GL inventory 50000.
    const stock = await seedStock(world, [
      { quantity: "10.0000", unitCost: "5000.0000" },
    ]);

    // Return 2 g of a 0-price line: value 0, q x avg = 10000, D = -10000.
    const done = await returnFromReceipt(world, stock, {
      quantity: "2.0000",
      receiptCost: "0.0000",
    });
    expect(done.lineValueIdr).toBe(0);
    expect(done.variance).toBe(-10_000);

    // Only the two variance lines; GRNI, AP and PPN stay 0.
    expect(await netOf(world, done.result.journalEntryId)).toEqual({
      inventory: -10_000,
      inventory_price_variance: 10_000,
    });
    await expectBalanced(world, done.result.journalEntryId);

    const after = await balanceOf(world, stock);
    expect(num(after.quantity)).toBe(8);
    expect(num(after.avg)).toBe(5_000);
    expect(await glNet(world, "inventory")).toBe(40_000);
    expect(await glNet(world, "inventory")).toBe(
      roundIdr(after.quantity, after.avg),
    );
    expect(await glNet(world, "inventory_price_variance")).toBe(10_000);
  });
});
