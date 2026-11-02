// Query keys and options of the management home. Hierarchical under
// "ws11-management-home" so one invalidation refreshes the layout and the
// report run it drives.
import { queryOptions } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/errors";
import type { DashboardQuery, ReportRunInput } from "@starter/shared/dashboard";
import { fetchManagementLayout, runManagementReport } from "./api";

/**
 * One quick retry for a server error, none for a client error or a lost
 * connection: the home is the first screen after login, so an offline or
 * failing API should reach its error state in about a second instead of
 * sitting on a skeleton through the app-wide retries (Opus review legend-6na6).
 */
export function retryOnceOnServerError(
  failureCount: number,
  error: unknown,
): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
}

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
    retry: retryOnceOnServerError,
  });
}

/** The role KPI tile's source report run (DASH-02). */
export function kpiRunQuery(input: ReportRunInput) {
  return queryOptions({
    queryKey: managementHomeKeys.kpiRun(input),
    queryFn: ({ signal }) => runManagementReport(input, signal),
    retry: retryOnceOnServerError,
  });
}
