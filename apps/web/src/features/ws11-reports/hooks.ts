// Data access of the report viewer. Runs are POST reports, so they start after
// hydration (never during SSR) like the owner dashboard's tiles.
import { useCallback, useSyncExternalStore } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type {
  CreateReportExportInput,
  ReportExport,
} from "@starter/shared/dashboard";
import { createReportExport } from "./api";
import { validateReportSearch, type ReportSearch } from "./lib";
import {
  businessScopeQuery,
  reportCatalogQuery,
  reportDefinitionQuery,
  reportExportQuery,
  reportExportsQuery,
  reportKeys,
  reportRunQuery,
} from "./queries";
import type { ReportRunInput } from "@starter/shared/dashboard";

const subscribeToNothing = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

/** The viewer filters live in the URL, so a link reproduces the view. */
export function useReportSearch(): [
  ReportSearch,
  (patch: Partial<Record<keyof ReportSearch, unknown>>) => void,
] {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate() as unknown as (options: {
    to: string;
    search: (previous: Record<string, unknown>) => Record<string, unknown>;
    replace: boolean;
  }) => void;
  const search = validateReportSearch(raw);
  const update = useCallback(
    (patch: Partial<Record<keyof ReportSearch, unknown>>) => {
      navigate({
        to: ".",
        replace: true,
        search: (previous) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const key of Object.keys(next))
            if (next[key] === undefined) delete next[key];
          return next;
        },
      });
    },
    [navigate],
  );
  return [search, update];
}

export function useReportDefinition(code: string) {
  return useQuery(reportDefinitionQuery(code, useHydrated()));
}

export function useBusinessScope() {
  return useQuery(businessScopeQuery(useHydrated()));
}

export function useReportRun(input: ReportRunInput | null) {
  return useQuery(reportRunQuery(input, useHydrated()));
}

export function useReportCatalog(query: { family?: string; search?: string }) {
  const typed = {
    ...(query.family ? { family: query.family } : {}),
    ...(query.search ? { search: query.search } : {}),
  } as Parameters<typeof reportCatalogQuery>[0];
  return useInfiniteQuery(reportCatalogQuery(typed, useHydrated()));
}

export function useReportExports(enabled: boolean) {
  const hydrated = useHydrated();
  return useQuery(reportExportsQuery(enabled && hydrated));
}

export function useReportExportJob(id: string | null) {
  return useQuery(reportExportQuery(id));
}

export function useCreateReportExport() {
  const queryClient = useQueryClient();
  return useMutation<ReportExport, Error, CreateReportExportInput>({
    mutationFn: (input) => createReportExport(input),
    onSuccess: (job) => {
      queryClient.setQueryData(reportKeys.export(job.id), job);
      void queryClient.invalidateQueries({ queryKey: reportKeys.exports() });
    },
  });
}
