// PRD §3 F34 "Shower Room": utilization, facility revenue, active
// subscriptions, and conversion to F&B. The per-unit status board is a staff
// facility screen (WS-09); this dashboard shows its source report instead of
// inventing unit rows, because the dashboard queue contract has no payload yet.
import { useT } from "@/components/i18n";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import { StatStrip } from "@/components/ui/stat-tile";
import type { DashboardTile } from "@starter/shared/dashboard";
import {
  countOf,
  metricCell,
  ownerBoardTile,
  OWNER_TILE,
  tileReportCode,
} from "../board";
import { useOwnerBoardContext } from "../board-context";
import { BoardEmpty } from "./board-widget";
import { KpiTile } from "./kpi-tile";
import { TileSource } from "./tile-source";

function UnitStatusNote({ tile }: { tile: DashboardTile }) {
  const t = useT();
  return (
    <CardShell>
      <CardShellBody className="gap-1 p-card">
        <h3 className="type-title">{t("ownerDashboard.shower.unitsTitle")}</h3>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("ownerDashboard.shower.unitsHint")}
        </p>
      </CardShellBody>
      <CardShellFooter>
        <TileSource
          tile={tile}
          className="font-semibold text-primary underline-offset-4 hover:underline"
        />
      </CardShellFooter>
    </CardShell>
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
        .map((tile) => (tile === null ? null : tileReportCode(tile)))
        .filter((code): code is string => code !== null),
    ),
  ];
  const allEmpty =
    reportCodes.length > 0 &&
    reportCodes.every((code) => board.report(code).status === "empty");
  if (allEmpty) return <BoardEmpty />;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      {statusTile && <UnitStatusNote tile={statusTile} />}

      <StatStrip label={t("ownerDashboard.shower.stripLabel")} columns={4}>
        {utilizationTile && (
          <KpiTile
            tile={utilizationTile}
            metricCode="shower_occupancy_pct"
            label={t("ownerDashboard.shower.utilization")}
            contextFor={(result) => {
              const sessions = countOf(metricCell(result, "shower_sessions"));
              return sessions === null
                ? undefined
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
                ? undefined
                : t("ownerDashboard.shower.conversionContext", {
                    count: sessions,
                  });
            }}
          />
        )}
      </StatStrip>
    </div>
  );
}
