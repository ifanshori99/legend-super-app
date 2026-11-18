// Metric source registry types (WS-11 foundation, bead legend-5wzoc; contract
// docs/briefs/sub-ws11-foundation-design.md §2.1). Exactly one `MetricSource`
// per registry metric code; a split is an extra reader of a ledger metric.

import type { BusinessDate, OutletQueryFilter } from "@starter/shared/core";
import type {
  MetricDimensionKey,
  MetricDimensionValue,
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
  /** The job's clock; a reader never reads the wall clock itself. */
  readonly now: Date;
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
  /**
   * Whether this reader writes the total row (dimension null) of its codes.
   * Default true: every reader writes the total beside its splits. A split
   * reader whose code's total comes from another reader says `false`. The
   * job deletes a stale total row only for the reader that owns it, and the
   * registry refuses two readers that own the total of one code.
   */
  readonly writesTotal?: boolean;
  /** POS metrics: final needs a pos_daily_closes row for the outlet-date. */
  readonly requiresDailyClose: boolean;
  /**
   * Finality hold: true while the outlet-day may still change (e.g. a
   * delivery order still in flight). The job keeps the reader's rows an
   * estimate while it holds, on top of the settle delay and the day close.
   * Asked only once the day would otherwise be final, and before `compute`,
   * so a hold that ends during the run never labels older values final.
   * The job's catch-up pass revisits held days older than its refresh window
   * (up to 90 days back) until they turn final. Default: no hold.
   */
  pendingDay?(input: DailyComputeInput): Promise<boolean>;
  /**
   * Once this reader's rows for an outlet-date are final, the job neither
   * rewrites nor deletes them (inputs without an effective date, e.g. today's
   * operating hours, must not rewrite a closed day). An outlet-date without
   * rows yet is written normally, so a backfill still works. Default false.
   */
  readonly keepFinal?: boolean;
  compute(input: DailyComputeInput): Promise<readonly DailyMetricValue[]>;
};

/** Whether the reader owns the total rows of its codes (`writesTotal`). */
export function readerWritesTotal(reader: DailyMetricReader): boolean {
  return reader.writesTotal ?? true;
}

/** Current state has no historical rows and is never written to metrics_daily. */
export type CurrentMetricReader = {
  readonly dimensions: readonly MetricDimensionKey[];
  compute(input: {
    readonly tx: Tx;
    readonly tenantId: string;
    readonly outletFilter: OutletQueryFilter;
    readonly now: Date;
  }): Promise<
    readonly {
      readonly dimensions: readonly MetricDimensionValue[];
      readonly value: MetricValue;
    }[]
  >;
};

export type MetricSource =
  | { readonly kind: "gl"; readonly code: string; readonly gl: GlMetricSource }
  | {
      /** A live balance, labelled current even when a past period is selected. */
      readonly kind: "current";
      readonly code: string;
      readonly reader: CurrentMetricReader;
    }
  | {
      readonly kind: "daily";
      readonly code: string;
      readonly reader: DailyMetricReader;
      /**
       * An `average` code only: the stored count code (same reader, same
       * dimensions) each day's average is weighted by across days and
       * outlets, Σ(average × weight) / Σ weight. A day without volume is left
       * out. Without it the engine takes the plain mean of the stored days.
       * The registry checks it: a registered `daily` count code that this
       * same reader writes, on a metric that aggregates as `average`.
       */
      readonly weightCode?: string;
    }
  | {
      /** Recomputed per bucket from two registry codes; never stored. */
      readonly kind: "derived";
      readonly code: string;
      readonly numerator: string;
      readonly denominator: string;
      readonly scale: 1 | 60 | 100; // 100 for percent
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
      readonly message?: string;
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
