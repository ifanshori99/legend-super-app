// Composition and value rules of the management home (PRD v1.7 §3.36
// "Dashboard Manajemen" → "Beranda per Role", bead legend-6na6). Pure
// functions, so the web kit and the Node tests read the same rules.
//
// Two contract sources and nothing else:
//   - the layout `GET /api/dashboards/management` returns (tiles, business
//     date, outlet scope, monitoring period) — the server already applied
//     TEN-03;
//   - each KPI tile's source report, run through `POST /api/reports/run` with
//     the same period and outlets, so a tile's number and its drill-down
//     cannot disagree (DASH-01/DASH-02).
// The kit never invents a queue, a metric or a number: a tile the caller may
// not see is dropped, a missing figure stays "no data" (never zero), and a
// role with no tiles renders an honest empty state.

import {
  dashboardTilePath,
  dashboardTileReport,
  MANAGEMENT_ROLES,
  reportMetricByCode,
  type DashboardLayout,
  type DashboardQueue,
  type DashboardSection,
  type DashboardTile,
  type ManagementRole,
  type MetricDashboardTile,
  type ReportPeriodPreset,
  type ReportResult,
  type ReportRunInput,
} from "@starter/shared/dashboard";
import type { MetricValue } from "@starter/shared/metrics";
import type { PermissionCode } from "@starter/shared/access";

/** Section a role's own work lives in (PRD "antrean kerjanya"). */
export const WORK_QUEUE_SECTION: DashboardSection = "work_queue";

/** The role's tiles plus the tiles every management home shows (role null). */
export function tilesForRole(
  tiles: readonly DashboardTile[],
  role: ManagementRole | null,
): readonly DashboardTile[] {
  return tiles.filter(
    (tile) => tile.managerRole === null || tile.managerRole === role,
  );
}

/**
 * Roles that actually have work in this layout, in the catalog's order. A real
 * API sends the caller's role only; mock mode sends the whole catalog, so the
 * switcher shows exactly the roles the payload can answer for.
 */
export function rolesInLayout(
  tiles: readonly DashboardTile[],
): readonly ManagementRole[] {
  const present = new Set<ManagementRole>();
  for (const tile of tiles)
    if (tile.managerRole !== null) present.add(tile.managerRole);
  return MANAGEMENT_ROLES.filter((role) => present.has(role));
}

/** The role a fresh page shows: the first role the layout offers. */
export function defaultRole(
  tiles: readonly DashboardTile[],
): ManagementRole | null {
  return rolesInLayout(tiles)[0] ?? null;
}

/**
 * RBAC in the UI (PRD §3.7): a tile that needs a permission the visitor does
 * not hold is not rendered. Presentation only — the API decides.
 */
export function isTilePermitted(
  tile: DashboardTile,
  permissions: readonly PermissionCode[],
): boolean {
  return tile.requiredPermissions.every((permission) =>
    permissions.includes(permission),
  );
}

export function permittedTiles(
  tiles: readonly DashboardTile[],
  permissions: readonly PermissionCode[],
): readonly DashboardTile[] {
  return tiles.filter((tile) => isTilePermitted(tile, permissions));
}

export function sectionTiles(
  tiles: readonly DashboardTile[],
  section: DashboardSection,
): readonly DashboardTile[] {
  return tiles.filter((tile) => tile.section === section);
}

/** Everything of one role's work queue: its KPI tile and its queue cards. */
export function roleWorkTiles(
  tiles: readonly DashboardTile[],
  role: ManagementRole | null,
): readonly DashboardTile[] {
  return sectionTiles(tilesForRole(tiles, role), WORK_QUEUE_SECTION);
}

/** The role's KPI tile (one per role in the catalog), the StatStrip's source. */
export function roleKpiTile(
  tiles: readonly DashboardTile[],
  role: ManagementRole | null,
): MetricDashboardTile | null {
  const tile = roleWorkTiles(tiles, role).find(
    (candidate): candidate is MetricDashboardTile =>
      candidate.kind === "metric",
  );
  return tile ?? null;
}

/** The role's queue cards: what the person actually works through. */
export function roleQueueTiles(
  tiles: readonly DashboardTile[],
  role: ManagementRole | null,
): readonly DashboardTile[] {
  return roleWorkTiles(tiles, role).filter((tile) => tile.kind === "queue");
}

/** Queue tiles of a shared section (the approval box). */
export function sectionQueueTiles(
  tiles: readonly DashboardTile[],
  section: DashboardSection,
): readonly DashboardTile[] {
  return sectionTiles(tiles, section).filter((tile) => tile.kind === "queue");
}

export function queueOf(tile: DashboardTile): DashboardQueue | null {
  return tile.kind === "queue" ? tile.queue : null;
}

/**
 * Whether the shared approval box is rendered. A role whose own work queue is
 * an approval queue already carries that inbox as a card (GM, purchasing,
 * finance, HR), so the box would be the same list twice; other roles
 * (outlet manager, kitchen lead, marketing) get it as a shared section
 * (PRD §3.36 "Kotak Approval").
 */
export function showsApprovalBox(
  roleQueue: readonly DashboardTile[],
  approvals: readonly DashboardTile[],
): boolean {
  return (
    approvals.length > 0 &&
    !roleQueue.some((tile) => queueOf(tile) === "approvals")
  );
}

export type ResolvedPeriod = {
  readonly startDate: string;
  readonly endDate: string;
  /** Catalog preset the tile defaults to (for its label). */
  readonly preset: ReportPeriodPreset;
};

/**
 * The period a KPI tile covers, anchored on the layout's business date. Only
 * the presets the management catalog uses are resolved here; anything else
 * falls back to the monitoring period the server already resolved, so the kit
 * never guesses dates the API owns.
 */
export function resolveTilePeriod(
  tile: MetricDashboardTile,
  layout: DashboardLayout,
): ResolvedPeriod {
  const { businessDate, monitoringPeriod } = layout;
  if (tile.period === "today")
    return {
      startDate: monitoringPeriod.startDate,
      endDate: monitoringPeriod.endDate,
      preset: "today",
    };
  if (tile.period === "this_month")
    // Month to date: the first day of the business date's month until it.
    return {
      startDate: `${businessDate.slice(0, 7)}-01`,
      endDate: businessDate,
      preset: "this_month",
    };
  return {
    startDate: monitoringPeriod.startDate,
    endDate: monitoringPeriod.endDate,
    preset: tile.period,
  };
}

/**
 * The source report run behind one KPI tile: unsplit (one total row), same
 * period and outlets as the dashboard (DASH-02).
 */
export function kpiRunInput(
  tile: MetricDashboardTile,
  layout: DashboardLayout,
): ReportRunInput {
  const period = resolveTilePeriod(tile, layout);
  return {
    reportCode: tile.reportCode,
    period: { startDate: period.startDate, endDate: period.endDate },
    outletIds: [...layout.availableOutlets],
    groupBy: [],
    filters: [],
    bucket: "total",
    limit: 100,
  };
}

/** DASH-01 drill-down of a tile: its report with the same period and outlets. */
export function tileDrillDownPath(
  tile: DashboardTile,
  layout: DashboardLayout,
): string | null {
  if (tile.kind !== "metric") return null;
  const period = resolveTilePeriod(tile, layout);
  return dashboardTilePath(tile, {
    startDate: period.startDate,
    endDate: period.endDate,
    outletIds: layout.availableOutlets,
  });
}

export function tileReportName(tile: DashboardTile): string | null {
  return dashboardTileReport(tile)?.name ?? null;
}

/** One cell of a run, by metric code. Null is "no data", never zero. */
export function metricValueOf(
  result: ReportResult | null | undefined,
  metricCode: string,
): MetricValue | null {
  if (!result) return null;
  for (const row of result.rows)
    for (const cell of row.values)
      if (cell.metricCode === metricCode) return cell.value;
  return null;
}

/** True when a run carries no number at all (the strip's empty state). */
export function isRunEmpty(result: ReportResult | null | undefined): boolean {
  if (!result) return true;
  return result.rows.every((row) =>
    row.values.every((cell) => cell.value === null),
  );
}

export type KpiLine = {
  readonly code: string;
  /** Registry name, e.g. "Penjualan bersih" (DASH-01). */
  readonly name: string;
  readonly value: MetricValue | null;
};

/** The registry rows a KPI tile cites, each with its run value. */
export function kpiLines(
  tile: MetricDashboardTile,
  result: ReportResult | null | undefined,
): readonly KpiLine[] {
  const lines: KpiLine[] = [];
  for (const code of tile.metricCodes) {
    const definition = reportMetricByCode.get(code);
    if (definition === undefined) continue;
    lines.push({
      code,
      name: definition.name,
      value: metricValueOf(result, code),
    });
  }
  return lines;
}

const percentFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const decimalFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Decimal4 percent string → "68,4" (the % sign is a catalog suffix). */
export function formatPercent(value: string): string {
  return percentFormat.format(Number(value));
}

/** Decimal4 string → "2,35", rounded for display only. */
export function formatDecimal(value: string): string {
  return decimalFormat.format(Number(value));
}

/** Seconds → whole minutes for the strip ("780" → 13). */
export function secondsToMinutes(seconds: number): number {
  return Math.max(0, Math.round(seconds / 60));
}

/**
 * True when the page was opened with a mock scenario (`?mock=empty|slow|…`).
 * The route loader then skips its prefetch, so the scenario reaches the
 * browser instead of being frozen into the server render (docs/frontend.md).
 */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
