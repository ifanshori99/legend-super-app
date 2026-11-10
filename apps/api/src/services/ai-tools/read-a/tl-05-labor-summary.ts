// TL-05 get_labor_summary (bead legend-mfyo). Aggregate only. Payroll runs,
// attendance and shift schedules have no tables yet, so labor cost and
// scheduled/worked hours are zero and the source label says the data is not
// available; headcount and approved overtime hours are real.
import { divideRounded, formatDecimal4 } from "@starter/shared/core";
import {
  getLaborSummaryInputSchema,
  getLaborSummaryOutputSchema,
} from "@starter/shared/ai";
import {
  liveFinality,
  monthsOf,
  resolveOutletScope,
} from "../../ai-metrics/scope.ts";
import { queryLaborAggregate } from "../../ai-metrics/labor.ts";
import { accountingMonthsClosed } from "../../ai-metrics/finance.ts";
import type { AiToolHandler } from "../types.ts";
import { makeSource } from "./shared.ts";

export const getLaborSummary: AiToolHandler = async (ctx, raw) => {
  const input = getLaborSummaryInputSchema.parse(raw);
  const scope = await resolveOutletScope(ctx, "TL-05", input.outletIds);
  const outletIds = scope.outlets.map((outlet) => outlet.id);
  const data = await queryLaborAggregate(scope.context, {
    outletIds,
    from: input.period.from,
    to: input.period.to,
  });
  const closed =
    liveFinality(input.period, ctx.now) === "final" &&
    (await accountingMonthsClosed(scope.context, monthsOf(input.period)));
  return getLaborSummaryOutputSchema.parse({
    laborCostIdr: 0,
    laborCostPct: "0.0000",
    scheduledHours: "0.0000",
    workedHours: "0.0000",
    overtimeHours: formatDecimal4(
      divideRounded(BigInt(data.overtimeMinutes) * 10_000n, 60n, "half_up"),
    ),
    headcount: data.headcount,
    sources: [
      makeSource({
        label:
          "Karyawan aktif dan lembur disetujui; biaya dan jam kerja belum tersedia (payroll/absensi belum aktif)",
        metricCode: "labor_cost_pct",
        period: input.period,
        finality: closed ? "final" : "estimate",
        route: "/reports/payroll/labor-cost",
        outletIds,
      }),
    ],
  });
};
