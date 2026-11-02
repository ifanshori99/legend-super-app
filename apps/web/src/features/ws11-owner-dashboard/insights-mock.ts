// Mock-only report runs of the owner dashboard, part 2 (bead legend-gb03). The
// shared fixtures carry the part-1 runs only, so the cost, margin, service,
// finance, alert and multi-outlet runs are built here from the metric catalog.
// One table of month figures feeds every cost report, so a tile, the trend and
// the income statement agree for the same period (DASH-02). Loaded in Node by
// tests/ws11-owner-dashboard.test.mjs: bare imports and relative `.ts` only.
import { cafeLegendAccountingFixtures } from "@starter/shared/accounting";
import {
  cafeLegendDashboardFixtures,
  reportByCode,
  reportMetricByCode,
  reportResultSchema,
  type ReportResult,
} from "@starter/shared/dashboard";
import { metricDefinitionRefSchema } from "@starter/shared/metrics";
import { monthPeriods } from "./insights.ts";

const layout = cafeLegendDashboardFixtures.ownerLayout;
const generatedAt = layout.generatedAt;

type Cell =
  | { unit: "idr"; valueIdr: number }
  | { unit: "count"; value: number }
  | { unit: "percent"; value: string };

type Period = { startDate: string; endDate: string; closed: boolean };

function ref(code: string) {
  const definition = reportMetricByCode.get(code);
  if (definition === undefined)
    throw new Error(`No registry row for insight metric ${code}`);
  return metricDefinitionRefSchema.parse({
    id: definition.id,
    code: definition.code,
    version: definition.version,
    name: definition.name,
    ownerModule: definition.ownerModule,
    formula: definition.formula,
    unit: definition.unit,
    aggregation: definition.aggregation,
    dimensions: definition.dimensions,
    grain: definition.grain,
    officiality: definition.officiality,
    sourceReport: definition.sourceReport,
  });
}

function run(
  code: string,
  period: Period,
  values: Readonly<Record<string, Cell>>,
): ReportResult {
  const report = reportByCode(code);
  if (report === undefined) throw new Error(`No report ${code}`);
  return reportResultSchema.parse({
    reportCode: code,
    period: {
      startDate: period.startDate,
      endDate: period.endDate,
      bucket: "total",
      status: period.closed ? "closed" : "open",
      accountingPeriodClosed: period.closed,
    },
    outletFilter: { kind: "outlets", outletIds: [...layout.availableOutlets] },
    definitions: report.metrics.map(ref),
    groupBy: [],
    rows: [
      {
        dimensions: [],
        values: report.metrics.map((metricCode) => ({
          metricCode,
          value: values[metricCode] ?? null,
          finality: period.closed ? "final" : "estimate",
        })),
      },
    ],
    generatedAt,
    rowLimit: 100,
  });
}

const pct = (value: number): Cell => ({
  unit: "percent",
  value: value.toFixed(4),
});
const idr = (valueIdr: number): Cell => ({ unit: "idr", valueIdr });
const count = (value: number): Cell => ({ unit: "count", value });

/** Month figures, oldest first; the last is the running month (an estimate). */
const MONTH_FIGURES = [
  {
    netSales: 241_600_000,
    food: 33.4,
    labor: 28.9,
    waste: 3_380_000,
    promo: 6_040_000,
    net: 31_400_000,
  },
  {
    netSales: 236_900_000,
    food: 32.8,
    labor: 28.1,
    waste: 3_080_000,
    promo: 5_450_000,
    net: 33_700_000,
  },
  {
    // October is the shareholder's closed month: same books (SH-01, DASH-02).
    netSales: 412_800_000,
    food: 33.7,
    labor: 27.6,
    waste: 4_180_000,
    promo: 9_810_000,
    net: Number(cafeLegendAccountingFixtures.profitShare.runs.october.periodNetProfitIdr),
  },
  {
    netSales: 7_420_000,
    food: 31.2,
    labor: 27.5,
    waste: 118_000,
    promo: 185_000,
    net: 1_025_000,
  },
] as const;

function monthRuns(period: Period, figure: (typeof MONTH_FIGURES)[number]) {
  const cogs = Math.round((figure.netSales * figure.food) / 100);
  const payroll = Math.round((figure.netSales * figure.labor) / 100);
  const gross = figure.netSales - cogs;
  const wastePct = (figure.waste / figure.netSales) * 100;
  return [
    run("inventory.food_cost", period, {
      food_cost_pct: pct(figure.food),
      cogs: idr(cogs),
    }),
    run("payroll.labor_cost", period, {
      labor_cost_pct: pct(figure.labor),
      gross_payroll: idr(payroll),
    }),
    run("finance.prime_cost", period, {
      prime_cost_pct: pct(figure.food + figure.labor),
      food_cost_pct: pct(figure.food),
      labor_cost_pct: pct(figure.labor),
    }),
    run("inventory.waste", period, {
      waste_cost: idr(figure.waste),
      waste_cost_pct: pct(wastePct),
    }),
    run("crm.promo_cost", period, {
      promo_cost: idr(figure.promo),
      discount_amount: idr(figure.promo),
    }),
    run("finance.income_statement", period, {
      net_sales: idr(figure.netSales),
      cogs: idr(cogs),
      gross_profit: idr(gross),
      net_profit: idr(figure.net),
    }),
  ];
}

/** Today's figures of the monitoring day (the running business date). */
function dayRuns(period: Period) {
  return [
    run("operations.failed_items", period, {
      failed_item_count: count(3),
      apology_voucher_count: count(2),
    }),
    run("operations.remake_comp", period, {
      remake_count: count(4),
      comp_count: count(2),
    }),
    run("performance.checklist", period, {
      checklist_compliance_pct: pct(87.5),
    }),
    run("finance.cash_position", period, {
      cash_balance: idr(8_250_000),
      bank_balance: idr(96_500_000),
    }),
    run("finance.supplier_due", period, { supplier_due: idr(6_480_000) }),
    run("finance.pending_settlement", period, {
      pending_settlement: idr(2_915_000),
    }),
    run("operations.alerts", period, {
      void_rate_pct: pct(2.1),
      cash_variance: idr(25_000),
    }),
    run("inventory.critical_stock", period, {
      critical_stock_count: count(4),
    }),
    run("operations.devices", period, { device_offline_count: count(1) }),
  ];
}

const periods = monthPeriods(layout.businessDate, MONTH_FIGURES.length);
const monitoring: Period = {
  startDate: layout.monitoringPeriod.startDate,
  endDate: layout.monitoringPeriod.endDate,
  closed: layout.monitoringPeriod.status === "closed",
};

/**
 * Unsplit total of the running period. The mock registry keys runs by report,
 * split and period (not outlet), so this must carry the same figures as the
 * management KPI run for that key (DASH-02).
 */
const runningPeriod = periods[periods.length - 1] as Period;
const multiOutletRun = run("sales.per_channel", runningPeriod, {
  net_sales: idr(44_750_000),
  transaction_count: count(168),
  pax: count(182),
});

export const ownerInsightRuns: Readonly<Record<string, ReportResult>> =
  Object.freeze(
    Object.fromEntries(
      [
        ...periods.flatMap((period, index) =>
          monthRuns(
            period,
            MONTH_FIGURES[index] as (typeof MONTH_FIGURES)[number],
          ),
        ),
        ...dayRuns(monitoring),
        multiOutletRun,
      ].map((result, index) => [`${result.reportCode}#${index}`, result]),
    ),
  );
