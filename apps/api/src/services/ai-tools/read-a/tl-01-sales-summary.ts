// TL-01 get_sales_summary (bead legend-mfyo). Paid orders only, aggregated by
// day, outlet or channel over the caller's permitted outlets.
import {
  getSalesSummaryInputSchema,
  getSalesSummaryOutputSchema,
} from "@starter/shared/ai";
import { liveFinality, resolveOutletScope } from "../../ai-metrics/scope.ts";
import { querySalesSummary } from "../../ai-metrics/sales.ts";
import type { AiToolHandler } from "../types.ts";
import { averagePerPax, makeSource, maxRowsOf } from "./shared.ts";

export const getSalesSummary: AiToolHandler = async (ctx, raw) => {
  const input = getSalesSummaryInputSchema.parse(raw);
  const scope = await resolveOutletScope(ctx, "TL-01", input.outletIds);
  const outletIds = scope.outlets.map((outlet) => outlet.id);
  const data = await querySalesSummary(scope.context, {
    outletIds,
    from: input.period.from,
    to: input.period.to,
    groupBy: input.groupBy,
    rowLimit: maxRowsOf("TL-01"),
  });
  const finality = liveFinality(input.period, ctx.now);
  return getSalesSummaryOutputSchema.parse({
    groupBy: input.groupBy,
    rows: data.rows.map((row) => ({
      ...row,
      avgSpendPerPaxIdr: averagePerPax(row.netSalesIdr, row.pax),
    })),
    totals: {
      ...data.totals,
      avgSpendPerPaxIdr: averagePerPax(data.totals.netSalesIdr, data.totals.pax),
    },
    truncated: data.truncated,
    sources: [
      makeSource({
        label: "Penjualan bersih (pesanan lunas)",
        metricCode: "net_sales",
        period: input.period,
        finality,
        route: "/reports/sales/daily",
        outletIds,
      }),
      makeSource({
        label: "Jumlah tamu (pax)",
        metricCode: "pax",
        period: input.period,
        finality,
        route: "/reports/traffic/pax",
        outletIds,
      }),
    ],
  });
};
