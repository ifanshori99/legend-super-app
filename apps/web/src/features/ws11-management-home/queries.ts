// Query keys and options of the management home. Hierarchical under
// "ws11-management-home" so one invalidation refreshes the layout and the
// report run it drives.
import { queryOptions } from "@tanstack/react-query";
import type { DashboardQuery, ReportRunInput } from "@starter/shared/dashboard";
import { fetchManagementLayout, runManagementReport } from "./api";

export const managementHomeKeys = {
  all: ["ws11-management-home"] as const,
  layout: (query: DashboardQuery) =>
    [...managementHomeKeys.all, "layout", query] as const,
  kpiRun: (input: ReportRunInput) =>
    [...managementHomeKeys.all, "kpi-run", input] as const,
};

/**
 * The composed layout. Fresh for 30 seconds like the rest of the app: a
 * dashboard is live data, so the page offers its own "Perbarui" action.
 */
export function managementLayoutQuery(query: DashboardQuery = {}) {
  return queryOptions({
    queryKey: managementHomeKeys.layout(query),
    queryFn: ({ signal }) => fetchManagementLayout(query, signal),
  });
}

/** The role KPI tile's source report run (DASH-02). */
export function kpiRunQuery(input: ReportRunInput) {
  return queryOptions({
    queryKey: managementHomeKeys.kpiRun(input),
    queryFn: ({ signal }) => runManagementReport(input, signal),
  });
}
