// TL-02 get_menu_performance (bead legend-mfyo). Margin = revenue - HPP
// snapshot, shown only when the caller holds `inventory.cost.view` at every
// outlet in scope (kitchen lead and marketing get null).
import {
  getMenuPerformanceInputSchema,
  getMenuPerformanceOutputSchema,
} from "@starter/shared/ai";
import {
  holdsAtAll,
  liveFinality,
  resolveOutletScope,
} from "../../ai-metrics/scope.ts";
import { queryMenuPerformance } from "../../ai-metrics/sales.ts";
import type { AiToolHandler } from "../types.ts";
import { makeSource, maxRowsOf } from "./shared.ts";

export const getMenuPerformance: AiToolHandler = async (ctx, raw) => {
  const input = getMenuPerformanceInputSchema.parse(raw);
  const scope = await resolveOutletScope(ctx, "TL-02", input.outletIds);
  const outletIds = scope.outlets.map((outlet) => outlet.id);
  const showMargin = holdsAtAll(ctx, "inventory.cost.view", scope.outlets);
  const all = await queryMenuPerformance(scope.context, {
    outletIds,
    from: input.period.from,
    to: input.period.to,
  });
  const items = all.map((row) => ({
    menuItemId: row.menuItemId,
    name: row.name,
    qtySold: row.qtySold,
    revenueIdr: row.revenueIdr,
    marginIdr: showMargin ? row.revenueIdr - row.costIdr : null,
  }));
  // Without cost permission "margin" cannot rank anything: fall back to revenue.
  const sortBy =
    input.sortBy === "margin" && !showMargin ? "revenue" : input.sortBy;
  const key = (item: (typeof items)[number]) =>
    sortBy === "qty"
      ? item.qtySold
      : sortBy === "margin"
        ? (item.marginIdr ?? 0)
        : item.revenueIdr;
  items.sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name));
  const limit = Math.min(input.limit, maxRowsOf("TL-02"));
  return getMenuPerformanceOutputSchema.parse({
    items: items.slice(0, limit),
    truncated: items.length > limit,
    sources: [
      makeSource({
        label: "Penjualan menu (pesanan lunas)",
        metricCode: "net_sales",
        period: input.period,
        finality: liveFinality(input.period, ctx.now),
        route: "/reports/sales/daily",
        outletIds,
      }),
    ],
  });
};
