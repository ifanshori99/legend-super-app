// PRD §3 F34 "Multi-outlet": the running month of every outlet in the owner's
// scope side by side. `sales.per_channel` is read once per outlet (the report
// splits by channel, not outlet) with the board's channel split, and each row
// adds that outlet's channels up, so it matches the channel table (DASH-02).
import { useT } from "@/components/i18n";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  idrOf,
  OWNER_BOARD_GROUP_BY,
  sharePercent,
  tileReportCode,
} from "../board";
import { useOwnerBoardContext } from "../board-context";
import { combineReports, useReportRuns } from "../hooks";
import {
  insightRunInput,
  insightTile,
  insightTileGroupBy,
  INSIGHT_TILE,
  monthLong,
  runningMonth,
  summedCell,
} from "../insights";
import { BoardTable } from "./board-table";
import { MetricCellView } from "./metric-display";
import { TileSource } from "./tile-source";

export function MultiOutletSection() {
  const t = useT();
  const { layout } = useOwnerBoardContext();
  const tile = insightTile(layout, INSIGHT_TILE.multiOutlet);
  const code =
    (tile === null ? null : tileReportCode(tile)) ?? "sales.per_channel";
  const groupBy =
    tile === null
      ? (OWNER_BOARD_GROUP_BY[code] ?? [])
      : insightTileGroupBy(tile);
  const period = runningMonth(layout.businessDate);
  const outlets = layout.availableOutlets;
  const reports = useReportRuns(
    outlets.map((id) =>
      insightRunInput(layout, code, period, { outletIds: [id], groupBy }),
    ),
  );
  const all = combineReports(reports);
  const totals = reports.map((report) =>
    idrOf(summedCell(report.result, "net_sales")),
  );
  const sum = totals.reduce<number>((acc, value) => acc + (value ?? 0), 0);
  const best = Math.max(...totals.map((value) => value ?? 0));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <BoardTable
        title={t("ownerInsights.multi.title")}
        description={t("ownerInsights.multi.hint", {
          period: monthLong(period.startDate),
        })}
        status={all.status}
        onRetry={all.retry}
        source={tile ? <TileSource tile={tile} /> : undefined}
      >
        <div className="grid gap-4 p-card">
          {/* One bar of 100% compares nothing; bars start at two outlets. */}
          {outlets.length > 1 && (
            <ul
              className="grid gap-2"
              aria-label={t("ownerInsights.multi.barsLabel")}
            >
              {outlets.map((id, index) => {
                const value = totals[index] ?? null;
                const width =
                  value === null || best === 0
                    ? 0
                    : Math.max(2, Math.round((value / best) * 100));
                return (
                  <li key={id} className="grid gap-1">
                    <span className="text-sm font-medium">
                      {t("ownerInsights.multi.outletN", { n: index + 1 })}
                    </span>
                    <span
                      className="block h-2 rounded-[3px] bg-surface-2"
                      aria-hidden="true"
                    >
                      <span
                        className="block h-2 rounded-[3px] bg-chart-accent"
                        style={{ width: `${width}%` }}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("ownerInsights.multi.outlet")}</TableHead>
                <TableHead numeric>{t("ownerInsights.multi.sales")}</TableHead>
                <TableHead numeric>{t("ownerInsights.multi.pax")}</TableHead>
                <TableHead numeric className="hidden sm:table-cell">
                  {t("ownerInsights.multi.transactions")}
                </TableHead>
                {/* At 390 the table keeps outlet, sales and guests in view. */}
                <TableHead numeric className="hidden sm:table-cell">
                  {t("ownerInsights.multi.share")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outlets.map((id, index) => {
                const result = reports[index]?.result ?? null;
                const value = totals[index] ?? null;
                const share = value === null ? null : sharePercent(value, sum);
                return (
                  <TableRow key={id}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {t("ownerInsights.multi.outletN", { n: index + 1 })}
                    </TableCell>
                    <TableCell numeric>
                      <MetricCellView value={summedCell(result, "net_sales")} />
                    </TableCell>
                    <TableCell numeric>
                      <MetricCellView value={summedCell(result, "pax")} />
                    </TableCell>
                    <TableCell numeric className="hidden sm:table-cell">
                      <MetricCellView
                        value={summedCell(result, "transaction_count")}
                      />
                    </TableCell>
                    <TableCell numeric className="hidden sm:table-cell">
                      {share === null
                        ? "—"
                        : t("ownerInsights.multi.shareValue", { value: share })}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {outlets.length < 2 && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("ownerInsights.multi.singleHint")}
            </p>
          )}
        </div>
      </BoardTable>
    </div>
  );
}
