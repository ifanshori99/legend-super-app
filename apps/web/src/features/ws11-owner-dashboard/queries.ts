// Query keys and options of the owner dashboard. One key per report run so a
// manual or interval refresh re-reads the same source reports the tiles cite.
import { queryOptions } from "@tanstack/react-query";
import type { ReportRunInput } from "@starter/shared/dashboard";
import { fetchLatestRatings, fetchOwnerDashboard, runOwnerReport } from "./api";

/** Realtime means "refresh this often while the tab is visible". */
export const OWNER_BOARD_REFRESH_MS = 60_000;

export const ownerDashboardKeys = {
  all: ["owner-dashboard"] as const,
  layout: () => [...ownerDashboardKeys.all, "layout"] as const,
  reports: () => [...ownerDashboardKeys.all, "report"] as const,
  report: (input: ReportRunInput) =>
    [...ownerDashboardKeys.reports(), input] as const,
  reviews: () => [...ownerDashboardKeys.all, "reviews"] as const,
};

export function ownerDashboardQuery() {
  return queryOptions({
    queryKey: ownerDashboardKeys.layout(),
    queryFn: ({ signal }) => fetchOwnerDashboard({}, signal),
    staleTime: 30_000,
  });
}

/**
 * Runs one source report. POST, so it never runs during SSR (`enabled` waits
 * for hydration); mock mode answers it from the shared dashboard fixtures.
 */
export function ownerReportQuery(input: ReportRunInput, enabled: boolean) {
  return queryOptions({
    queryKey: ownerDashboardKeys.report(input),
    queryFn: ({ signal }) => runOwnerReport(input, signal),
    enabled,
    staleTime: 0,
  });
}

export function latestRatingsQuery(enabled: boolean) {
  return queryOptions({
    queryKey: ownerDashboardKeys.reviews(),
    queryFn: ({ signal }) => fetchLatestRatings(signal),
    enabled,
    staleTime: 0,
  });
}
