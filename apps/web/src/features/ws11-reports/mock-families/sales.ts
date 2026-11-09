// Sales family of the report viewer mock: the sales target (the sales atoms are
// the day model's), the cells of the sales metrics and the sales reports.
import type { Atoms } from "../mock-day-model.ts";
import { count, idr, ratio, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  // The day's target sits a little above the open day's net sales.
  salesTarget: { from: "net", ratio: 1.05 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

export function cellFor(metricCode: string, atoms: Figures): Cell | undefined {
  switch (metricCode) {
    case "sales_target":
      return idr(atoms.salesTarget);
    case "target_achievement_pct":
      return ratio(atoms.net, atoms.salesTarget);
    case "net_sales":
      return idr(atoms.net);
    case "gross_sales":
      return idr(atoms.gross);
    case "discount_amount":
      return idr(atoms.discount);
    case "refund_amount":
      return idr(atoms.refund);
    case "void_amount":
      return idr(atoms.voided);
    case "transaction_count":
      return count(atoms.tx);
    case "pax":
      return count(atoms.pax);
    case "menu_sold_qty":
      return count(atoms.qty);
    case "avg_ticket":
      return atoms.tx === 0 ? null : idr(Math.round(atoms.net / atoms.tx));
    case "avg_spend_per_pax":
      return atoms.pax === 0 ? null : idr(Math.round(atoms.net / atoms.pax));
    case "discount_rate_pct":
      return ratio(atoms.discount, atoms.gross);
    case "refund_rate_pct":
      return ratio(atoms.refund, atoms.net);
    case "void_rate_pct":
      return ratio(atoms.voided, atoms.net);
    default:
      return undefined;
  }
}

export const SALES_REPORTS = [
  "sales.daily",
  "sales.per_hour",
  "sales.per_channel",
  "sales.per_menu",
  "sales.per_employee",
  "sales.transactions",
  "sales.per_pax",
  "sales.void",
  "sales.discount",
  "sales.refund",
  "sales.target",
  "sales.by_day",
  "sales.by_category",
] as const;

/** Report codes served here, by code prefix. */
export const reportsByPrefix = {
  sales: SALES_REPORTS,
} as const;
