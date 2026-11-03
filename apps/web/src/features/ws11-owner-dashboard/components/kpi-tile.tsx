// A metric tile fed by its source report run: the label, value, period and
// source link of one catalog tile (DASH-01). Related metrics sit in one
// StatStrip (DESIGN.md v3 / Q30), so the tile styles only its inner content and
// the strip draws the hairlines. Loading and failure keep the cell shape.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import type { DashboardTile, ReportResult } from "@starter/shared/dashboard";
import { metricCell, tileReportCode } from "../board";
import { useOwnerBoardContext } from "../board-context";
import { StatMetricValue } from "./metric-display";
import { TileSource, useHasTileSource } from "./tile-source";

function MissingValue() {
  return (
    <span className="type-heading font-normal text-muted-foreground">—</span>
  );
}

export function KpiTile({
  tile,
  metricCode,
  label,
  context,
  contextFor,
  valueSuffix,
}: {
  tile: DashboardTile;
  /** The tile's own metric code, e.g. "pax". */
  metricCode: string;
  label: string;
  /** Secondary fact, without the period prefix (e.g. "Belanja per tamu Rp 50.135"). */
  context?: string;
  /** Secondary fact that needs another metric from the same report run. */
  contextFor?: (result: ReportResult | null) => string | undefined;
  /** Unit suffix for a decimal value, e.g. "×" or "GB". */
  valueSuffix?: string;
}): ReactNode {
  const t = useT();
  const hasSource = useHasTileSource(tile);
  const board = useOwnerBoardContext();
  const state = board.report(tileReportCode(tile));
  const period = t("ownerDashboard.todayShort");

  if (state.status === "loading")
    return (
      <StatTile
        label={label}
        value={<Skeleton className="h-7 w-24" />}
        context={period}
      />
    );
  if (state.status === "error")
    return (
      <StatTile
        label={label}
        value={<MissingValue />}
        context={t("ownerDashboard.loadFailed")}
      />
    );

  const value = metricCell(state.result, metricCode);
  const contextText = contextFor ? contextFor(state.result) : context;
  return (
    <StatTile
      label={label}
      value={
        value === null ? (
          <MissingValue />
        ) : (
          <StatMetricValue value={value} suffix={valueSuffix} />
        )
      }
      context={[period, contextText].filter(Boolean).join(" · ")}
      source={hasSource ? <TileSource tile={tile} /> : undefined}
    />
  );
}
