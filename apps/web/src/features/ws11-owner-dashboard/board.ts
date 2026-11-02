// Pure view model of the owner dashboard, part 1 (bead legend-k8fk; PRD v1.7
// §3 F34 "Dashboard Owner": Ringkasan Real-time, Operasional, Shower Room,
// Kursi & WFC). Everything here is data-driven from the dashboard contract:
// a tile cites its metric definitions, period and source report (DASH-01), and
// the numbers come from running that source report with the same period,
// outlets and split (DASH-02). No React and no browser API, so
// tests/ws11-owner-dashboard.test.mjs can load this file with Node.
import {
  dashboardTilePath,
  dashboardTileReport,
  type DashboardLayout,
  type DashboardSection,
  type DashboardTile,
  type ReportResult,
  type ReportRunInput,
} from "@starter/shared/dashboard";
import type { MetricValue } from "@starter/shared/metrics";

/** Sections this screen owns; part 2 (legend-gb03) adds the rest. */
export const OWNER_BOARD_SECTIONS = [
  "realtime_summary",
  "operations",
  "shower",
  "seats_wfc",
] as const;
export type OwnerBoardSection = (typeof OWNER_BOARD_SECTIONS)[number];

/**
 * Split each source report is run with, so a table row and the tile that cites
 * the same report read one result (DASH-02). Reports without an entry are run
 * unsplit (one total row).
 */
export const OWNER_BOARD_GROUP_BY: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "sales.per_channel": ["channel"],
    "operations.serving_time": ["station"],
    "operations.kitchen_queue": ["station"],
    "operations.waiter_calls": ["zone"],
    "menu.best_sellers": ["menu_item"],
    "facility.revpash": ["zone"],
    "traffic.dwell_time": ["zone"],
  });

function isOwnerBoardSection(
  section: DashboardSection,
): section is OwnerBoardSection {
  return (OWNER_BOARD_SECTIONS as readonly string[]).includes(section);
}

/** Tiles of the sections this screen renders, in catalog order. */
export function ownerBoardTiles(
  layout: DashboardLayout,
): readonly DashboardTile[] {
  return layout.tiles.filter((tile) => isOwnerBoardSection(tile.section));
}

export function ownerBoardTilesOf(
  layout: DashboardLayout,
  section: OwnerBoardSection,
): readonly DashboardTile[] {
  return ownerBoardTiles(layout).filter((tile) => tile.section === section);
}

/** Catalog keys of the tiles this screen renders (PRD §3 F34). */
export const OWNER_TILE = {
  sales: "owner.today_sales",
  pax: "owner.pax_today",
  transactions: "owner.transactions_today",
  occupancy: "owner.table_occupancy",
  channels: "owner.sales_by_channel",
  servingTime: "owner.serving_time",
  kitchenQueue: "owner.kitchen_queue",
  bestSellers: "owner.best_sellers",
  soldOut: "owner.sold_out",
  waiterCalls: "owner.waiter_calls",
  rating: "owner.review_rating",
  latestReviews: "owner.latest_reviews",
  showerStatus: "owner.shower_status",
  showerUtilization: "owner.shower_utilization",
  showerRevenue: "owner.shower_revenue",
  showerSubscriptions: "owner.shower_subscriptions",
  showerConversion: "owner.shower_fnb_conversion",
  zoneOccupancy: "owner.zone_occupancy",
  dwellVsSpend: "owner.dwell_vs_spend",
  wifiUsage: "owner.wifi_usage",
} as const;

export type OwnerTileKey = (typeof OWNER_TILE)[keyof typeof OWNER_TILE];

/** One tile by its stable catalog key, e.g. `owner.today_sales`. */
export function ownerBoardTile(
  layout: DashboardLayout,
  key: string,
): DashboardTile | null {
  return layout.tiles.find((tile) => tile.key === key) ?? null;
}

/** Distinct source reports of the part-1 tiles, sorted for a stable order. */
export function ownerBoardReportCodes(layout: DashboardLayout): string[] {
  const codes = new Set<string>();
  for (const tile of ownerBoardTiles(layout))
    if (tile.reportCode !== null) codes.add(tile.reportCode);
  return [...codes].sort();
}

/** The run input of one report: same period and outlets as the dashboard. */
export function ownerBoardRunInput(
  layout: DashboardLayout,
  reportCode: string,
): ReportRunInput {
  return {
    reportCode,
    period: {
      startDate: layout.monitoringPeriod.startDate,
      endDate: layout.monitoringPeriod.endDate,
    },
    outletIds: [...layout.availableOutlets],
    groupBy: [...(OWNER_BOARD_GROUP_BY[reportCode] ?? [])],
    limit: 100,
  };
}

/** Every report run the part-1 sections need. */
export function ownerBoardRunInputs(layout: DashboardLayout): ReportRunInput[] {
  return ownerBoardReportCodes(layout).map((code) =>
    ownerBoardRunInput(layout, code),
  );
}

/** DASH-01 drill-down: the source report with the same period and outlets. */
export function ownerBoardTilePath(
  tile: DashboardTile,
  layout: DashboardLayout,
): string | null {
  const groupBy =
    tile.reportCode === null
      ? null
      : (OWNER_BOARD_GROUP_BY[tile.reportCode]?.[0] ?? null);
  return dashboardTilePath(tile, {
    startDate: layout.monitoringPeriod.startDate,
    endDate: layout.monitoringPeriod.endDate,
    outletIds: layout.availableOutlets,
    groupBy,
  });
}

export function ownerBoardTileReportName(tile: DashboardTile): string | null {
  return dashboardTileReport(tile)?.name ?? null;
}

/** One cell of a run, by metric code. Null is "no data", never zero. */
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

/** Typed readers: a cell only counts when its unit matches the definition. */
export function idrOf(value: MetricValue | null): number | null {
  return value !== null && value.unit === "idr" ? value.valueIdr : null;
}

export function countOf(value: MetricValue | null): number | null {
  return value !== null && value.unit === "count" ? value.value : null;
}

export function percentOf(value: MetricValue | null): string | null {
  return value !== null && value.unit === "percent" ? value.value : null;
}

export function decimalOf(value: MetricValue | null): string | null {
  return value !== null && value.unit === "decimal" ? value.value : null;
}

export function secondsOf(value: MetricValue | null): number | null {
  return value !== null && value.unit === "seconds" ? value.value : null;
}

/** True when a result carries no number at all (its empty state). */
export function isReportResultEmpty(result: ReportResult): boolean {
  return (
    result.rows.length === 0 ||
    result.rows.every((row) => row.values.every((cell) => cell.value === null))
  );
}

export type DimensionRow = {
  /** The split value, e.g. "qr" or "Dapur"; null for a total row. */
  label: string | null;
  values: ReadonlyMap<string, MetricValue | null>;
};

/** Rows of a grouped run in catalog order, one value per metric code. */
export function reportRows(
  result: ReportResult,
  metricCodes: readonly string[],
): DimensionRow[] {
  return result.rows.map((row) => ({
    label: row.dimensions[0]?.value ?? null,
    values: new Map(
      metricCodes.map((code) => [
        code,
        row.values.find((cell) => cell.metricCode === code)?.value ?? null,
      ]),
    ),
  }));
}

const CHANNEL_MESSAGE_KEYS = {
  qr: "ownerDashboard.realtime.channels.qr",
  pos: "ownerDashboard.realtime.channels.pos",
  captain: "ownerDashboard.realtime.channels.captain",
  gofood: "ownerDashboard.realtime.channels.gofood",
  grabfood: "ownerDashboard.realtime.channels.grabfood",
  shopeefood: "ownerDashboard.realtime.channels.shopeefood",
  reservation: "ownerDashboard.realtime.channels.reservation",
  kiosk: "ownerDashboard.realtime.channels.kiosk",
} as const;

export type ChannelMessageKey =
  (typeof CHANNEL_MESSAGE_KEYS)[keyof typeof CHANNEL_MESSAGE_KEYS];

/** Catalog label of a known sales channel; null for an unknown value. */
export function channelMessageKey(
  channel: string,
): ChannelMessageKey | null {
  return channel in CHANNEL_MESSAGE_KEYS
    ? CHANNEL_MESSAGE_KEYS[channel as keyof typeof CHANNEL_MESSAGE_KEYS]
    : null;
}

const percentFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const decimalFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Decimal4 percent string → "30,9" (the % sign is catalog text). */
export function formatPercent(value: string): string {
  return percentFormat.format(Number(value));
}

/** Decimal4 string → "1,84", rounded for display only. */
export function formatDecimal(value: string): string {
  return decimalFormat.format(Number(value));
}

/** Whole rupiah as a share of a total, in percent: 4150000/7420000 → 55.9. */
export function sharePercent(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((part / total) * 1000) / 10;
}

/** Seconds → whole minutes and leftover seconds for the catalog template. */
export function durationParts(seconds: number): {
  minutes: number;
  seconds: number;
} {
  const whole = Math.max(0, Math.round(seconds));
  return { minutes: Math.floor(whole / 60), seconds: whole % 60 };
}

/**
 * Outlet wall-clock zone until the outlet-context bead supplies the outlet's
 * own IANA zone (PRD: business dates in the outlet time zone). An explicit
 * zone keeps the server render and the browser render identical.
 */
export const OUTLET_TIME_ZONE = "Asia/Jakarta";

const businessDateFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const outletClockFormat = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: OUTLET_TIME_ZONE,
});

/** A business date (`2026-11-01`) as "1 November 2026". */
export function formatBusinessDate(businessDate: string): string {
  return businessDateFormat.format(new Date(`${businessDate}T00:00:00Z`));
}

/** A fetch instant as the outlet's wall-clock time, e.g. "11.40". */
export function formatOutletTime(instantMs: number): string {
  return outletClockFormat.format(new Date(instantMs));
}

const reviewDateFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: OUTLET_TIME_ZONE,
});

/** A review timestamp in the outlet's wall clock. */
export function formatReviewDate(isoDateTime: string): string {
  return reviewDateFormat.format(new Date(isoDateTime));
}
