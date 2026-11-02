// Composition rules of the management home (PRD v1.7 §3.36 "Dashboard
// Manajemen" → "Beranda per Role", bead legend-6na6). Pure functions so the
// contract server, the web kit and the Node tests read the same rules.
//
// The home is assembled from two sources of truth and nothing else:
//   - the layout `GET /api/dashboards/management` returns (tiles, business
//     date, outlet scope) — the server already applied TEN-03;
//   - the tile catalog in `@starter/shared/dashboard` (one role per tile,
//     extra permissions, section) — the same rows the API filters by.
// The kit never invents a queue, a metric or a number: a tile the caller may
// not see is dropped, and a role with no tiles renders an honest empty state.

import {
  MANAGEMENT_ROLES,
  reportMetricByCode,
  type DashboardLayout,
  type DashboardQueue,
  type DashboardSection,
  type DashboardTile,
  type ManagementRole,
} from "@starter/shared/dashboard";
import type { PermissionCode } from "@starter/shared/access";

/** Section a role's own work lives in (PRD "antrean kerjanya"). */
export const WORK_QUEUE_SECTION: DashboardSection = "work_queue";

/** Shared sections below the role queue; not owned by any one role. */
export const SHARED_SECTIONS: readonly DashboardSection[] = [
  "approvals",
  "reports",
];

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
 * RBAC in the UI (PRD §3.7, RBAC §3.7): a tile that needs a permission the
 * visitor does not hold is not rendered. Presentation only — the API decides.
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

/** Work-queue tiles of one role: its KPI and queue cards, without the shared
 * approval/report cards (those render in their own sections). */
export function roleWorkTiles(
  tiles: readonly DashboardTile[],
  role: ManagementRole | null,
): readonly DashboardTile[] {
  return sectionTiles(tilesForRole(tiles, role), WORK_QUEUE_SECTION);
}

export type MetricLine = {
  readonly code: string;
  /** Registry name, e.g. "Saldo kas" (DASH-01: the number's definition). */
  readonly name: string;
  readonly unit: "idr" | "count" | "percent" | "decimal" | "seconds";
};

/**
 * The registry rows a metric tile cites (DASH-01). Displaying the definitions
 * on the card keeps the tile honest while the metric values come from the
 * dashboard API; an unknown code is dropped rather than shown as a raw code.
 */
export function metricLines(tile: DashboardTile): readonly MetricLine[] {
  if (tile.kind !== "metric") return [];
  const lines: MetricLine[] = [];
  for (const code of tile.metricCodes) {
    const definition = reportMetricByCode.get(code);
    if (definition === undefined) continue;
    lines.push({ code, name: definition.name, unit: definition.unit });
  }
  return lines;
}

/** Queue tiles report which list they render; used for the card's subtitle. */
export function queueOf(tile: DashboardTile): DashboardQueue | null {
  return tile.kind === "queue" ? tile.queue : null;
}

/**
 * Section groups of a layout in render order. Empty groups are dropped, so the
 * page never shows a heading over nothing.
 */
export function layoutSections(
  layout: DashboardLayout,
  permissions: readonly PermissionCode[],
): readonly {
  readonly section: DashboardSection;
  readonly tiles: readonly DashboardTile[];
}[] {
  const visible = permittedTiles(layout.tiles, permissions);
  const order: readonly DashboardSection[] = [
    WORK_QUEUE_SECTION,
    ...SHARED_SECTIONS,
  ];
  return order
    .map((section) => ({ section, tiles: sectionTiles(visible, section) }))
    .filter((group) => group.tiles.length > 0);
}

/**
 * True when the page was opened with a mock scenario (`?mock=empty|slow|…`).
 * The route loader then skips its prefetch, so the scenario reaches the
 * browser instead of being frozen into the server render
 * (docs/frontend.md §4; the same guard the menu screens use).
 */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
