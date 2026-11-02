// PRD §3 F34 "Shower Room": utilization, facility revenue, active
// subscriptions, and conversion to F&B. The per-unit status board is a staff
// facility screen (WS-09); this dashboard shows its source report instead of
// inventing unit rows, because the dashboard queue contract has no payload yet.
import { useT } from "@/components/i18n";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import type { DashboardTile } from "@starter/shared/dashboard";
import {
  countOf,
  metricCell,
  ownerBoardTile,
  OWNER_TILE,
} from "../board";
import { useOwnerBoardContext } from "../board-context";
import { BoardEmpty } from "./board-widget";
import { KpiTile } from "./kpi-tile";
import { TileSource } from "./tile-source";

function UnitStatusNote({ tile }: { tile: DashboardTile }) {
  const t = useT();
  return (
    <Card className="min-w-0 gap-2">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid gap-1">
          <CardTitle>{t("ownerDashboard.shower.unitsTitle")}</CardTitle>
          <CardDescription>
            {t("ownerDashboard.shower.unitsHint")}
          </CardDescription>
        </div>
        <TileSource tile={tile} />
      </div>
    </Card>
  );
}

export function ShowerSection() {
  const t = useT();
  const board = useOwnerBoardContext();
  const layout = board.layout;
  const statusTile = ownerBoardTile(layout, OWNER_TILE.showerStatus);
  const utilizationTile = ownerBoardTile(layout, OWNER_TILE.showerUtilization);
  const revenueTile = ownerBoardTile(layout, OWNER_TILE.showerRevenue);
  const subscriptionsTile = ownerBoardTile(
    layout,
    OWNER_TILE.showerSubscriptions,
  );
  const conversionTile = ownerBoardTile(layout, OWNER_TILE.showerConversion);

  const reportCodes = [
    ...new Set(
      [
        utilizationTile,
        revenueTile,
        subscriptionsTile,
        conversionTile,
        statusTile,
      ]
        .map((tile) => tile?.reportCode ?? null)
        .filter((code): code is string => code !== null),
    ),
  ];
  const allEmpty =
    reportCodes.length > 0 &&
    reportCodes.every((code) => board.report(code).status === "empty");
  if (allEmpty) return <BoardEmpty />;

  return (
    <div className="grid min-w-0 gap-4">
      {statusTile && <UnitStatusNote tile={statusTile} />}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {utilizationTile && (
          <KpiTile
            tile={utilizationTile}
            metricCode="shower_occupancy_pct"
            label={t("ownerDashboard.shower.utilization")}
            contextFor={(result) => {
              const sessions = countOf(metricCell(result, "shower_sessions"));
              return sessions === null
                ? null
                : t("ownerDashboard.shower.utilizationContext", {
                    count: sessions,
                  });
            }}
          />
        )}
        {revenueTile && (
          <KpiTile
            tile={revenueTile}
            metricCode="shower_revenue"
            label={t("ownerDashboard.shower.revenue")}
            context={t("ownerDashboard.shower.revenueContext")}
          />
        )}
        {subscriptionsTile && (
          <KpiTile
            tile={subscriptionsTile}
            metricCode="active_subscriptions"
            label={t("ownerDashboard.shower.subscriptions")}
            context={t("ownerDashboard.shower.subscriptionsContext")}
          />
        )}
        {conversionTile && (
          <KpiTile
            tile={conversionTile}
            metricCode="shower_fnb_conversion_pct"
            label={t("ownerDashboard.shower.conversion")}
            contextFor={(result) => {
              const sessions = countOf(
                metricCell(result, "shower_sessions_with_fnb"),
              );
              return sessions === null
                ? null
                : t("ownerDashboard.shower.conversionContext", {
                    count: sessions,
                  });
            }}
          />
        )}
      </div>
    </div>
  );
}
