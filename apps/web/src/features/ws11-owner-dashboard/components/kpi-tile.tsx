// A metric tile fed by its source report run: the label, value, period and
// source link of one catalog tile (DASH-01). Errors and loading stay inside
// the tile so the rest of the section keeps working.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { StatTile } from "@/components/ui/stat-tile";
import type { DashboardTile, ReportResult } from "@starter/shared/dashboard";
import { metricCell } from "../board";
import { useOwnerBoardContext } from "../board-context";
import { TileSkeleton, WidgetErrorCard } from "./board-widget";
import { MetricValueView } from "./metric-display";
import { TileSource } from "./tile-source";

export function KpiTile({
  tile,
  metricCode,
  label,
  context,
  contextFor,
}: {
  tile: DashboardTile;
  /** The tile's own metric code, e.g. "pax". */
  metricCode: string;
  label: string;
  /** Secondary fact shown under the value; "Hari ini ·" is prepended. */
  context?: ReactNode;
  /** Secondary fact that needs another metric from the same report run. */
  contextFor?: (result: ReportResult | null) => ReactNode;
}) {
  const t = useT();
  const board = useOwnerBoardContext();
  const state = board.report(tile.reportCode);
  if (state.status === "loading") return <TileSkeleton />;
  if (state.status === "error") return <WidgetErrorCard retry={state.retry} />;
  const value = metricCell(state.result, metricCode);
  const contextNode = contextFor ? contextFor(state.result) : context;
  return (
    <StatTile
      label={label}
      value={
        value === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <MetricValueView value={value} />
        )
      }
      context={
        <>
          {t("ownerDashboard.todayShort")}
          {contextNode ? <> · {contextNode}</> : null}
        </>
      }
      source={<TileSource tile={tile} />}
      className="min-w-0"
    />
  );
}
