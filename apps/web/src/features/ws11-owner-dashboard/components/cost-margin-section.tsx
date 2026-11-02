// PRD §3 F34 "Biaya & Margin": food, labor and prime cost, waste and promo cost
// for the running month against the last closed month, plus a four-month trend
// of prime cost and a month table with gross and net profit. The running month
// is an estimate until the books close (SH-02); closed months are official.
import { useT } from "@/components/i18n";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatStrip } from "@/components/ui/stat-tile";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { DashboardTile } from "@starter/shared/dashboard";
import { formatPercent, idrOf, metricCell, percentOf } from "../board";
import { useOwnerBoardContext } from "../board-context";
import { useNamedRuns } from "../insights-hooks";
import {
  cellFinality,
  formatSigned,
  insightRunInput,
  insightTile,
  INSIGHT_TILE,
  monthPeriods,
  monthShort,
  pointChange,
  relativeChange,
  TREND_MONTHS,
} from "../insights";
import { BoardEmpty, BoardError, TileSkeleton } from "./board-widget";
import { BoardTable } from "./board-table";
import { InsightTile } from "./insight-tile";
import { MetricCellView } from "./metric-display";
import { TileSource } from "./tile-source";
import { TrendChart, type TrendPoint } from "./trend-chart";

export function CostMarginSection() {
  const t = useT();
  const { layout } = useOwnerBoardContext();
  const months = monthPeriods(layout.businessDate, TREND_MONTHS);
  const running = months[months.length - 1];
  const previous = months[months.length - 2];
  const tiles = {
    food: insightTile(layout, INSIGHT_TILE.foodCost),
    labor: insightTile(layout, INSIGHT_TILE.laborCost),
    prime: insightTile(layout, INSIGHT_TILE.primeCost),
    waste: insightTile(layout, INSIGHT_TILE.waste),
    promo: insightTile(layout, INSIGHT_TILE.promoCost),
    income: insightTile(layout, INSIGHT_TILE.incomeStatement),
  };
  // Hooks need stable inputs; a period always exists for TREND_MONTHS >= 2.
  const period = (index: number) => months[index] ?? running!;
  const reportOf = (tile: DashboardTile | null, fallback: string) =>
    tile !== null && "reportCode" in tile && tile.reportCode
      ? tile.reportCode
      : fallback;
  const food = reportOf(tiles.food, "inventory.food_cost");
  const labor = reportOf(tiles.labor, "payroll.labor_cost");
  const prime = reportOf(tiles.prime, "finance.prime_cost");
  const waste = reportOf(tiles.waste, "inventory.waste");
  const promo = reportOf(tiles.promo, "crm.promo_cost");
  const income = reportOf(tiles.income, "finance.income_statement");
  const monthRun = (code: string, index: number) =>
    insightRunInput(layout, code, period(index));
  const last = months.length - 1;
  const { runs, all } = useNamedRuns({
    foodNow: monthRun(food, last),
    foodPrev: monthRun(food, last - 1),
    laborNow: monthRun(labor, last),
    laborPrev: monthRun(labor, last - 1),
    primeNow: monthRun(prime, last),
    primePrev: monthRun(prime, last - 1),
    wasteNow: monthRun(waste, last),
    wastePrev: monthRun(waste, last - 1),
    promoNow: monthRun(promo, last),
    promoPrev: monthRun(promo, last - 1),
    prime0: monthRun(prime, 0),
    prime1: monthRun(prime, 1),
    prime2: monthRun(prime, 2),
    income0: monthRun(income, 0),
    income1: monthRun(income, 1),
    income2: monthRun(income, 2),
    income3: monthRun(income, 3),
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

  const nowLabel = t("ownerInsights.cost.runningMonth", {
    month: monthShort(running!.startDate),
  });
  const prevName = previous ? monthShort(previous.startDate) : "";
  const pctContext = (
    nowCode: string,
    now: typeof runs.foodNow,
    prev: typeof runs.foodPrev,
  ) => {
    const before = percentOf(metricCell(prev.result, nowCode));
    const change = pointChange(
      percentOf(metricCell(now.result, nowCode)),
      before,
    );
    if (before === null) return undefined;
    return t("ownerInsights.cost.vsPercent", {
      month: prevName,
      value: formatPercent(before),
      change:
        change === null
          ? ""
          : t("ownerInsights.cost.points", { value: formatSigned(change) }),
    });
  };
  const idrContext = (
    code: string,
    now: typeof runs.foodNow,
    prev: typeof runs.foodPrev,
  ) => {
    const before = idrOf(metricCell(prev.result, code));
    if (before === null) return undefined;
    const change = relativeChange(idrOf(metricCell(now.result, code)), before);
    return t("ownerInsights.cost.vsAmount", {
      month: prevName,
      change: change === null ? "" : `${formatSigned(change)}%`,
    });
  };

  const trendPoints: TrendPoint[] = [
    runs.prime0,
    runs.prime1,
    runs.prime2,
    runs.primeNow,
  ].map((report, index) => {
    const value = percentOf(metricCell(report.result, "prime_cost_pct"));
    return {
      label: monthShort(period(index).startDate),
      value: value === null ? null : Number(value),
      estimate: !period(index).closed,
      text: value === null ? "" : `${formatPercent(value)}%`,
    };
  });
  const incomeRuns = [runs.income0, runs.income1, runs.income2, runs.income3];
  const primeRuns = [runs.prime0, runs.prime1, runs.prime2, runs.primeNow];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <StatStrip label={t("ownerInsights.cost.stripLabel")} columns={3}>
        {tiles.food && (
          <InsightTile
            tile={tiles.food}
            state={runs.foodNow}
            metricCode="food_cost_pct"
            label={t("ownerInsights.cost.food")}
            period={nowLabel}
            flagEstimate
            context={pctContext("food_cost_pct", runs.foodNow, runs.foodPrev)}
          />
        )}
        {tiles.labor && (
          <InsightTile
            tile={tiles.labor}
            state={runs.laborNow}
            metricCode="labor_cost_pct"
            label={t("ownerInsights.cost.labor")}
            period={nowLabel}
            flagEstimate
            context={pctContext(
              "labor_cost_pct",
              runs.laborNow,
              runs.laborPrev,
            )}
          />
        )}
        {tiles.prime && (
          <InsightTile
            tile={tiles.prime}
            state={runs.primeNow}
            metricCode="prime_cost_pct"
            label={t("ownerInsights.cost.prime")}
            period={nowLabel}
            flagEstimate
            context={pctContext(
              "prime_cost_pct",
              runs.primeNow,
              runs.primePrev,
            )}
          />
        )}
      </StatStrip>

      <StatStrip label={t("ownerInsights.cost.leakStripLabel")} columns={2}>
        {tiles.waste && (
          <InsightTile
            tile={tiles.waste}
            state={runs.wasteNow}
            metricCode="waste_cost"
            label={t("ownerInsights.cost.waste")}
            period={nowLabel}
            flagEstimate
            context={idrContext("waste_cost", runs.wasteNow, runs.wastePrev)}
          />
        )}
        {tiles.promo && (
          <InsightTile
            tile={tiles.promo}
            state={runs.promoNow}
            metricCode="promo_cost"
            label={t("ownerInsights.cost.promo")}
            period={nowLabel}
            flagEstimate
            context={idrContext("promo_cost", runs.promoNow, runs.promoPrev)}
          />
        )}
      </StatStrip>

      <CardShell>
        <CardShellBody className="gap-3 p-card">
          <div className="grid gap-0.5">
            <p className="type-eyebrow text-muted-foreground">
              {t("ownerInsights.cost.trendEyebrow", { count: TREND_MONTHS })}
            </p>
            <h3 className="type-title">{t("ownerInsights.cost.trendTitle")}</h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("ownerInsights.cost.trendHint")}
            </p>
          </div>
          <TrendChart
            points={trendPoints}
            ariaLabel={t("ownerInsights.cost.trendAria")}
          />
        </CardShellBody>
        <CardShellFooter>
          {tiles.prime && <TileSource tile={tiles.prime} />}
        </CardShellFooter>
      </CardShell>

      <BoardTable
        title={t("ownerInsights.cost.tableTitle")}
        description={t("ownerInsights.cost.tableHint")}
        status="ready"
        onRetry={all.retry}
        source={tiles.income ? <TileSource tile={tiles.income} /> : undefined}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("ownerInsights.cost.month")}</TableHead>
              <TableHead numeric>{t("ownerInsights.cost.food")}</TableHead>
              <TableHead numeric>{t("ownerInsights.cost.labor")}</TableHead>
              <TableHead numeric>{t("ownerInsights.cost.prime")}</TableHead>
              <TableHead numeric className="hidden sm:table-cell">
                {t("ownerInsights.cost.grossProfit")}
              </TableHead>
              <TableHead numeric className="hidden sm:table-cell">
                {t("ownerInsights.cost.netProfit")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {months.map((month, index) => {
              const primeResult = primeRuns[index]?.result ?? null;
              const incomeResult = incomeRuns[index]?.result ?? null;
              const estimate =
                cellFinality(primeResult, "prime_cost_pct") !== "final";
              return (
                <TableRow key={month.startDate}>
                  <TableCell className="font-medium">
                    {monthShort(month.startDate)}
                    {estimate && (
                      <Badge tone="info" className="ms-2">
                        {t("ownerInsights.estimateTag")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell numeric>
                    <MetricCellView
                      value={metricCell(primeResult, "food_cost_pct")}
                    />
                  </TableCell>
                  <TableCell numeric>
                    <MetricCellView
                      value={metricCell(primeResult, "labor_cost_pct")}
                    />
                  </TableCell>
                  <TableCell numeric>
                    <MetricCellView
                      value={metricCell(primeResult, "prime_cost_pct")}
                    />
                  </TableCell>
                  <TableCell numeric className="hidden sm:table-cell">
                    <MetricCellView
                      value={metricCell(incomeResult, "gross_profit")}
                    />
                  </TableCell>
                  <TableCell numeric className="hidden sm:table-cell">
                    <MetricCellView
                      value={metricCell(incomeResult, "net_profit")}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </BoardTable>
    </div>
  );
}
