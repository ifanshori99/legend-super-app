// Finance family of the report viewer mock: cost and profit lines of the day,
// payroll cost and the cash and bank balances. `periodFigures` in `../mock.ts`
// overrides the cost lines with the period's cost structure.
import type { Atoms } from "../mock-day-model.ts";
import { idr, ratio, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  // Cost and profit lines of the day.
  cogs: { from: "net", ratio: 0.34 },
  labor: { from: "net", ratio: 0.27 },
  opex: { from: "net", ratio: 0.22 },
  below: { from: "net", ratio: 0.04 },
  // Balances on the last day of the period (the management KPI strip's day).
  cash: { from: "net", snapshot: 8_250_000 },
  bank: { from: "net", snapshot: 96_500_000 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

export function cellFor(metricCode: string, atoms: Figures): Cell | undefined {
  const grossProfit = atoms.net - atoms.cogs;
  const ebitda = grossProfit - atoms.labor - atoms.opex;
  switch (metricCode) {
    // Cost, profit and payroll: net sales less the day's cost lines.
    case "cogs":
      return idr(atoms.cogs);
    case "menu_gross_margin":
    case "gross_profit":
      return idr(grossProfit);
    case "ebitda":
      return idr(ebitda);
    case "net_profit":
      return idr(ebitda - atoms.below);
    case "gross_payroll":
      return idr(atoms.labor);
    case "food_cost_pct":
      return ratio(atoms.cogs, atoms.net);
    case "gross_margin_pct":
      return ratio(grossProfit, atoms.net);
    case "labor_cost_pct":
      return ratio(atoms.labor, atoms.net);
    case "prime_cost_pct":
      return ratio(atoms.cogs + atoms.labor, atoms.net);
    case "cash_balance":
      return idr(atoms.cash);
    case "bank_balance":
      return idr(atoms.bank);
    default:
      return undefined;
  }
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = {
  finance: [
    "finance.cash_position",
    "finance.ebitda",
    "finance.gross_margin",
    "finance.income_statement",
    "finance.pending_settlement",
    "finance.prime_cost",
    "finance.profit_trend",
    "finance.supplier_due",
  ],
} as const;

/** Metrics the API answers `unavailable` (metric registry): the mock shows no number. */
export const unavailableMetrics: ReadonlySet<string> = new Set([
  "pending_settlement",
]);
