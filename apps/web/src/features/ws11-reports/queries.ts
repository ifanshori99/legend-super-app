// Query keys and options of the report viewer.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { retryOnceOnServerError } from "@/lib/api/retry";
import type {
  ReportCatalogQuery,
  ReportRunInput,
} from "@starter/shared/dashboard";
import {
  fetchBusinessScope,
  fetchReportCatalog,
  fetchReportDefinition,
  fetchReportExport,
  fetchReportExports,
  runReport,
} from "./api";

export const reportKeys = {
  all: ["ws11-reports"] as const,
  catalog: (query: Omit<ReportCatalogQuery, "cursor" | "limit">) =>
    [...reportKeys.all, "catalog", query] as const,
  definition: (code: string) =>
    [...reportKeys.all, "definition", code] as const,
  scope: () => [...reportKeys.all, "scope"] as const,
  runs: () => [...reportKeys.all, "run"] as const,
  run: (input: ReportRunInput) => [...reportKeys.runs(), input] as const,
  exports: () => [...reportKeys.all, "exports"] as const,
  export: (id: string) => [...reportKeys.exports(), id] as const,
};

export const CATALOG_PAGE_SIZE = 25;
export const EXPORT_LIST_SIZE = 5;
export const EXPORT_POLL_MS = 2_000;

export function reportCatalogQuery(
  query: Omit<ReportCatalogQuery, "cursor" | "limit">,
  enabled = true,
) {
  return infiniteQueryOptions({
    queryKey: reportKeys.catalog(query),
    queryFn: ({ pageParam, signal }) =>
      fetchReportCatalog(
        {
          ...query,
          limit: CATALOG_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    enabled,
    retry: retryOnceOnServerError,
  });
}

export function reportDefinitionQuery(code: string, enabled = true) {
  return queryOptions({
    queryKey: reportKeys.definition(code),
    queryFn: ({ signal }) => fetchReportDefinition(code, signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: retryOnceOnServerError,
  });
}

export function businessScopeQuery(enabled = true) {
  return queryOptions({
    queryKey: reportKeys.scope(),
    queryFn: ({ signal }) => fetchBusinessScope(signal),
    enabled,
    staleTime: 60_000,
    retry: retryOnceOnServerError,
  });
}

/** POST, so it waits for hydration and for a resolved period. */
export function reportRunQuery(input: ReportRunInput | null, enabled: boolean) {
  return queryOptions({
    queryKey: reportKeys.run(
      input ??
        ({ reportCode: "", period: { startDate: "", endDate: "" } } as never),
    ),
    queryFn: ({ signal }) => runReport(input as ReportRunInput, signal),
    enabled: enabled && input !== null,
    staleTime: 0,
    retry: retryOnceOnServerError,
  });
}

export function reportExportsQuery(enabled: boolean) {
  return queryOptions({
    queryKey: reportKeys.exports(),
    queryFn: ({ signal }) => fetchReportExports(25, signal),
    enabled,
    retry: retryOnceOnServerError,
  });
}

/** Polls a job until it is ready, failed or waiting for a person (DASH-04). */
export function reportExportQuery(id: string | null) {
  return queryOptions({
    queryKey: reportKeys.export(id ?? "none"),
    queryFn: ({ signal }) => fetchReportExport(id as string, signal),
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "generating"
        ? EXPORT_POLL_MS
        : false;
    },
    retry: retryOnceOnServerError,
  });
}
