// Menu and COGS metric sources (WS-11 family F3, bead legend-e58wz; DECISIONS
// 2026-11-10 points 1, 4 and 5). Real registry, real reader, real orders and
// journal lines: the figures below are worked out by hand from the seed.
//
// Seed (business date 2025-06-10, outlet 1): Kopi 2 + 1 portions with line
// costs 12.000 + 6.000; Nasi 1 portion, cost 12.000; Teh 1 portion without a
// cost snapshot. Ignored: a voided line (cost 99.999), a voided order, a
// training order. Outlet 2: Kopi 4 portions, cost 24.000. Another tenant sells
// a Kopi of its own with huge numbers. Ledger cogs: outlet 1 = 31.000 (1.000
// more than the order rows), outlet 2 = 24.000.
//
// Honest note: production code writes no `order_items.cost_snapshot_idr` yet,
// so there the split is 100% residual. These tests seed the column by hand to
// pin the reader, and one test pins the production state (no snapshot: only
// the residual row, equal to the whole ledger total).
// `menu_sold_qty` is sales family (F1); `menu_gross_margin` is unavailable.
// `menu_popularity_pct` is a "share" source over `menu_sold_qty` (portions of
// a menu / portions of all menus in the period), read through the sales reader.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  METRIC_SOURCE_MODULES,
  dailyReaders,
  metricSourceOf,
  metricSplitOf,
} from "../services/metric-sources";
import { menuCogsReader } from "../services/metric-sources/menu-cogs";
import {
  recomputeMetricsDaily,
  refreshMetricsDaily,
} from "../services/metrics-daily.service";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
} from "../services/metrics-query.service";
import { agent, signUp } from "./helpers";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type World = {
  tenantId: string;
  brandId: string;
  entityId: string;
  outlet1: string;
  outlet2: string;
  cogsAccount: string;
  stockAccount: string;
  kopi: string;
  nasi: string;
  teh: string;
  minuman: string;
  makanan: string;
};

const NOW = new Date("2025-09-15T05:00:00Z");
const D10 = "2025-06-10";
const D11 = "2025-06-11";
const D12 = "2025-06-12";
const D13 = "2025-06-13";
const soldSource = metricSourceOf("menu_sold_qty");
if (soldSource.kind !== "daily") throw new Error("menu_sold_qty is not daily");
const READERS = [
  { family: "menu-cogs", reader: menuCogsReader },
  { family: "sales", reader: soldSource.reader },
];
let world: World;
let foreign: World;
let closerUserId: string;
let orderNo = 0;

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

async function asOwner<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Line = {
  menuItemId: string;
  quantity: number;
  unitPrice: number;
  cost: number | null;
  status?: string;
};

async function seedOrder(
  client: PoolClient,
  w: World,
  outletId: string,
  date: string,
  lines: Line[],
  opts: { status?: string; training?: boolean } = {},
) {
  const id = randomUUID();
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  orderNo += 1;
  await client.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
       subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
       status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5, $6, $7, $8)`,
    [
      id,
      w.tenantId,
      outletId,
      `MC${orderNo}`,
      subtotal,
      opts.status ?? "completed",
      date,
      `${date}T05:00:00.000Z`,
    ],
  );
  if (opts.training)
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
       VALUES ($1, $2, $3, 'pos', true)`,
      [id, w.tenantId, outletId],
    );
  for (const line of lines)
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
         unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status,
         reserved_business_date, cost_snapshot_idr)
       VALUES ($1, $2, $3, $4, $5, 'Menu', $6, $7, 0, $8, 'fired', $9, $10, $11)`,
      [
        randomUUID(),
        w.tenantId,
        outletId,
        id,
        line.menuItemId,
        line.quantity,
        line.unitPrice,
        line.unitPrice * line.quantity,
        line.status ?? "served",
        date,
        line.cost,
      ],
    );
}

function journalLine(
  accountId: string,
  debit: number,
  credit: number,
  outletId: string,
): JournalLineInput {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: outletIdSchema.parse(outletId),
    costCenter: null,
  };
}

async function postCogs(
  w: World,
  date: string,
  outlet: string,
  amount: number,
) {
  const ctx = context(w.tenantId);
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: w.entityId,
      outletId: outletIdSchema.parse(outlet),
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji HPP per menu",
      lines: [
        journalLine(w.cogsAccount, amount, 0, outlet),
        journalLine(w.stockAccount, 0, amount, outlet),
      ],
      postedBy: null,
      idempotencyKey: `ms-menu-cogs-${randomUUID()}`,
    }),
  );
}

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `mcg-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const cogsAccount = randomUUID();
  const stockAccount = randomUUID();
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '5101', 'HPP', 'expense', 'cogs'),
            ($2, $3, $4, '1301', 'Persediaan', 'asset', 'current_asset')`,
    [cogsAccount, stockAccount, tenant.tenantId, tenant.legalEntityId],
  );
  const [minuman, makanan, kopi, nasi, teh] = Array.from(
    { length: 5 },
    randomUUID,
  ) as [string, string, string, string, string];
  await asOwner(tenant.tenantId, async (client) => {
    for (const [id, name] of [
      [minuman, "Minuman"],
      [makanan, "Makanan"],
    ] as const)
      await client.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, $4)`,
        [id, tenant.tenantId, tenant.brandId, name],
      );
    for (const [id, category, name] of [
      [kopi, minuman, "Kopi"],
      [nasi, makanan, "Nasi"],
      [teh, makanan, "Teh"],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, $5)`,
        [id, tenant.tenantId, tenant.brandId, category, name],
      );
  });
  return {
    tenantId: tenant.tenantId,
    brandId: tenant.brandId,
    entityId: tenant.legalEntityId,
    outlet1: tenant.outletId,
    outlet2,
    cogsAccount,
    stockAccount,
    kopi,
    nasi,
    teh,
    minuman,
    makanan,
  };
}

async function markClosed(w: World, outletId: string, date: string) {
  await asOwner(w.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_daily_closes
         (tenant_id, outlet_id, business_date, order_count, total_sales_idr,
          total_refunds_idr, total_voids_idr, total_variance_idr,
          inventory_deduction_applied, recap, closed_by, closed_at,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, 0, 0, 0, 0, 0, false, '{}', $4, now(), $5, $6)`,
      [w.tenantId, outletId, date, closerUserId, randomUUID(), "0".repeat(64)],
    ),
  );
}

function refresh(w: World, outletId: string, date: string) {
  return refreshMetricsDaily(
    context(w.tenantId),
    { outletId, businessDate: businessDateSchema.parse(date) },
    NOW,
    { readers: READERS },
  );
}

function evaluate(
  w: World,
  request: {
    metricCodes: string[];
    period?: { start: string; end: string };
    bucket?: "total" | "day";
    groupBy?: string[];
    outletIds?: string[];
  },
): Promise<EvaluatedMetrics> {
  const ctx = context(w.tenantId, request.outletIds);
  const period = request.period ?? { start: D10, end: D10 };
  return withTenantSnapshot(ctx, (tx) =>
    evaluateMetrics(
      tx,
      ctx,
      {
        metricCodes: request.metricCodes,
        period: {
          start: businessDateSchema.parse(period.start),
          end: businessDateSchema.parse(period.end),
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

function num(point: { value: unknown }): number | null {
  const value = point.value as
    | { unit: "idr"; valueIdr: number }
    | { unit: string; value: number | string }
    | null;
  if (value === null) return null;
  return "valueIdr" in value ? value.valueIdr : Number(value.value);
}

/** dimension value -> number for one metric split by one dimension. */
function splitOf(result: EvaluatedMetrics, code: string, key: string) {
  const out = new Map<string, number | null>();
  for (const series of result.series) {
    if (series.metricCode !== code) continue;
    const dim = series.dimensions.find((d) => d.key === key);
    if (dim) out.set(dim.value, num(series.points[0]!));
  }
  return out;
}

function totalOf(result: EvaluatedMetrics, code: string) {
  const series = result.series.find(
    (s) => s.metricCode === code && s.dimensions.length === 0,
  );
  expect(series, code).toBeDefined();
  return series!.points[0]!;
}

beforeAll(async () => {
  world = await makeWorld("a");
  foreign = await makeWorld("b");
  const email = await signUp(agent(), "Penutup Menu");
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id FROM "user" WHERE email = $1',
    [email],
  );
  closerUserId = rows[0]!.id;

  await asOwner(world.tenantId, async (client) => {
    const { kopi, nasi, teh } = world;
    await seedOrder(client, world, world.outlet1, D10, [
      { menuItemId: kopi, quantity: 2, unitPrice: 20_000, cost: 12_000 },
      { menuItemId: nasi, quantity: 1, unitPrice: 30_000, cost: 12_000 },
    ]);
    await seedOrder(client, world, world.outlet1, D10, [
      { menuItemId: kopi, quantity: 1, unitPrice: 20_000, cost: 6_000 },
      // voided line: ignored
      {
        menuItemId: kopi,
        quantity: 5,
        unitPrice: 20_000,
        cost: 99_999,
        status: "voided",
      },
    ]);
    await seedOrder(client, world, world.outlet1, D10, [
      { menuItemId: teh, quantity: 1, unitPrice: 10_000, cost: null },
    ]);
    await seedOrder(
      client,
      world,
      world.outlet1,
      D10,
      [{ menuItemId: kopi, quantity: 9, unitPrice: 20_000, cost: 54_000 }],
      { status: "voided" },
    );
    await seedOrder(
      client,
      world,
      world.outlet1,
      D10,
      [{ menuItemId: kopi, quantity: 7, unitPrice: 20_000, cost: 42_000 }],
      { training: true },
    );
    await seedOrder(client, world, world.outlet2, D10, [
      { menuItemId: world.kopi, quantity: 4, unitPrice: 20_000, cost: 24_000 },
    ]);
  });
  await asOwner(foreign.tenantId, (client) =>
    seedOrder(client, foreign, foreign.outlet1, D10, [
      {
        menuItemId: foreign.kopi,
        quantity: 50,
        unitPrice: 20_000,
        cost: 500_000,
      },
    ]),
  );
  await postCogs(world, D10, world.outlet1, 31_000);
  await postCogs(world, D10, world.outlet2, 24_000);
  await postCogs(foreign, D10, foreign.outlet1, 500_000);

  await markClosed(world, world.outlet1, D10);
  for (const outlet of [world.outlet1, world.outlet2])
    await refresh(world, outlet, D10);
  await refresh(foreign, foreign.outlet1, D10);
});

afterAll(async () => {
  await owner.end();
});

describe("menu-cogs registry", () => {
  it("claims the cogs by menu_item split and no code another family owns", () => {
    expect(metricSplitOf("cogs", "menu_item")?.reader).toBe(menuCogsReader);
    expect(metricSplitOf("cogs", "menu_category")).toBeNull();
    expect(menuCogsReader.metricCodes).toEqual(["cogs"]);
    for (const code of ["menu_gross_margin", "sold_out_menu_count"])
      expect(metricSourceOf(code)).toMatchObject({ kind: "unavailable" });
    expect(metricSourceOf("menu_popularity_pct")).toEqual({
      kind: "share",
      code: "menu_popularity_pct",
      of: "menu_sold_qty",
      dimension: "menu_item",
    });
    const claimed = METRIC_SOURCE_MODULES.find(
      (module) => module.family === "menu-cogs",
    )!.sources.map((source) => source.code);
    expect(claimed).not.toContain("menu_sold_qty");
    expect(
      dailyReaders().filter((entry) => entry.family === "menu-cogs"),
    ).toHaveLength(1);
  });
});

describe("menu-cogs figures", () => {
  it("cogs per menu: order rows plus the ledger residual add up to the GL total", async () => {
    const result = await evaluate(world, {
      metricCodes: ["cogs"],
      groupBy: ["menu_item"],
    });
    const rows = splitOf(result, "cogs", "menu_item");
    expect(rows.get(world.kopi)).toBe(12_000 + 6_000 + 24_000);
    expect(rows.get(world.nasi)).toBe(12_000);
    expect(rows.has(world.teh)).toBe(false); // no cost snapshot: no row
    // GL 31.000 + 24.000 = 55.000; rows 54.000; residual 1.000
    expect(rows.get(METRIC_LEDGER_ADJUSTMENT)).toBe(1_000);
    const sum = [...rows.values()].reduce<number>((s, v) => s + (v ?? 0), 0);
    const glTotal = totalOf(
      await evaluate(world, { metricCodes: ["cogs"] }),
      "cogs",
    );
    expect(sum).toBe(num(glTotal));
    expect(sum).toBe(55_000);
  });

  it("outlet filter: outlet 2 has no residual row and its own figures", async () => {
    const result = await evaluate(world, {
      metricCodes: ["cogs"],
      groupBy: ["menu_item"],
      outletIds: [world.outlet2],
    });
    const rows = splitOf(result, "cogs", "menu_item");
    expect([...rows.entries()]).toEqual([[world.kopi, 24_000]]);
  });

  it("production state: no cost snapshot gives only the residual row, the whole GL total", async () => {
    await asOwner(world.tenantId, (client) =>
      seedOrder(client, world, world.outlet1, D12, [
        { menuItemId: world.kopi, quantity: 2, unitPrice: 20_000, cost: null },
      ]),
    );
    await postCogs(world, D12, world.outlet1, 5_000);
    await refresh(world, world.outlet1, D12);
    const result = await evaluate(world, {
      metricCodes: ["cogs"],
      period: { start: D12, end: D12 },
      groupBy: ["menu_item"],
      outletIds: [world.outlet1],
    });
    expect([...splitOf(result, "cogs", "menu_item").entries()]).toEqual([
      [METRIC_LEDGER_ADJUSTMENT, 5_000],
    ]);
  });

  it("the 11 reports: cogs is built, the rest say they are unavailable", async () => {
    const status = async (code: string, groupBy: string[]) =>
      (await evaluate(world, { metricCodes: [code], groupBy }))
        .availability[0]!;
    // cogs.per_menu, cogs.recipe, menu.recipe_cost: cogs by menu item
    expect((await status("cogs", ["menu_item"])).status).toBe("available");
    // cogs.trend and cogs.production by outlet (ledger, no split needed)
    for (const code of ["cogs", "food_cost_pct"])
      expect((await status(code, ["outlet"])).status, code).toBe("available");
    // menu.engineering: popularity is the share of menu_sold_qty by menu item
    expect((await status("menu_popularity_pct", ["menu_item"])).status).toBe(
      "available",
    );
    // no data source, or no engine support yet
    for (const code of ["menu_gross_margin", "sold_out_menu_count"])
      expect((await status(code, ["menu_item"])).status, code).toBe(
        "unavailable",
      );
    expect((await status("food_cost_pct", ["menu_item"])).status).toBe(
      "unavailable",
    );
  });
});

describe("menu_popularity_pct: share of the period total", () => {
  const D20 = "2025-06-20";
  const D21 = "2025-06-21";
  const popularity = async (
    request: Parameters<typeof evaluate>[1],
  ): Promise<Map<string, number | null>> =>
    splitOf(
      await evaluate(world, {
        ...request,
        metricCodes: ["menu_popularity_pct"],
      }),
      "menu_popularity_pct",
      "menu_item",
    );

  it("one day: portions of a menu over portions of all menus", async () => {
    // The sales reader of menu_sold_qty counts every completed order, the
    // training one too: outlet 1 Kopi 2 + 1 + 7, Nasi 1, Teh 1; outlet 2
    // Kopi 4 -> Kopi 14, Nasi 1, Teh 1 of 16.
    const shares = await popularity({ groupBy: ["menu_item"] });
    expect(shares.get(world.kopi)).toBe(87.5);
    expect(shares.get(world.nasi)).toBe(6.25);
    expect(shares.get(world.teh)).toBe(6.25);
  });

  it("several days: share of the summed portions, not the mean of daily percents", async () => {
    await asOwner(world.tenantId, async (client) => {
      await seedOrder(client, world, world.outlet1, D20, [
        { menuItemId: world.kopi, quantity: 1, unitPrice: 20_000, cost: null },
        { menuItemId: world.nasi, quantity: 3, unitPrice: 30_000, cost: null },
      ]);
      await seedOrder(client, world, world.outlet1, D21, [
        { menuItemId: world.kopi, quantity: 9, unitPrice: 20_000, cost: null },
      ]);
    });
    for (const date of [D20, D21]) await refresh(world, world.outlet1, date);
    // Kopi 10, Nasi 3 of 13 = 76.9231 / 23.0769 (daily percents would give
    // Kopi (25 + 100) / 2 = 62.5).
    const shares = await popularity({
      groupBy: ["menu_item"],
      period: { start: D20, end: D21 },
      outletIds: [world.outlet1],
    });
    expect(shares.get(world.kopi)).toBe(76.9231);
    expect(shares.get(world.nasi)).toBe(23.0769);
  });

  it("per outlet: each outlet is its own total", async () => {
    const result = await evaluate(world, {
      metricCodes: ["menu_popularity_pct"],
      groupBy: ["outlet", "menu_item"],
    });
    const share = (outlet: string, item: string) =>
      num(
        result.series.find(
          (series) =>
            series.dimensions.some(
              (d) => d.key === "outlet" && d.value === outlet,
            ) &&
            series.dimensions.some(
              (d) => d.key === "menu_item" && d.value === item,
            ),
        )!.points[0]!,
      );
    expect(share(world.outlet2, world.kopi)).toBe(100);
    expect(share(world.outlet1, world.kopi)).toBe(83.3333); // 10 of 12
  });

  it("without a menu_item split there is nothing to share: dimension_not_supported", async () => {
    const result = await evaluate(world, {
      metricCodes: ["menu_popularity_pct"],
    });
    expect(result.availability[0]).toMatchObject({
      status: "unavailable",
      reason: "dimension_not_supported",
    });
  });
});

describe("menu-cogs isolation", () => {
  it("another tenant's cogs never show up, and ours never show up there", async () => {
    const mine = splitOf(
      await evaluate(world, { metricCodes: ["cogs"], groupBy: ["menu_item"] }),
      "cogs",
      "menu_item",
    );
    expect(mine.has(foreign.kopi)).toBe(false);
    const theirs = splitOf(
      await evaluate(foreign, {
        metricCodes: ["cogs"],
        groupBy: ["menu_item"],
      }),
      "cogs",
      "menu_item",
    );
    expect([...theirs.entries()]).toEqual([[foreign.kopi, 500_000]]);
  });

  it("an outlet-scoped caller sees only its outlet", async () => {
    const rows = splitOf(
      await evaluate(world, {
        metricCodes: ["cogs"],
        groupBy: ["menu_item"],
        outletIds: [world.outlet1],
      }),
      "cogs",
      "menu_item",
    );
    expect(rows.get(world.kopi)).toBe(18_000);
  });

  it("a refresh with our context never writes rows for another tenant's outlet", async () => {
    await refresh(world, foreign.outlet1, D10).catch(() => undefined);
    const { rows } = await owner.query(
      "SELECT 1 FROM metrics_daily WHERE tenant_id = $1 AND outlet_id = $2",
      [world.tenantId, foreign.outlet1],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("menu-cogs finality and backfill", () => {
  const rowFinality = async (outletId: string, date: string) =>
    (
      await owner.query<{ finality: string }>(
        `SELECT finality FROM metrics_daily
          WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
            AND metric_code = 'cogs' AND dimension_key IS NULL`,
        [world.tenantId, outletId, date],
      )
    ).rows.map((row) => row.finality);

  it("a closed day stores final rows, an open day estimate, a day nobody computed none", async () => {
    expect(await rowFinality(world.outlet1, D10)).toEqual(["final"]);
    expect(await rowFinality(world.outlet2, D10)).toEqual(["estimate"]);
    // No total row means the engine keeps the bucket an estimate (pinned in
    // metrics-engine.test.ts); the reader must not have written one here.
    expect(await rowFinality(world.outlet1, D13)).toEqual([]);
  });

  it("a quiet day gets a zero total row, and a late order appears after recompute", async () => {
    await refresh(world, world.outlet1, D11);
    const total = async () =>
      (
        await owner.query<{ v: string }>(
          `SELECT value_int::text AS v FROM metrics_daily
            WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
              AND metric_code = 'cogs' AND dimension_key IS NULL`,
          [world.tenantId, world.outlet1, D11],
        )
      ).rows.map((row) => row.v);
    expect(await total()).toEqual(["0"]);
    await asOwner(world.tenantId, (client) =>
      seedOrder(client, world, world.outlet1, D11, [
        {
          menuItemId: world.nasi,
          quantity: 3,
          unitPrice: 30_000,
          cost: 36_000,
        },
      ]),
    );
    await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      businessDateSchema.parse(D11),
      businessDateSchema.parse(D11),
      { readers: READERS, now: NOW },
    );
    expect(await total()).toEqual(["36000"]);
  });

  it("recompute is idempotent: a rerun writes nothing and keeps updated_at", async () => {
    const stamp = async () =>
      (
        await owner.query(
          `SELECT id, value_int::text, updated_at FROM metrics_daily
            WHERE tenant_id = $1 AND metric_date = $2 ORDER BY id`,
          [world.tenantId, D10],
        )
      ).rows;
    const before = await stamp();
    expect(before.length).toBeGreaterThan(0);
    const again = await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      businessDateSchema.parse(D10),
      businessDateSchema.parse(D10),
      { readers: READERS, now: NOW },
    );
    expect(again.written).toBe(0);
    expect(again.deleted).toBe(0);
    expect(again.failedFamilies).toEqual([]);
    expect(await stamp()).toEqual(before);
  });
});
