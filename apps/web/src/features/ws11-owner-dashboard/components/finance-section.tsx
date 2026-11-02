// PRD §3 F34 "Keuangan": cash and bank, supplier dues, pending gateway
// settlements, and the running income statement. The running month's P&L is
// labelled an estimate (SH-02); the last closed month is the official figure.
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { StatStrip } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { idrOf, metricCell } from "../board";
import { useOwnerBoardContext } from "../board-context";
import { useNamedRuns } from "../insights-hooks";
import { formatRupiah } from "@starter/shared/i18n";
import {
  cellFinality,
  insightRunInput,
  insightTile,
  INSIGHT_TILE,
  monitoringDay,
  monthLong,
  monthPeriods,
} from "../insights";
import { tileReportCode } from "../board";
import { BoardEmpty, BoardError, TileSkeleton } from "./board-widget";
import { BoardTable } from "./board-table";
import { InsightTile } from "./insight-tile";
import { MetricCellView } from "./metric-display";
import { TileSource } from "./tile-source";

const STATEMENT_ROWS = [
  ["net_sales", "ownerInsights.finance.netSales"],
  ["cogs", "ownerInsights.finance.cogs"],
  ["gross_profit", "ownerInsights.finance.grossProfit"],
  ["net_profit", "ownerInsights.finance.netProfit"],
] as const;

export function FinanceSection() {
  const t = useT();
  const { layout } = useOwnerBoardContext();
  const cash = insightTile(layout, INSIGHT_TILE.cashPosition);
  const due = insightTile(layout, INSIGHT_TILE.supplierDue);
  const settlement = insightTile(layout, INSIGHT_TILE.pendingSettlement);
  const income = insightTile(layout, INSIGHT_TILE.incomeStatement);
  const day = monitoringDay(layout);
  const [previous, running] = monthPeriods(layout.businessDate, 2);
  const code = (tile: typeof cash, fallback: string) =>
    (tile === null ? null : tileReportCode(tile)) ?? fallback;
  const { runs, all } = useNamedRuns({
    cash: insightRunInput(layout, code(cash, "finance.cash_position"), day),
    due: insightRunInput(layout, code(due, "finance.supplier_due"), day),
    settlement: insightRunInput(
      layout,
      code(settlement, "finance.pending_settlement"),
      day,
    ),
    now: insightRunInput(
      layout,
      code(income, "finance.income_statement"),
      running!,
    ),
    before: insightRunInput(
      layout,
      code(income, "finance.income_statement"),
      previous!,
    ),
  });
  if (all.status === "error") return <BoardError retry={all.retry} />;
  if (all.status === "empty") return <BoardEmpty retry={all.retry} />;
  if (all.status === "loading")
    return (
      <div className="grid gap-5">
        <TileSkeleton />
        <TileSkeleton />
      </div>
    );
  const today = t("ownerDashboard.todayShort");
  const bank = idrOf(metricCell(runs.cash.result, "bank_balance"));
  const estimate = cellFinality(runs.now.result, "net_profit") !== "final";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <StatStrip label={t("ownerInsights.finance.stripLabel")} columns={3}>
        {cash && (
          <InsightTile
            tile={cash}
            state={runs.cash}
            metricCode="cash_balance"
            label={t("ownerInsights.finance.cash")}
            period={today}
            context={
              bank === null
                ? undefined
                : t("ownerInsights.finance.bankContext", {
                    amount: formatRupiah(bank),
                  })
            }
          />
        )}
        {due && (
          <InsightTile
            tile={due}
            state={runs.due}
            metricCode="supplier_due"
            label={t("ownerInsights.finance.due")}
            period={today}
            context={t("ownerInsights.finance.dueContext")}
          />
        )}
        {settlement && (
          <InsightTile
            tile={settlement}
            state={runs.settlement}
            metricCode="pending_settlement"
            label={t("ownerInsights.finance.settlement")}
            period={today}
            context={t("ownerInsights.finance.settlementContext")}
          />
        )}
      </StatStrip>

      <BoardTable
        title={t("ownerInsights.finance.statementTitle")}
        description={t(
          estimate
            ? "ownerInsights.finance.statementEstimateHint"
            : "ownerInsights.finance.statementFinalHint",
        )}
        status="ready"
        onRetry={all.retry}
        source={income ? <TileSource tile={income} /> : undefined}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("ownerInsights.finance.line")}</TableHead>
              <TableHead numeric>
                {monthLong(running!.startDate)}
                {estimate && (
                  <Badge tone="info" className="ms-2">
                    {t("ownerInsights.estimateTag")}
                  </Badge>
                )}
              </TableHead>
              <TableHead numeric className="hidden sm:table-cell">
                {monthLong(previous!.startDate)}
                <span className="ms-2 text-xs font-normal text-muted-foreground">
                  {t("ownerInsights.officialTag")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {STATEMENT_ROWS.map(([metric, label]) => (
              <TableRow key={metric}>
                <TableCell className="font-medium">{t(label)}</TableCell>
                <TableCell numeric>
                  <MetricCellView value={metricCell(runs.now.result, metric)} />
                </TableCell>
                <TableCell numeric className="hidden sm:table-cell">
                  <MetricCellView
                    value={metricCell(runs.before.result, metric)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </BoardTable>
    </div>
  );
}
