// PRD §3 F34 "Ringkasan Real-time": today's sales against the target, guests,
// average spend, table occupancy and turnover, and sales per channel. Every
// number comes from the tile's source report (DASH-01/DASH-02).
// DESIGN.md v3: page title lives in the ManagementShell topbar, the hero is a
// CardShell, the related KPIs share one StatStrip.
import { useT } from "@/components/i18n";
import { formatRupiah } from "@starter/shared/i18n";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardTile } from "@starter/shared/dashboard";
import { ErrorState } from "@/components/ui/feedback-state";
import {
  channelMessageKey,
  decimalOf,
  formatDecimal,
  formatPercent,
  idrOf,
  metricCell,
  ownerBoardTile,
  OWNER_TILE,
  percentOf,
  reportRows,
  sharePercent,
  tileReportCode,
} from "../board";
import { useOwnerBoardContext } from "../board-context";
import { BoardEmpty } from "./board-widget";
import { BoardTable } from "./board-table";
import { KpiTile } from "./kpi-tile";
import { MetricCellView } from "./metric-display";
import { TileSource } from "./tile-source";

function SalesCard({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const board = useOwnerBoardContext();
  const state = board.report(tileReportCode(tile));

  if (state.status === "loading")
    return (
      <CardShell aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <CardShellBody className="gap-3 p-card">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-2 w-full" />
        </CardShellBody>
      </CardShell>
    );
  if (state.status === "error")
    return (
      <CardShell>
        <CardShellBody>
          <ErrorState onRetry={state.retry} />
        </CardShellBody>
      </CardShell>
    );

  const netSalesIdr = idrOf(metricCell(state.result, "net_sales"));
  const targetIdr = idrOf(metricCell(state.result, "sales_target"));
  const achievement = percentOf(
    metricCell(state.result, "target_achievement_pct"),
  );

  return (
    <CardShell>
      <CardShellBody className="gap-4 p-card">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="grid gap-1.5">
            <p className="type-eyebrow text-muted-foreground">
              {t("ownerDashboard.realtime.salesLabel")}
            </p>
            {netSalesIdr === null ? (
              <p className="type-money-display text-muted-foreground">—</p>
            ) : (
              <Money amount={netSalesIdr} size="stat" />
            )}
          </div>
          <div className="grid gap-1.5 text-right">
            <p className="type-eyebrow text-muted-foreground">
              {t("ownerDashboard.realtime.targetLabel")}
            </p>
            {targetIdr === null ? (
              <p className="type-money-display text-muted-foreground">—</p>
            ) : (
              <Money amount={targetIdr} size="stat" />
            )}
          </div>
        </div>
        {achievement === null ? null : (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Number(achievement))}
            aria-label={t("ownerDashboard.realtime.progressLabel")}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{
                width: `${Math.min(100, Math.max(0, Number(achievement)))}%`,
              }}
            />
          </div>
        )}
      </CardShellBody>
      <CardShellFooter>
        {achievement === null ? null : (
          <span className="tabular">
            {t("ownerDashboard.realtime.achievement", {
              percent: `${formatPercent(achievement)}%`,
            })}
          </span>
        )}
        <TileSource
          tile={tile}
          className="ms-auto font-semibold text-primary underline-offset-4 hover:underline"
        />
      </CardShellFooter>
    </CardShell>
  );
}

function ChannelTable({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const board = useOwnerBoardContext();
  const state = board.report(tileReportCode(tile));
  const rows = state.result
    ? reportRows(state.result, ["net_sales", "pax"])
    : [];
  const totalNetSales = rows.reduce(
    (sum, row) => sum + (idrOf(row.values.get("net_sales") ?? null) ?? 0),
    0,
  );

  return (
    <BoardTable
      title={t("ownerDashboard.realtime.channelTitle")}
      description={t("ownerDashboard.realtime.channelHint")}
      status={state.status}
      onRetry={state.retry}
      source={<TileSource tile={tile} />}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("ownerDashboard.realtime.channelColumn")}</TableHead>
            <TableHead numeric>
              {t("ownerDashboard.realtime.channelRevenue")}
            </TableHead>
            <TableHead numeric>
              {t("ownerDashboard.realtime.channelPax")}
            </TableHead>
            <TableHead numeric className="hidden sm:table-cell">
              {t("ownerDashboard.realtime.channelShare")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const netSales = idrOf(row.values.get("net_sales") ?? null);
            const share =
              netSales === null ? null : sharePercent(netSales, totalNetSales);
            const messageKey = row.label ? channelMessageKey(row.label) : null;
            const label = messageKey ? t(messageKey) : (row.label ?? "—");
            return (
              <TableRow key={row.label ?? "unknown"}>
                <TableCell className="font-medium">{label}</TableCell>
                <TableCell numeric>
                  <MetricCellView value={row.values.get("net_sales") ?? null} />
                </TableCell>
                <TableCell numeric>
                  <MetricCellView value={row.values.get("pax") ?? null} />
                </TableCell>
                <TableCell numeric className="hidden sm:table-cell">
                  {share === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className="tabular">
                      {formatPercent(String(share))}%
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </BoardTable>
  );
}

export function RealtimeSummarySection() {
  const t = useT();
  const board = useOwnerBoardContext();
  const layout = board.layout;
  const salesTile = ownerBoardTile(layout, OWNER_TILE.sales);
  const paxTile = ownerBoardTile(layout, OWNER_TILE.pax);
  const transactionsTile = ownerBoardTile(layout, OWNER_TILE.transactions);
  const occupancyTile = ownerBoardTile(layout, OWNER_TILE.occupancy);
  const channelsTile = ownerBoardTile(layout, OWNER_TILE.channels);

  const reportCodes = [
    ...new Set(
      [salesTile, paxTile, transactionsTile, occupancyTile, channelsTile]
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
      {salesTile && <SalesCard tile={salesTile} />}

      <StatStrip label={t("ownerDashboard.realtime.stripLabel")} columns={3}>
        {paxTile && (
          <KpiTile
            tile={paxTile}
            metricCode="pax"
            label={t("ownerDashboard.realtime.pax")}
            contextFor={(result) => {
              const spend = idrOf(metricCell(result, "avg_spend_per_pax"));
              return spend === null
                ? undefined
                : `${t("ownerDashboard.realtime.paxContext")} ${formatRupiah(spend)}`;
            }}
          />
        )}
        {transactionsTile && (
          <KpiTile
            tile={transactionsTile}
            metricCode="transaction_count"
            label={t("ownerDashboard.realtime.transactions")}
            contextFor={(result) => {
              const ticket = idrOf(metricCell(result, "avg_ticket"));
              return ticket === null
                ? undefined
                : `${t("ownerDashboard.realtime.transactionsContext")} ${formatRupiah(ticket)}`;
            }}
          />
        )}
        {occupancyTile && (
          <KpiTile
            tile={occupancyTile}
            metricCode="table_occupancy_pct"
            label={t("ownerDashboard.realtime.occupancy")}
            contextFor={(result) => {
              const turnover = decimalOf(metricCell(result, "table_turnover"));
              return turnover === null
                ? undefined
                : t("ownerDashboard.realtime.occupancyContext", {
                    count: formatDecimal(turnover),
                  });
            }}
          />
        )}
      </StatStrip>

      {channelsTile && <ChannelTable tile={channelsTile} />}
    </div>
  );
}
