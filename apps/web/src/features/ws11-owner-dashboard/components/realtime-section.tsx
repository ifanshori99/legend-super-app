// PRD §3 F34 "Ringkasan Real-time": today's sales against the target, guests,
// average spend, table occupancy and turnover, and sales per channel. Every
// number comes from the tile's source report (DASH-01/DASH-02).
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardTile } from "@starter/shared/dashboard";
import {
  channelMessageKey,
  countOf,
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
} from "../board";
import { useOwnerBoardContext } from "../board-context";
import { BoardEmpty, WidgetErrorCard } from "./board-widget";
import { BoardTable } from "./board-table";
import { KpiTile } from "./kpi-tile";
import { MetricCellView } from "./metric-display";
import { TileSource } from "./tile-source";

function SalesHero({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const board = useOwnerBoardContext();
  const state = board.report(tile.reportCode);
  if (state.status === "loading")
    return (
      <Card className="min-w-0 gap-3" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-2 w-full" />
      </Card>
    );
  if (state.status === "error")
    return <WidgetErrorCard retry={state.retry} />;

  const netSalesIdr = idrOf(metricCell(state.result, "net_sales"));
  const targetIdr = idrOf(metricCell(state.result, "sales_target"));
  const achievement = percentOf(
    metricCell(state.result, "target_achievement_pct"),
  );

  return (
    <Card className="min-w-0 gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="grid gap-1">
          <p className="text-sm leading-5 font-medium text-muted-foreground">
            {t("ownerDashboard.realtime.salesLabel")}
          </p>
          {netSalesIdr === null ? (
            <p className="text-2xl leading-8 font-semibold text-muted-foreground">
              —
            </p>
          ) : (
            <Money amount={netSalesIdr} size="xl" />
          )}
        </div>
        <div className="grid gap-1 text-right">
          <p className="text-sm leading-5 text-muted-foreground">
            {t("ownerDashboard.realtime.targetLabel")}
          </p>
          {targetIdr === null ? (
            <p className="tabular text-muted-foreground">—</p>
          ) : (
            <Money amount={targetIdr} size="lg" className="font-semibold" />
          )}
        </div>
      </div>
      {achievement === null ? (
        <TileSource tile={tile} />
      ) : (
        <div className="grid gap-2">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Number(achievement))}
            aria-label={t("ownerDashboard.realtime.progressLabel")}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{
                width: `${Math.min(100, Math.max(0, Number(achievement)))}%`,
              }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p className="text-sm leading-5 text-muted-foreground">
              {t("ownerDashboard.realtime.achievement", {
                percent: `${formatPercent(achievement)}%`,
              })}
            </p>
            <TileSource tile={tile} />
          </div>
        </div>
      )}
    </Card>
  );
}

function ChannelTable({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const board = useOwnerBoardContext();
  const state = board.report(tile.reportCode);
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
            <TableHead numeric>
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
            const label = messageKey
              ? t(messageKey)
              : (row.label ?? t("common.more"));
            return (
              <TableRow key={row.label ?? "unknown"}>
                <TableCell className="font-medium">{label}</TableCell>
                <TableCell numeric>
                  <MetricCellView value={row.values.get("net_sales") ?? null} />
                </TableCell>
                <TableCell numeric>
                  <MetricCellView value={row.values.get("pax") ?? null} />
                </TableCell>
                <TableCell numeric>
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
      {salesTile && <SalesHero tile={salesTile} />}

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        {paxTile && (
          <PaxTile tile={paxTile} label={t("ownerDashboard.realtime.pax")} />
        )}
        {transactionsTile && (
          <TransactionsTile
            tile={transactionsTile}
            label={t("ownerDashboard.realtime.transactions")}
          />
        )}
        {occupancyTile && (
          <OccupancyTile
            tile={occupancyTile}
            label={t("ownerDashboard.realtime.occupancy")}
          />
        )}
      </div>

      {channelsTile && <ChannelTable tile={channelsTile} />}
    </div>
  );
}

function PaxTile({ tile, label }: { tile: DashboardTile; label: string }) {
  const t = useT();
  const state = useOwnerBoardContext().report(tile.reportCode);
  if (state.status === "loading")
    return (
      <StatTile
        label={label}
        value={<Skeleton className="h-8 w-16" />}
        className="min-w-0"
      />
    );
  if (state.status === "error")
    return <WidgetErrorCard retry={state.retry} />;
  const pax = countOf(metricCell(state.result, "pax"));
  const avgSpend = idrOf(metricCell(state.result, "avg_spend_per_pax"));
  return (
    <StatTile
      label={label}
      value={
        pax === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <NumberDisplay value={pax} className="text-[length:inherit]" />
        )
      }
      context={
        <>
          {t("ownerDashboard.todayShort")}
          {avgSpend === null ? null : (
            <>
              {" · "}
              {t("ownerDashboard.realtime.paxContext")}{" "}
              <Money amount={avgSpend} size="sm" />
            </>
          )}
        </>
      }
      source={<TileSource tile={tile} />}
      className="min-w-0"
    />
  );
}

function TransactionsTile({
  tile,
  label,
}: {
  tile: DashboardTile;
  label: string;
}) {
  const t = useT();
  const state = useOwnerBoardContext().report(tile.reportCode);
  if (state.status === "loading")
    return (
      <StatTile
        label={label}
        value={<Skeleton className="h-8 w-16" />}
        className="min-w-0"
      />
    );
  if (state.status === "error")
    return <WidgetErrorCard retry={state.retry} />;
  const transactions = countOf(metricCell(state.result, "transaction_count"));
  const avgTicket = idrOf(metricCell(state.result, "avg_ticket"));
  return (
    <StatTile
      label={label}
      value={
        transactions === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <NumberDisplay
            value={transactions}
            className="text-[length:inherit]"
          />
        )
      }
      context={
        <>
          {t("ownerDashboard.todayShort")}
          {avgTicket === null ? null : (
            <>
              {" · "}
              {t("ownerDashboard.realtime.transactionsContext")}{" "}
              <Money amount={avgTicket} size="sm" />
            </>
          )}
        </>
      }
      source={<TileSource tile={tile} />}
      className="min-w-0"
    />
  );
}

function OccupancyTile({ tile, label }: { tile: DashboardTile; label: string }) {
  const t = useT();
  const state = useOwnerBoardContext().report(tile.reportCode);
  if (state.status === "loading")
    return (
      <StatTile
        label={label}
        value={<Skeleton className="h-8 w-16" />}
        className="min-w-0"
      />
    );
  if (state.status === "error")
    return <WidgetErrorCard retry={state.retry} />;
  const occupancy = percentOf(metricCell(state.result, "table_occupancy_pct"));
  const turnover = decimalOf(metricCell(state.result, "table_turnover"));
  return (
    <StatTile
      label={label}
      value={
        occupancy === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="tabular">{formatPercent(occupancy)}%</span>
        )
      }
      context={
        <>
          {t("ownerDashboard.todayShort")}
          {turnover === null ? null : (
            <>
              {" · "}
              {t("ownerDashboard.realtime.occupancyContext", {
                count: formatDecimal(turnover),
              })}
            </>
          )}
        </>
      }
      source={<TileSource tile={tile} />}
      className="min-w-0"
    />
  );
}
