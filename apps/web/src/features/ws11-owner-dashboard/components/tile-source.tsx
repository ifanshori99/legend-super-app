// DASH-01: every number links to the report that produced it, with the same
// period, outlets and split, so the owner can trace a figure (PRD §3 F34).
// DESIGN.md v3 StatTile adds the chevron; the link text is the report name.
import { useT } from "@/components/i18n";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useRouteAvailable } from "@/lib/use-route-available";
import { reportPathIsComingSoon } from "@/features/ws11-reports/lib";
import type { DashboardTile } from "@starter/shared/dashboard";
import { ownerBoardTilePath, ownerBoardTileReportName } from "../board";
import { useOwnerBoardContext } from "../board-context";

/**
 * Whether a tile has a source link to render: a report name and an existing
 * route. A StatTile draws its chevron for any `source`, so callers pass one only
 * when this is true (no orphan chevron next to an absent link).
 */
export function useHasTileSource(tile: DashboardTile): boolean {
  const routeAvailable = useRouteAvailable();
  const { layout } = useOwnerBoardContext();
  const path = ownerBoardTilePath(tile, layout);
  return (
    path !== null &&
    ownerBoardTileReportName(tile) !== null &&
    routeAvailable(path)
  );
}

export function TileSource({
  tile,
  className,
}: {
  tile: DashboardTile;
  className?: string;
}) {
  const t = useT();
  const routeAvailable = useRouteAvailable();
  const { layout } = useOwnerBoardContext();
  const path = ownerBoardTilePath(tile, layout);
  const reportName = ownerBoardTileReportName(tile);
  if (path === null || reportName === null) return null;
  // Family without server data yet: same "Segera hadir" as the catalog.
  if (
    reportPathIsComingSoon(path.split(/[?#]/, 1)[0] ?? path, { mock: API_MOCK })
  )
    return (
      <span className={className ?? "text-muted-foreground"}>
        {reportName} · {t("reportViewer.catalog.soon")}
      </span>
    );
  // No report viewer route yet (legend-tp3x): no link that lands on a 404.
  if (!routeAvailable(path)) return null;
  return (
    <a
      href={path}
      aria-label={t("ownerDashboard.sourceAria", { report: reportName })}
      className={
        className ??
        "font-semibold text-primary underline-offset-4 hover:underline"
      }
    >
      {reportName}
    </a>
  );
}
