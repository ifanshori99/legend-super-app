// Facility family of the report viewer mock. The facility report runs are
// registered by `features/facility-report/mock.ts`; this module owns the list
// that mirrors the API: the registry answers 12 of the 19 facility metrics as
// `unavailable` / `source_not_built` (apps/api/src/services/metric-sources/
// facility.ts), so the mock shows "belum tersedia" for exactly those and keeps
// figures for the four sums the API reads (shower sessions, overtime sessions
// and seconds, incident count) and the three ratios it derives from sums
// (shower occupancy, unit utilization, incident response seconds).
import type { Cell, DerivedSpec } from "./cells.ts";

export const derived = {} as const satisfies Record<string, DerivedSpec>;

export function cellFor(): Cell | undefined {
  return undefined;
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = { facility: [] } as const;

/** Facility metrics the API answers `unavailable` / `source_not_built`. */
export const unavailableMetrics: ReadonlySet<string> = new Set([
  "shower_revenue",
  "facility_product_revenue",
  "facility_product_sales",
  "active_subscriptions",
  "wifi_sessions",
  "wifi_quota_used",
  "shower_sessions_with_fnb",
  "shower_fnb_conversion_pct",
  "facility_cleaning_count",
  "facility_cleaning_seconds",
]);
