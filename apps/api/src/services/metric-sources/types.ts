// Metric source registry types (WS-11 foundation, bead legend-5wzoc; contract
// docs/briefs/sub-ws11-foundation-design.md §2.1). Exactly one `MetricSource`
// per registry metric code; a split is an extra reader of a ledger metric.

import type { BusinessDate } from "@starter/shared/core";
import type {
  MetricDimensionKey,
  MetricUnavailableReason,
  MetricValue,
} from "@starter/shared/metrics";
import type { withTenant } from "../../db/tenant";
import type { GlMetricSource } from "../metrics-gl-sources";

export type { MetricUnavailableReason };

export type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

export const METRIC_SOURCE_FAMILIES = [
  "sales",
  "traffic-operations",
  "menu-cogs",
  "payments-tax",
  "inventory-purchasing",
  "finance",
  "loyalty-crm",
  "reservation-delivery",
  "hr",
  "facility",
] as const;
export type MetricSourceFamily = (typeof METRIC_SOURCE_FAMILIES)[number];

/** One outlet-day value a daily reader returns; dimension null = the total. */
export type DailyMetricValue = {
  readonly metricCode: string;
  readonly dimension: {
    readonly key: Exclude<MetricDimensionKey, "outlet">;
    readonly value: string; // max 200 chars, never a person's name (ids only)
  } | null;
  readonly value: MetricValue;
};

export type DailyComputeInput = {
  readonly tx: Tx; // job's withTenant transaction (RLS is the second wall)
  readonly tenantId: string;
  readonly outletId: string;
  readonly businessDate: BusinessDate;
};

/**
 * Computes the stored rows of one outlet-day. Rule: a reader always returns a
 * total row (dimension null) for every code it lists, for every outlet-day it
 * computes, with zero when there was no activity. Split readers of a ledger
 * code do the same. The engine labels a stored value or split `final` only
 * when every business day of the bucket has such a total row, so a missing
 * total keeps the bucket an estimate.
 */
export type DailyMetricReader = {
  /** Codes this reader writes; the job deletes stale rows of these codes only. */
  readonly metricCodes: readonly string[];
  /** Split keys written besides the total (subset of each definition's dimensions). */
  readonly dimensions: readonly Exclude<MetricDimensionKey, "outlet">[];
  /** POS metrics: final needs a pos_daily_closes row for the outlet-date. */
  readonly requiresDailyClose: boolean;
  compute(input: DailyComputeInput): Promise<readonly DailyMetricValue[]>;
};

export type MetricSource =
  | { readonly kind: "gl"; readonly code: string; readonly gl: GlMetricSource }
  | {
      readonly kind: "daily";
      readonly code: string;
      readonly reader: DailyMetricReader;
    }
  | {
      /** Recomputed per bucket from two registry codes; never stored. */
      readonly kind: "derived";
      readonly code: string;
      readonly numerator: string;
      readonly denominator: string;
      readonly scale: 1 | 100; // 100 for percent
    }
  | {
      /**
       * Share of a total, recomputed per bucket and never stored: each
       * `dimension` value of the registry code `of`, divided by the sum of all
       * values of that dimension in the same bucket (and outlet group), × 100.
       * Answers `dimension_not_supported` unless the query splits by
       * `dimension` (an unsplit total would always read 100 %).
       */
      readonly kind: "share";
      readonly code: string; // percent unit
      readonly of: string;
      readonly dimension: Exclude<MetricDimensionKey, "outlet">;
    }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly reason: MetricUnavailableReason;
    };

/** Non-outlet split of a `gl` metric: operational rows + ledger residual row. */
export type MetricSplitSource = {
  readonly code: string; // must resolve to kind "gl"
  readonly dimension: Exclude<MetricDimensionKey, "outlet">;
  readonly reader: DailyMetricReader; // writes rows with this dimension only
};

export type MetricSourceFamilyModule = {
  readonly family: MetricSourceFamily;
  readonly sources: readonly MetricSource[];
  readonly splits: readonly MetricSplitSource[];
};

/** The ledger module (`gl.ts`) is not a family card; it owns the 12 GL codes. */
export type MetricSourceGlModule = Omit<MetricSourceFamilyModule, "family"> & {
  readonly family: "gl";
};

export type MetricSourceModule =
  MetricSourceFamilyModule | MetricSourceGlModule;
