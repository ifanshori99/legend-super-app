// Mock mode for the shareholder dashboard (`VITE_API_MOCK=true`). Serves the
// shareholder layout, the closed-period and running-period report runs, the
// caller's own profit share (SH-01) and the published documents through the
// shared endpoint owners (dashboards.ts, report-runs.ts). The contract
// fixtures carry no shareholder layout or runs, so they are built here from
// the tile catalog and the accounting fixtures; one report + period key
// carries one set of numbers everywhere (DASH-02), and the closed month's net
// profit is the October run of the profit-share fixtures.
//
// `?mock=empty` keeps the layout and returns runs without rows, an empty
// profit-share view and no documents. `slow|error|offline` come from the
// runtime. Loaded in Node by tests/ws11-shareholder.test.mjs: bare package
// imports and relative `.ts` paths only, no `@/` alias.
import {
  cafeLegendAccountingFixtures,
  getMyProfitShare,
  listShareholderDocuments,
} from "@starter/shared/accounting";
import {
  cafeLegendDashboardFixtures,
  dashboardLayoutSchema,
  reportByCode,
  reportMetricByCode,
  reportResultSchema,
  SHAREHOLDER_DASHBOARD_TILES,
  type ReportResult,
} from "@starter/shared/dashboard";
import {
  metricDefinitionRefSchema,
  type MetricValue,
} from "@starter/shared/metrics";
import { registerMock } from "../../lib/mock/registry.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMockDashboard } from "../../lib/mock/handlers/dashboards.ts";
import {
  hasMockReportRun,
  registerMockReportRuns,
} from "../../lib/mock/handlers/report-runs.ts";
import {
  closedPeriodOf,
  runningPeriodOf,
  shareholderRunInputs,
  ytdPeriodOf,
} from "./board.ts";

const outletId = cafeLegendDashboardFixtures.ownerLayout.availableOutlets[0]!;
const generatedAt = "2026-11-05T05:00:00.000Z";

export const shareholderLayoutFixture = dashboardLayoutSchema.parse({
  dashboard: "shareholder",
  title: "Dashboard Shareholder",
  businessDate: "2026-11-05",
  availableOutlets: [outletId],
  tiles: SHAREHOLDER_DASHBOARD_TILES,
  generatedAt,
  monitoringPeriod: {
    startDate: "2026-11-01",
    endDate: "2026-11-05",
    bucket: "total",
    status: "open",
    accountingPeriodClosed: false,
  },
});
const layout = shareholderLayoutFixture;

registerMockDashboard("shareholder", { normal: layout });

const idr = (valueIdr: number) => ({ unit: "idr", valueIdr }) as MetricValue;

const accounting = cafeLegendAccountingFixtures.profitShare;
const octoberNetProfit = Number(accounting.runs.october.periodNetProfitIdr);

/**
 * Figures per period; one table feeds every report of that period (DASH-02).
 * October is the same closed month the report viewer (features/ws11-reports
 * mock: day model scaled to net sales Rp412.800.000) and the owner insights
 * (finance.income_statement: COGS 33,7%, net profit from the October
 * profit-share run) already serve, so sales, guests and gross profit are
 * copied from those owners rather than invented: a tile and its source report
 * must show the same number for the same key.
 */
const closedMonth: Record<string, MetricValue> = {
  // Report viewer, sales.daily / sales.per_pax, 2026-10-01..2026-10-31.
  net_sales: idr(412_800_000),
  gross_sales: idr(440_616_712),
  discount_amount: idr(21_140_701),
  refund_amount: idr(6_676_011),
  transaction_count: { unit: "count", value: 5_341 } as MetricValue,
  pax: { unit: "count", value: 8_222 } as MetricValue,
  // round(412.800.000 / 8.222), the viewer's per-pax formula.
  avg_spend_per_pax: idr(50_207),
  // Owner insights, finance.income_statement October: COGS = 33,7% of sales.
  cogs: idr(139_113_600),
  gross_profit: idr(273_686_400),
  gross_margin_pct: { unit: "percent", value: "66.3000" } as MetricValue,
  ebitda: idr(octoberNetProfit + 21_000_000),
  net_profit: idr(octoberNetProfit),
  cash_balance: idr(34_600_000),
  bank_balance: idr(512_300_000),
};
// Year to date (Jan..Oct, closed months only): only the income statement runs
// over it, so it carries only income-statement figures (net - COGS = gross).
const yearToDate: Record<string, MetricValue> = {
  net_sales: idr(3_642_000_000),
  cogs: idr(1_231_000_000),
  gross_profit: idr(2_411_000_000),
  net_profit: idr(1_226_000_000),
};
// Same estimated net profit as the accounting estimate (Rp 120.000.000).
const runningFigures: Record<string, MetricValue> = {
  net_sales: idr(268_000_000),
  gross_profit: idr(178_000_000),
  net_profit: idr(120_000_000),
  cogs: idr(90_000_000),
};

function ref(code: string) {
  const definition = reportMetricByCode.get(code);
  if (definition === undefined) throw new Error(`No registry row for ${code}`);
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
  reportCode: string,
  period: { startDate: string; endDate: string },
  figures: Record<string, MetricValue>,
  official: boolean,
): ReportResult {
  const report = reportByCode(reportCode);
  if (report === undefined) throw new Error(`No report ${reportCode}`);
  return reportResultSchema.parse({
    reportCode,
    period: {
      ...period,
      bucket: "total",
      status: official ? "closed" : "open",
      accountingPeriodClosed: official,
    },
    outletFilter: { kind: "outlets", outletIds: [outletId] },
    definitions: report.metrics.map(ref),
    groupBy: [],
    rows: [
      {
        dimensions: [],
        values: report.metrics.map((metricCode) => ({
          metricCode,
          value: figures[metricCode] ?? null,
          finality: official ? "final" : "estimate",
        })),
      },
    ],
    generatedAt,
    rowLimit: 100,
  });
}

// Derived from the run inputs the screen itself sends, so a key never drifts.
const runningPeriod = runningPeriodOf(layout);
const ytd = ytdPeriodOf(layout);
const closed = closedPeriodOf(layout);
const runs: Record<string, ReportResult> = {};
for (const input of shareholderRunInputs(layout)) {
  const { startDate, endDate } = input.period;
  const isRunning =
    runningPeriod?.startDate === startDate && runningPeriod.endDate === endDate;
  const isYtd =
    ytd.startDate === startDate &&
    ytd.endDate === endDate &&
    closed.startDate !== startDate;
  // Another feature (owner insights, report viewer) already serves this key:
  // one question has one answer (DASH-02), so yield instead of redefining it.
  if (hasMockReportRun(input.reportCode, [], input.period)) continue;
  runs[`${input.reportCode}|${startDate}|${endDate}`] = run(
    input.reportCode,
    input.period,
    isRunning ? runningFigures : isYtd ? yearToDate : closedMonth,
    !isRunning,
  );
}
registerMockReportRuns(runs);

const emptyProfitShare = {
  shareholderId: accounting.myProfitShare.shareholderId,
  shareholderName: accounting.myProfitShare.shareholderName,
  holdings: [],
  shareHistory: [],
  distributionHistory: [],
  estimates: [],
};

// F35: only this shareholder's own rows (SH-01).
registerMock(getMyProfitShare, ({ scenario }) => ({
  data: scenario === "empty" ? emptyProfitShare : accounting.myProfitShare,
}));

// F35 documents: the API returns what shareholders may see; unpublished and
// management-only fixtures are filtered here like the server would (SH-02).
registerMock(listShareholderDocuments, ({ query, scenario }) =>
  paginateFixture(
    accounting.documents.filter(
      (doc) =>
        doc.visibility === "shareholders" &&
        doc.publishedAt !== null &&
        (query.profitEntityId === undefined ||
          doc.profitEntityId === query.profitEntityId) &&
        (query.kind === undefined || doc.kind === query.kind),
    ),
    query,
    (doc) => doc.id,
    scenario,
  ),
);
