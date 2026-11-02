// Query keys and options of the management home. Hierarchical under
// "ws11-management-home" so one invalidation refreshes every stored layout.
import { queryOptions } from "@tanstack/react-query";
import type { DashboardQuery } from "@starter/shared/dashboard";
import { fetchManagementLayout } from "./api";

export const managementHomeKeys = {
  all: ["ws11-management-home"] as const,
  layout: (query: DashboardQuery) =>
    [...managementHomeKeys.all, "layout", query] as const,
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
