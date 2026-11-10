// Inventory and purchasing families of the report viewer mock: purchases and
// waste of the day, and the stock and supplier balances.
import type { Atoms } from "../mock-day-model.ts";
import { count, idr, ratio, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  // Purchases of a business day are about a third of its net sales; 1 Nov is
  // Rp2.597.000, the management KPI strip's figure (I4).
  purchase: { from: "net", ratio: 0.35 },
  waste: { from: "net", ratio: 0.02 },
  supplierDue: { from: "net", snapshot: 12_400_000 },
  stockValue: { from: "net", snapshot: 18_900_000 },
  criticalStock: { from: "net", snapshot: 4 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

export function cellFor(metricCode: string, atoms: Figures): Cell | undefined {
  switch (metricCode) {
    case "purchase_total":
      return idr(atoms.purchase);
    case "supplier_due":
      return idr(atoms.supplierDue);
    case "stock_value":
      return idr(atoms.stockValue);
    case "waste_cost":
      return idr(atoms.waste);
    case "waste_cost_pct":
      return ratio(atoms.waste, atoms.net);
    case "critical_stock_count":
      return count(atoms.criticalStock);
    default:
      return undefined;
  }
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = {
  inventory: [
    "inventory.critical_stock",
    "inventory.food_cost",
    "inventory.movement",
    "inventory.stock_usage",
    "inventory.stock_value",
    "inventory.waste",
    "inventory.waste_by_category",
  ],
  purchasing: [
    "purchasing.orders",
    "purchasing.price_history",
    "purchasing.receipts",
    "purchasing.requests",
    "purchasing.supplier_due",
  ],
} as const;

/** Metrics the API answers `unavailable` (metric registry): the mock shows no number. */
export const unavailableMetrics: ReadonlySet<string> = new Set([]);
