// DASH-01: every number links to the report that produced it, with the same
// period, outlets and split, so the owner can trace a figure (PRD §3 F34).
import { useT } from "@/components/i18n";
import type { DashboardTile } from "@starter/shared/dashboard";
import { ownerBoardTilePath, ownerBoardTileReportName } from "../board";
import { useOwnerBoardContext } from "../board-context";

export function TileSource({
  tile,
  className,
}: {
  tile: DashboardTile;
  className?: string;
}) {
  const t = useT();
  const { layout } = useOwnerBoardContext();
  const path = ownerBoardTilePath(tile, layout);
  const reportName = ownerBoardTileReportName(tile);
  if (path === null || reportName === null) return null;
  return (
    <a
      href={path}
      aria-label={t("ownerDashboard.sourceAria", { report: reportName })}
      className={
        className ??
        "text-sm font-semibold text-primary underline underline-offset-4"
      }
    >
      {t("ownerDashboard.source", { report: reportName })}
    </a>
  );
}
