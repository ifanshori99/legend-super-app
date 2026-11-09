// Metric sources of the "menu-cogs" family (bead legend-e58wz, F3 of
// legend-5wzoc). Owned by this family's card: add sources and splits here,
// never in another file.
//
// One reader aggregates the paid orders of an outlet business date per menu
// item and per menu category (DECISIONS 2026-11-10 points 1 and 5):
// - `cogs` by `menu_item` is a split of the ledger metric: the rows are the
//   sum of `order_items.cost_snapshot_idr` (HPP of the line at sale time); the
//   engine adds the `__ledger_adjustment__` residual so the rows add up to the
//   ledger total. Lines without a cost snapshot add no row value (an unknown
//   cost is not a zero cost).
// - `menu_sold_qty` and `menu_gross_margin` are stored sums. The ledger never
//   posts a per-menu margin, so `menu_gross_margin` (line total minus cost
//   snapshot, lines with a known cost only) reads the order rows directly.
// A paid order is `orders.status = 'completed'` on its business date, without
// training orders and voided lines (same definition as `ai-metrics/sales.ts`).
// Every code gets a total row (dimension null), zero when nothing was sold, so
// the engine can tell a computed day from a missing one.
//
// Unavailable: `menu_popularity_pct` (a share of the total needs a "share of
// total" source kind the registry lacks) and `sold_out_menu_count` (the schema
// keeps only the current 86 status, no history per day).

import { sql } from "drizzle-orm";
import { idr } from "@starter/shared/core";
import type {
  DailyComputeInput,
  DailyMetricReader,
  DailyMetricValue,
  MetricSourceFamilyModule,
} from "./types";

const num = (value: unknown): number => Number(value ?? 0);

type Line = {
  menuItemId: string;
  categoryId: string;
  qty: number;
  costKnownLines: number;
  cost: number;
  margin: number;
};

async function readLines(input: DailyComputeInput): Promise<Line[]> {
  const result = await input.tx.execute(sql`
    SELECT oi.menu_item_id::text AS menu_item_id,
           mi.category_id::text AS category_id,
           SUM(oi.quantity)::bigint AS qty,
           COUNT(oi.cost_snapshot_idr)::int AS cost_lines,
           COALESCE(SUM(oi.cost_snapshot_idr), 0)::bigint AS cost,
           COALESCE(SUM(oi.line_total_idr - oi.cost_snapshot_idr)
             FILTER (WHERE oi.cost_snapshot_idr IS NOT NULL), 0)::bigint AS margin
      FROM order_items oi
      JOIN orders o ON o.tenant_id = oi.tenant_id AND o.id = oi.order_id
      JOIN menu_items mi ON mi.tenant_id = oi.tenant_id AND mi.id = oi.menu_item_id
      LEFT JOIN pos_orders po ON po.tenant_id = o.tenant_id AND po.order_id = o.id
     WHERE o.tenant_id = ${input.tenantId}::uuid
       AND o.outlet_id = ${input.outletId}::uuid
       AND o.business_date = ${input.businessDate}::date
       AND o.status = 'completed'
       AND oi.status <> 'voided'
       AND COALESCE(po.is_training, false) = false
     GROUP BY oi.menu_item_id, mi.category_id
     ORDER BY oi.menu_item_id`);
  return result.rows.map((row) => ({
    menuItemId: String(row.menu_item_id),
    categoryId: String(row.category_id),
    qty: num(row.qty),
    costKnownLines: num(row.cost_lines),
    cost: num(row.cost),
    margin: num(row.margin),
  }));
}

const count = (value: number) => ({ unit: "count" as const, value });
const money = (value: number) => ({
  unit: "idr" as const,
  valueIdr: idr(value),
});

export const menuSalesReader: DailyMetricReader = {
  metricCodes: ["menu_sold_qty", "menu_gross_margin", "cogs"],
  dimensions: ["menu_item", "menu_category"],
  requiresDailyClose: true,
  async compute(input) {
    const lines = await readLines(input);
    const rows: DailyMetricValue[] = [];
    const sum = (pick: (line: Line) => number, of: readonly Line[]) =>
      of.reduce((total, line) => total + pick(line), 0);

    rows.push(
      {
        metricCode: "menu_sold_qty",
        dimension: null,
        value: count(sum((l) => l.qty, lines)),
      },
      {
        metricCode: "menu_gross_margin",
        dimension: null,
        value: money(sum((l) => l.margin, lines)),
      },
      {
        metricCode: "cogs",
        dimension: null,
        value: money(sum((l) => l.cost, lines)),
      },
    );
    for (const line of lines) {
      const item = { key: "menu_item" as const, value: line.menuItemId };
      rows.push({
        metricCode: "menu_sold_qty",
        dimension: item,
        value: count(line.qty),
      });
      if (line.costKnownLines > 0) {
        rows.push(
          {
            metricCode: "menu_gross_margin",
            dimension: item,
            value: money(line.margin),
          },
          { metricCode: "cogs", dimension: item, value: money(line.cost) },
        );
      }
    }
    const categories = new Map<string, Line[]>();
    for (const line of lines)
      categories.set(line.categoryId, [
        ...(categories.get(line.categoryId) ?? []),
        line,
      ]);
    for (const [categoryId, members] of categories) {
      const category = { key: "menu_category" as const, value: categoryId };
      rows.push({
        metricCode: "menu_sold_qty",
        dimension: category,
        value: count(sum((l) => l.qty, members)),
      });
      if (members.some((line) => line.costKnownLines > 0))
        rows.push({
          metricCode: "menu_gross_margin",
          dimension: category,
          value: money(sum((l) => l.margin, members)),
        });
    }
    return rows;
  },
};

export const menuCogsSources: MetricSourceFamilyModule = {
  family: "menu-cogs",
  sources: [
    { kind: "daily", code: "menu_sold_qty", reader: menuSalesReader },
    { kind: "daily", code: "menu_gross_margin", reader: menuSalesReader },
    {
      kind: "unavailable",
      code: "menu_popularity_pct",
      reason: "source_not_built",
    },
    {
      kind: "unavailable",
      code: "sold_out_menu_count",
      reason: "source_not_built",
    },
  ],
  splits: [{ code: "cogs", dimension: "menu_item", reader: menuSalesReader }],
};
