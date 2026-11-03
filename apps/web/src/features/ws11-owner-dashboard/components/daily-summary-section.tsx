// PRD §3 F34 "Ringkasan Harian" (AI-10). The dashboard contract has a
// `daily_summary` queue but no payload yet, so no summary text is shown or
// invented. What this tab shows is the closing day's own figures from their
// source reports, plus an honest statement that the written summary is absent.
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { StatStrip } from "@/components/ui/stat-tile";
import { formatBusinessDate, ownerBoardTile, OWNER_TILE } from "../board";
import { useOwnerBoardContext } from "../board-context";
import { insightTile, INSIGHT_TILE } from "../insights";
import { KpiTile } from "./kpi-tile";

export function DailySummarySection() {
  const t = useT();
  const { layout } = useOwnerBoardContext();
  const summary = insightTile(layout, INSIGHT_TILE.dailySummary);
  const sales = ownerBoardTile(layout, OWNER_TILE.sales);
  const pax = ownerBoardTile(layout, OWNER_TILE.pax);
  const transactions = ownerBoardTile(layout, OWNER_TILE.transactions);
  const open = layout.monitoringPeriod.status !== "closed";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <CardShell>
        <CardShellBody className="gap-3 p-card">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="type-title">{t("ownerInsights.daily.title")}</h3>
            <Badge tone={open ? "info" : "success"}>
              {t(
                open
                  ? "ownerInsights.daily.open"
                  : "ownerInsights.daily.closed",
              )}
            </Badge>
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("ownerInsights.daily.date", {
              date: formatBusinessDate(layout.businessDate),
            })}
          </p>
          {summary === null ? null : (
            <EmptyState
              title={t("ownerInsights.daily.emptyTitle")}
              description={t("ownerInsights.daily.emptyHint")}
            />
          )}
        </CardShellBody>
      </CardShell>
      <StatStrip label={t("ownerInsights.daily.stripLabel")} columns={3}>
        {sales && (
          <KpiTile
            tile={sales}
            metricCode="net_sales"
            label={t("ownerInsights.daily.sales")}
          />
        )}
        {pax && (
          <KpiTile
            tile={pax}
            metricCode="pax"
            label={t("ownerInsights.daily.pax")}
          />
        )}
        {transactions && (
          <KpiTile
            tile={transactions}
            metricCode="transaction_count"
            label={t("ownerInsights.daily.transactions")}
          />
        )}
      </StatStrip>
    </div>
  );
}
