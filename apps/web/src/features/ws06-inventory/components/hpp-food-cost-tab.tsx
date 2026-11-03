// Actual vs theoretical food cost (PRD §17 "Food Cost Aktual vs Teoretis"):
// one comparison per period, the explained parts of the variance (waste,
// adjustment, off-recipe usage), a quiet bar chart, and the same numbers as a
// table (DESIGN.md §10: the table is the chart's text alternative).
import * as React from "react";
import { useT } from "@/components/i18n";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFoodCost } from "../hpp-hooks";
import { formatRupiah } from "@starter/shared/i18n";
import { foodCostPeriodLabel, sortFoodCost, type HppPeriod } from "../hpp-lib";
import { FoodCostChart, type FoodCostBar } from "./hpp-food-cost-chart";
import { SignedMoney } from "./hpp-signed-money";

export function HppFoodCostTab({ period }: { period: HppPeriod }) {
  const t = useT();
  const query = useFoodCost(period);

  const rows = React.useMemo(
    () => sortFoodCost(query.data?.data ?? []),
    [query.data],
  );

  const state: DataState = query.isPending
    ? "loading"
    : query.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  if (state !== "ready") {
    return (
      <DataTableShell
        title={t("inventoryHpp.foodCost.title")}
        description={t("inventoryHpp.foodCost.description")}
        state={state}
        onRetry={() => void query.refetch()}
        empty={{
          title: t("inventoryHpp.foodCost.emptyTitle"),
          description: t("inventoryHpp.foodCost.emptyHint"),
        }}
        loadingRows={4}
      />
    );
  }

  const latest = rows[0];
  const latestPeriod = latest ? foodCostPeriodLabel(latest) : "";
  const bars: FoodCostBar[] = latest
    ? [
        {
          key: "theoretical",
          label: t("inventoryHpp.foodCost.legend.theoretical"),
          value: latest.theoreticalCostIdr,
          tone: "neutral",
        },
        {
          key: "actual",
          label: t("inventoryHpp.foodCost.legend.actual"),
          value: latest.actualCostIdr,
          tone: "accent",
        },
      ]
    : [];

  return (
    <div className="grid min-w-0 gap-4">
      <CardShell>
        <CardShellBody className="gap-3 p-card">
          <div className="grid gap-0.5">
            <p className="type-eyebrow text-muted-foreground">{latestPeriod}</p>
            <h3 className="type-title">
              {t("inventoryHpp.foodCost.chartTitle")}
            </h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryHpp.foodCost.chartHint")}
            </p>
          </div>
          <FoodCostChart
            bars={bars}
            ariaLabel={t("inventoryHpp.foodCost.chartAria", {
              period: latestPeriod,
              theoretical: latest
                ? formatRupiah(latest.theoreticalCostIdr)
                : "",
              actual: latest ? formatRupiah(latest.actualCostIdr) : "",
            })}
          />
        </CardShellBody>
        <CardShellFooter>{t("inventoryHpp.foodCost.footer")}</CardShellFooter>
      </CardShell>

      <DataTableShell
        title={t("inventoryHpp.foodCost.title")}
        description={t("inventoryHpp.foodCost.description")}
        state="ready"
        rowCount={rows.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("inventoryHpp.foodCost.columns.period")}</TableHead>
              <TableHead numeric>
                {t("inventoryHpp.foodCost.columns.theoretical")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryHpp.foodCost.columns.actual")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryHpp.foodCost.columns.variance")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryHpp.foodCost.columns.waste")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryHpp.foodCost.columns.adjustment")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryHpp.foodCost.columns.offRecipe")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.outletId}:${row.fromDate}:${row.toDate}`}>
                <TableCell className="whitespace-nowrap font-medium">
                  {foodCostPeriodLabel(row)}
                </TableCell>
                <TableCell numeric>
                  <Money amount={row.theoreticalCostIdr} />
                </TableCell>
                <TableCell numeric>
                  <Money amount={row.actualCostIdr} />
                </TableCell>
                <TableCell numeric>
                  <SignedMoney amount={row.varianceIdr} />
                </TableCell>
                <TableCell numeric>
                  <Money amount={row.wasteIdr} />
                </TableCell>
                <TableCell numeric>
                  <SignedMoney amount={row.adjustmentIdr} />
                </TableCell>
                <TableCell numeric>
                  <Money amount={row.offRecipeUsageIdr} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
