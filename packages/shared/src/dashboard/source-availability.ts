// Which catalog metrics have no data source on the server yet (the registry
// answers `unavailable` / `source_not_built`, see metricSourceOf in
// apps/api/src/services/metric-sources). The web catalog reads this one list to
// print "Segera hadir"; apps/api/src/test/ms-source-availability.test.ts fails
// when it drifts from the registry, so a source that lands (or is removed)
// cannot leave the catalog lying. Edit it only together with that registry.

export const METRIC_CODES_WITHOUT_SOURCE: readonly string[] = [
  "active_subscriptions",
  "apology_voucher_count",
  "attendance_late_count",
  "avg_spend_per_pax",
  "checklist_compliance_pct",
  "device_offline_count",
  "edc_settlement",
  "facility_cleaning_count",
  "facility_cleaning_seconds",
  "facility_product_revenue",
  "facility_product_sales",
  "failed_item_count",
  "gateway_settlement",
  "menu_gross_margin",
  "overtime_hours",
  "pending_settlement",
  "points_redeemed",
  "shower_fnb_conversion_pct",
  "shower_revenue",
  "shower_sessions_with_fnb",
  "sold_out_menu_count",
  "table_occupancy_pct",
  "wifi_quota_used",
  "wifi_sessions",
];

const withoutSource: ReadonlySet<string> = new Set(METRIC_CODES_WITHOUT_SOURCE);

export function metricHasSource(code: string): boolean {
  return !withoutSource.has(code);
}

/**
 * A report has data when at least one of its metrics has a source. A report
 * whose metrics are all unbuilt is "Segera hadir"; one with a mix opens and
 * marks the unbuilt cells through the run's per-metric availability.
 */
export function reportHasSource(report: {
  readonly metrics: readonly string[];
}): boolean {
  return report.metrics.some(metricHasSource);
}
