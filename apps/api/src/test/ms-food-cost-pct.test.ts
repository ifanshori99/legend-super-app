// Percent split of `food_cost_pct` (legend-iwsrp 9, brief 272 S7 item 3):
// numerator `cogs` and denominator `net_sales` are split first and then
// divided per bucket, outlet and split value, never a mean of daily percents.
// A split one side cannot read answers `dimension_not_supported`.

import { randomUUID } from "node:crypto";
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
import { reportMetricByCode } from "@starter/shared/dashboard";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import {
  metricSourceOf,
  metricSplitOf,
  type MetricSplitSource,
} from "../services/metric-sources";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
  type SourceLookup,
} from "../services/metrics-query.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type World = {
  tenantId: string;
  entityId: string;
  outlet1: string;
  outlet2: string;
  cash: string;
  revenue: string;
  cogs: string;
};

const LATE = new Date("2025-12-20T05:00:00Z");
let world: World;

function context(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const date = (value: string) => businessDateSchema.parse(value);

function line(
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

/** One sale and its cost of goods on an outlet-day. */
async function trade(day: string, outlet: string, sales: number, cost: number) {
  const ctx = context(world.tenantId);
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: world.entityId,
      outletId: outletIdSchema.parse(outlet),
      entryDate: date(day),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji food cost",
      lines: [
        line(world.cash, sales, 0, outlet),
        line(world.revenue, 0, sales, outlet),
        line(world.cogs, cost, 0, outlet),
        line(world.cash, 0, cost, outlet),
      ],
      postedBy: null,
      idempotencyKey: `ms-food-cost-pct-${randomUUID()}`,
    }),
  );
}

/** One idr metrics_daily split row as a split reader would have written it. */
async function splitRow(
  day: string,
  outlet: string,
  code: "net_sales" | "cogs",
  category: string,
  value: number,
) {
  const definition = reportMetricByCode.get(code)!;
  await owner.query(
    `INSERT INTO metrics_daily (tenant_id, outlet_id, metric_date, metric_code, definition_id, definition_version,
       dimension_key, dimension_value, unit, value_int, value_decimal, finality, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'menu_category', $7, 'idr', $8, null, 'final', now())`,
    [
      world.tenantId,
      outlet,
      day,
      code,
      definition.id,
      definition.version,
      category,
      value,
    ],
  );
}

/** The registry plus a cogs split by menu_category (no card builds one yet). */
const COGS_BY_CATEGORY: MetricSplitSource = {
  code: "cogs",
  dimension: "menu_category",
  reader: {
    metricCodes: ["cogs"],
    dimensions: ["menu_category"],
    requiresDailyClose: false,
    compute: async () => [],
  },
};
const WITH_COGS_SPLIT: SourceLookup = {
  sourceOf: metricSourceOf,
  splitOf(code, dimension) {
    if (code === "cogs" && dimension === "menu_category")
      return COGS_BY_CATEGORY;
    return metricSplitOf(code, dimension);
  },
};

function evaluate(
  groupBy: string[],
  period: { start: string; end: string },
  sources?: SourceLookup,
): Promise<EvaluatedMetrics> {
  const ctx = context(world.tenantId);
  return withTenantSnapshot(ctx, (tx) =>
    evaluateMetrics(
      tx,
      ctx,
      {
        metricCodes: ["food_cost_pct"],
        period: { start: date(period.start), end: date(period.end) },
        bucket: "total",
        outletFilter: outletIdsForQuery(ctx.outletScope),
        groupBy: groupBy as never,
        filters: [],
        comparePrevious: false,
        viewer: "full",
      },
      LATE,
      sources ? { sources } : {},
    ),
  );
}

/** Split values (outlet and/or category) joined by "|", to the percent. */
function percents(result: EvaluatedMetrics): Map<string, number | null> {
  return new Map(
    result.series.map((series) => {
      const value = series.points[0]?.value as {
        unit: "percent";
        value: string;
      } | null;
      return [
        series.dimensions.map((dimension) => dimension.value).join("|"),
        value ? Number(value.value) : null,
      ];
    }),
  );
}

const JUNE = { start: "2025-06-01", end: "2025-06-30" };

beforeAll(async () => {
  const tenant = await createIsolatedTenant(`mfc-${randomUUID().slice(0, 6)}`);
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const [cash, revenue, cogs] = [randomUUID(), randomUUID(), randomUUID()];
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $4, $5, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $4, $5, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $4, $5, '5101', 'HPP', 'expense', 'cogs')`,
    [cash, revenue, cogs, tenant.tenantId, tenant.legalEntityId],
  );
  world = {
    tenantId: tenant.tenantId,
    entityId: tenant.legalEntityId,
    outlet1: tenant.outletId,
    outlet2,
    cash,
    revenue,
    cogs,
  };
  // Outlet 1: day 1 food 100k sales / 50k cost (50 %), day 2 food 900k /
  // 90k (10 %) and drink 200k / 20k. Outlet 2: 500k / 250k, no split rows.
  await trade("2025-06-01", world.outlet1, 100_000, 50_000);
  await trade("2025-06-02", world.outlet1, 1_100_000, 110_000);
  await trade("2025-06-03", world.outlet2, 500_000, 250_000);
  await splitRow("2025-06-01", world.outlet1, "net_sales", "food", 100_000);
  await splitRow("2025-06-01", world.outlet1, "cogs", "food", 50_000);
  await splitRow("2025-06-02", world.outlet1, "net_sales", "food", 900_000);
  await splitRow("2025-06-02", world.outlet1, "cogs", "food", 90_000);
  await splitRow("2025-06-02", world.outlet1, "net_sales", "drink", 200_000);
  await splitRow("2025-06-02", world.outlet1, "cogs", "drink", 20_000);
});

afterAll(async () => {
  await owner.end();
});

describe("food_cost_pct split (legend-iwsrp 9)", () => {
  it("per outlet: each outlet's cogs over its own net sales", async () => {
    expect(percents(await evaluate(["outlet"], JUNE))).toEqual(
      new Map([
        [world.outlet1, 13.3333], // 160k / 1.2M
        [world.outlet2, 50],
      ]),
    );
    // The total is summed first (410k / 1.7M), not a mean of outlet percents.
    expect(percents(await evaluate([], JUNE)).get("")).toBe(24.1176);
  });

  it("per menu_category: split numerator over split denominator, summed over days", async () => {
    const result = await evaluate(["menu_category"], JUNE, WITH_COGS_SPLIT);
    expect(result.availability[0]).toMatchObject({ status: "available" });
    const values = percents(result);
    // food: 140k / 1M = 14 %, never the mean of 50 % and 10 %.
    expect(values.get("food")).toBe(14);
    expect(values.get("drink")).toBe(10);
    // Outlet 2 has no split rows: its whole ledger total is the residual.
    expect(values.get("__ledger_adjustment__")).toBe(50);
  });

  it("per outlet and menu_category: the split stays inside each outlet", async () => {
    const values = percents(
      await evaluate(["outlet", "menu_category"], JUNE, WITH_COGS_SPLIT),
    );
    expect(values.get(`${world.outlet1}|food`)).toBe(14);
    expect(values.get(`${world.outlet1}|drink`)).toBe(10);
    expect(values.get(`${world.outlet2}|__ledger_adjustment__`)).toBe(50);
  });

  it("a split one side cannot read is dimension_not_supported", async () => {
    // The registry splits net_sales by menu_category but not cogs.
    const result = await evaluate(["menu_category"], JUNE);
    expect(result.availability[0]).toMatchObject({
      status: "unavailable",
      reason: "dimension_not_supported",
    });
    expect(result.series).toEqual([]);
  });
});
