// TL-05 get_labor_summary (bead legend-mfyo, legend-39d.4). Aggregate only.
// Headcount, overtime, scheduled and worked hours are outlet-scoped. Labor cost
// and its percent of net sales come from frozen payroll runs and need
// `payroll.view` at tenant scope (a run has no outlet split): without it, for an
// outlet-filtered request, when the caller's reach does not cover every tenant
// outlet, or without a frozen run covering the period, both are null, never 0.
import {
  divideRounded,
  formatDecimal4,
  type Decimal4,
} from "@starter/shared/core";
import {
  getLaborSummaryInputSchema,
  getLaborSummaryOutputSchema,
} from "@starter/shared/ai";
import {
  liveFinality,
  monthsOf,
  resolveOutletScope,
} from "../../ai-metrics/scope.ts";
import { queryLaborAggregate, queryLaborCost } from "../../ai-metrics/labor.ts";
import { querySalesSummary } from "../../ai-metrics/sales.ts";
import { accountingMonthsClosed } from "../../ai-metrics/finance.ts";
import type { AiToolHandler } from "../types.ts";
import { makeSource } from "./shared.ts";

const hours = (minutes: number): Decimal4 =>
  formatDecimal4(divideRounded(BigInt(minutes) * 10_000n, 60n, "half_up"));

export const getLaborSummary: AiToolHandler = async (ctx, raw) => {
  const input = getLaborSummaryInputSchema.parse(raw);
  const scope = await resolveOutletScope(ctx, "TL-05", input.outletIds);
  const outletIds = scope.outlets.map((outlet) => outlet.id);
  const data = await queryLaborAggregate(scope.context, {
    outletIds,
    from: input.period.from,
    to: input.period.to,
  });

  // Cost is tenant-wide payroll data: only a caller who may view payroll at
  // tenant scope, asking for the whole tenant, whose reach covers EVERY tenant
  // outlet (tenant-kind context), gets it. Otherwise cost and pct would pair
  // tenant payroll with a subset of outlets' sales.
  const payrollContext =
    (input.outletIds?.length ?? 0) === 0 &&
    scope.context.outletScope.kind === "tenant" &&
    ctx.access.allows("payroll.view", { type: "tenant" })
      ? ctx.access.contextFor("payroll.view", { type: "tenant" })
      : null;
  const laborCostIdr = payrollContext
    ? await queryLaborCost(payrollContext, input.period)
    : null;
  let laborCostPct: Decimal4 | null = null;
  if (laborCostIdr !== null && payrollContext) {
    const sales = await querySalesSummary(scope.context, {
      outletIds,
      from: input.period.from,
      to: input.period.to,
      groupBy: "day",
      rowLimit: 1,
    });
    if (sales.totals.netSalesIdr > 0)
      laborCostPct = formatDecimal4(
        divideRounded(
          BigInt(laborCostIdr) * 1_000_000n,
          BigInt(sales.totals.netSalesIdr),
          "half_up",
        ),
      );
  }

  const closed =
    liveFinality(input.period, ctx.now) === "final" &&
    (await accountingMonthsClosed(scope.context, monthsOf(input.period)));
  return getLaborSummaryOutputSchema.parse({
    laborCostIdr,
    laborCostPct,
    scheduledHours: hours(data.scheduledMinutes),
    workedHours: hours(data.workedMinutes),
    overtimeHours: hours(data.overtimeMinutes),
    headcount: data.headcount,
    sources: [
      makeSource({
        label:
          laborCostIdr === null
            ? "Karyawan aktif, jadwal, absensi, lembur; biaya kerja tidak tersedia (perlu izin gaji, payroll terkunci, semua outlet)"
            : "Karyawan aktif, jadwal, absensi, lembur disetujui, dan biaya dari payroll terkunci (pro rata hari)",
        metricCode: "labor_cost_pct",
        period: input.period,
        finality: closed ? "final" : "estimate",
        route: "/reports/payroll/labor-cost",
        outletIds,
      }),
    ],
  });
};
