// Query keys and options of the report builder. Reads that are POST (the
// preview) wait for hydration; saved reports and schedules are GET lists.
import { queryOptions } from "@tanstack/react-query";
import { retryOnceOnServerError } from "@/lib/api/retry";
import type { ReportBuilderQuery } from "@starter/shared/dashboard";
import {
  fetchBuilderOutlets,
  fetchReportSchedules,
  fetchScheduleRecipients,
  fetchSavedReports,
  previewReport,
} from "./api";

export const reportBuilderKeys = {
  all: ["report-builder"] as const,
  preview: (query: ReportBuilderQuery) =>
    [...reportBuilderKeys.all, "preview", query] as const,
  saved: () => [...reportBuilderKeys.all, "saved"] as const,
  schedules: () => [...reportBuilderKeys.all, "schedules"] as const,
  outlets: () => [...reportBuilderKeys.all, "outlets"] as const,
  recipients: () => [...reportBuilderKeys.all, "recipients"] as const,
};

export function previewQuery(
  query: ReportBuilderQuery | null,
  enabled: boolean,
) {
  return queryOptions({
    // The key never runs with a null query (`enabled` is false then).
    queryKey: reportBuilderKeys.preview(
      query ?? ({} as unknown as ReportBuilderQuery),
    ),
    queryFn: ({ signal }) => previewReport(query as ReportBuilderQuery, signal),
    enabled: enabled && query !== null,
    staleTime: 0,
    retry: retryOnceOnServerError,
  });
}

export function savedReportsQuery(enabled: boolean) {
  return queryOptions({
    queryKey: reportBuilderKeys.saved(),
    queryFn: ({ signal }) => fetchSavedReports(signal),
    enabled,
    staleTime: 15_000,
    retry: retryOnceOnServerError,
  });
}

export function reportSchedulesQuery(enabled: boolean) {
  return queryOptions({
    queryKey: reportBuilderKeys.schedules(),
    queryFn: ({ signal }) => fetchReportSchedules(signal),
    enabled,
    staleTime: 15_000,
    retry: retryOnceOnServerError,
  });
}

export function scheduleRecipientsQuery(enabled: boolean) {
  return queryOptions({
    queryKey: reportBuilderKeys.recipients(),
    queryFn: ({ signal }) => fetchScheduleRecipients(signal),
    enabled,
    staleTime: 60_000,
    retry: retryOnceOnServerError,
  });
}

export function builderOutletsQuery(enabled: boolean) {
  return queryOptions({
    queryKey: reportBuilderKeys.outlets(),
    queryFn: ({ signal }) => fetchBuilderOutlets(signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: retryOnceOnServerError,
  });
}
