// Fail-first tests for the "inventory-purchasing" metric family (WS-11 F5,
// bead legend-5wzoc; brief docs/briefs/268b-shared-context.md, DECISIONS
// 2026-11-10 points 1-2 and 5-6).
//
// Metric map under test:
// - gl (already in `gl.ts`, untouched): cogs, waste_cost, food_cost_pct.
// - daily: stock_value, critical_stock_count (point in time at business day
//   end), purchase_total (+ supplier split), supplier_due (+ supplier split).
// - derived: waste_cost_pct = waste_cost / net_sales x 100.
// - ledger splits of waste_cost: menu_item and menu_category, from waste_logs.
//
// Every case builds its own tenants and uses fixed past business dates, so
// cases never share rows. Stock fixtures are raw inserts as the sibling
// inventory tests do (balances are not trigger-maintained).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateOf,
  businessDateSchema,
  businessDayRange,
  idr,
  outletIdSchema,
  outletIdsForQuery,
  tenantIdSchema,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accountIdSchema,
  type JournalLineInput,
} from "@starter/shared/accounting";
import { METRIC_LEDGER_ADJUSTMENT } from "@starter/shared/metrics";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { outletBusinessDayClock } from "../services/outlet-clock";
import {
  dailyReaders,
  metricSourceOf,
  metricSplitOf,
  type DailyMetricReader,
  type DailyMetricValue,
} from "../services/metric-sources";
import { queryStockLevels } from "../services/metric-sources/inventory-purchasing";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
  type EvaluatedSeries,
} from "../services/metrics-query.service";
import { recomputeMetricsDaily } from "../services/metrics-daily.service";
import { agent, signUp } from "./helpers";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

const D0 = "2025-06-09"; // no activity at all
const D1 = "2025-06-10";
const D2 = "2025-06-11";
const D3 = "2025-06-12"; // supplier invoices fall due
const NOW = new Date("2025-09-15T05:00:00Z");
const LATE = new Date("2025-12-20T05:00:00Z");

type World = {
  tenantId: string;
  brandId: string;
  entityId: string;
  outlet1: string;
  outlet2: string;
  clock: ReturnType<typeof outletBusinessDayClock>;
  supplierA: string;
  supplierB: string;
  item: Record<"beras" | "gula" | "minyak" | "tepung" | "susu", string>;
  loc1: string;
  loc1b: string;
  locO2: string;
  menu: { m1: string; m2: string; cat: string };
  waste: string;
  inventory: string;
  revenue: string;
  cash: string;
};

let world: World;
let other: World;
let userId: string;

const date = (value: string): BusinessDate => businessDateSchema.parse(value);

function context(tenantId: string, outletIds?: string[]): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(
    tenant,
    outletIds
      ? {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        }
      : { kind: "tenant" },
  );
}

/** An instant one hour into the outlet business day `businessDate`. */
function at(w: World, businessDate: string): string {
  return new Date(
    businessDayRange(date(businessDate), w.clock).start.getTime() + 3_600_000,
  ).toISOString();
}

function dailyReaderOf(code: string): DailyMetricReader {
  const source = metricSourceOf(code);
  if (source.kind !== "daily")
    throw new Error(`${code} is ${source.kind}, expected daily`);
  return source.reader;
}

function wasteReaderOf(dimension: "menu_item" | "menu_category") {
  const split = metricSplitOf("waste_cost", dimension);
  if (!split) throw new Error(`no waste_cost split on ${dimension}`);
  return split.reader;
}

function numberOf(value: DailyMetricValue["value"]): number {
  switch (value.unit) {
    case "idr":
      return value.valueIdr;
    case "count":
    case "seconds":
      return value.value;
    default:
      return Number(value.value);
  }
}

/** `code` or `code|dimension_value` to number, as one reader computes a day. */
async function compute(
  w: World,
  reader: DailyMetricReader,
  businessDate: string,
  outlet: string = w.outlet1,
  tenantId: string = w.tenantId,
): Promise<Record<string, number>> {
  const values = await withTenant(db, context(tenantId), (tx) =>
    reader.compute({
      tx,
      tenantId,
      outletId: outlet,
      businessDate: date(businessDate),
    }),
  );
  const out: Record<string, number> = {};
  for (const entry of values) {
    const key = entry.dimension
      ? `${entry.metricCode}|${entry.dimension.key}:${entry.dimension.value}`
      : entry.metricCode;
    expect(out[key], `duplicate row ${key}`).toBeUndefined();
    out[key] = numberOf(entry.value);
  }
  return out;
}

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `msip-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const { rows } = await owner.query<{
    timezone: string;
    business_day_cutoff: string;
  }>("SELECT timezone, business_day_cutoff FROM outlets WHERE id = $1", [
    tenant.outletId,
  ]);
  const clock = outletBusinessDayClock({
    timezone: rows[0]!.timezone,
    businessDayCutoff: rows[0]!.business_day_cutoff,
  });
  const t = tenant.tenantId;

  const uom = randomUUID();
  await owner.query(
    `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, 'kg', 'Kilogram')`,
    [uom, t],
  );
  const [loc1, loc1b, locO2] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, outlet, name] of [
    [loc1, tenant.outletId, "Gudang"],
    [loc1b, tenant.outletId, "Dapur"],
    [locO2, outlet2, "Gudang Dua"],
  ] as const)
    await owner.query(
      `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, 'warehouse')`,
      [id, t, outlet, name],
    );
  const item = {
    beras: randomUUID(),
    gula: randomUUID(),
    minyak: randomUUID(),
    tepung: randomUUID(),
    susu: randomUUID(),
  };
  // [key, par_min, par_max, active]: par is the item default (min and max).
  for (const [key, parMin, parMax, active] of [
    ["beras", "12", "40", true],
    ["gula", "10", "30", true],
    ["minyak", null, null, true],
    ["tepung", "5", "20", false],
    ["susu", "20", "40", true],
  ] as const)
    await owner.query(
      `INSERT INTO inventory_items (id, tenant_id, name, category, base_uom_id, par_min, par_max, is_active)
       VALUES ($1, $2, $3, 'bahan', $4, $5, $6, $7)`,
      [item[key], t, `Bahan ${key}`, uom, parMin, parMax, active],
    );
  // A per-location par wins over the item default: susu needs only 2 at loc1.
  await owner.query(
    `INSERT INTO par_levels (tenant_id, outlet_id, location_id, inventory_item_id, par_min, par_max)
     VALUES ($1, $2, $3, $4, 2, 10)`,
    [t, tenant.outletId, loc1, item.susu],
  );

  const supplierA = randomUUID();
  const supplierB = randomUUID();
  for (const [id, name] of [
    [supplierA, "Pemasok A"],
    [supplierB, "Pemasok B"],
  ] as const)
    await owner.query(
      `INSERT INTO suppliers (id, tenant_id, name, payment_terms_days, created_by)
       VALUES ($1, $2, $3, 14, $4)`,
      [id, t, name, userId],
    );

  const cat = randomUUID();
  const m1 = randomUUID();
  const m2 = randomUUID();
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Minuman')`,
    [cat, t, tenant.brandId],
  );
  for (const [id, name] of [
    [m1, "Kopi"],
    [m2, "Teh"],
  ] as const)
    await owner.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, $5)`,
      [id, t, tenant.brandId, cat, name],
    );

  const [cash, revenue, waste, inventory] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $5, $6, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $5, $6, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $5, $6, '6101', 'Beban waste', 'expense', 'operating_expense'),
            ($4, $5, $6, '1301', 'Persediaan', 'asset', 'cash_and_equivalents')`,
    [cash, revenue, waste, inventory, t, tenant.legalEntityId],
  );
  for (const [role, account] of [
    ["sales_revenue", revenue],
    ["waste_expense", waste],
  ] as const)
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [t, tenant.legalEntityId, role, account],
    );

  return {
    tenantId: t,
    brandId: tenant.brandId,
    entityId: tenant.legalEntityId,
    outlet1: tenant.outletId,
    outlet2,
    clock,
    supplierA,
    supplierB,
    item,
    loc1,
    loc1b,
    locO2,
    menu: { m1, m2, cat },
    waste,
    inventory,
    revenue,
    cash,
  };
}

async function ledger(
  w: World,
  row: {
    outlet?: string;
    location: string;
    item: string;
    type: "receipt" | "sale" | "waste";
    quantity: number;
    cost: number;
    day: string;
    /** Later inside the day, so same-day rows replay in a fixed order. */
    afterMs?: number;
  },
) {
  const source = {
    receipt: "goods_receipt",
    sale: "order",
    waste: "waste_log",
  } as const;
  await owner.query(
    `INSERT INTO stock_ledger (id, tenant_id, outlet_id, location_id, inventory_item_id,
        movement_type, quantity, unit_cost_idr, source_type, source_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      w.tenantId,
      row.outlet ?? w.outlet1,
      row.location,
      row.item,
      row.type,
      row.quantity,
      row.cost,
      source[row.type],
      randomUUID(),
      new Date(Date.parse(at(w, row.day)) + (row.afterMs ?? 0)).toISOString(),
    ],
  );
}

async function balance(
  w: World,
  row: {
    outlet?: string;
    location: string;
    item: string;
    quantity: number;
    cost: number;
  },
) {
  await owner.query(
    `INSERT INTO stock_balances (tenant_id, outlet_id, location_id, inventory_item_id, quantity, avg_cost_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      w.tenantId,
      row.outlet ?? w.outlet1,
      row.location,
      row.item,
      row.quantity,
      row.cost,
    ],
  );
}

let poNumber = 0;
async function purchaseOrder(
  w: World,
  row: {
    outlet?: string;
    supplier: string;
    status: string;
    total: number;
    approvedDay: string | null;
  },
) {
  poNumber += 1;
  await owner.query(
    `INSERT INTO purchase_orders
       (tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, '2099-12-20', $6, 0, $6, 'user', $7, $8, $9)`,
    [
      w.tenantId,
      row.outlet ?? w.outlet1,
      row.supplier,
      `PO-MS-${randomUUID().slice(0, 8)}-${poNumber}`,
      row.status,
      row.total,
      userId,
      row.approvedDay ? userId : null,
      row.approvedDay ? at(w, row.approvedDay) : null,
    ],
  );
}

async function invoice(
  w: World,
  row: {
    outlet: string | null;
    supplier: string;
    original: number;
    docDate: string;
    dueOn: string;
    paid?: { on: string; amount: number }[];
  },
) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO accounting_open_items (tenant_id, kind, id, legal_entity_id, outlet_id, counterparty_type, counterparty_id, counterparty_name, document_number, document_date, due_on, original_idr)
     VALUES ($1, 'payable', $2, $3, $4, 'supplier', $5, 'Pemasok', $6, $7, $8, $9)`,
    [
      w.tenantId,
      id,
      w.entityId,
      row.outlet,
      row.supplier,
      `INV-${id.slice(0, 8)}`,
      row.docDate,
      row.dueOn,
      row.original,
    ],
  );
  for (const payment of row.paid ?? [])
    await owner.query(
      `INSERT INTO accounting_open_item_settlements (tenant_id, kind, open_item_id, method, settled_on, amount_idr)
       VALUES ($1, 'payable', $2, 'payment', $3, $4)`,
      [w.tenantId, id, payment.on, payment.amount],
    );
}

async function wasteLog(
  w: World,
  row: {
    outlet?: string;
    location: string;
    target: "inventory_item" | "menu_item";
    targetId: string;
    value: number;
    day: string;
  },
) {
  await owner.query(
    `INSERT INTO waste_logs (tenant_id, outlet_id, location_id, target_type, target_id, quantity,
        reason, value_idr, logged_by, occurred_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'spoiled', $6, $7, $8, $8)`,
    [
      w.tenantId,
      row.outlet ?? w.outlet1,
      row.location,
      row.target,
      row.targetId,
      row.value,
      userId,
      at(w, row.day),
    ],
  );
}

function line(
  accountId: string,
  debit: number,
  credit: number,
  outlet: string,
): JournalLineInput {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: outletIdSchema.parse(outlet),
    costCenter: null,
  };
}

/** One balanced journal on `day` at `outlet`: debit `debitAccount`, credit `creditAccount`. */
async function journal(
  w: World,
  input: {
    day: string;
    outlet: string;
    debitAccount: string;
    creditAccount: string;
    amount: number;
  },
) {
  const ctx = context(w.tenantId);
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: w.entityId,
      outletId: outletIdSchema.parse(input.outlet),
      entryDate: date(input.day),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji keluarga stok dan pembelian",
      lines: [
        line(input.debitAccount, input.amount, 0, input.outlet),
        line(input.creditAccount, 0, input.amount, input.outlet),
      ],
      postedBy: null,
      idempotencyKey: `ms-ip-${randomUUID()}`,
    }),
  );
}

function ownReaders() {
  return dailyReaders().filter(
    ({ family }) => family === "inventory-purchasing",
  );
}

function evaluate(
  w: World,
  request: {
    metricCodes: string[];
    period: { start: string; end: string };
    groupBy?: string[];
    bucket?: "total" | "day";
  },
  outletIds?: string[],
): Promise<EvaluatedMetrics> {
  const ctx = context(w.tenantId, outletIds);
  return withTenantSnapshot(ctx, (tx) =>
    evaluateMetrics(
      tx,
      ctx,
      {
        metricCodes: request.metricCodes,
        period: {
          start: date(request.period.start),
          end: date(request.period.end),
        },
        bucket: request.bucket ?? "total",
        outletFilter: outletIdsForQuery(ctx.outletScope),
        groupBy: request.groupBy ?? [],
        filters: [],
        comparePrevious: false,
        viewer: "full",
      },
      NOW,
    ),
  );
}

function seriesOf(result: EvaluatedMetrics, code: string): EvaluatedSeries[] {
  return result.series.filter((series) => series.metricCode === code);
}

function pointNumber(series: EvaluatedSeries | undefined): number | null {
  const value = series?.points[0]?.value as
    | { unit: "idr"; valueIdr: number }
    | { unit: string; value: number | string }
    | null
    | undefined;
  if (value === null || value === undefined) return null;
  return "valueIdr" in value ? value.valueIdr : Number(value.value);
}

beforeAll(async () => {
  const email = await signUp(agent(), "Penguji Stok");
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id FROM "user" WHERE email = $1',
    [email],
  );
  userId = rows[0]!.id;
  world = await makeWorld("a");
  other = await makeWorld("b");
  const w = world;

  // Stock ledger, outlet 1 (gudang = loc1):
  //  D1: beras +10 @1000, gula +5 @4000, minyak +3 @500, tepung +1 @2000, susu +3 @3000
  //  D2: beras +10 @2000 (average 1500, qty 20), then sale -4 (qty 16, avg 1500)
  // Value at end of D1: 10000 + 20000 + 1500 + 2000 + 9000 = 42500.
  // Value at end of D2: 24000 + 20000 + 1500 + 2000 + 9000 = 56500.
  const day1 = [
    ["beras", 10, 1000],
    ["gula", 5, 4000],
    ["minyak", 3, 500],
    ["tepung", 1, 2000],
    ["susu", 3, 3000],
  ] as const;
  for (const [key, quantity, cost] of day1)
    await ledger(w, {
      location: w.loc1,
      item: w.item[key],
      type: "receipt",
      quantity,
      cost,
      day: D1,
    });
  await ledger(w, {
    location: w.loc1,
    item: w.item.beras,
    type: "receipt",
    quantity: 10,
    cost: 2000,
    day: D2,
  });
  await ledger(w, {
    location: w.loc1,
    item: w.item.beras,
    type: "sale",
    quantity: -4,
    cost: 1500,
    day: D2,
    afterMs: 60_000,
  });
  // Outlet 2 holds a lot of stock on D1; it must never reach outlet 1.
  await ledger(w, {
    outlet: w.outlet2,
    location: w.locO2,
    item: w.item.beras,
    type: "receipt",
    quantity: 500,
    cost: 9999,
    day: D1,
  });
  // Tenant B holds stock, orders and invoices on the same dates.
  await ledger(other, {
    location: other.loc1,
    item: other.item.beras,
    type: "receipt",
    quantity: 100,
    cost: 7777,
    day: D1,
  });

  // Purchase orders (outlet 1): D1 approved 100000 (A) + sent 50000 (B);
  // cancelled and draft orders never count; D2 approved 25000 (A).
  await purchaseOrder(w, {
    supplier: w.supplierA,
    status: "approved",
    total: 100_000,
    approvedDay: D1,
  });
  await purchaseOrder(w, {
    supplier: w.supplierB,
    status: "sent",
    total: 50_000,
    approvedDay: D1,
  });
  await purchaseOrder(w, {
    supplier: w.supplierA,
    status: "cancelled",
    total: 70_000,
    approvedDay: D1,
  });
  await purchaseOrder(w, {
    supplier: w.supplierA,
    status: "draft",
    total: 80_000,
    approvedDay: null,
  });
  await purchaseOrder(w, {
    supplier: w.supplierA,
    status: "received",
    total: 25_000,
    approvedDay: D2,
  });
  await purchaseOrder(w, {
    outlet: w.outlet2,
    supplier: w.supplierA,
    status: "approved",
    total: 999_000,
    approvedDay: D1,
  });
  await purchaseOrder(other, {
    supplier: other.supplierA,
    status: "approved",
    total: 888_000,
    approvedDay: D1,
  });

  // Supplier invoices of outlet 1 (payable, due on or before the data date):
  //  I1 supplier A 100000, doc D1, due D2, paid 30000 on D2  -> due 100000 on D2 morning? see tests
  //  I2 supplier B  60000, doc D1, due D3, unpaid
  //  I3 supplier A  40000, doc D1, due D2, paid in full on D3 -> due on D2, gone on D3
  //  I4 no outlet (entity level) and an outlet 2 invoice never count at outlet 1
  await invoice(w, {
    outlet: w.outlet1,
    supplier: w.supplierA,
    original: 100_000,
    docDate: D1,
    dueOn: D2,
    paid: [{ on: D2, amount: 30_000 }],
  });
  await invoice(w, {
    outlet: w.outlet1,
    supplier: w.supplierB,
    original: 60_000,
    docDate: D1,
    dueOn: D3,
  });
  await invoice(w, {
    outlet: w.outlet1,
    supplier: w.supplierA,
    original: 40_000,
    docDate: D1,
    dueOn: D2,
    paid: [{ on: D3, amount: 40_000 }],
  });
  await invoice(w, {
    outlet: null,
    supplier: w.supplierA,
    original: 500_000,
    docDate: D1,
    dueOn: D1,
  });
  await invoice(w, {
    outlet: w.outlet2,
    supplier: w.supplierA,
    original: 700_000,
    docDate: D1,
    dueOn: D1,
  });
  await invoice(other, {
    outlet: other.outlet1,
    supplier: other.supplierA,
    original: 600_000,
    docDate: D1,
    dueOn: D1,
  });

  // Waste logs of outlet 1 on D1: Kopi 30000, Teh 20000, a raw item 10000.
  await wasteLog(w, {
    location: w.loc1,
    target: "menu_item",
    targetId: w.menu.m1,
    value: 30_000,
    day: D1,
  });
  await wasteLog(w, {
    location: w.loc1,
    target: "menu_item",
    targetId: w.menu.m2,
    value: 20_000,
    day: D1,
  });
  await wasteLog(w, {
    location: w.loc1,
    target: "inventory_item",
    targetId: w.item.beras,
    value: 10_000,
    day: D1,
  });
  await wasteLog(w, {
    location: w.loc1,
    target: "menu_item",
    targetId: w.menu.m1,
    value: 5_000,
    day: D2,
  });
  await wasteLog(other, {
    location: other.loc1,
    target: "menu_item",
    targetId: other.menu.m1,
    value: 77_000,
    day: D1,
  });

  // Ledger: waste posted 65000 on D1 (60000 of logs plus a 5000 write-off the
  // logs never carried), net sales 1,000,000 on D1.
  await journal(w, {
    day: D1,
    outlet: w.outlet1,
    debitAccount: w.waste,
    creditAccount: w.inventory,
    amount: 65_000,
  });
  await journal(w, {
    day: D1,
    outlet: w.outlet1,
    debitAccount: w.cash,
    creditAccount: w.revenue,
    amount: 1_000_000,
  });
});

afterAll(async () => {
  await owner.end();
});

describe("registry: kind of every metric of the family", () => {
  it("keeps cogs, waste_cost and food_cost_pct on the ledger", () => {
    for (const code of ["cogs", "waste_cost", "food_cost_pct"])
      expect(metricSourceOf(code).kind, code).toBe("gl");
  });

  it("reads stock, orders and supplier due from daily readers", () => {
    for (const code of [
      "stock_value",
      "critical_stock_count",
      "purchase_total",
      "supplier_due",
    ])
      expect(metricSourceOf(code).kind, code).toBe("daily");
  });

  it("derives waste_cost_pct from waste_cost and net_sales", () => {
    expect(metricSourceOf("waste_cost_pct")).toEqual({
      kind: "derived",
      code: "waste_cost_pct",
      numerator: "waste_cost",
      denominator: "net_sales",
      scale: 100,
    });
  });

  it("splits waste_cost by menu item and menu category", () => {
    for (const dimension of ["menu_item", "menu_category"] as const)
      expect(metricSplitOf("waste_cost", dimension), dimension).not.toBeNull();
  });

  it("runs every reader of the family once in the daily job", () => {
    const codes = ownReaders().flatMap(({ reader }) => reader.metricCodes);
    expect([...codes].sort()).toEqual(
      [
        "critical_stock_count",
        "purchase_total",
        "stock_value",
        "supplier_due",
        "waste_cost",
      ].sort(),
    );
  });
});

describe("stock_value and critical_stock_count (point in time)", () => {
  const reader = () => dailyReaderOf("stock_value");

  it("shares one reader for both codes", () => {
    expect(dailyReaderOf("critical_stock_count")).toBe(reader());
  });

  it("replays the stock ledger to the end of a past business day", async () => {
    const d1 = await compute(world, reader(), D1);
    expect(d1.stock_value).toBe(42_500);
    const d2 = await compute(world, reader(), D2);
    expect(d2.stock_value).toBe(56_500);
  });

  it("counts items below par at that day: item default, location override, inactive and no-par items left out", async () => {
    // D1: beras 10 < 12 and gula 5 < 10 are critical. minyak has no par,
    // tepung is inactive, susu has 3 against the loc1 override of 2.
    expect((await compute(world, reader(), D1)).critical_stock_count).toBe(2);
    // D2: beras recovered to 16, only gula is left.
    expect((await compute(world, reader(), D2)).critical_stock_count).toBe(1);
  });

  it("returns a zero total row for a day before any stock", async () => {
    const d0 = await compute(world, reader(), D0);
    expect(d0).toEqual({ stock_value: 0, critical_stock_count: 0 });
  });

  it("reads the live balances of the current business day and agrees with the stock levels helper", async () => {
    const w = world;
    const today = businessDateOf(new Date(), w.clock);
    // Outlet 2: beras 4 @ 1000 (par 12 -> critical), gula 20 @ 500 (ok),
    // beras in a second location 3 @ 1000 sums with the first (7 < 12).
    await balance(w, {
      outlet: w.outlet2,
      location: w.locO2,
      item: w.item.beras,
      quantity: 4,
      cost: 1000,
    });
    await balance(w, {
      outlet: w.outlet2,
      location: w.locO2,
      item: w.item.gula,
      quantity: 20,
      cost: 500,
    });
    const live = await compute(w, reader(), today, w.outlet2);
    expect(live.stock_value).toBe(4 * 1000 + 20 * 500);
    expect(live.critical_stock_count).toBe(1);

    const levels = await queryStockLevels(context(w.tenantId), {
      outletIds: [w.outlet2],
      onlyBelowPar: true,
      rowLimit: 100,
    });
    expect(levels.rows).toHaveLength(live.critical_stock_count!);
  });

  it("hides open blind-count pairs on the live day only, so a past day stays put", async () => {
    const w = world;
    const today = businessDateOf(new Date(), w.clock);
    const blindCount = async (
      outlet: string,
      location: string,
      item: string,
    ) => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO stock_counts (id, tenant_id, outlet_id, location_id, type, status, blind, business_date,
           counted_by, create_idempotency_key, create_fingerprint)
         VALUES ($1, $2, $3, $4, 'full', 'counting', true, $5, $6, $7, $7)`,
        [
          id,
          w.tenantId,
          outlet,
          location,
          today,
          userId,
          randomUUID().slice(0, 16),
        ],
      );
      await owner.query(
        `INSERT INTO stock_count_lines (tenant_id, outlet_id, stock_count_id, inventory_item_id, system_qty, unit_cost_idr)
         VALUES ($1, $2, $3, $4, 1, 1)`,
        [w.tenantId, outlet, id, item],
      );
    };
    const pastBefore = await compute(w, reader(), D1);
    // Outlet 1 counts gula blind: its past D1 figures must not move.
    await blindCount(w.outlet1, w.loc1, w.item.gula);
    expect(await compute(w, reader(), D1)).toEqual(pastBefore);
    expect(pastBefore.critical_stock_count).toBe(2);
    // Outlet 2 counts beras blind: on the live day its pair is hidden.
    await blindCount(w.outlet2, w.locO2, w.item.beras);
    const live = await compute(w, reader(), today, w.outlet2);
    expect(live.critical_stock_count).toBe(0);
    expect(live.stock_value).toBe(4 * 1000 + 20 * 500);
  });

  it("never mixes outlets or tenants", async () => {
    // Outlet 2 has 500 beras @9999 on D1 in the ledger; outlet 1 stays 42,500.
    expect((await compute(world, reader(), D1)).stock_value).toBe(42_500);
    expect(
      (await compute(world, reader(), D1, world.outlet2)).stock_value,
    ).toBe(500 * 9999);
    // Tenant B's own outlet sees only tenant B stock.
    expect(
      (await compute(other, reader(), D1, other.outlet1, other.tenantId))
        .stock_value,
    ).toBe(100 * 7777);
    // Tenant B asking for tenant A's outlet fails: RLS hides the outlet.
    await expect(
      compute(world, reader(), D1, world.outlet1, other.tenantId),
    ).rejects.toThrow("Outlet not found");
  });
});

describe("purchase_total", () => {
  const reader = () => dailyReaderOf("purchase_total");

  it("sums approved orders of the outlet by approval day, cancelled and draft left out, per supplier", async () => {
    const d1 = await compute(world, reader(), D1);
    expect(d1).toEqual({
      purchase_total: 150_000,
      [`purchase_total|supplier:${world.supplierA}`]: 100_000,
      [`purchase_total|supplier:${world.supplierB}`]: 50_000,
    });
    const d2 = await compute(world, reader(), D2);
    expect(d2).toEqual({
      purchase_total: 25_000,
      [`purchase_total|supplier:${world.supplierA}`]: 25_000,
    });
  });

  it("returns a zero total row for a day without orders", async () => {
    expect(await compute(world, reader(), D0)).toEqual({ purchase_total: 0 });
  });

  it("never mixes outlets or tenants", async () => {
    expect(
      (await compute(world, reader(), D1, world.outlet2)).purchase_total,
    ).toBe(999_000);
    expect(
      (await compute(other, reader(), D1, other.outlet1, other.tenantId))
        .purchase_total,
    ).toBe(888_000);
    await expect(
      compute(world, reader(), D1, world.outlet1, other.tenantId),
    ).rejects.toThrow("Outlet not found");
  });
});

describe("supplier_due (open payable balance, due on or before the day)", () => {
  const reader = () => dailyReaderOf("supplier_due");

  it("is nothing before an invoice falls due", async () => {
    expect(await compute(world, reader(), D1)).toEqual({ supplier_due: 0 });
  });

  it("counts the unpaid part of invoices due that day, per supplier", async () => {
    // D2: I1 owes 100000 - 30000 paid on D2 = 70000, I3 owes 40000 (paid D3).
    const d2 = await compute(world, reader(), D2);
    expect(d2).toEqual({
      supplier_due: 110_000,
      [`supplier_due|supplier:${world.supplierA}`]: 110_000,
    });
  });

  it("reads settlements as of the day, not as of now", async () => {
    // D3: I3 is paid off, I2 (supplier B) falls due.
    const d3 = await compute(world, reader(), D3);
    expect(d3).toEqual({
      supplier_due: 130_000,
      [`supplier_due|supplier:${world.supplierA}`]: 70_000,
      [`supplier_due|supplier:${world.supplierB}`]: 60_000,
    });
  });

  it("never mixes outlets or tenants, and skips entity-level invoices", async () => {
    // Entity-level (500000) and outlet 2 (700000) invoices never reach outlet 1.
    expect((await compute(world, reader(), D3)).supplier_due).toBe(130_000);
    expect(
      (await compute(world, reader(), D3, world.outlet2)).supplier_due,
    ).toBe(700_000);
    expect(
      (await compute(other, reader(), D3, other.outlet1, other.tenantId))
        .supplier_due,
    ).toBe(600_000);
    expect(
      await compute(world, reader(), D3, world.outlet1, other.tenantId),
    ).toEqual({ supplier_due: 0 });
  });
});

describe("waste_cost split rows (operational side of the ledger metric)", () => {
  it("serves both splits with one reader", () => {
    expect(wasteReaderOf("menu_item")).toBe(wasteReaderOf("menu_category"));
  });

  it("writes the operational total, one row per menu item and one per menu category", async () => {
    const rows = await compute(world, wasteReaderOf("menu_item"), D1);
    expect(rows).toEqual({
      waste_cost: 60_000,
      [`waste_cost|menu_item:${world.menu.m1}`]: 30_000,
      [`waste_cost|menu_item:${world.menu.m2}`]: 20_000,
      [`waste_cost|menu_category:${world.menu.cat}`]: 50_000,
    });
  });

  it("returns a zero total for a day without waste and never mixes tenants", async () => {
    expect(await compute(world, wasteReaderOf("menu_item"), D0)).toEqual({
      waste_cost: 0,
    });
    await expect(
      compute(
        world,
        wasteReaderOf("menu_item"),
        D1,
        world.outlet1,
        other.tenantId,
      ),
    ).rejects.toThrow("Outlet not found");
  });
});

describe("through the engine: backfill, ledger control and finality", () => {
  beforeAll(async () => {
    await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      date(D1),
      date(D3),
      { readers: ownReaders(), now: LATE },
    );
  });

  it("backfill is idempotent: a second run changes nothing", async () => {
    const before = await owner.query(
      `SELECT id, updated_at FROM metrics_daily WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY id`,
      [world.tenantId, world.outlet1],
    );
    expect(before.rowCount).toBeGreaterThan(0);
    const again = await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      date(D1),
      date(D3),
      { readers: ownReaders(), now: LATE },
    );
    expect(again.written).toBe(0);
    expect(again.deleted).toBe(0);
    expect(again.failedFamilies).toEqual([]);
    const after = await owner.query(
      `SELECT id, updated_at FROM metrics_daily WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY id`,
      [world.tenantId, world.outlet1],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("answers stock value, purchases and supplier due per bucket", async () => {
    const result = await evaluate(world, {
      metricCodes: ["stock_value", "critical_stock_count", "purchase_total"],
      period: { start: D1, end: D2 },
    });
    // latest in the bucket (D2) for stock; sum over the days for purchases.
    expect(pointNumber(seriesOf(result, "stock_value")[0])).toBe(56_500);
    expect(pointNumber(seriesOf(result, "critical_stock_count")[0])).toBe(1);
    expect(pointNumber(seriesOf(result, "purchase_total")[0])).toBe(175_000);
    for (const code of [
      "stock_value",
      "critical_stock_count",
      "purchase_total",
    ])
      expect(
        result.availability.find((entry) => entry.metricCode === code)?.status,
        code,
      ).toBe("available");
  });

  it("purchase_total split per supplier adds up to the total", async () => {
    const result = await evaluate(world, {
      metricCodes: ["purchase_total"],
      period: { start: D1, end: D2 },
      groupBy: ["supplier"],
    });
    const rows = Object.fromEntries(
      seriesOf(result, "purchase_total")
        .filter((series) => series.dimension)
        .map((series) => [series.dimension!.value, pointNumber(series)]),
    );
    expect(rows).toEqual({
      [world.supplierA]: 125_000,
      [world.supplierB]: 50_000,
    });
  });

  it("waste_cost per menu item plus the ledger adjustment equals the ledger total", async () => {
    const result = await evaluate(world, {
      metricCodes: ["waste_cost"],
      period: { start: D1, end: D1 },
      groupBy: ["menu_item"],
    });
    const rows = Object.fromEntries(
      seriesOf(result, "waste_cost")
        .filter((series) => series.dimension)
        .map((series) => [series.dimension!.value, pointNumber(series)]),
    );
    expect(rows).toEqual({
      [world.menu.m1]: 30_000,
      [world.menu.m2]: 20_000,
      [METRIC_LEDGER_ADJUSTMENT]: 15_000,
    });
    const ledger = await evaluate(world, {
      metricCodes: ["waste_cost"],
      period: { start: D1, end: D1 },
    });
    expect(pointNumber(seriesOf(ledger, "waste_cost")[0])).toBe(65_000);
    expect(Object.values(rows).reduce((sum, n) => sum! + n!, 0)).toBe(65_000);
  });

  it("waste_cost per menu category plus the ledger adjustment equals the ledger total", async () => {
    const result = await evaluate(world, {
      metricCodes: ["waste_cost"],
      period: { start: D1, end: D1 },
      groupBy: ["menu_category"],
    });
    const rows = Object.fromEntries(
      seriesOf(result, "waste_cost")
        .filter((series) => series.dimension)
        .map((series) => [series.dimension!.value, pointNumber(series)]),
    );
    expect(rows).toEqual({
      [world.menu.cat]: 50_000,
      [METRIC_LEDGER_ADJUSTMENT]: 15_000,
    });
  });

  it("waste_cost_pct is the ledger waste over ledger net sales", async () => {
    const result = await evaluate(world, {
      metricCodes: ["waste_cost_pct"],
      period: { start: D1, end: D1 },
    });
    expect(pointNumber(seriesOf(result, "waste_cost_pct")[0])).toBeCloseTo(
      6.5,
      4,
    );
  });

  it("a day nobody computed keeps the bucket an estimate; computed days are final", async () => {
    const computed = await evaluate(world, {
      metricCodes: ["purchase_total"],
      period: { start: D1, end: D3 },
    });
    expect(seriesOf(computed, "purchase_total")[0]!.points[0]!.finality).toBe(
      "final",
    );
    // D0 was never computed for this outlet (it is before the backfill range).
    const gap = await evaluate(world, {
      metricCodes: ["purchase_total"],
      period: { start: D0, end: D1 },
    });
    expect(seriesOf(gap, "purchase_total")[0]!.points[0]!.finality).toBe(
      "estimate",
    );
  });

  it("a day computed before it ended is an estimate", async () => {
    await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      date(D0),
      date(D0),
      { readers: ownReaders(), now: new Date(`${D0}T00:00:00Z`) },
    );
    const { rows } = await owner.query<{ finality: string }>(
      `SELECT DISTINCT finality FROM metrics_daily WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3`,
      [world.tenantId, world.outlet1, D0],
    );
    expect(rows).toEqual([{ finality: "estimate" }]);
  });

  it("an outlet-scoped caller reads only its own outlet", async () => {
    const result = await evaluate(
      world,
      { metricCodes: ["purchase_total"], period: { start: D1, end: D1 } },
      [world.outlet2],
    );
    // Outlet 2 was never computed through the job here: no row, never outlet 1's.
    expect(pointNumber(seriesOf(result, "purchase_total")[0])).not.toBe(
      150_000,
    );
  });
});
