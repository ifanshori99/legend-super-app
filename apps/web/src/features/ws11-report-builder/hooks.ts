// Data access of the report builder.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReportBuilderQuery } from "@starter/shared/dashboard";
import {
  createReportSchedule,
  createSavedReport,
  updateReportSchedule,
  updateSavedReport,
} from "./api";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import {
  builderOutletsQuery,
  previewQuery,
  reportBuilderKeys,
  reportSchedulesQuery,
  savedReportsQuery,
  scheduleRecipientsQuery,
} from "./queries";

const subscribeToNothing = () => () => {};

/** True only in the browser, so POST-backed queries never run during SSR. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

/** A value that follows `value` after it stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function usePreview(query: ReportBuilderQuery | null) {
  const hydrated = useHydrated();
  return useQuery(previewQuery(query, hydrated));
}

export function useSavedReports() {
  return useQuery(savedReportsQuery(useHydrated()));
}

export function useReportSchedules() {
  return useQuery(reportSchedulesQuery(useHydrated()));
}

export function useScheduleRecipients(enabled: boolean) {
  const hydrated = useHydrated();
  return useQuery(scheduleRecipientsQuery(hydrated && enabled));
}

export function useBuilderOutlets() {
  return useQuery(builderOutletsQuery(useHydrated()));
}

/**
 * One Idempotency-Key per attempt: a retry of the same request reuses it (the
 * server replays the first result), a changed request gets a new one.
 */
export function useAttemptKey(): (request: unknown) => string {
  const last = useRef<{ print: string; key: string } | null>(null);
  return (request) => {
    const print = JSON.stringify(request);
    if (last.current?.print !== print)
      last.current = { print, key: newIdempotencyKey() };
    return last.current.key;
  };
}

export function useCreateSavedReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      input,
      idempotencyKey,
    }: {
      input: Parameters<typeof createSavedReport>[0];
      idempotencyKey: string;
    }) => createSavedReport(input, idempotencyKey),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: reportBuilderKeys.saved() }),
  });
}

export function useUpdateSavedReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: Parameters<typeof updateSavedReport>[0];
      input: Parameters<typeof updateSavedReport>[1];
    }) => updateSavedReport(id, input),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: reportBuilderKeys.saved() }),
  });
}

export function useCreateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      input,
      idempotencyKey,
    }: {
      input: Parameters<typeof createReportSchedule>[0];
      idempotencyKey: string;
    }) => createReportSchedule(input, idempotencyKey),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: reportBuilderKeys.schedules() }),
  });
}

export function useUpdateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: Parameters<typeof updateReportSchedule>[0];
      input: Parameters<typeof updateReportSchedule>[1];
    }) => updateReportSchedule(id, input),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: reportBuilderKeys.schedules() }),
  });
}
