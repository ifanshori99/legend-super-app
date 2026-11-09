// Metric sources of the "menu-cogs" family (bead legend-e58wz, F3 of
// legend-5wzoc). Owned by this family's card: add sources and splits here,
// never in another file.
//
// `cogs` by `menu_item` is a split of the ledger metric: one reader sums
// `order_items.cost_snapshot_idr` (HPP of the line at sale time) of the paid
// orders of an outlet business date per menu item, and the engine adds the
// `__ledger_adjustment__` residual so the rows add up to the ledger total
// (DECISIONS 2026-11-10 points 1 and 5). A paid order is `orders.status =
// 'completed'` on its business date, without training orders and voided lines
// (same definition as `ai-metrics/sales.ts`). A line without a cost snapshot
// adds no row (an unknown cost is not a zero cost). The reader always writes a
// total row (dimension null), zero when nothing was sold, so the engine can
// tell a computed day from a missing one.
//
// KNOWN LIMIT (architect review): no code path writes
// `order_items.cost_snapshot_idr` yet (pos-order.service, qr-order.service,
// delivery-inject and the edge applier all insert it as null). Until a card
// writes it, production has no per-item rows and the whole ledger total shows
// as the residual row. The split starts to carry figures by itself once the
// column is filled; no change here is needed then.
//
// Not claimed here:
// - `menu_sold_qty` belongs to the sales family (F1), which also owns its
//   menu_item / menu_category dimensions.
// - `menu_gross_margin` is `unavailable`: it needs the same cost snapshot, and
//   without it a margin would read as the full sales price. It turns into a
//   source when the snapshot is written.
// - `menu_popularity_pct` needs a "share of total" source kind the registry
//   lacks; `sold_out_menu_count` has no history per day (the schema keeps only
//   the current 86 status).

import { sql } from "drizzle-orm";
import { idr } from "@starter/shared/core";
import type {
  DailyMetricReader,
  DailyMetricValue,
  MetricSourceFamilyModule,
} from "./types";

export const menuCogsReader: DailyMetricReader = {
  metricCodes: ["cogs"],
  dimensions: ["menu_item"],
  requiresDailyClose: true,
  async compute(input) {
    const result = await input.tx.execute(sql`
      SELECT oi.menu_item_id::text AS menu_item_id,
             SUM(oi.cost_snapshot_idr)::bigint AS cost
        FROM order_items oi
        JOIN orders o ON o.tenant_id = oi.tenant_id AND o.id = oi.order_id
        LEFT JOIN pos_orders po
               ON po.tenant_id = o.tenant_id AND po.order_id = o.id
       WHERE o.tenant_id = ${input.tenantId}::uuid
         AND o.outlet_id = ${input.outletId}::uuid
         AND o.business_date = ${input.businessDate}::date
         AND o.status = 'completed'
         AND oi.status <> 'voided'
         AND oi.cost_snapshot_idr IS NOT NULL
         AND COALESCE(po.is_training, false) = false
       GROUP BY oi.menu_item_id
       ORDER BY oi.menu_item_id`);
    const items = result.rows.map((row) => ({
      menuItemId: String(row.menu_item_id),
      cost: Number(row.cost ?? 0),
    }));
    const total = items.reduce((sum, item) => sum + item.cost, 0);
    const rows: DailyMetricValue[] = [
      {
        metricCode: "cogs",
        dimension: null,
        value: { unit: "idr", valueIdr: idr(total) },
      },
    ];
    for (const item of items)
      rows.push({
        metricCode: "cogs",
        dimension: { key: "menu_item", value: item.menuItemId },
        value: { unit: "idr", valueIdr: idr(item.cost) },
      });
    return rows;
  },
};

export const menuCogsSources: MetricSourceFamilyModule = {
  family: "menu-cogs",
  sources: [
    {
      kind: "unavailable",
      code: "menu_gross_margin",
      reason: "source_not_built",
    },
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
  splits: [{ code: "cogs", dimension: "menu_item", reader: menuCogsReader }],
};
