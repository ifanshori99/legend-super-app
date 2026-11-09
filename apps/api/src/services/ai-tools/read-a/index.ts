// TL-01..TL-06 handlers (bead legend-mfyo). Owned by part R-A.
import type { AiToolHandlerMap } from "../types.ts";
import { getSalesSummary } from "./tl-01-sales-summary.ts";
import { getMenuPerformance } from "./tl-02-menu-performance.ts";
import { getStockLevels } from "./tl-03-stock-levels.ts";
import { getFoodCost } from "./tl-04-food-cost.ts";
import { getLaborSummary } from "./tl-05-labor-summary.ts";
import { getFinancialStatement } from "./tl-06-financial-statement.ts";

export const readToolsA: AiToolHandlerMap = {
  "TL-01": getSalesSummary,
  "TL-02": getMenuPerformance,
  "TL-03": getStockLevels,
  "TL-04": getFoodCost,
  "TL-05": getLaborSummary,
  "TL-06": getFinancialStatement,
};
