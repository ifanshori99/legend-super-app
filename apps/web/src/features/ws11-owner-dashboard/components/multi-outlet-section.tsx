// PRD §3 F34 "Multi-outlet": the running month of every outlet in the owner's
// scope side by side. `sales.per_channel` is read once per outlet (the report
// splits by channel, not outlet), so each row is that outlet's own run.
import { useT } from "@/components/i18n";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { idrOf, metricCell, sharePercent, tileReportCode } from "../board";
import { useOwnerBoardContext } from "../board-context";
import { combineReports, useReportRuns } from "../hooks";
import {
  insightRunInput,
  insightTile,
  INSIGHT_TILE,
  monthLong,
  runningMonth,
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
  const period = runningMonth(layout.businessDate);
  const outlets = layout.availableOutlets;
  const reports = useReportRuns(
    outlets.map((id) =>
      insightRunInput(layout, code, period, { outletIds: [id] }),
    ),
  );
  const all = combineReports(reports);
  const totals = reports.map((report) =>
    idrOf(metricCell(report.result, "net_sales")),
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("ownerInsights.multi.outlet")}</TableHead>
                <TableHead numeric>{t("ownerInsights.multi.sales")}</TableHead>
                <TableHead numeric>{t("ownerInsights.multi.pax")}</TableHead>
                <TableHead numeric className="hidden sm:table-cell">
                  {t("ownerInsights.multi.transactions")}
                </TableHead>
                <TableHead numeric>{t("ownerInsights.multi.share")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outlets.map((id, index) => {
                const result = reports[index]?.result ?? null;
                const value = totals[index] ?? null;
                const share = value === null ? null : sharePercent(value, sum);
                return (
                  <TableRow key={id}>
                    <TableCell className="font-medium">
                      {t("ownerInsights.multi.outletN", { n: index + 1 })}
                    </TableCell>
                    <TableCell numeric>
                      <MetricCellView value={metricCell(result, "net_sales")} />
                    </TableCell>
                    <TableCell numeric>
                      <MetricCellView value={metricCell(result, "pax")} />
                    </TableCell>
                    <TableCell numeric className="hidden sm:table-cell">
                      <MetricCellView
                        value={metricCell(result, "transaction_count")}
                      />
                    </TableCell>
                    <TableCell numeric>
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
