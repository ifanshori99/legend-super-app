// PRD §3 F34 "Peringatan" (AI-09 anomalies): void rate and cash variance, items
// below par, and offline devices. The dashboard contract carries the counts of
// each source report, not an item list or a generated explanation, so this
// shows the counts and the report to open; it does not invent alert rows.
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { StatStrip } from "@/components/ui/stat-tile";
import { countOf, metricCell } from "../board";
import { useOwnerBoardContext } from "../board-context";
import { useNamedRuns } from "../insights-hooks";
import { insightTile, INSIGHT_TILE } from "../insights";
import { BoardEmpty, BoardError, TileSkeleton } from "./board-widget";
import { dayRunsFor } from "./day-runs";
import { InsightTile } from "./insight-tile";

export function AlertsSection() {
  const t = useT();
  const { layout } = useOwnerBoardContext();
  const keys = {
    alerts: INSIGHT_TILE.alerts,
    cashVariance: INSIGHT_TILE.alerts,
    stock: INSIGHT_TILE.criticalStock,
    devices: INSIGHT_TILE.devices,
  };
  const { runs, all } = useNamedRuns(
    dayRunsFor(layout, keys, {
      alerts: "operations.alerts",
      cashVariance: "operations.alerts",
      stock: "inventory.critical_stock",
      devices: "operations.devices",
    }),
  );
  if (all.status === "error") return <BoardError retry={all.retry} />;
  if (all.status === "empty") return <BoardEmpty retry={all.retry} />;
  if (all.status === "loading")
    return (
      <div className="grid gap-5">
        <TileSkeleton />
      </div>
    );
  const today = t("ownerDashboard.todayShort");
  const alerts = insightTile(layout, INSIGHT_TILE.alerts);
  const stock = insightTile(layout, INSIGHT_TILE.criticalStock);
  const devices = insightTile(layout, INSIGHT_TILE.devices);
  const stockCount = countOf(
    metricCell(runs.stock.result, "critical_stock_count"),
  );
  const deviceCount = countOf(
    metricCell(runs.devices.result, "device_offline_count"),
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <StatStrip label={t("ownerInsights.alerts.stripLabel")} columns={4}>
        {alerts && (
          <InsightTile
            tile={alerts}
            state={runs.alerts}
            metricCode="void_rate_pct"
            label={t("ownerInsights.alerts.voidRate")}
            period={today}
            context={t("ownerInsights.alerts.voidContext")}
          />
        )}
        {alerts && (
          <InsightTile
            tile={alerts}
            state={runs.cashVariance}
            metricCode="cash_variance"
            label={t("ownerInsights.alerts.cashVariance")}
            period={today}
            context={t("ownerInsights.alerts.cashContext")}
          />
        )}
        {stock && (
          <InsightTile
            tile={stock}
            state={runs.stock}
            metricCode="critical_stock_count"
            label={t("ownerInsights.alerts.stock")}
            period={today}
            context={
              stockCount === 0
                ? t("ownerInsights.alerts.none")
                : t("ownerInsights.alerts.stockContext")
            }
          />
        )}
        {devices && (
          <InsightTile
            tile={devices}
            state={runs.devices}
            metricCode="device_offline_count"
            label={t("ownerInsights.alerts.devices")}
            period={today}
            context={
              deviceCount === 0
                ? t("ownerInsights.alerts.none")
                : t("ownerInsights.alerts.devicesContext")
            }
          />
        )}
      </StatStrip>
      <CardShell>
        <CardShellBody className="gap-1 p-card">
          <h3 className="type-title">{t("ownerInsights.alerts.noteTitle")}</h3>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("ownerInsights.alerts.noteHint")}
          </p>
        </CardShellBody>
      </CardShell>
    </div>
  );
}
