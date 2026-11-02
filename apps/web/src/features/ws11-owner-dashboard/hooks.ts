// Data access of the owner dashboard. The layout is suspense-loaded (GET, SSR
// safe); tile values are POST report runs, so they start after hydration and
// refresh together every minute (PRD §3 F34 "Ringkasan Real-time", DASH-03).
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Feedback } from "@starter/shared/crm";
import type { DashboardLayout, ReportResult } from "@starter/shared/dashboard";
import { isReportResultEmpty, ownerBoardRunInputs } from "./board.ts";
import {
  latestRatingsQuery,
  ownerDashboardKeys,
  ownerDashboardQuery,
  ownerReportQuery,
  OWNER_BOARD_REFRESH_MS,
} from "./queries";

const subscribeToNothing = () => () => {};

/** True only in the browser, so a POST-backed query never runs during SSR. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

export type BoardReportStatus = "loading" | "error" | "empty" | "ready";

export type BoardReport = {
  status: BoardReportStatus;
  result: ReportResult | null;
  retry: () => void;
};

export type BoardReviews = {
  status: BoardReportStatus;
  items: Feedback[];
  retry: () => void;
};

export type OwnerBoard = {
  layout: DashboardLayout;
  report: (reportCode: string | null | undefined) => BoardReport;
  reviews: BoardReviews;
  /** Some request is in flight (the refresh button shows it). */
  isFetching: boolean;
  /** Browser time of the last successful report read; null before hydration. */
  lastUpdatedAt: number | null;
  refresh: () => void;
};

function reportState(
  query: UseQueryResult<ReportResult, Error> | undefined,
): BoardReport {
  if (query === undefined)
    return { status: "loading", result: null, retry: () => {} };
  const retry = () => {
    void query.refetch();
  };
  if (query.isError) return { status: "error", result: null, retry };
  if (query.data === undefined)
    return { status: "loading", result: null, retry };
  return {
    status: isReportResultEmpty(query.data) ? "empty" : "ready",
    result: query.data,
    retry,
  };
}

export function useOwnerDashboard() {
  return useSuspenseQuery(ownerDashboardQuery());
}

export function useOwnerBoard(layout: DashboardLayout): OwnerBoard {
  const hydrated = useHydrated();
  const queryClient = useQueryClient();
  const inputs = useMemo(() => ownerBoardRunInputs(layout), [layout]);
  const reportQueries = useQueries({
    queries: inputs.map((input) => ownerReportQuery(input, hydrated)),
  });
  const reviewsQuery = useQuery(latestRatingsQuery(hydrated));

  const reportsByCode = useMemo(() => {
    const map = new Map<string, UseQueryResult<ReportResult, Error>>();
    inputs.forEach((input, index) => {
      const query = reportQueries[index];
      if (query !== undefined) map.set(input.reportCode, query);
    });
    return map;
  }, [inputs, reportQueries]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ownerDashboardKeys.reports(),
    });
    void queryClient.invalidateQueries({
      queryKey: ownerDashboardKeys.reviews(),
    });
  }, [queryClient]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setInterval(refresh, OWNER_BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hydrated, refresh]);

  const lastUpdatedAt = useMemo(() => {
    if (!hydrated) return null;
    let latest = 0;
    for (const query of reportQueries)
      if (query.data !== undefined) latest = Math.max(latest, query.dataUpdatedAt);
    return latest > 0 ? latest : null;
  }, [hydrated, reportQueries]);

  const reviews: BoardReviews = {
    status: reviewsQuery.isError
      ? "error"
      : reviewsQuery.data === undefined
        ? "loading"
        : reviewsQuery.data.length === 0
          ? "empty"
          : "ready",
    items: reviewsQuery.data ?? [],
    retry: () => {
      void reviewsQuery.refetch();
    },
  };

  return {
    layout,
    report: (reportCode) =>
      reportState(reportCode ? reportsByCode.get(reportCode) : undefined),
    reviews,
    isFetching: reportsByCode.size > 0 && (reportQueries.some((query) => query.isFetching) || reviewsQuery.isFetching),
    lastUpdatedAt,
    refresh,
  };
}
