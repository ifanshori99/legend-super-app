// Metric engine (WS-11 foundation, bead legend-5wzoc; design
// docs/briefs/sub-ws11-foundation-design.md §2.1 "Engine entry" and §2.4,
// DECISIONS 2026-11-10 points 1-4 and 6). Sources are injected through
// `options.sources`; `metrics_daily` rows are inserted directly, so these cases
// do not depend on a family card or on the daily job.

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
import {
  METRIC_LEDGER_ADJUSTMENT,
  metricQueryRequestSchema,
  type MetricDimensionFilter,
} from "@starter/shared/metrics";
import { reportMetricByCode } from "@starter/shared/dashboard";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import {
  metricSourceOf,
  metricSplitOf,
  type DailyMetricReader,
  type MetricSource,
  type MetricSplitSource,
} from "../services/metric-sources";
import {
  evaluateMetrics,
  queryMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
  type EvaluatedSeries,
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
};

const NOW = new Date("2025-09-15T05:00:00Z"); // business date 2025-09-15 WIB
const JUNE = { start: "2025-06-01", end: "2025-06-30" } as const;
const JULY = { start: "2025-07-01", end: "2025-07-31" } as const;
let world: World;

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

async function sale(w: World, date: string, outlet: string, amount: number) {
  const ctx = context(w.tenantId);
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: w.entityId,
      outletId: outletIdSchema.parse(outlet),
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji engine metrik",
      lines: [
        line(w.cash, amount, 0, outlet),
        line(w.revenue, 0, amount, outlet),
      ],
      postedBy: null,
      idempotencyKey: `metrics-engine-${randomUUID()}`,
    }),
  );
}

async function makeWorld(): Promise<World> {
  const tenant = await createIsolatedTenant(`meng-${randomUUID().slice(0, 6)}`);
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
  return {
    tenantId: tenant.tenantId,
    entityId: tenant.legalEntityId,
    outlet1: tenant.outletId,
    outlet2,
    cash,
    revenue,
  };
}

/** Inserts one metrics_daily row as the job would have written it. */
async function daily(
  w: World,
  row: {
    outlet: string;
    date: string;
    code: string;
    value: number;
    dimension?: { key: string; value: string };
    finality?: "estimate" | "final";
  },
) {
  const definition = reportMetricByCode.get(row.code)!;
  const decimal =
    definition.unit === "percent" || definition.unit === "decimal";
  await owner.query(
    `INSERT INTO metrics_daily (tenant_id, outlet_id, metric_date, metric_code, definition_id, definition_version,
       dimension_key, dimension_value, unit, value_int, value_decimal, finality, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
    [
      w.tenantId,
      row.outlet,
      row.date,
      row.code,
      definition.id,
      definition.version,
      row.dimension?.key ?? null,
      row.dimension?.value ?? null,
      definition.unit,
      decimal ? null : row.value,
      decimal ? row.value.toFixed(4) : null,
      row.finality ?? "final",
    ],
  );
}

function reader(
  codes: string[],
  dimensions: DailyMetricReader["dimensions"],
): DailyMetricReader {
  return {
    metricCodes: codes,
    dimensions,
    requiresDailyClose: false,
    compute: async () => [],
  };
}

const COUNT_READER = reader(["transaction_count"], ["channel"]);
const CHANNEL_SPLIT: MetricSplitSource = {
  code: "net_sales",
  dimension: "channel",
  reader: reader(["net_sales"], ["channel"]),
};

/** The registry, with transaction_count stored and avg_ticket derived. */
const SOURCES: SourceLookup = {
  sourceOf(code): MetricSource {
    if (code === "transaction_count")
      return { kind: "daily", code, reader: COUNT_READER };
    if (code === "avg_ticket")
      return {
        kind: "derived",
        code,
        numerator: "net_sales",
        denominator: "transaction_count",
        scale: 1,
      };
    return metricSourceOf(code);
  },
  splitOf(code, dimension) {
    if (code === "net_sales" && dimension === "channel") return CHANNEL_SPLIT;
    return metricSplitOf(code, dimension);
  },
};

function evaluate(
  request: {
    metricCodes: string[];
    period?: { start: string; end: string };
    bucket?: "total" | "day" | "month";
    groupBy?: string[];
    filters?: MetricDimensionFilter[];
    comparePrevious?: boolean;
  },
  outletIds?: string[],
): Promise<EvaluatedMetrics> {
  const ctx = context(world.tenantId, outletIds);
  const period = request.period ?? JUNE;
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
        filters: request.filters ?? [],
        comparePrevious: request.comparePrevious ?? false,
        viewer: "full",
      },
      NOW,
      { sources: SOURCES },
    ),
  );
}

function seriesOf(result: EvaluatedMetrics, code: string): EvaluatedSeries[] {
  return result.series.filter((series) => series.metricCode === code);
}

function totalOf(result: EvaluatedMetrics, code: string) {
  const series = seriesOf(result, code).find(
    (entry) => entry.dimensions.length === 0,
  );
  expect(series, code).toBeDefined();
  return series!.points[0]!;
}

function numberOf(point: { value: unknown }): number | null {
  const value = point.value as
    | { unit: "idr"; valueIdr: number }
    | { unit: string; value: number | string }
    | null;
  if (value === null) return null;
  return "valueIdr" in value ? value.valueIdr : Number(value.value);
}

beforeAll(async () => {
  world = await makeWorld();
  // Ledger: net sales 1,000,000 at outlet 1 and 400,000 at outlet 2 in June.
  await sale(world, "2025-06-10", world.outlet1, 1_000_000);
  await sale(world, "2025-06-11", world.outlet2, 400_000);

  // transaction_count totals (dimension null) and one channel row.
  await daily(world, {
    outlet: world.outlet1,
    date: "2025-06-10",
    code: "transaction_count",
    value: 5,
  });
  await daily(world, {
    outlet: world.outlet2,
    date: "2025-06-11",
    code: "transaction_count",
    value: 3,
  });
  await daily(world, {
    outlet: world.outlet1,
    date: "2025-06-10",
    code: "transaction_count",
    value: 4,
    dimension: { key: "channel", value: "dine_in" },
  });
  await daily(world, {
    outlet: world.outlet1,
    date: "2025-07-02",
    code: "transaction_count",
    value: 2,
    finality: "estimate",
  });

  // net_sales split per channel (operational rows); they miss 100,000.
  for (const [outlet, channel, value] of [
    [world.outlet1, "dine_in", 600_000],
    [world.outlet1, "takeaway", 300_000],
    [world.outlet2, "dine_in", 400_000],
  ] as const)
    await daily(world, {
      outlet,
      date: outlet === world.outlet1 ? "2025-06-10" : "2025-06-11",
      code: "net_sales",
      value,
      dimension: { key: "channel", value: channel },
    });
});

afterAll(async () => {
  await owner.end();
});

describe("daily sources read metrics_daily", () => {
  it("sums the total rows per bucket, ignoring split rows", async () => {
    const result = await evaluate({ metricCodes: ["transaction_count"] });
    expect(result.availability).toEqual([
      { metricCode: "transaction_count", status: "available" },
    ]);
    const point = totalOf(result, "transaction_count");
    expect(numberOf(point)).toBe(8);
    // June has days without a stored total row: the sum may miss them.
    expect(point.finality).toBe("estimate");
  });

  it("is final only when every day of the bucket has a stored total row", async () => {
    // 10 June (outlet 1) and 11 June (outlet 2) both have a total row, all final.
    const covered = await evaluate({
      metricCodes: ["transaction_count"],
      period: { start: "2025-06-10", end: "2025-06-11" },
    });
    expect(numberOf(totalOf(covered, "transaction_count"))).toBe(8);
    expect(totalOf(covered, "transaction_count").finality).toBe("final");

    // Per outlet, each outlet misses one of the two days.
    const byOutlet = await evaluate({
      metricCodes: ["transaction_count"],
      period: { start: "2025-06-10", end: "2025-06-11" },
      groupBy: ["outlet"],
    });
    for (const series of seriesOf(byOutlet, "transaction_count"))
      expect(series.points[0]!.finality).toBe("estimate");

    // A day bucket without a row is no data and an estimate.
    const days = await evaluate({
      metricCodes: ["transaction_count"],
      period: { start: "2025-06-10", end: "2025-06-12" },
      bucket: "day",
    });
    expect(
      seriesOf(days, "transaction_count")[0]!.points.map(
        (point) => point.finality,
      ),
    ).toEqual(["final", "final", "estimate"]);
  });

  it("splits per outlet and leaves a day without rows null, never zero", async () => {
    const byOutlet = await evaluate({
      metricCodes: ["transaction_count"],
      groupBy: ["outlet"],
    });
    const values = Object.fromEntries(
      seriesOf(byOutlet, "transaction_count").map((series) => [
        series.dimensions[0]!.value,
        numberOf(series.points[0]!),
      ]),
    );
    expect(values).toEqual({ [world.outlet1]: 5, [world.outlet2]: 3 });

    const days = await evaluate({
      metricCodes: ["transaction_count"],
      period: { start: "2025-06-10", end: "2025-06-12" },
      bucket: "day",
    });
    expect(
      seriesOf(days, "transaction_count")[0]!.points.map(numberOf),
    ).toEqual([5, 3, null]);
  });

  it("an estimate row keeps the bucket an estimate", async () => {
    const point = totalOf(
      await evaluate({ metricCodes: ["transaction_count"], period: JULY }),
      "transaction_count",
    );
    expect(numberOf(point)).toBe(2);
    expect(point.finality).toBe("estimate");
  });

  it("reads a stored split and a filter on it", async () => {
    const split = await evaluate({
      metricCodes: ["transaction_count"],
      groupBy: ["channel"],
    });
    expect(
      seriesOf(split, "transaction_count").map((series) => [
        series.dimension,
        numberOf(series.points[0]!),
      ]),
    ).toEqual([[{ key: "channel", value: "dine_in" }, 4]]);

    const filtered = await evaluate({
      metricCodes: ["transaction_count"],
      filters: [{ key: "channel", values: ["dine_in"] }],
    });
    expect(numberOf(totalOf(filtered, "transaction_count"))).toBe(4);
  });

  it("an outlet-scoped caller reads only its outlet's rows", async () => {
    const result = await evaluate({ metricCodes: ["transaction_count"] }, [
      world.outlet1,
    ]);
    expect(numberOf(totalOf(result, "transaction_count"))).toBe(5);
  });

  it("a split the reader does not write is dimension_not_supported", async () => {
    const result = await evaluate({
      metricCodes: ["transaction_count"],
      groupBy: ["hour"],
    });
    expect(result.availability[0]).toMatchObject({
      status: "unavailable",
      reason: "dimension_not_supported",
    });
    expect(seriesOf(result, "transaction_count")).toEqual([]);
  });
});

describe("derived sources", () => {
  it("divides the ledger total by the stored count per bucket", async () => {
    const result = await evaluate({ metricCodes: ["avg_ticket"] });
    // 1,400,000 / 8 transactions.
    expect(numberOf(totalOf(result, "avg_ticket"))).toBe(175_000);
    // Net sales is closed_period_only and June's books are open.
    expect(totalOf(result, "avg_ticket").finality).toBe("estimate");
  });

  it("is null when an input has no data", async () => {
    const result = await evaluate({
      metricCodes: ["avg_ticket"],
      period: JULY,
    });
    expect(totalOf(result, "avg_ticket").value).toBeNull();
  });

  it("recomputes per outlet", async () => {
    const result = await evaluate({
      metricCodes: ["avg_ticket"],
      groupBy: ["outlet"],
    });
    const values = Object.fromEntries(
      seriesOf(result, "avg_ticket").map((series) => [
        series.dimensions[0]!.value,
        numberOf(series.points[0]!),
      ]),
    );
    expect(values).toEqual({
      [world.outlet1]: 200_000,
      [world.outlet2]: 133_333,
    });
  });
});

describe("unavailable sources", () => {
  it("an unclaimed code answers null points and source_not_built", async () => {
    const result = await evaluate({
      metricCodes: ["net_sales", "wifi_sessions"],
    });
    expect(result.availability).toEqual([
      { metricCode: "net_sales", status: "available" },
      {
        metricCode: "wifi_sessions",
        status: "unavailable",
        reason: "source_not_built",
        message: "Data metrik ini belum tersedia.",
      },
    ]);
    expect(totalOf(result, "wifi_sessions").value).toBeNull();
    expect(numberOf(totalOf(result, "net_sales"))).toBe(1_400_000);
  });

  it("queryMetrics carries the availability of every definition", async () => {
    const response = await queryMetrics(
      context(world.tenantId),
      metricQueryRequestSchema.parse({
        metricCodes: ["net_sales", "wifi_sessions"],
        period: { startDate: JUNE.start, endDate: JUNE.end },
      }),
      { viewer: "full", now: NOW },
    );
    expect(response.data.availability.map((entry) => entry.status)).toEqual([
      "available",
      "unavailable",
    ]);
  });
});

describe("ledger splits: operational rows plus the ledger residual", () => {
  it("channel rows plus the adjustment row add up to the ledger total", async () => {
    const result = await evaluate({
      metricCodes: ["net_sales"],
      groupBy: ["channel"],
    });
    const rows = seriesOf(result, "net_sales").map((series) => [
      series.dimension?.value,
      numberOf(series.points[0]!),
    ]);
    expect(rows).toEqual([
      ["dine_in", 1_000_000],
      ["takeaway", 300_000],
      [METRIC_LEDGER_ADJUSTMENT, 100_000],
    ]);
    // Split rows take the finality of the ledger total (books open: estimate).
    for (const series of seriesOf(result, "net_sales"))
      expect(series.points[0]!.finality).toBe("estimate");
  });

  it("splits per outlet first, with a residual only where it is not zero", async () => {
    const result = await evaluate({
      metricCodes: ["net_sales"],
      groupBy: ["outlet", "channel"],
    });
    const rows = seriesOf(result, "net_sales").map((series) => [
      ...series.dimensions.map((dimension) => dimension.value),
      numberOf(series.points[0]!),
    ]);
    const expected = [
      [world.outlet1, "dine_in", 600_000],
      [world.outlet1, "takeaway", 300_000],
      [world.outlet1, METRIC_LEDGER_ADJUSTMENT, 100_000],
      [world.outlet2, "dine_in", 400_000],
    ];
    expect(rows).toEqual(
      world.outlet1 < world.outlet2
        ? expected
        : [...expected.slice(3), ...expected.slice(0, 3)],
    );
    for (const series of seriesOf(result, "net_sales")) {
      expect(series.dimensions[0]!.key).toBe("outlet");
      expect(series.dimension).toBeNull();
    }
  });

  it("a declared split without a split source is dimension_not_supported", async () => {
    const result = await evaluate({
      metricCodes: ["net_sales"],
      groupBy: ["promo"],
    });
    expect(result.availability[0]).toMatchObject({
      status: "unavailable",
      reason: "dimension_not_supported",
    });
    expect(seriesOf(result, "net_sales")).toEqual([]);
  });

  it("more than the outlet plus one dimension is dimension_not_supported", async () => {
    const result = await evaluate({
      metricCodes: ["net_sales", "transaction_count"],
      groupBy: ["outlet", "channel", "hour"],
    });
    for (const entry of result.availability)
      expect(entry).toMatchObject({
        status: "unavailable",
        reason: "dimension_not_supported",
      });
    expect(result.series).toEqual([]);
  });

  it("a dimension the definition does not declare stays a 400", async () => {
    await expect(
      evaluate({ metricCodes: ["net_sales"], groupBy: ["zone"] }),
    ).rejects.toMatchObject({ code: "METRIC_DIMENSION_NOT_SUPPORTED" });
  });
});
