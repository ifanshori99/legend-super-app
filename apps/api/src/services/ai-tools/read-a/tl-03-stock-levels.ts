// TL-03 get_stock_levels (bead legend-mfyo). On hand vs par per item over the
// caller's permitted outlets. No unit costs are returned.
import {
  getStockLevelsInputSchema,
  getStockLevelsOutputSchema,
} from "@starter/shared/ai";
import { resolveOutletScope, todayBusinessDate } from "../../ai-metrics/scope.ts";
import { queryStockLevels } from "../../ai-metrics/stock.ts";
import type { AiToolHandler } from "../types.ts";
import { makeSource, maxRowsOf } from "./shared.ts";

export const getStockLevels: AiToolHandler = async (ctx, raw) => {
  const input = getStockLevelsInputSchema.parse(raw);
  const scope = await resolveOutletScope(ctx, "TL-03", input.outletIds);
  const outletIds = scope.outlets.map((outlet) => outlet.id);
  const data = await queryStockLevels(scope.context, {
    outletIds,
    onlyBelowPar: input.onlyBelowPar ?? false,
    search: input.search,
    rowLimit: maxRowsOf("TL-03"),
  });
  const today = todayBusinessDate(ctx.now);
  return getStockLevelsOutputSchema.parse({
    items: data.rows,
    truncated: data.truncated,
    sources: [
      makeSource({
        label: "Stok saat ini terhadap par level",
        period: { from: today, to: today },
        finality: "estimate",
        route: "/reports/inventory/stock",
        outletIds,
      }),
    ],
  });
};
