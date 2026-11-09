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
  buildProfitShareEstimate,
  cafeLegendAccountingFixtures,
  createShareholderDocumentSignedUrl,
  getMyProfitShare,
  listShareholderDocuments,
} from "@starter/shared/accounting";
import { idr as wholeRupiah } from "@starter/shared/core";
import {
  cafeLegendDashboardFixtures,
  dashboardLayoutSchema,
  reportByCode,
  reportMetricByCode,
  ownerBoardGeneratedAt,
  reportResultSchema,
  SHAREHOLDER_DASHBOARD_TILES,
  type ReportResult,
} from "@starter/shared/dashboard";
import {
  metricDefinitionRefSchema,
  type MetricValue,
} from "@starter/shared/metrics";
import { ownerMonthIncomes } from "../ws11-owner-dashboard/insights-mock.ts";
import { ApiError } from "../../lib/api/errors.ts";
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
// The same instant and business day as the owner board and the management
// home (legend-zc3g): every WS-11 screen describes 1 November 2026.
const generatedAt = ownerBoardGeneratedAt;
const businessDate = cafeLegendDashboardFixtures.businessDate;

export const shareholderLayoutFixture = dashboardLayoutSchema.parse({
  dashboard: "shareholder",
  title: "Dashboard Shareholder",
  businessDate,
  availableOutlets: [outletId],
  tiles: SHAREHOLDER_DASHBOARD_TILES,
  generatedAt,
  monitoringPeriod: {
    // Month to date: the running accounting period is an MTD estimate, never
    // a projection of the full month (legend-zc3g).
    startDate: `${businessDate.slice(0, 7)}-01`,
    endDate: businessDate,
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
// It is January..July (below) plus the closed months the owner insights
// already serve (August..October), so YTD and the owner's monthly figures
// reconcile by construction (legend-zc3g).
const JAN_JUL = {
  netSales: 2_305_000_000,
  cogs: 786_059_600,
  netProfit: 722_600_000,
} as const;
const closedOwnerMonths = ownerMonthIncomes.filter((month) => month.closed);
const sumOwner = (
  pick: (month: (typeof closedOwnerMonths)[number]) => number,
) => closedOwnerMonths.reduce((sum, month) => sum + pick(month), 0);
const ytdNetSales = JAN_JUL.netSales + sumOwner((month) => month.netSales);
const ytdCogs = JAN_JUL.cogs + sumOwner((month) => month.cogs);
const yearToDate: Record<string, MetricValue> = {
  net_sales: idr(ytdNetSales),
  cogs: idr(ytdCogs),
  gross_profit: idr(ytdNetSales - ytdCogs),
  net_profit: idr(JAN_JUL.netProfit + sumOwner((month) => month.netProfit)),
};
// The running period is month to date and an estimate. It is the owner
// insights' running month (the same income statement, same period), so the
// owner board and the shareholder board show one number for it.
const runningMonth = ownerMonthIncomes.find((month) => !month.closed);
if (runningMonth === undefined)
  throw new Error("Owner insights have no running month.");
const runningFigures: Record<string, MetricValue> = {
  net_sales: idr(runningMonth.netSales),
  gross_profit: idr(runningMonth.grossProfit),
  net_profit: idr(runningMonth.netProfit),
  cogs: idr(runningMonth.cogs),
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
    bucket: "total",
    outletFilter: { kind: "outlets", outletIds: [outletId] },
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
  if (hasMockReportRun(input.reportCode, [], input.period, input.outletIds))
    continue;
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

// The accounting fixture's November estimate (Rp120.000.000) is a whole-month
// figure; the running period is month to date, so the personal estimate is
// rebuilt from the same MTD net profit as the running income statement above
// (legend-zc3g): one estimate, one number.
const myProfitShare = {
  ...accounting.myProfitShare,
  estimates: accounting.myProfitShare.estimates.map((estimate) =>
    buildProfitShareEstimate({
      profitEntity: {
        id: estimate.profitEntityId,
        name: estimate.profitEntityName,
      },
      period: estimate.period,
      shareBp: estimate.shareBp,
      estimatedNetProfitIdr: wholeRupiah(runningMonth.netProfit),
      asOf: generatedAt,
    }),
  ),
};

// F35: only this shareholder's own rows (SH-01).
registerMock(getMyProfitShare, ({ scenario }) => ({
  data: scenario === "empty" ? emptyProfitShare : myProfitShare,
}));

// F35 documents: the API returns what shareholders may see; unpublished and
// management-only fixtures are filtered here like the server would (SH-02).
const isShareholderDocument = (doc: (typeof accounting.documents)[number]) =>
  doc.visibility === "shareholders" && doc.publishedAt !== null;

registerMock(listShareholderDocuments, ({ query, scenario }) =>
  paginateFixture(
    accounting.documents.filter(
      (doc) =>
        isShareholderDocument(doc) &&
        (query.profitEntityId === undefined ||
          doc.profitEntityId === query.profitEntityId) &&
        (query.kind === undefined || doc.kind === query.kind),
    ),
    query,
    (doc) => doc.id,
    scenario,
  ),
);

// F35 download (legend-135u): a signed URL only for a document the list above
// shows; anything else is "not found", like the server (SH-01, SH-02). The URL
// is a stand-in that lives 300 s, like the real one.
registerMock(createShareholderDocumentSignedUrl, ({ params }) => {
  const doc = accounting.documents.find(
    (row) => row.id === params.shareholderDocumentId,
  );
  if (!doc || !isShareholderDocument(doc))
    throw new ApiError(404, "NOT_FOUND", "Dokumen tidak ditemukan.");
  return {
    data: {
      url: `https://files.mock.legend.test/${doc.id}.pdf?expires=300`,
      expiresAt: new Date(Date.parse(generatedAt) + 300_000).toISOString(),
    },
  };
});
