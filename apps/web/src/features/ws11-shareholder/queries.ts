// Query keys and options of the shareholder dashboard. Report runs are POST,
// so they wait for hydration (`enabled`) and never run during SSR.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { retryOnceOnServerError } from "@/lib/api/retry";
import type { ReportRunInput } from "@starter/shared/dashboard";
import {
  fetchMyProfitShare,
  fetchShareholderDashboard,
  fetchShareholderDocuments,
  runShareholderReport,
} from "./api";

export const shareholderKeys = {
  all: ["shareholder-home"] as const,
  layout: () => [...shareholderKeys.all, "layout"] as const,
  reports: () => [...shareholderKeys.all, "report"] as const,
  report: (input: ReportRunInput) =>
    [...shareholderKeys.reports(), input] as const,
  profitShare: () => [...shareholderKeys.all, "profit-share"] as const,
  documents: () => [...shareholderKeys.all, "documents"] as const,
};

export function shareholderDashboardQuery() {
  return queryOptions({
    queryKey: shareholderKeys.layout(),
    queryFn: ({ signal }) => fetchShareholderDashboard(signal),
    staleTime: 30_000,
    retry: retryOnceOnServerError,
  });
}

export function shareholderReportQuery(
  input: ReportRunInput,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: shareholderKeys.report(input),
    queryFn: ({ signal }) => runShareholderReport(input, signal),
    enabled,
    staleTime: 0,
    retry: retryOnceOnServerError,
  });
}

export function myProfitShareQuery() {
  return queryOptions({
    queryKey: shareholderKeys.profitShare(),
    queryFn: ({ signal }) => fetchMyProfitShare(signal),
    staleTime: 0,
    retry: retryOnceOnServerError,
  });
}

export function shareholderDocumentsQuery() {
  return infiniteQueryOptions({
    queryKey: shareholderKeys.documents(),
    queryFn: ({ pageParam, signal }) =>
      fetchShareholderDocuments(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
    retry: retryOnceOnServerError,
  });
}
