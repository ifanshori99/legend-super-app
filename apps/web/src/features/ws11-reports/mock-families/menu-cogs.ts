// Menu and COGS families of the report viewer mock. The cost lines themselves
// (cogs, gross margin) hang off the finance family's cost structure.
import type { Atoms } from "../mock-day-model.ts";
import { count, ratio, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  soldOut: { from: "net", snapshot: 3 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

export function cellFor(
  metricCode: string,
  atoms: Figures,
  totals: Figures,
): Cell | undefined {
  switch (metricCode) {
    case "sold_out_menu_count":
      return count(atoms.soldOut);
    case "menu_popularity_pct":
      return ratio(atoms.qty, totals.qty);
    default:
      return undefined;
  }
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = {
  menu: [
    "menu.best_sellers",
    "menu.category_sales",
    "menu.engineering",
    "menu.margin",
    "menu.recipe_cost",
    "menu.slow_movers",
    "menu.sold_out",
  ],
  cogs: ["cogs.per_menu", "cogs.production", "cogs.recipe", "cogs.trend"],
} as const;
