// Helpers shared by the TL-01..TL-06 handlers (part R-A, bead legend-mfyo).
import { divideRounded, formatDecimal4 } from "@starter/shared/core";
import { getAiTool } from "@starter/shared/ai";
import type { AiToolCode, ToolPeriod, ToolSource } from "@starter/shared/ai";
import type { MetricFinality } from "@starter/shared/metrics";
import { reportLink } from "../../ai-metrics/scope.ts";

export function maxRowsOf(code: AiToolCode): number {
  const tool = getAiTool(code);
  if (!tool) throw new RangeError(`Unknown tool ${code}`);
  return tool.maxRows;
}

/** Whole-rupiah average, 0 when there is nobody to divide by. */
export function averagePerPax(netSalesIdr: number, pax: number): number {
  return pax > 0 ? Math.round(netSalesIdr / pax) : 0;
}

/** One "Jawaban Bersumber" entry (metric, period, finality, report link). */
export function makeSource(input: {
  label: string;
  metricCode?: string;
  period: ToolPeriod;
  finality: MetricFinality;
  route: string;
  outletIds?: readonly string[];
}): ToolSource {
  return {
    ...(input.metricCode ? { metricCode: input.metricCode } : {}),
    label: input.label,
    period: { from: input.period.from, to: input.period.to },
    finality: input.finality,
    link: reportLink(input.route, input.period, input.outletIds),
  };
}

/** a / b * 100 as a Decimal4 percent string; "0.0000" when b is not positive. */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return "0.0000";
  return formatDecimal4(
    divideRounded(BigInt(part) * 1_000_000n, BigInt(whole), "half_up"),
  );
}
