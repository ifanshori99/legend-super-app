// TL-04 get_food_cost (bead legend-mfyo). Aggregate food cost (HPP snapshots of
// paid, non-voided lines) against net sales per outlet. Returns no unit costs,
// so a kitchen lead with only `recipe.manage` may call it. Final only when the
// accounting months are closed (metric officiality closed_period_only).
import {
  getFoodCostInputSchema,
  getFoodCostOutputSchema,
} from "@starter/shared/ai";
import {
  liveFinality,
  monthsOf,
  resolveOutletScope,
} from "../../ai-metrics/scope.ts";
import { queryFoodCost } from "../../ai-metrics/sales.ts";
import { accountingMonthsClosed } from "../../ai-metrics/finance.ts";
import type { AiToolHandler } from "../types.ts";
import { makeSource, maxRowsOf, percentOf } from "./shared.ts";

export const getFoodCost: AiToolHandler = async (ctx, raw) => {
  const input = getFoodCostInputSchema.parse(raw);
  const scope = await resolveOutletScope(ctx, "TL-04", input.outletIds);
  const outletIds = scope.outlets.map((outlet) => outlet.id);
  const data = await queryFoodCost(scope.context, {
    outletIds,
    from: input.period.from,
    to: input.period.to,
  });
  const names = new Map(scope.outlets.map((o) => [o.id.toLowerCase(), o.name]));
  const all = data.map((row) => ({
    outletId: row.outletId,
    outletName: names.get(row.outletId.toLowerCase()) ?? row.outletId,
    foodCostIdr: row.foodCostIdr,
    netSalesIdr: row.netSalesIdr,
    foodCostPct: percentOf(row.foodCostIdr, row.netSalesIdr),
  }));
  const foodCostIdr = all.reduce((sum, row) => sum + row.foodCostIdr, 0);
  const netSalesIdr = all.reduce((sum, row) => sum + row.netSalesIdr, 0);
  const rowCap = maxRowsOf("TL-04");
  const closed =
    liveFinality(input.period, ctx.now) === "final" &&
    (await accountingMonthsClosed(scope.context, monthsOf(input.period)));
  return getFoodCostOutputSchema.parse({
    foodCostIdr,
    netSalesIdr,
    foodCostPct: percentOf(foodCostIdr, netSalesIdr),
    rows: all.slice(0, rowCap),
    truncated: all.length > rowCap,
    sources: [
      makeSource({
        label: "Food cost % (HPP bahan terhadap penjualan bersih)",
        metricCode: "food_cost_pct",
        period: input.period,
        finality: closed ? "final" : "estimate",
        route: "/reports/inventory/food-cost",
        outletIds,
      }),
    ],
  });
};
