// Rules that turn stored metric values into what a screen or an answer may
// claim: finality (SH-02), period comparison, and the DASH-01 drill-down link
// back to the source report.

import {
  divideRounded,
  formatDecimal4,
  idr,
  parseDecimal4,
} from "../core/index.ts";
import type {
  MetricComparison,
  MetricFinality,
  MetricOfficiality,
  MetricSourceReport,
  MetricUnit,
  MetricValue,
} from "./schemas.ts";

/**
 * SH-02: a value is only final when its calendar bucket is closed. Metrics
 * whose formula belongs to accounting (`closed_period_only`: food cost %,
 * labor cost %, net profit, EBITDA) additionally need the covering accounting
 * period to be closed, because those numbers move until the books close.
 */
export function metricValueFinality(input: {
  officiality: MetricOfficiality;
  periodClosed: boolean;
  accountingPeriodClosed: boolean;
}): MetricFinality {
  if (!input.periodClosed) return "estimate";
  if (
    input.officiality === "closed_period_only" &&
    !input.accountingPeriodClosed
  )
    return "estimate";
  return "final";
}

/**
 * The numeric core of a value in its unit's native integer scale: rupiah,
 * count, seconds, or Decimal4 scaled by 10^4 for percent/decimal.
 */
function nativeValue(value: MetricValue): bigint {
  switch (value.unit) {
    case "idr":
      return BigInt(value.valueIdr);
    case "count":
    case "seconds":
      return BigInt(value.value);
    case "percent":
    case "decimal":
      return parseDecimal4(value.value);
  }
}

function valueFromNative(unit: MetricUnit, native: bigint): MetricValue {
  switch (unit) {
    case "idr": {
      if (
        native > BigInt(Number.MAX_SAFE_INTEGER) ||
        native < BigInt(Number.MIN_SAFE_INTEGER)
      )
        throw new RangeError(`Rupiah comparison overflow: ${native}`);
      return { unit, valueIdr: idr(Number(native)) };
    }
    case "count":
    case "seconds": {
      const count = Number(native);
      if (!Number.isSafeInteger(count))
        throw new RangeError(`Integer comparison overflow: ${native}`);
      return { unit, value: count };
    }
    case "percent":
    case "decimal":
      return { unit, value: formatDecimal4(native) };
  }
}

/**
 * Current minus previous in the same unit, plus the percentage change as
 * Decimal4 percentage points (null when the baseline is zero). Rounding is
 * half-up and explicit, in bigint, so no float ever touches a reported number.
 */
export function compareMetricValues(
  current: MetricValue,
  previous: MetricValue,
): MetricComparison {
  if (current.unit !== previous.unit)
    throw new RangeError(
      `Cannot compare ${current.unit} with ${previous.unit}`,
    );
  const currentNative = nativeValue(current);
  const previousNative = nativeValue(previous);
  const difference = currentNative - previousNative;
  return {
    previousValue: previous,
    changeValue: valueFromNative(current.unit, difference),
    // difference / previous * 100, expressed as Decimal4 (x 10^4) percentage:
    // difference * 100 * 10^4 / previous.
    changePercent:
      previousNative === 0n
        ? null
        : formatDecimal4(
            divideRounded(difference * 1_000_000n, previousNative, "half_up"),
          ),
  };
}

export type MetricSourceReportParams = {
  startDate: string;
  endDate: string;
  outletIds?: readonly string[];
  groupBy?: string | null;
};

/**
 * DASH-01: dashboard tiles link to the report that produced the number, with
 * the same period and outlet filter. Report routes live in the registry
 * (`sourceReport.route`); this builder only adds the standard query keys.
 */
export function metricSourceReportPath(
  source: MetricSourceReport,
  params: MetricSourceReportParams,
): string {
  const query = [
    `startDate=${encodeURIComponent(params.startDate)}`,
    `endDate=${encodeURIComponent(params.endDate)}`,
  ];
  for (const outletId of params.outletIds ?? [])
    query.push(`outletId=${encodeURIComponent(outletId)}`);
  if (params.groupBy)
    query.push(`groupBy=${encodeURIComponent(params.groupBy)}`);
  return `${source.route}?${query.join("&")}`;
}
