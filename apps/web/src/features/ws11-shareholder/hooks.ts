// Data access of the shareholder dashboard. Every region maps its query to one
// of five states so loading / empty / error / offline are never forgotten.
import { useMemo, useSyncExternalStore } from "react";
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api/errors";
import type {
  MyProfitShare,
  ShareholderDocument,
} from "@starter/shared/accounting";
import type { DashboardLayout, ReportResult } from "@starter/shared/dashboard";
import {
  isMyProfitShareEmpty,
  isReportResultEmpty,
  runInput,
  runKey,
  shareholderRunInputs,
  visibleDocuments,
  type SharePeriod,
} from "./board.ts";
import {
  myProfitShareQuery,
  shareholderDashboardQuery,
  shareholderDocumentsQuery,
  shareholderKeys,
  shareholderReportQuery,
} from "./queries";

const subscribeToNothing = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

export type RegionStatus = "loading" | "error" | "offline" | "empty" | "ready";

function failureStatus(error: unknown): "error" | "offline" {
  return error instanceof ApiError && error.status === 0 ? "offline" : "error";
}

export type BoardRun = {
  status: RegionStatus;
  result: ReportResult | null;
  retry: () => void;
};

export type ShareholderBoard = {
  layout: DashboardLayout;
  run: (reportCode: string, period: SharePeriod) => BoardRun;
  isFetching: boolean;
  refresh: () => void;
};

function runState(
  query: UseQueryResult<ReportResult, Error> | undefined,
): BoardRun {
  if (query === undefined)
    return { status: "loading", result: null, retry: () => {} };
  const retry = () => {
    void query.refetch();
  };
  if (query.isError)
    return { status: failureStatus(query.error), result: null, retry };
  if (query.data === undefined)
    return { status: "loading", result: null, retry };
  return {
    status: isReportResultEmpty(query.data) ? "empty" : "ready",
    result: query.data,
    retry,
  };
}

export function useShareholderDashboard() {
  return useSuspenseQuery(shareholderDashboardQuery());
}

export function useShareholderBoard(layout: DashboardLayout): ShareholderBoard {
  const hydrated = useHydrated();
  const queryClient = useQueryClient();
  const inputs = useMemo(() => shareholderRunInputs(layout), [layout]);
  const queries = useQueries({
    queries: inputs.map((input) => shareholderReportQuery(input, hydrated)),
  });
  const byKey = useMemo(() => {
    const map = new Map<string, UseQueryResult<ReportResult, Error>>();
    inputs.forEach((input, index) => {
      const query = queries[index];
      if (query !== undefined) map.set(runKey(input), query);
    });
    return map;
  }, [inputs, queries]);

  return {
    layout,
    run: (reportCode, period) =>
      runState(byKey.get(runKey(runInput(layout, reportCode, period)))),
    isFetching: queries.some((query) => query.isFetching),
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: shareholderKeys.all });
    },
  };
}

export type MyProfitShareState = {
  status: RegionStatus;
  data: MyProfitShare | null;
  retry: () => void;
};

export function useMyProfitShare(): MyProfitShareState {
  const hydrated = useHydrated();
  const query = useQuery({ ...myProfitShareQuery(), enabled: hydrated });
  const retry = () => {
    void query.refetch();
  };
  if (query.isError)
    return { status: failureStatus(query.error), data: null, retry };
  if (query.data === undefined) return { status: "loading", data: null, retry };
  return {
    status: isMyProfitShareEmpty(query.data) ? "empty" : "ready",
    data: query.data,
    retry,
  };
}

export type DocumentsState = {
  status: RegionStatus;
  items: ShareholderDocument[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
};

export function useShareholderDocuments(): DocumentsState {
  const hydrated = useHydrated();
  const query = useInfiniteQuery({
    ...shareholderDocumentsQuery(),
    enabled: hydrated,
  });
  const retry = () => {
    void query.refetch();
  };
  const items = visibleDocuments(
    (query.data?.pages ?? []).flatMap((page) => page.data),
  );
  const base = {
    items,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => {
      void query.fetchNextPage();
    },
    retry,
  };
  if (query.isError)
    return { ...base, status: failureStatus(query.error), items: [] };
  if (query.data === undefined) return { ...base, status: "loading" };
  return { ...base, status: items.length === 0 ? "empty" : "ready" };
}
