// Pure view model of the shareholder dashboard (bead legend-ik9g; PRD v1.7 §3
// F35, §4 Alur O, SH-01, SH-02). Official figures come only from CLOSED
// periods; the running period is always labelled estimate. No React and no
// browser API, so tests/ws11-shareholder.test.mjs can load this file in Node.
import {
  REPORT_AGGREGATE_VIEW_PERMISSION,
  dashboardTileReport,
  reportAcceptsAggregateView,
  reportPermittedFor,
  type DashboardLayout,
  type DashboardTile,
  type ReportResult,
  type ReportRunInput,
} from "@starter/shared/dashboard";
import type { MetricValue } from "@starter/shared/metrics";
import type {
  MyProfitShare,
  ShareholderDocument,
} from "@starter/shared/accounting";

export type SharePeriod = { startDate: string; endDate: string };

/** Tiles per strip, in display order (catalog keys). */
export const STRIP_RESULT_KEYS = [
  "shareholder.revenue",
  "shareholder.gross_profit",
  "shareholder.ebitda",
  "shareholder.net_profit",
] as const;
export const STRIP_CASH_KEYS = [
  "shareholder.cash_position",
  "shareholder.pax",
] as const;
export const KPI_MONTH_KEY = "shareholder.kpi_month";
export const KPI_YTD_KEY = "shareholder.kpi_ytd";
export const PROFIT_SHARE_KEY = "shareholder.profit_share";
export const DOCUMENTS_KEY = "shareholder.documents";

/** The running-period estimate is the income statement of the open period. */
export const RUNNING_ESTIMATE_REPORT = "finance.income_statement";
export const RUNNING_ESTIMATE_METRICS = [
  "net_sales",
  "gross_profit",
  "net_profit",
] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The latest closed month before the running period (SH-02). */
export function closedPeriodOf(layout: DashboardLayout): SharePeriod {
  const monitoring = layout.monitoringPeriod;
  if (monitoring.status === "closed")
    return { startDate: monitoring.startDate, endDate: monitoring.endDate };
  const [year = 0, month = 1] = monitoring.startDate.split("-").map(Number);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return {
    startDate: `${prevYear}-${pad(prevMonth)}-01`,
    endDate: `${prevYear}-${pad(prevMonth)}-${pad(lastDay(prevYear, prevMonth))}`,
  };
}

/** Year-to-date counts closed periods only, so it ends with the closed month. */
export function ytdPeriodOf(layout: DashboardLayout): SharePeriod {
  const closed = closedPeriodOf(layout);
  return {
    startDate: `${closed.endDate.slice(0, 4)}-01-01`,
    endDate: closed.endDate,
  };
}

/** The open period, or null when everything is closed. */
export function runningPeriodOf(layout: DashboardLayout): SharePeriod | null {
  const monitoring = layout.monitoringPeriod;
  return monitoring.status === "open"
    ? { startDate: monitoring.startDate, endDate: monitoring.endDate }
    : null;
}

export function tileOf(
  layout: DashboardLayout,
  key: string,
): DashboardTile | null {
  return layout.tiles.find((tile) => tile.key === key) ?? null;
}

export function hasSection(layout: DashboardLayout, key: string): boolean {
  return tileOf(layout, key) !== null;
}

/** Period a business tile runs over. */
export function tilePeriod(
  layout: DashboardLayout,
  tile: DashboardTile,
): SharePeriod {
  return "period" in tile && tile.period === "year_to_date"
    ? ytdPeriodOf(layout)
    : closedPeriodOf(layout);
}

export function runInput(
  layout: DashboardLayout,
  reportCode: string,
  period: SharePeriod,
): ReportRunInput {
  return {
    reportCode,
    period: { startDate: period.startDate, endDate: period.endDate },
    outletIds: [...layout.availableOutlets],
    groupBy: [],
    filters: [],
    bucket: "total",
    limit: 100,
  };
}

export function runKey(input: ReportRunInput): string {
  return `${input.reportCode}|${input.period.startDate}|${input.period.endDate}`;
}

/** Every report run the business-condition tab needs, deduplicated. */
export function shareholderRunInputs(
  layout: DashboardLayout,
): ReportRunInput[] {
  const inputs = new Map<string, ReportRunInput>();
  for (const tile of layout.tiles) {
    if (tile.kind !== "metric" || tile.section !== "business_condition")
      continue;
    const input = runInput(layout, tile.reportCode, tilePeriod(layout, tile));
    inputs.set(runKey(input), input);
  }
  const running = runningPeriodOf(layout);
  if (running !== null && inputs.size > 0) {
    const input = runInput(layout, RUNNING_ESTIMATE_REPORT, running);
    inputs.set(runKey(input), input);
  }
  return [...inputs.values()];
}

/**
 * Drill-down link to a tile's source report. Report pages live in the kelola
 * area, which needs dashboard.management.view; a shareholder does not hold it.
 * The area guard lets report.aggregate.view open only the aggregate reports
 * (lib/areas/kelola-guard.ts, bead legend-5bjh), so the link shows for those
 * and stays hidden for any other report (SH-01: no employee, customer or
 * member split).
 */
export const REPORT_AREA_PERMISSION = "dashboard.management.view";

export function permittedReportPath(
  tile: DashboardTile,
  permissions: readonly string[],
): string | null {
  const report = dashboardTileReport(tile);
  if (report === null || !reportPermittedFor(report, permissions)) return null;
  if (permissions.includes(REPORT_AREA_PERMISSION)) return report.route;
  // No kelola area: only an aggregate report opens, on report.aggregate.view
  // (lib/areas/kelola-guard.ts, legend-5bjh).
  return reportAcceptsAggregateView(report) &&
    permissions.includes(REPORT_AGGREGATE_VIEW_PERMISSION)
    ? report.route
    : null;
}

export function metricCell(
  result: ReportResult | null | undefined,
  metricCode: string,
): MetricValue | null {
  if (!result) return null;
  for (const row of result.rows)
    for (const cell of row.values)
      if (cell.metricCode === metricCode) return cell.value;
  return null;
}

export function metricName(
  result: ReportResult | null | undefined,
  metricCode: string,
): string | null {
  return (
    result?.definitions.find((definition) => definition.code === metricCode)
      ?.name ?? null
  );
}

export function isReportResultEmpty(result: ReportResult): boolean {
  return (
    result.rows.length === 0 ||
    result.rows.every((row) => row.values.every((cell) => cell.value === null))
  );
}

/** SH-01: official only when the period is closed and every figure is final. */
export function isOfficial(result: ReportResult): boolean {
  return (
    result.period.status === "closed" &&
    result.period.accountingPeriodClosed &&
    result.rows.every((row) =>
      row.values.every(
        (cell) => cell.value === null || cell.finality === "final",
      ),
    )
  );
}

/** SH-02: own data only; a document shows only when published for shareholders. */
export function visibleDocuments(
  documents: readonly ShareholderDocument[],
): ShareholderDocument[] {
  return documents.filter(
    (doc) => doc.visibility === "shareholders" && doc.publishedAt !== null,
  );
}

export function isMyProfitShareEmpty(data: MyProfitShare): boolean {
  return (
    data.holdings.length === 0 &&
    data.shareHistory.length === 0 &&
    data.distributionHistory.length === 0 &&
    data.estimates.length === 0
  );
}

/** Entity names known from the caller's own rows. */
export function entityNames(data: MyProfitShare): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of data.holdings)
    names.set(row.profitEntityId, row.profitEntityName);
  for (const row of data.estimates)
    names.set(row.profitEntityId, row.profitEntityName);
  for (const row of data.distributionHistory)
    names.set(row.profitEntityId, row.profitEntityName);
  return names;
}

/** Newest period first; an adjustment sorts after its regular run. */
export function sortedDistributions(data: MyProfitShare) {
  return [...data.distributionHistory].sort((a, b) =>
    a.period === b.period
      ? a.runType === b.runType
        ? 0
        : a.runType === "adjustment"
          ? -1
          : 1
      : b.period.localeCompare(a.period),
  );
}

// ---- Formatting (id-ID, UTC date math: SSR and browser agree) --------------

const monthYear = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const shortMonthYear = new Intl.DateTimeFormat("id-ID", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const shortMonth = new Intl.DateTimeFormat("id-ID", {
  month: "short",
  timeZone: "UTC",
});
const dayMonthYear = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const dayMonth = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const clock = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Jakarta",
});
const instantDate = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Jakarta",
});

function at(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** "Oktober 2026", "Jan – Okt 2026", "1 – 5 Nov 2026" or "1 Nov 2026". */
export function formatPeriod(period: SharePeriod): string {
  if (period.startDate === period.endDate)
    return dayMonthYear.format(at(period.endDate));
  const start = at(period.startDate);
  const end = at(period.endDate);
  const [sy = 0, sm = 1, sd = 1] = period.startDate.split("-").map(Number);
  const [ey = 0, em = 1, ed = 1] = period.endDate.split("-").map(Number);
  const endsMonth = ed === lastDay(ey, em);
  if (sy === ey && sm === em && sd === 1 && endsMonth)
    return monthYear.format(start);
  if (sy === ey && sd === 1 && endsMonth)
    return `${shortMonth.format(start)} – ${shortMonthYear.format(end)}`;
  if (sy === ey && sm === em) return `${sd} – ${dayMonthYear.format(end)}`;
  return `${dayMonth.format(start)} – ${dayMonthYear.format(end)}`;
}

/** "2026-10" → "Oktober 2026". */
export function formatPeriodKey(key: string): string {
  return monthYear.format(at(`${key}-01`));
}

export function formatDate(businessDate: string): string {
  return dayMonthYear.format(at(businessDate));
}

export function formatInstantDate(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? "" : instantDate.format(date);
}

export function formatInstantTime(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? "" : clock.format(date);
}

const shareFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const percentFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});
const decimalFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** 2500 basis points → "25%". */
export function formatShareBp(bp: number): string {
  return `${shareFormat.format(bp / 100)}%`;
}
export function formatPercent(value: string): string {
  return percentFormat.format(Number(value));
}
export function formatDecimal(value: string): string {
  return decimalFormat.format(Number(value));
}
