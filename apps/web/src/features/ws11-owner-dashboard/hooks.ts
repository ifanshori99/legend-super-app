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
import type {
  DashboardLayout,
  ReportResult,
  ReportRunInput,
} from "@starter/shared/dashboard";
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
  refresh: () => void;
};

export function reportState(
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
    // Only while the tab is visible: a background tab must not keep firing
    // the board's report runs at the API every minute.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, OWNER_BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hydrated, refresh]);

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
    isFetching:
      reportsByCode.size > 0 &&
      (reportQueries.some((query) => query.isFetching) ||
        reviewsQuery.isFetching),
    refresh,
  };
}

/** Aggregate state of several runs: any failure, then any wait, then empty. */
export function combineReports(reports: readonly BoardReport[]): BoardReport {
  const retry = () => reports.forEach((report) => report.retry());
  if (reports.some((report) => report.status === "error"))
    return { status: "error", result: null, retry };
  if (reports.some((report) => report.status === "loading"))
    return { status: "loading", result: null, retry };
  const ready = reports.filter((report) => report.status === "ready");
  return {
    status: ready.length === 0 ? "empty" : "ready",
    result: null,
    retry,
  };
}

/**
 * Runs the given source reports (part 2 sections run theirs only while their
 * tab is open). Same query keys as the board, so refresh reloads them too.
 */
export function useReportRuns(
  inputs: readonly ReportRunInput[],
): BoardReport[] {
  const hydrated = useHydrated();
  const queries = useQueries({
    queries: inputs.map((input) => ownerReportQuery(input, hydrated)),
  });
  return queries.map((query) => reportState(query));
}
