// Metric query runtime against the disposable database (bead legend-cdta;
// PRD v1.7 §5, DASH-02, SH-01, SH-02; brief invariants I1-I3). Calls the
// service directly so each rule is pinned without HTTP; the route and its
// permissions are covered by ws11-gl-parity.acceptance.test.ts.
//
// Every run builds its own tenants (outlets, legal entity, chart, journals).
// Journal and snapshot rows are append-only and stay until the run ends.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accountIdSchema,
  type JournalLineInput,
} from "@starter/shared/accounting";
import {
  METRIC_ENTITY_LEVEL_OUTLET,
  metricQueryRequestSchema,
  parseMetricQueryParams,
  type MetricQueryResponse,
} from "@starter/shared/metrics";
import { reportMetricByCode } from "@starter/shared/dashboard";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  requestPeriodReopen,
} from "../services/accounting-period-close.service";
import {
  previousMetricRange,
  queryMetrics,
  withTenantSnapshot,
  type MetricViewer,
} from "../services/metrics-query.service";
import {
  GL_METRIC_SOURCES,
  NON_GL_MONEY_METRICS,
} from "../services/metrics-gl-sources";
import { METRIC_SOURCE_MODULES } from "../services/metric-sources";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type World = {
  tenantId: string;
  entityId: string;
  outlet1: string;
  outlet2: string;
  accounts: Record<
    "cash" | "inventory" | "revenue" | "discount" | "cogs" | "salary" | "rent",
    string
  >;
};

const NOW = new Date("2025-09-15T05:00:00Z"); // business date 2025-09-15 WIB
let world: World;
let other: World;

function context(
  tenantId: string,
  scope: { kind: "tenant" } | { kind: "outlets"; outletIds: string[] } = {
    kind: "tenant",
  },
): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(
    tenant,
    scope.kind === "tenant"
      ? scope
      : {
          kind: "outlets",
          outletIds: scope.outletIds.map((id) => outletIdSchema.parse(id)),
        },
  );
}

function line(
  accountId: string,
  debit: number,
  credit: number,
  outletId: string | null,
): JournalLineInput {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: outletId === null ? null : outletIdSchema.parse(outletId),
    costCenter: null,
  };
}

async function post(
  w: World,
  date: string,
  outletId: string | null,
  lines: JournalLineInput[],
) {
  const ctx = context(w.tenantId);
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: w.entityId,
      outletId,
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji runtime metrik",
      lines,
      postedBy: null,
      idempotencyKey: `metrics-runtime-${randomUUID()}`,
    }),
  );
}

const sale = (w: World, date: string, outlet: string, amount: number) =>
  post(w, date, outlet, [
    line(w.accounts.cash, amount, 0, outlet),
    line(w.accounts.revenue, 0, amount, outlet),
  ]);
const discount = (w: World, date: string, outlet: string, amount: number) =>
  post(w, date, outlet, [
    line(w.accounts.discount, amount, 0, outlet),
    line(w.accounts.cash, 0, amount, outlet),
  ]);
const cogs = (w: World, date: string, outlet: string, amount: number) =>
  post(w, date, outlet, [
    line(w.accounts.cogs, amount, 0, outlet),
    line(w.accounts.inventory, 0, amount, outlet),
  ]);
/** Entity-level payroll: no outlet on the lines. */
const payroll = (w: World, date: string, amount: number) =>
  post(w, date, null, [
    line(w.accounts.salary, amount, 0, null),
    line(w.accounts.cash, 0, amount, null),
  ]);
const rent = (w: World, date: string, outlet: string, amount: number) =>
  post(w, date, outlet, [
    line(w.accounts.rent, amount, 0, outlet),
    line(w.accounts.cash, 0, amount, outlet),
  ]);

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `mrt-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const accounts = {
    cash: randomUUID(),
    inventory: randomUUID(),
    revenue: randomUUID(),
    discount: randomUUID(),
    cogs: randomUUID(),
    salary: randomUUID(),
    rent: randomUUID(),
  };
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $8, $9, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $8, $9, '1301', 'Persediaan', 'asset', 'current_asset'),
            ($3, $8, $9, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($4, $8, $9, '4201', 'Diskon penjualan', 'revenue', 'revenue'),
            ($5, $8, $9, '5101', 'HPP', 'expense', 'cogs'),
            ($6, $8, $9, '6101', 'Gaji', 'expense', 'operating_expense'),
            ($7, $8, $9, '6201', 'Sewa', 'expense', 'operating_expense')`,
    [
      accounts.cash,
      accounts.inventory,
      accounts.revenue,
      accounts.discount,
      accounts.cogs,
      accounts.salary,
      accounts.rent,
      tenant.tenantId,
      tenant.legalEntityId,
    ],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'sales_revenue', $3), ($1, $2, 'sales_discount', $4),
            ($1, $2, 'cogs', $5), ($1, $2, 'salary_expense', $6)
     ON CONFLICT DO NOTHING`,
    [
      tenant.tenantId,
      tenant.legalEntityId,
      accounts.revenue,
      accounts.discount,
      accounts.cogs,
      accounts.salary,
    ],
  );
  return {
    tenantId: tenant.tenantId,
    entityId: tenant.legalEntityId,
    outlet1: tenant.outletId,
    outlet2,
    accounts,
  };
}

async function createPeriod(w: World, period: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) RETURNING id`,
    [w.tenantId, w.entityId, period],
  );
  return rows[0]!.id;
}

/** The ledger oracle: signed balance of one account set, straight from SQL. */
async function gl(
  w: World,
  input: {
    start: string;
    end: string;
    groups?: string[];
    accountIds?: string[];
    sign: 1 | -1;
    outletIds?: string[];
  },
): Promise<number> {
  const { rows } = await owner.query<{ v: string }>(
    `SELECT COALESCE(SUM(l.credit_idr - l.debit_idr), 0)::text AS v
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND e.entry_date BETWEEN $2 AND $3
        AND (a.report_group = ANY($4::text[]) OR a.id = ANY($5::uuid[]))
        AND ($6::uuid[] IS NULL OR l.outlet_id = ANY($6::uuid[]))`,
    [
      w.tenantId,
      input.start,
      input.end,
      input.groups ?? [],
      input.accountIds ?? [],
      input.outletIds ?? null,
    ],
  );
  return input.sign * Number(rows[0]!.v);
}

function run(
  w: World,
  request: Record<string, unknown>,
  opts: {
    scope?: { kind: "tenant" } | { kind: "outlets"; outletIds: string[] };
    viewer?: MetricViewer;
  } = {},
): Promise<MetricQueryResponse> {
  return queryMetrics(
    context(w.tenantId, opts.scope),
    metricQueryRequestSchema.parse(request),
    { viewer: opts.viewer ?? "full", now: NOW },
  );
}

function total(response: MetricQueryResponse, code: string) {
  const series = response.data.series.find(
    (entry) => entry.metricCode === code && entry.dimension === null,
  );
  expect(series, code).toBeDefined();
  expect(series!.points).toHaveLength(1);
  return series!.points[0]!;
}

function idrOf(point: { value: unknown }): number {
  const value = point.value as { unit: string; valueIdr: number } | null;
  expect(value).not.toBeNull();
  expect(value!.unit).toBe("idr");
  return value!.valueIdr;
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

const JUNE = { startDate: "2025-06-01", endDate: "2025-06-30" };
const JULY = { startDate: "2025-07-01", endDate: "2025-07-31" };
const SEPT = { startDate: "2025-09-01", endDate: "2025-09-30" };

beforeAll(async () => {
  world = await makeWorld("a");
  other = await makeWorld("b");
  const june = await createPeriod(world, "2025-06");
  await createPeriod(world, "2025-07");
  await createPeriod(world, "2025-09");

  await sale(world, "2025-06-10", world.outlet1, 1_000_000);
  await cogs(world, "2025-06-10", world.outlet1, 300_000);
  await sale(world, "2025-06-11", world.outlet2, 400_000);
  await cogs(world, "2025-06-11", world.outlet2, 120_000);
  await discount(world, "2025-06-20", world.outlet1, 50_000);
  await payroll(world, "2025-06-30", 200_000);
  await rent(world, "2025-06-30", world.outlet1, 100_000);
  await sale(world, "2025-07-05", world.outlet1, 500_000);
  await cogs(world, "2025-07-05", world.outlet1, 150_000);
  await sale(world, "2025-09-02", world.outlet2, 250_000);

  // Another tenant with a bigger ledger on the same days (RLS check).
  await createPeriod(other, "2025-06");
  await sale(other, "2025-06-10", other.outlet1, 9_000_000);

  await closeFiscalPeriod(
    context(world.tenantId),
    june,
    { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(randomUUID()),
  );
});

afterAll(async () => {
  await owner.end();
});

describe("I1: money metrics equal the general ledger", () => {
  it("net sales, HPP, gross profit and net profit equal the GL balances", async () => {
    const response = await run(world, {
      metricCodes: ["net_sales", "cogs", "gross_profit", "net_profit"],
      period: JUNE,
    });
    const range = { start: JUNE.startDate, end: JUNE.endDate };
    const netSales = await gl(world, {
      ...range,
      groups: ["revenue"],
      sign: 1,
    });
    const hpp = await gl(world, { ...range, groups: ["cogs"], sign: -1 });
    const profit = await gl(world, {
      ...range,
      groups: [
        "revenue",
        "other_income",
        "cogs",
        "operating_expense",
        "other_expense",
      ],
      sign: 1,
    });
    expect(netSales).toBe(1_350_000);
    expect(idrOf(total(response, "net_sales"))).toBe(netSales);
    expect(idrOf(total(response, "cogs"))).toBe(hpp);
    expect(idrOf(total(response, "gross_profit"))).toBe(netSales - hpp);
    expect(profit).toBe(1_350_000 - 420_000 - 200_000 - 100_000);
    expect(idrOf(total(response, "net_profit"))).toBe(profit);
  });

  it("payroll comes from the salary account and food cost % is HPP over net sales", async () => {
    const response = await run(world, {
      metricCodes: ["gross_payroll", "food_cost_pct", "labor_cost_pct"],
      period: JUNE,
    });
    expect(idrOf(total(response, "gross_payroll"))).toBe(
      await gl(world, {
        start: JUNE.startDate,
        end: JUNE.endDate,
        accountIds: [world.accounts.salary],
        sign: -1,
      }),
    );
    // 420000 / 1350000 × 100 = 31.1111 (half up); 200000 / 1350000 = 14.8148.
    expect(total(response, "food_cost_pct").value).toEqual({
      unit: "percent",
      value: "31.1111",
    });
    expect(total(response, "labor_cost_pct").value).toEqual({
      unit: "percent",
      value: "14.8148",
    });
  });

  it("daily and per-outlet splits add up to the total", async () => {
    const totalResponse = await run(world, {
      metricCodes: ["net_sales"],
      period: JUNE,
    });
    const daily = await run(world, {
      metricCodes: ["net_sales"],
      period: JUNE,
      bucket: "day",
    });
    const points = daily.data.series[0]!.points;
    expect(points).toHaveLength(30);
    const sum = points.reduce(
      (acc, point) => acc + (point.value === null ? 0 : idrOf(point)),
      0,
    );
    expect(sum).toBe(idrOf(total(totalResponse, "net_sales")));

    const byOutlet = await run(world, {
      metricCodes: ["net_sales"],
      period: JUNE,
      groupBy: "outlet",
    });
    const values = Object.fromEntries(
      byOutlet.data.series.map((s) => [
        s.dimension!.value,
        idrOf(s.points[0]!),
      ]),
    );
    expect(values).toEqual({
      [world.outlet1]: 950_000,
      [world.outlet2]: 400_000,
    });
  });

  it("a period without journal lines answers null, never zero", async () => {
    const response = await run(world, {
      metricCodes: ["net_sales", "food_cost_pct"],
      period: { startDate: "2024-01-01", endDate: "2024-01-31" },
    });
    for (const series of response.data.series)
      for (const point of series.points) expect(point.value).toBeNull();
  });

  it("a money metric without a ledger source answers null instead of raw-table figures", async () => {
    const response = await run(world, {
      metricCodes: ["delivery_sales"],
      period: JUNE,
    });
    expect(total(response, "delivery_sales").value).toBeNull();
  });

  it("compares a whole month with the previous whole month", async () => {
    const response = await run(world, {
      metricCodes: ["net_sales"],
      period: JULY,
      comparePrevious: true,
    });
    const point = total(response, "net_sales");
    expect(idrOf(point)).toBe(500_000);
    expect(point.comparison).toEqual({
      previousValue: { unit: "idr", valueIdr: 1_350_000 },
      changeValue: { unit: "idr", valueIdr: -850_000 },
      changePercent: "-62.9630",
    });
    expect(
      previousMetricRange({ start: "2025-07-01", end: "2025-07-31" } as never),
    ).toEqual({
      start: "2025-06-01",
      end: "2025-06-30",
    });
    expect(
      previousMetricRange({ start: "2025-07-10", end: "2025-07-12" } as never),
    ).toEqual({
      start: "2025-07-07",
      end: "2025-07-09",
    });
  });

  it("the closed month's ledger figure equals its balance snapshot", async () => {
    // June is the entity's first closed month, so its cumulative snapshot of
    // the revenue accounts is exactly June's movement.
    const { rows } = await owner.query<{ v: string }>(
      `SELECT COALESCE(SUM(sl.credit_idr - sl.debit_idr), 0)::text AS v
         FROM fiscal_period_snapshot_lines sl
         JOIN fiscal_period_snapshots s ON s.id = sl.snapshot_id AND s.tenant_id = sl.tenant_id
         JOIN chart_of_accounts a ON a.id = sl.account_id AND a.tenant_id = sl.tenant_id
        WHERE s.tenant_id = $1 AND s.period = '2025-06' AND a.report_group = 'revenue'`,
      [world.tenantId],
    );
    const response = await run(world, {
      metricCodes: ["net_sales"],
      period: JUNE,
    });
    expect(idrOf(total(response, "net_sales"))).toBe(Number(rows[0]!.v));
  });
});

describe("I2 / SH-02: finality", () => {
  it("a closed accounting month is final", async () => {
    const response = await run(world, {
      metricCodes: ["net_sales", "food_cost_pct"],
      period: JUNE,
    });
    expect(response.data.period).toMatchObject({
      status: "closed",
      accountingPeriodClosed: true,
    });
    expect(total(response, "net_sales").finality).toBe("final");
    expect(total(response, "food_cost_pct").finality).toBe("final");
  });

  it("a past month whose books are open stays an estimate, even for a live metric", async () => {
    const response = await run(world, {
      metricCodes: ["net_sales"],
      period: JULY,
    });
    expect(response.data.period).toMatchObject({
      status: "closed",
      accountingPeriodClosed: false,
    });
    expect(total(response, "net_sales").finality).toBe("estimate");
  });

  it("the running month is an estimate and requireFinal refuses it", async () => {
    const response = await run(world, {
      metricCodes: ["net_sales"],
      period: SEPT,
    });
    expect(response.data.period.status).toBe("open");
    expect(total(response, "net_sales").finality).toBe("estimate");
    expect(idrOf(total(response, "net_sales"))).toBe(250_000);
    expect(
      await codeOf(
        run(world, {
          metricCodes: ["net_sales"],
          period: SEPT,
          requireFinal: true,
        }),
      ),
    ).toBe("PERIOD_NOT_CLOSED");
    const official = await run(world, {
      metricCodes: ["net_sales"],
      period: JUNE,
      requireFinal: true,
    });
    expect(total(official, "net_sales").finality).toBe("final");
  });

  it("daily buckets inside the closed month are final, open-month days are estimates", async () => {
    const response = await run(world, {
      metricCodes: ["net_sales"],
      period: { startDate: "2025-06-30", endDate: "2025-07-01" },
      bucket: "day",
    });
    expect(response.data.series[0]!.points.map((p) => p.finality)).toEqual([
      "final",
      "estimate",
    ]);
  });
});

describe("TEN-03 / TEN-01 / SH-01: scope", () => {
  it("an outlet scope reads only its outlet and leaves entity-level lines out", async () => {
    const scoped = await run(
      world,
      { metricCodes: ["net_sales", "net_profit"], period: JUNE },
      { scope: { kind: "outlets", outletIds: [world.outlet1] } },
    );
    expect(scoped.data.outletFilter).toEqual({
      kind: "outlets",
      outletIds: [world.outlet1],
    });
    expect(idrOf(total(scoped, "net_sales"))).toBe(950_000);
    // Outlet 1: 950000 − 300000 HPP − 100000 rent; payroll has no outlet.
    expect(idrOf(total(scoped, "net_profit"))).toBe(550_000);
  });

  it("asking for an outlet outside the scope is refused", async () => {
    expect(
      await codeOf(
        run(
          world,
          {
            metricCodes: ["net_sales"],
            period: JUNE,
            outletIds: [world.outlet2],
          },
          { scope: { kind: "outlets", outletIds: [world.outlet1] } },
        ),
      ),
    ).toBe("OUTLET_OUT_OF_SCOPE");
  });

  it("another tenant's ledger never reaches the figures", async () => {
    const mine = await run(world, { metricCodes: ["net_sales"], period: JUNE });
    expect(idrOf(total(mine, "net_sales"))).toBe(1_350_000);
    const theirs = await run(other, {
      metricCodes: ["net_sales"],
      period: JUNE,
    });
    expect(idrOf(total(theirs, "net_sales"))).toBe(9_000_000);
  });

  it("an aggregate viewer cannot split by a person; a ledger metric split without a source is unsupported", async () => {
    for (const groupBy of ["employee", "customer", "member"])
      expect(
        await codeOf(
          run(
            world,
            { metricCodes: ["net_sales"], period: JUNE, groupBy },
            { viewer: "aggregate" },
          ),
        ),
      ).toBe("PERMISSION_DENIED");
    expect(
      await codeOf(
        run(world, {
          metricCodes: ["net_sales"],
          period: JUNE,
          groupBy: "promo", // net_sales declares it, no card builds the split
        }),
      ),
    ).toBe("METRIC_DIMENSION_NOT_SUPPORTED");
  });

  it("an unknown metric code is METRIC_NOT_FOUND", async () => {
    expect(
      await codeOf(
        run(world, { metricCodes: ["metrik_tidak_ada"], period: JUNE }),
      ),
    ).toBe("METRIC_NOT_FOUND");
  });
});

// ---- legend-cdta review K fixes ----------------------------------------------

const CLOSER = randomUUID();

async function closePeriod(
  w: World,
  periodId: string,
  expectedVersion: number,
) {
  await closeFiscalPeriod(
    context(w.tenantId),
    periodId,
    { expectedVersion, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(CLOSER),
  );
}

async function reopenPeriod(w: World, periodId: string) {
  const request = await requestPeriodReopen(
    context(w.tenantId),
    periodId,
    { reason: "Koreksi uji runtime metrik" },
    userIdSchema.parse(randomUUID()),
  );
  await approvePeriodReopen(
    context(w.tenantId),
    request.id,
    { note: null },
    userIdSchema.parse(randomUUID()),
  );
}

/** Revenue movement of a closed month from balance snapshots (cumulative). */
async function snapshotRevenueMovement(
  w: World,
  period: string,
): Promise<number> {
  const { rows } = await owner.query<{ period: string; v: string }>(
    `SELECT s.period, COALESCE(SUM(sl.credit_idr - sl.debit_idr), 0)::text AS v
       FROM fiscal_periods p
       JOIN fiscal_period_snapshots s
         ON s.tenant_id = p.tenant_id AND s.fiscal_period_id = p.id AND s.version = p.version
       LEFT JOIN fiscal_period_snapshot_lines sl ON sl.snapshot_id = s.id AND sl.tenant_id = s.tenant_id
       LEFT JOIN chart_of_accounts a ON a.id = sl.account_id AND a.tenant_id = sl.tenant_id
      WHERE p.tenant_id = $1 AND p.legal_entity_id = $2 AND p.status = 'closed'
        AND p.period <= $3 AND (a.report_group = 'revenue' OR a.id IS NULL)
      GROUP BY s.period ORDER BY s.period DESC LIMIT 2`,
    [w.tenantId, w.entityId, period],
  );
  expect(rows[0]?.period).toBe(period);
  return Number(rows[0]!.v) - Number(rows[1]?.v ?? 0);
}

describe("review K: book state per entity, reopen and snapshot parity", () => {
  let books: World;
  const periods: Record<string, string> = {};
  const MONTH = (m: string) => ({
    startDate: `2025-${m}-01`,
    endDate: addMonthEnd(`2025-${m}`),
  });
  function addMonthEnd(period: string) {
    const [y, m] = period.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }

  beforeAll(async () => {
    books = await makeWorld("books");
    periods.jan = await createPeriod(books, "2025-01");
    periods.feb = await createPeriod(books, "2025-02");
    await sale(books, "2025-01-10", books.outlet1, 100_000);
    await sale(books, "2025-02-10", books.outlet1, 200_000);
    await closePeriod(books, periods.jan, 1);
    await closePeriod(books, periods.feb, 1);
    // Entity B of the same tenant keeps books from March only.
    const entityB = randomUUID();
    await owner.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entitas B', false)`,
      [entityB, books.tenantId],
    );
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period) VALUES ($1, $2, '2025-03')`,
      [books.tenantId, entityB],
    );
  });

  it("an entity whose books start in March does not hold January open", async () => {
    const response = await run(books, {
      metricCodes: ["net_sales"],
      period: MONTH("01"),
    });
    expect(response.data.period.accountingPeriodClosed).toBe(true);
    expect(total(response, "net_sales").finality).toBe("final");
    expect(response.meta.accountingPeriods).toEqual([
      { period: "2025-01", accountingVersion: 2, closed: true },
    ]);
    // March: B has books and has not closed them.
    const march = await run(books, {
      metricCodes: ["net_sales"],
      period: MONTH("03"),
    });
    expect(march.meta.accountingPeriods).toEqual([
      { period: "2025-03", accountingVersion: 1, closed: false },
    ]);
    expect(total(march, "net_sales").finality).toBe("estimate");
  });

  it("a month nobody keeps books for stays an estimate", async () => {
    const response = await run(books, {
      metricCodes: ["net_sales"],
      period: MONTH("04"),
    });
    expect(response.meta.accountingPeriods).toEqual([
      { period: "2025-04", accountingVersion: 0, closed: false },
    ]);
    expect(total(response, "net_sales").finality).toBe("estimate");
  });

  it("reopen turns a month into an estimate, re-close makes it final with the corrected ledger", async () => {
    const before = await run(books, {
      metricCodes: ["net_sales"],
      period: MONTH("02"),
    });
    expect(total(before, "net_sales").finality).toBe("final");
    expect(idrOf(total(before, "net_sales"))).toBe(200_000);

    await reopenPeriod(books, periods.feb);
    const reopened = await run(books, {
      metricCodes: ["net_sales"],
      period: MONTH("02"),
    });
    expect(total(reopened, "net_sales").finality).toBe("estimate");
    expect(reopened.meta.accountingPeriods).toEqual([
      { period: "2025-02", accountingVersion: 3, closed: false },
    ]);
    expect(
      await codeOf(
        run(books, {
          metricCodes: ["net_sales"],
          period: MONTH("02"),
          requireFinal: true,
        }),
      ),
    ).toBe("PERIOD_NOT_CLOSED");

    await sale(books, "2025-02-20", books.outlet1, 50_000);
    await closePeriod(books, periods.feb, 3);
    const reclosed = await run(books, {
      metricCodes: ["net_sales"],
      period: MONTH("02"),
    });
    expect(total(reclosed, "net_sales").finality).toBe("final");
    expect(idrOf(total(reclosed, "net_sales"))).toBe(250_000);
    expect(reclosed.meta.accountingPeriods).toEqual([
      { period: "2025-02", accountingVersion: 4, closed: true },
    ]);
  });

  it("every closed month: ledger figure == journal == snapshot movement", async () => {
    for (const month of ["01", "02"]) {
      const period = MONTH(month);
      const response = await run(books, {
        metricCodes: ["net_sales"],
        period,
        requireFinal: true,
      });
      const fromRuntime = idrOf(total(response, "net_sales"));
      expect(fromRuntime).toBe(
        await gl(books, {
          start: period.startDate,
          end: period.endDate,
          groups: ["revenue"],
          sign: 1,
        }),
      );
      expect(fromRuntime).toBe(
        await snapshotRevenueMovement(books, `2025-${month}`),
      );
    }
  });
});

describe("review K: ratios, entity-level series, child accounts, snapshot reads", () => {
  it("a ratio whose numerator has no lines is null, not 0 %", async () => {
    // Payroll posts at entity level, so outlet 1 has no labor cost lines.
    const scoped = await run(
      world,
      { metricCodes: ["labor_cost_pct", "food_cost_pct"], period: JUNE },
      { scope: { kind: "outlets", outletIds: [world.outlet1] } },
    );
    expect(total(scoped, "labor_cost_pct").value).toBeNull();
    // 300000 / 950000 × 100.
    expect(total(scoped, "food_cost_pct").value).toEqual({
      unit: "percent",
      value: "31.5789",
    });
  });

  it("groupBy outlet adds an entity-level series so the split sums to net profit", async () => {
    const totalResponse = await run(world, {
      metricCodes: ["net_profit"],
      period: JUNE,
    });
    const byOutlet = await run(world, {
      metricCodes: ["net_profit"],
      period: JUNE,
      groupBy: "outlet",
    });
    const values = Object.fromEntries(
      byOutlet.data.series.map((s) => [
        s.dimension!.value,
        idrOf(s.points[0]!),
      ]),
    );
    expect(values).toEqual({
      [world.outlet1]: 550_000,
      [world.outlet2]: 280_000,
      [METRIC_ENTITY_LEVEL_OUTLET]: -200_000,
    });
    expect(byOutlet.data.series.at(-1)!.dimension!.value).toBe(
      METRIC_ENTITY_LEVEL_OUTLET,
    );
    const sum = Object.values(values).reduce((acc, value) => acc + value, 0);
    expect(sum).toBe(idrOf(total(totalResponse, "net_profit")));

    // An outlet-scoped reader never gets the entity-level series.
    const scoped = await run(
      world,
      { metricCodes: ["net_profit"], period: JUNE, groupBy: "outlet" },
      { scope: { kind: "outlets", outletIds: [world.outlet1] } },
    );
    expect(scoped.data.series.map((s) => s.dimension!.value)).toEqual([
      world.outlet1,
    ]);
  });

  it("a role term reads the child accounts of the mapped account", async () => {
    const child = randomUUID();
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, parent_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, '6102', 'Gaji lembur', 'expense', 'operating_expense')`,
      [child, world.tenantId, world.entityId, world.accounts.salary],
    );
    await post(world, "2025-08-28", null, [
      line(child, 75_000, 0, null),
      line(world.accounts.cash, 0, 75_000, null),
    ]);
    const response = await run(world, {
      metricCodes: ["gross_payroll"],
      period: { startDate: "2025-08-01", endDate: "2025-08-31" },
    });
    expect(idrOf(total(response, "gross_payroll"))).toBe(75_000);
  });

  it("reads book state and ledger in one REPEATABLE READ READ ONLY transaction", async () => {
    const state = await withTenantSnapshot(
      context(world.tenantId),
      async (tx) => {
        const result = await tx.execute<{
          iso: string;
          ro: string;
          tenant: string;
        }>(
          sql`SELECT current_setting('transaction_isolation') AS iso,
                   current_setting('transaction_read_only') AS ro,
                   current_setting('app.tenant_id') AS tenant`,
        );
        return result.rows[0]!;
      },
    );
    expect(state).toEqual({
      iso: "repeatable read",
      ro: "on",
      tenant: world.tenantId,
    });
  });
});

describe("review K: one formula source", () => {
  it("every ledger source is a registered metric with a matching unit", () => {
    for (const [code, source] of Object.entries(GL_METRIC_SOURCES)) {
      const definition = reportMetricByCode.get(code);
      expect(definition, code).toBeDefined();
      expect(definition!.unit, code).toBe(
        source.kind === "ratio" ? "percent" : "idr",
      );
    }
  });

  it("every rupiah metric is ledger-mapped or listed as NON_GL, never both", () => {
    const mapped = new Set(Object.keys(GL_METRIC_SOURCES));
    const nonGl = new Set(NON_GL_MONEY_METRICS);
    for (const code of nonGl) expect(mapped.has(code), code).toBe(false);
    // A rupiah metric a family card claims as a non-ledger source (stored,
    // derived, or unavailable with its own reason, such as
    // menu_gross_margin) is neither ledger-mapped nor a ledger gap.
    const familyClaimed = new Set(
      METRIC_SOURCE_MODULES.filter((module) => module.family !== "gl").flatMap(
        (module) => module.sources.map((source) => source.code),
      ),
    );
    const registeredNonGl = (code: string) => familyClaimed.has(code);
    for (const definition of reportMetricByCode.values())
      if (definition.unit === "idr")
        expect(
          mapped.has(definition.code) ||
            nonGl.has(definition.code) ||
            registeredNonGl(definition.code),
          definition.code,
        ).toBe(true);
    for (const code of nonGl)
      expect(reportMetricByCode.get(code)?.unit, code).toBe("idr");
  });

  it("the registry formula of a ledger metric describes the ledger", () => {
    const mapped = new Set(Object.keys(GL_METRIC_SOURCES));
    const describesLedger = (code: string): boolean => {
      const formula = reportMetricByCode.get(code)!.formula;
      if (formula.expression.includes("journal_lines")) return true;
      return (
        formula.inputs.length > 0 &&
        formula.inputs.every(
          (input) => mapped.has(input) && describesLedger(input),
        )
      );
    };
    const stale = [...mapped].filter((code) => !describesLedger(code));
    expect(stale).toEqual([]);
    for (const code of [
      "net_sales",
      "net_profit",
      "food_cost_pct",
      "labor_cost_pct",
      "prime_cost_pct",
      "waste_cost",
      "cogs",
      "discount_amount",
      "gross_payroll",
      "payment_fee",
    ])
      expect(
        reportMetricByCode.get(code)!.version,
        code,
      ).toBeGreaterThanOrEqual(2);
  });
});

describe("wire query", () => {
  it("accepts the web client's flat form and the qs bracket form alike", () => {
    const flat = parseMetricQueryParams({
      metricCodes: "net_sales,cogs",
      startDate: "2025-06-01",
      endDate: "2025-06-30",
      outletIds: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      comparePrevious: "true",
    });
    const bracket = parseMetricQueryParams({
      metricCodes: ["net_sales", "cogs"],
      "period[startDate]": "2025-06-01",
      "period[endDate]": "2025-06-30",
      outletId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      comparePrevious: "true",
    });
    expect(flat).toEqual(bracket);
    expect(flat).toMatchObject({
      bucket: "total",
      requireFinal: false,
      comparePrevious: true,
    });
    expect(() =>
      parseMetricQueryParams({
        metricCodes: "net_sales",
        startDate: "2025-06-30",
        endDate: "2025-06-01",
      }),
    ).toThrow();
    expect(() =>
      parseMetricQueryParams({
        metricCodes: "net_sales",
        startDate: "2025-06-01",
        endDate: "2025-06-30",
        tenantId: "x",
      }),
    ).toThrow();
  });
});

describe("GL split finality counts total rows per outlet", () => {
  // June is closed, so the ledger total is final; a split row is final only
  // when every outlet has a stored total row on every day of the bucket.
  async function cogsRow(
    outlet: string,
    date: string,
    value: number,
    dimension?: string,
  ) {
    const definition = reportMetricByCode.get("cogs")!;
    await owner.query(
      `INSERT INTO metrics_daily (tenant_id, outlet_id, metric_date, metric_code, definition_id, definition_version,
         dimension_key, dimension_value, unit, value_int, finality, computed_at)
       VALUES ($1, $2, $3, 'cogs', $4, $5, $6, $7, 'idr', $8, 'final', now())`,
      [
        world.tenantId,
        outlet,
        date,
        definition.id,
        definition.version,
        dimension ? "menu_item" : null,
        dimension ?? null,
        value,
      ],
    );
  }
  const finalities = async (start: string, end: string) => {
    const response = await run(world, {
      metricCodes: ["cogs"],
      period: { startDate: start, endDate: end },
      groupBy: "menu_item",
    });
    return response.data.series
      .filter((entry) => entry.dimension?.key === "menu_item")
      .map((entry) => entry.points[0]!.finality);
  };

  it("two outlets that each miss a different day do not cover the bucket together", async () => {
    // outlet 1 has a total row on the 10th only, outlet 2 on the 11th only:
    // the union of dates is complete, the per-outlet sets are not.
    await cogsRow(world.outlet1, "2025-06-10", 100);
    await cogsRow(world.outlet1, "2025-06-10", 100, "menu-a");
    await cogsRow(world.outlet2, "2025-06-11", 50);
    await cogsRow(world.outlet2, "2025-06-11", 50, "menu-a");
    expect(await finalities("2025-06-10", "2025-06-11")).toEqual([
      "estimate",
      "estimate",
    ]);
  });

  it("every outlet with a total row on every day keeps the split final", async () => {
    for (const outlet of [world.outlet1, world.outlet2])
      for (const date of ["2025-06-12", "2025-06-13"]) {
        await cogsRow(outlet, date, 10);
        await cogsRow(outlet, date, 10, "menu-b");
      }
    expect(await finalities("2025-06-12", "2025-06-13")).toEqual([
      "final",
      "final",
    ]);
  });
});
