// Sales metric source (WS-11 F1, bead legend-ne81z; brief 268c). Real
// PostgreSQL: orders are seeded per tenant, the sales readers run through
// `recomputeMetricsDaily`, and the engine reads the stored rows back. Covers:
// figures from the test data, tenant and outlet isolation, split rows plus the
// ledger residual add up to the GL total, a day without stored rows is not
// final, an idempotent backfill, and the 12 ledger codes staying `gl`.
// The sales_target cases need table `sales_targets` (migration 0181, same card).

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  outletIdSchema,
  outletIdsForQuery,
  tenantIdSchema,
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
import {
  dailyReaders,
  metricSourceOf,
  metricSplitOf,
} from "../services/metric-sources";
import { salesRows } from "../services/metric-sources/sales";
import { recomputeMetricsDaily } from "../services/metrics-daily.service";
import { GL_METRIC_SOURCES } from "../services/metrics-gl-sources";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
} from "../services/metrics-query.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type World = {
  tenantId: string;
  entityId: string;
  outlet1: string;
  outlet2: string;
  cash: string;
  revenue: string;
  menuA: string;
  menuB: string;
  category: string;
};

const D1 = "2025-05-10";
const D2 = "2025-05-11"; // never computed: no stored rows
const NOW = new Date("2025-09-15T05:00:00Z");
const date = (value: string) => businessDateSchema.parse(value);
const salesReaders = () =>
  dailyReaders().filter((entry) => entry.family === "sales");

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

async function postSale(w: World, day: string, outlet: string, amount: number) {
  const ctx = context(w.tenantId);
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: w.entityId,
      outletId: outletIdSchema.parse(outlet),
      entryDate: date(day),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji sumber penjualan",
      lines: [
        line(w.cash, amount, 0, outlet),
        line(w.revenue, 0, amount, outlet),
      ],
      postedBy: null,
      idempotencyKey: `ms-sales-${randomUUID()}`,
    }),
  );
}

async function makeWorld(): Promise<World> {
  const tenant = await createIsolatedTenant(`mss-${randomUUID().slice(0, 6)}`);
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const cash = randomUUID();
  const revenue = randomUUID();
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [cash, revenue, tenant.tenantId, tenant.legalEntityId],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'sales_revenue', $3) ON CONFLICT DO NOTHING`,
    [tenant.tenantId, tenant.legalEntityId, revenue],
  );
  const category = randomUUID();
  const menuA = randomUUID();
  const menuB = randomUUID();
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Minuman')`,
    [category, tenant.tenantId, tenant.brandId],
  );
  for (const [id, name] of [
    [menuA, "Kopi Susu"],
    [menuB, "Nasi Goreng"],
  ] as const)
    await owner.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, $5)`,
      [id, tenant.tenantId, tenant.brandId, category, name],
    );
  return {
    tenantId: tenant.tenantId,
    entityId: tenant.legalEntityId,
    outlet1: tenant.outletId,
    outlet2,
    cash,
    revenue,
    menuA,
    menuB,
    category,
  };
}

async function seedOrder(
  w: World,
  outlet: string,
  order: {
    number: string;
    channel: string;
    subtotal: number;
    discount?: number;
    status?: string;
    cashier?: string;
    items: { menu: string; quantity: number; unit: number }[];
    refund?: number;
    /** Method of the refund tender line; `null` stores a line without one. */
    refundMethod?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const discount = order.discount ?? 0;
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
       subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
       status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, $5, 'dine_in', 'pay_first', $6, $7, 0, 0, 0, $8, $9, $10, $11)`,
    [
      id,
      w.tenantId,
      outlet,
      order.number,
      order.channel,
      order.subtotal,
      discount,
      order.subtotal - discount,
      order.status ?? "completed",
      D1,
      `${D1}T05:00:00.000Z`, // 12:00 Asia/Jakarta
    ],
  );
  for (const item of order.items)
    await owner.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
         unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, 'Menu', $6, $7, 0, $8, 'fired', 'served', $9)`,
      [
        randomUUID(),
        w.tenantId,
        outlet,
        id,
        item.menu,
        item.quantity,
        item.unit,
        item.quantity * item.unit,
        D1,
      ],
    );
  if (order.cashier)
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, cashier_id) VALUES ($1, $2, $3, 'pos', $4)`,
      [id, w.tenantId, outlet, order.cashier],
    );
  if (order.refund)
    await owner.query(
      `INSERT INTO pos_order_refunds (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note,
         lines, requested_by, approved_by, approval_request_id, refunded_at)
       VALUES ($1, $2, $3, $4, 'other', 'uji', $5::jsonb, 'cashier-1', 'supervisor-1', $6, $7)`,
      [
        w.tenantId,
        outlet,
        id,
        order.refund,
        JSON.stringify([
          {
            method:
              order.refundMethod === undefined ? "cash" : order.refundMethod,
            amountIdr: order.refund,
            reference: null,
          },
        ]),
        randomUUID(),
        `${D1}T06:00:00.000Z`,
      ],
    );
  return id;
}

/** A captured tender line of a POS order (the order needs a `pos_orders` row). */
async function seedTender(
  w: World,
  outlet: string,
  orderId: string,
  method: string,
  amount: number,
) {
  await owner.query(
    `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
       amount_idr, received_idr, change_idr, status, requested_at, resolved_at)
     VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7, 'captured', now(), now())`,
    [
      w.tenantId,
      outlet,
      orderId,
      method,
      amount,
      method === "cash" ? amount : null,
      method === "cash" ? 0 : null,
    ],
  );
}

let world: World;
let other: World;

beforeAll(async () => {
  world = await makeWorld();
  other = await makeWorld();
  // Outlet 1, D1: A (pos, 100k - 10k discount, 5k refund = 85k net), B (gofood 50k),
  // C is not paid and must not count.
  await seedOrder(world, world.outlet1, {
    number: "A1",
    channel: "pos",
    subtotal: 100_000,
    discount: 10_000,
    cashier: "cashier-1",
    refund: 5_000,
    items: [
      { menu: world.menuA, quantity: 2, unit: 32_000 },
      { menu: world.menuB, quantity: 1, unit: 36_000 },
    ],
  });
  await seedOrder(world, world.outlet1, {
    number: "A2",
    channel: "gofood",
    subtotal: 50_000,
    items: [{ menu: world.menuB, quantity: 1, unit: 50_000 }],
  });
  await seedOrder(world, world.outlet1, {
    number: "A3",
    channel: "pos",
    subtotal: 999_000,
    status: "awaiting_payment",
    items: [{ menu: world.menuA, quantity: 1, unit: 999_000 }],
  });
  // Outlet 2 and another tenant hold orders that must never leak.
  await seedOrder(world, world.outlet2, {
    number: "B1",
    channel: "pos",
    subtotal: 200_000,
    items: [{ menu: world.menuA, quantity: 4, unit: 50_000 }],
  });
  await seedOrder(other, other.outlet1, {
    number: "X1",
    channel: "pos",
    subtotal: 777_000,
    items: [{ menu: other.menuA, quantity: 1, unit: 777_000 }],
  });
  // Ledger: 140,000 at outlet 1 (the operational net is 135,000).
  await postSale(world, D1, world.outlet1, 140_000);
  await recomputeMetricsDaily(
    context(world.tenantId),
    world.outlet1,
    date(D1),
    date(D1),
    {
      readers: salesReaders(),
      now: NOW,
    },
  );
  await recomputeMetricsDaily(
    context(world.tenantId),
    world.outlet2,
    date(D1),
    date(D1),
    {
      readers: salesReaders(),
      now: NOW,
    },
  );
});

type Row = {
  metric_code: string;
  dimension_key: string | null;
  dimension_value: string | null;
  value_int: string | null;
};

async function stored(w: World, outlet: string): Promise<Row[]> {
  const { rows } = await owner.query<Row>(
    `SELECT metric_code, dimension_key, dimension_value, value_int FROM metrics_daily
      WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3`,
    [w.tenantId, outlet, D1],
  );
  return rows;
}

const valueOf = (
  rows: Row[],
  code: string,
  key: string | null = null,
  value: string | null = null,
) =>
  Number(
    rows.find(
      (row) =>
        row.metric_code === code &&
        row.dimension_key === key &&
        row.dimension_value === value,
    )?.value_int ?? NaN,
  );

describe("sales metric source: stored figures", () => {
  it("writes totals and splits from the paid orders of the outlet-day", async () => {
    const rows = await stored(world, world.outlet1);
    expect(valueOf(rows, "gross_sales")).toBe(150_000);
    expect(valueOf(rows, "refund_amount")).toBe(5_000);
    expect(valueOf(rows, "refund_amount", "payment_method", "cash")).toBe(
      5_000,
    );
    expect(valueOf(rows, "void_amount")).toBe(0);
    expect(valueOf(rows, "transaction_count")).toBe(2);
    expect(valueOf(rows, "transaction_count", "channel", "gofood")).toBe(1);
    expect(valueOf(rows, "transaction_count", "hour", "12")).toBe(2);
    expect(valueOf(rows, "menu_sold_qty")).toBe(4);
    expect(valueOf(rows, "menu_sold_qty", "menu_item", world.menuA)).toBe(2);
    expect(
      valueOf(rows, "menu_sold_qty", "menu_category", world.category),
    ).toBe(4);
    expect(valueOf(rows, "net_sales")).toBe(135_000);
    expect(valueOf(rows, "net_sales", "channel", "pos")).toBe(85_000);
    expect(valueOf(rows, "net_sales", "channel", "gofood")).toBe(50_000);
    expect(valueOf(rows, "net_sales", "employee", "cashier-1")).toBe(85_000);
    expect(valueOf(rows, "net_sales", "day_of_week", "6")).toBe(135_000); // Saturday
    expect(valueOf(rows, "discount_amount")).toBe(10_000);
    expect(valueOf(rows, "discount_amount", "channel", "pos")).toBe(10_000);
    expect(valueOf(rows, "sales_target")).toBe(0);
  });

  it("never reads another outlet or tenant", async () => {
    const rows = await stored(world, world.outlet2);
    expect(valueOf(rows, "gross_sales")).toBe(200_000);
    expect(valueOf(rows, "transaction_count")).toBe(1);
    const foreign = await stored(other, other.outlet1);
    expect(foreign.length).toBe(0);
    const leaked = await owner.query(
      `SELECT 1 FROM metrics_daily WHERE tenant_id = $1 AND outlet_id = ANY($2)`,
      [other.tenantId, [world.outlet1, world.outlet2]],
    );
    expect(leaked.rowCount).toBe(0);
  });

  it("totals of the pure rows equal the sum of one split's rows", () => {
    const facts = {
      orders: [
        {
          id: "1",
          channel: "pos",
          subtotal: 100,
          discount: 0,
          refund: 0,
          net: 100,
          hour: "10",
          employee: null,
          method: null,
          tenders: [],
          intentMethod: null,
        },
        {
          id: "2",
          channel: "qr",
          subtotal: 50,
          discount: 10,
          refund: 0,
          net: 40,
          hour: "11",
          employee: "e",
          method: null,
          tenders: [],
          intentMethod: null,
        },
      ],
      lines: [],
      promos: [],
      voids: [],
      refundLines: [],
      target: 0,
    };
    const rows = salesRows("net_sales", facts, D1);
    const byChannel = rows.filter((row) => row.dimension?.key === "channel");
    const total = rows.find((row) => row.dimension === null)!;
    expect(byChannel.length).toBe(2);
    expect(total.value).toEqual({ unit: "idr", valueIdr: 140 });
  });
});

describe("sales metric source: engine", () => {
  function evaluate(request: {
    codes: string[];
    start: string;
    end: string;
    groupBy?: string[];
    outletIds?: string[];
  }): Promise<EvaluatedMetrics> {
    const ctx = context(world.tenantId, request.outletIds);
    return withTenantSnapshot(ctx, (tx) =>
      evaluateMetrics(
        tx,
        ctx,
        {
          metricCodes: request.codes,
          period: { start: date(request.start), end: date(request.end) },
          bucket: "total",
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
  const cell = (series: EvaluatedMetrics["series"][number]) => {
    const value = series.points[0]!.value as { valueIdr: number } | null;
    return value === null ? null : value.valueIdr;
  };

  it("channel rows plus the ledger residual add up to the GL total", async () => {
    const result = await evaluate({
      codes: ["net_sales"],
      start: D1,
      end: D1,
      groupBy: ["channel"],
      outletIds: [world.outlet1],
    });
    const rows = result.series.filter((series) => series.dimensions.length > 0);
    const byValue = new Map(
      rows.map((series) => [series.dimensions[0]!.value, cell(series)]),
    );
    expect(byValue.get("pos")).toBe(85_000);
    expect(byValue.get("gofood")).toBe(50_000);
    expect(byValue.get(METRIC_LEDGER_ADJUSTMENT)).toBe(5_000);
    const total = [...byValue.values()].reduce((a, b) => a! + b!, 0);
    expect(total).toBe(140_000);
  });

  it("a day without stored rows is not final", async () => {
    const result = await evaluate({
      codes: ["net_sales"],
      start: D1,
      end: D2,
      groupBy: ["channel"],
      outletIds: [world.outlet1],
    });
    const rows = result.series.filter((series) => series.dimensions.length > 0);
    expect(rows.length).toBeGreaterThan(0);
    for (const series of rows)
      expect(series.points[0]!.finality).toBe("estimate");
  });

  it("an outlet-scoped context sees only its outlet", async () => {
    const result = await evaluate({
      codes: ["transaction_count"],
      start: D1,
      end: D1,
      outletIds: [world.outlet2],
    });
    const total = result.series.find(
      (series) => series.dimensions.length === 0,
    )!;
    const value = total.points[0]!.value as { value: number } | null;
    expect(value?.value).toBe(1);
  });
});

describe("sales metric source: backfill and registry", () => {
  it("recompute is idempotent: same rows, nothing rewritten", async () => {
    const before = await stored(world, world.outlet1);
    const again = await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      date(D1),
      date(D1),
      { readers: salesReaders(), now: NOW },
    );
    expect(again.written).toBe(0);
    expect(again.deleted).toBe(0);
    expect(again.failedFamilies).toEqual([]);
    expect((await stored(world, world.outlet1)).length).toBe(before.length);
  });

  it("claims its codes and keeps the 12 ledger codes on gl", () => {
    for (const code of [
      "gross_sales",
      "refund_amount",
      "void_amount",
      "transaction_count",
      "menu_sold_qty",
      "sales_target",
    ])
      expect(metricSourceOf(code).kind, code).toBe("daily");
    for (const code of [
      "avg_ticket",
      "discount_rate_pct",
      "refund_rate_pct",
      "void_rate_pct",
      "target_achievement_pct",
    ])
      expect(metricSourceOf(code).kind, code).toBe("derived");
    expect(Object.keys(GL_METRIC_SOURCES)).toHaveLength(12);
    for (const code of Object.keys(GL_METRIC_SOURCES))
      expect(metricSourceOf(code).kind, code).toBe("gl");
    for (const dimension of [
      "channel",
      "hour",
      "employee",
      "day_of_week",
      "menu_item",
      "menu_category",
      "payment_method",
    ] as const)
      expect(metricSplitOf("net_sales", dimension), dimension).not.toBeNull();
    expect(metricSplitOf("discount_amount", "promo")).not.toBeNull();
  });
});

describe("sales metric source: net_sales by payment method and category", () => {
  const order = (
    id: string,
    net: number,
    tenders: { method: string; amount: number }[],
    intentMethod: string | null = null,
  ) => ({
    id,
    channel: "pos",
    subtotal: net,
    discount: 0,
    refund: 0,
    net,
    hour: "10",
    employee: null,
    method: null,
    tenders,
    intentMethod,
  });
  const amountOf = (
    rows: ReturnType<typeof salesRows>,
    key: string,
    value: string,
  ) =>
    (
      rows.find(
        (row) => row.dimension?.key === key && row.dimension.value === value,
      )?.value as { valueIdr: number } | undefined
    )?.valueIdr;

  it("pure: spreads an order net over its tenders, residual-free", () => {
    const facts = {
      orders: [
        order("1", 100_000, [
          { method: "cash", amount: 30_000 },
          { method: "qris", amount: 70_000 },
        ]),
        order("2", 10_001, [
          { method: "cash", amount: 1 },
          { method: "qris", amount: 1 },
        ]),
        order("3", 20_000, [], "edc"),
        order("4", 5_000, []),
      ],
      lines: [],
      promos: [],
      voids: [],
      refundLines: [],
      target: 0,
    };
    const rows = salesRows("net_sales", facts, D1);
    expect(amountOf(rows, "payment_method", "cash")).toBe(30_000 + 5_001);
    expect(amountOf(rows, "payment_method", "qris")).toBe(70_000 + 5_000);
    expect(amountOf(rows, "payment_method", "edc")).toBe(20_000);
    expect(amountOf(rows, "payment_method", "unassigned")).toBe(5_000);
    const split = rows
      .filter((row) => row.dimension?.key === "payment_method")
      .reduce((a, row) => a + (row.value as { valueIdr: number }).valueIdr, 0);
    expect(split).toBe(135_001);
  });

  it("pure: category parts of an order add up to its net exactly", () => {
    const facts = {
      orders: [order("1", 100, [{ method: "cash", amount: 100 }])],
      lines: [
        {
          orderId: "1",
          menuItemId: "a",
          categoryId: "c1",
          quantity: 1,
          lineTotal: 1,
        },
        {
          orderId: "1",
          menuItemId: "b",
          categoryId: "c2",
          quantity: 1,
          lineTotal: 1,
        },
        {
          orderId: "1",
          menuItemId: "c",
          categoryId: "c3",
          quantity: 1,
          lineTotal: 1,
        },
      ],
      promos: [],
      voids: [],
      refundLines: [],
      target: 0,
    };
    const rows = salesRows("net_sales", facts, D1);
    const parts = rows
      .filter((row) => row.dimension?.key === "menu_category")
      .reduce((a, row) => a + (row.value as { valueIdr: number }).valueIdr, 0);
    expect(parts).toBe(100);
  });

  it("stored: payment_method rows add up to the net_sales total", async () => {
    const w = await makeWorld();
    const t1 = await seedOrder(w, w.outlet1, {
      number: "T1",
      channel: "pos",
      subtotal: 100_000,
      cashier: "cashier-t",
      items: [{ menu: w.menuA, quantity: 1, unit: 100_000 }],
    });
    await seedTender(w, w.outlet1, t1, "cash", 30_000);
    await seedTender(w, w.outlet1, t1, "qris", 70_000);
    await seedOrder(w, w.outlet1, {
      number: "T2",
      channel: "gofood",
      subtotal: 20_000,
      items: [{ menu: w.menuB, quantity: 1, unit: 20_000 }],
    });
    await recomputeMetricsDaily(
      context(w.tenantId),
      w.outlet1,
      date(D1),
      date(D1),
      { readers: salesReaders(), now: NOW },
    );
    const rows = await stored(w, w.outlet1);
    expect(valueOf(rows, "net_sales")).toBe(120_000);
    expect(valueOf(rows, "net_sales", "payment_method", "cash")).toBe(30_000);
    expect(valueOf(rows, "net_sales", "payment_method", "qris")).toBe(70_000);
    expect(valueOf(rows, "net_sales", "payment_method", "unassigned")).toBe(
      20_000,
    );
    expect(valueOf(rows, "net_sales", "menu_category", w.category)).toBe(
      120_000,
    );
  });
});

describe("sales metric source: null dimension keys", () => {
  it('a refund line without a method makes no "null" payment_method row', async () => {
    const lone = await makeWorld();
    await seedOrder(lone, lone.outlet1, {
      number: "N1",
      channel: "pos",
      subtotal: 40_000,
      cashier: "cashier-n",
      refund: 4_000,
      refundMethod: null,
      items: [{ menu: lone.menuA, quantity: 1, unit: 40_000 }],
    });
    await recomputeMetricsDaily(
      context(lone.tenantId),
      lone.outlet1,
      date(D1),
      date(D1),
      { readers: salesReaders(), now: NOW },
    );
    const rows = await stored(lone, lone.outlet1);
    expect(valueOf(rows, "refund_amount")).toBe(4_000);
    expect(rows.filter((row) => row.dimension_value === "null")).toEqual([]);
  });
});

describe("sales metric source: target (needs migration 0181)", () => {
  it("sales_target reads the day target of the outlet", async () => {
    await owner.query(
      `INSERT INTO sales_targets (tenant_id, outlet_id, target_date, target_idr, created_by)
       VALUES ($1, $2, $3, 500000, $4)`,
      [world.tenantId, world.outlet1, D1, randomUUID()],
    );
    await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      date(D1),
      date(D1),
      { readers: salesReaders(), now: NOW },
    );
    expect(valueOf(await stored(world, world.outlet1), "sales_target")).toBe(
      500_000,
    );
    expect(valueOf(await stored(world, world.outlet2), "sales_target")).toBe(0);
  });
});
