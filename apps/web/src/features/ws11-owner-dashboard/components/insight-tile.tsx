// A metric tile of the part-2 sections: label, value, period/finality line and
// the DASH-01 source link. It reads its own run (the part-1 KpiTile reads the
// board's shared day runs), and keeps the cell shape while loading or failed.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import type { DashboardTile } from "@starter/shared/dashboard";
import { metricCell } from "../board";
import { cellFinality } from "../insights";
import type { BoardReport } from "../hooks";
import { StatMetricValue } from "./metric-display";
import { TileSource } from "./tile-source";

export function InsightTile({
  tile,
  state,
  metricCode,
  label,
  period,
  context,
  flagEstimate = false,
}: {
  tile: DashboardTile;
  state: BoardReport;
  metricCode: string;
  label: string;
  /** "Hari ini" or "November 2026"; the first part of the context line. */
  period: string;
  /** Secondary fact, appended after the period. */
  context?: string | undefined;
  /** Running-period figure: append the "estimasi" label when not final. */
  flagEstimate?: boolean;
}): ReactNode {
  const t = useT();
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
        value={
          <span className="type-heading font-normal text-muted-foreground">
            —
          </span>
        }
        context={t("ownerDashboard.loadFailed")}
      />
    );
  const value = metricCell(state.result, metricCode);
  const estimate =
    flagEstimate && cellFinality(state.result, metricCode) !== "final"
      ? t("ownerInsights.estimateTag")
      : undefined;
  return (
    <StatTile
      label={label}
      value={
        value === null ? (
          <span className="type-heading font-normal text-muted-foreground">
            —
          </span>
        ) : (
          <StatMetricValue value={value} />
        )
      }
      context={[period, estimate, context].filter(Boolean).join(" · ")}
      source={<TileSource tile={tile} />}
    />
  );
}
