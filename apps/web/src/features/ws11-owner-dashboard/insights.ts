// Pure view model of the owner dashboard, part 2 (bead legend-gb03; PRD v1.7
// §3 F34 "Biaya & Margin", "Kualitas Layanan", "Keuangan", "Peringatan",
// "Ringkasan Harian", "Multi-outlet"). Same rules as part 1 (board.ts): a tile
// cites its source report (DASH-01) and every number is a run of that report
// with the tile's own period and split (DASH-02). No React and no browser API,
// so tests/ws11-owner-dashboard.test.mjs can load this file with Node.
import type {
  DashboardLayout,
  DashboardTile,
  ReportResult,
  ReportRunInput,
} from "@starter/shared/dashboard";
import type { MetricFinality } from "@starter/shared/metrics";
import { tileReportCode } from "./board.ts";

/** Sections added by part 2. */
export const OWNER_INSIGHT_SECTIONS = [
  "cost_margin",
  "service_quality",
  "finance",
  "alerts",
  "daily_summary",
  "multi_outlet",
] as const;
export type OwnerInsightSection = (typeof OWNER_INSIGHT_SECTIONS)[number];

/** Catalog keys of the part-2 tiles. */
export const INSIGHT_TILE = {
  foodCost: "owner.food_cost",
  laborCost: "owner.labor_cost",
  primeCost: "owner.prime_cost",
  waste: "owner.waste",
  promoCost: "owner.promo_cost",
  failedItems: "owner.failed_items",
  remakeComp: "owner.remake_comp",
  apologyVouchers: "owner.apology_vouchers",
  checklist: "owner.checklist_compliance",
  cashPosition: "owner.cash_position",
  supplierDue: "owner.supplier_due",
  pendingSettlement: "owner.pending_settlement",
  incomeStatement: "owner.income_statement",
  alerts: "owner.alerts",
  criticalStock: "owner.critical_stock",
  devices: "owner.devices",
  dailySummary: "owner.daily_summary",
  multiOutlet: "owner.multi_outlet",
} as const;

/** One tile by its catalog key, or null when the layout does not carry it. */
export function insightTile(
  layout: DashboardLayout,
  key: string,
): DashboardTile | null {
  return layout.tiles.find((tile) => tile.key === key) ?? null;
}

export function insightTilesOf(
  layout: DashboardLayout,
  section: OwnerInsightSection,
): readonly DashboardTile[] {
  return layout.tiles.filter((tile) => tile.section === section);
}

// ---- Periods ------------------------------------------------------------------

export type InsightPeriod = {
  startDate: string;
  endDate: string;
  /** True for a calendar month the books are closed for. */
  closed: boolean;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Month periods ending at the business date's month, oldest first. The last
 * one is the running month (month to date, an estimate); the others are whole
 * closed months. Dates are business dates, so the math stays in UTC.
 */
export function monthPeriods(businessDate: string, count = 4): InsightPeriod[] {
  const [year = 1970, month = 1] = businessDate.split("-").map(Number);
  const periods: InsightPeriod[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const first = new Date(Date.UTC(year, month - 1 - back, 1));
    const y = first.getUTCFullYear();
    const m = first.getUTCMonth() + 1;
    const startDate = `${y}-${pad(m)}-01`;
    if (back === 0) {
      periods.push({ startDate, endDate: businessDate, closed: false });
    } else {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      periods.push({
        startDate,
        endDate: `${y}-${pad(m)}-${pad(last)}`,
        closed: true,
      });
    }
  }
  return periods;
}

/** The running month, month to date. */
export function runningMonth(businessDate: string): InsightPeriod {
  return monthPeriods(businessDate, 1)[0] as InsightPeriod;
}

/** The month before the running one (closed, official). */
export function previousMonth(businessDate: string): InsightPeriod {
  return monthPeriods(businessDate, 2)[0] as InsightPeriod;
}

/** The dashboard's own monitoring day (the tiles whose period is "today"). */
export function monitoringDay(layout: DashboardLayout): InsightPeriod {
  return {
    startDate: layout.monitoringPeriod.startDate,
    endDate: layout.monitoringPeriod.endDate,
    closed: layout.monitoringPeriod.status === "closed",
  };
}

/** The period a part-2 tile describes: its preset, resolved on the layout. */
export function insightTilePeriod(
  tile: DashboardTile,
  layout: DashboardLayout,
): InsightPeriod {
  if (tile.kind === "metric" && tile.period === "this_month")
    return runningMonth(layout.businessDate);
  return monitoringDay(layout);
}

/** The run of one report over a period, unsplit unless a split is given. */
export function insightRunInput(
  layout: DashboardLayout,
  reportCode: string,
  period: Pick<InsightPeriod, "startDate" | "endDate">,
  options: {
    groupBy?: readonly string[];
    outletIds?: DashboardLayout["availableOutlets"];
  } = {},
): ReportRunInput {
  return {
    reportCode,
    period: { startDate: period.startDate, endDate: period.endDate },
    outletIds: [...(options.outletIds ?? layout.availableOutlets)],
    groupBy: [...(options.groupBy ?? [])],
    filters: [],
    bucket: "total",
    limit: 100,
  };
}

/** The run a part-2 tile shows: its report over its own period. */
export function insightTileRunInput(
  tile: DashboardTile,
  layout: DashboardLayout,
): ReportRunInput | null {
  const code = tileReportCode(tile);
  if (code === null) return null;
  return insightRunInput(layout, code, insightTilePeriod(tile, layout));
}

/** Months of the cost and margin trend, oldest first (running month last). */
export const TREND_MONTHS = 4;

// ---- Reading results ------------------------------------------------------------

/**
 * Finality of one metric in an unsplit run. A running period is an estimate
 * (SH-02); anything the run does not say counts as an estimate, never final.
 */
export function cellFinality(
  result: ReportResult | null | undefined,
  metricCode: string,
): MetricFinality {
  if (!result) return "estimate";
  for (const row of result.rows)
    for (const cell of row.values)
      if (cell.metricCode === metricCode) return cell.finality;
  return "estimate";
}

/** True when every number the run carries is an official (final) figure. */
export function isResultFinal(
  result: ReportResult | null | undefined,
): boolean {
  if (!result || result.rows.length === 0) return false;
  return result.rows.every((row) =>
    row.values.every(
      (cell) => cell.value === null || cell.finality === "final",
    ),
  );
}

/** A percent-point change between two Decimal4 percent strings, or null. */
export function pointChange(
  current: string | null,
  previous: string | null,
): number | null {
  if (current === null || previous === null) return null;
  const diff = Number(current) - Number(previous);
  return Number.isFinite(diff) ? Math.round(diff * 10) / 10 : null;
}

/** Relative change of two whole-rupiah amounts in percent; null on a zero base. */
export function relativeChange(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

const monthLabelFormat = new Intl.DateTimeFormat("id-ID", {
  month: "short",
  timeZone: "UTC",
});
const monthLongFormat = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "Okt" for a period starting in October. */
export function monthShort(startDate: string): string {
  return monthLabelFormat.format(new Date(`${startDate}T00:00:00Z`));
}

/** "Oktober 2026". */
export function monthLong(startDate: string): string {
  return monthLongFormat.format(new Date(`${startDate}T00:00:00Z`));
}

const signedFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

/** A change as "+1,2" / "−0,8" / "0". */
export function formatSigned(value: number): string {
  return signedFormat.format(value);
}
