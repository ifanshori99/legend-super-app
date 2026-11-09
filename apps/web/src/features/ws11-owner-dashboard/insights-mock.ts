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
    bucket: "total",
    outletFilter: { kind: "outlets", outletIds: [...layout.availableOutlets] },
    definitions: report.metrics.map(ref),
    availability: report.metrics.map((metricCode) => ({
      metricCode,
      status: "available",
    })),
    groupBy: [],
    rows: [
      {
        bucketStart: period.startDate,
        bucketEnd: period.endDate,
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

/**
 * Month figures, oldest first; the last is the running month (an estimate).
 * Closed months tie to the books: net profit is the profit-share base of the
 * legal entity (Cafe Legend is its only outlet), and October's sales and
 * discounts are the report viewer's closed month (`sales.daily`,
 * `sales.discount`); the shareholder board copies October's COGS
 * (Rp139.113.600) from here (SH-01, DASH-02). The running month is 1 November
 * only, so its sales and discounts are the owner board's day (Rp7.420.000).
 */
export type MonthFigure = {
  netSales: number;
  food: number;
  labor: number;
  waste: number;
  promo: number;
  discount: number;
  net: number;
};

const profitShareRuns = cafeLegendAccountingFixtures.profitShare.runs;

export const MONTH_FIGURES: readonly MonthFigure[] = [
  {
    netSales: 448_200_000,
    food: 33.4,
    labor: 27.3,
    waste: 5_920_000,
    promo: 10_640_000,
    discount: 22_860_000,
    net: 158_400_000,
  },
  {
    netSales: 476_000_000,
    food: 32.8,
    labor: 26,
    waste: 5_710_000,
    promo: 10_950_000,
    discount: 24_280_000,
    net: Number(profitShareRuns.september.periodNetProfitIdr),
  },
  {
    netSales: 412_800_000,
    food: 33.7,
    labor: 24.5,
    waste: 4_180_000,
    promo: 9_810_000,
    discount: 21_140_701,
    net: Number(profitShareRuns.october.periodNetProfitIdr),
  },
  {
    netSales: 7_420_000,
    food: 31.2,
    labor: 27.5,
    waste: 118_000,
    promo: 185_000,
    discount: 380_000,
    net: 1_025_000,
  },
];

/**
 * Income-statement figures of one month: the single source the shareholder
 * board copies from (year to date, running estimate), so the two screens can
 * never drift (DASH-02, legend-zc3g).
 */
export type MonthIncome = {
  startDate: string;
  endDate: string;
  closed: boolean;
  netSales: number;
  cogs: number;
  grossProfit: number;
  netProfit: number;
};

function incomeOf(figure: MonthFigure) {
  const cogs = Math.round((figure.netSales * figure.food) / 100);
  return {
    netSales: figure.netSales,
    cogs,
    grossProfit: figure.netSales - cogs,
    netProfit: figure.net,
  };
}

function monthRuns(period: Period, figure: MonthFigure) {
  const { cogs, grossProfit: gross } = incomeOf(figure);
  const payroll = Math.round((figure.netSales * figure.labor) / 100);
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
      discount_amount: idr(figure.discount),
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
    // Same supplier dues as the purchasing KPI of the management home.
    run("finance.supplier_due", period, { supplier_due: idr(12_400_000) }),
    run("finance.pending_settlement", period, {
      pending_settlement: idr(2_915_000),
    }),
    run("operations.alerts", period, {
      // The report viewer's sales.void of the same day: 95.000 / 7.420.000.
      void_rate_pct: pct((95_000 / 7_420_000) * 100),
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

/** Months oldest first; the last one is the running month, to date. */
export const ownerMonthIncomes: readonly MonthIncome[] = Object.freeze(
  periods.map((period, index) => ({
    startDate: period.startDate,
    endDate: period.endDate,
    closed: period.closed,
    ...incomeOf(MONTH_FIGURES[index] as MonthFigure),
  })),
);

export const ownerInsightRuns: Readonly<Record<string, ReportResult>> =
  Object.freeze(
    Object.fromEntries(
      [
        ...periods.flatMap((period, index) =>
          monthRuns(period, MONTH_FIGURES[index] as MonthFigure),
        ),
        // The multi-outlet tab reads the owner board's per-channel split of
        // the running month (registered with the part-1 runs), not a run here.
        ...dayRuns(monitoring),
      ].map((result, index) => [`${result.reportCode}#${index}`, result]),
    ),
  );
