// Custom hooks of the employee PWA: the only way components touch its data.
// Query keys, cache updates and invalidation live here (docs/frontend.md).
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  AttendanceCorrection,
  AttendanceLog,
} from "@starter/shared/hris";
import { ApiError } from "@/lib/api/errors";
import { useOnline } from "@/lib/use-online";
import {
  submitAttendanceCorrection,
  submitClockAttendance,
  type AttendanceCorrectionInput,
  type ClockAttendanceInput,
} from "./api.ts";
import {
  announcementsQuery,
  attendanceCorrectionPagesQuery,
  attendanceDayQuery,
  attendanceLogPagesQuery,
  hrisKeys,
  myHrisProfileQuery,
  pendingCorrectionsQuery,
  positionsQuery,
  shiftAssignmentsQuery,
} from "./queries.ts";
import {
  correctionQueueSnapshot,
  enqueueCorrection,
  readCorrectionQueue,
  removeQueuedCorrection,
  subscribeCorrectionQueue,
  type QueuedCorrection,
} from "./queue.ts";
import { useHydrated } from "./use-hydrated.ts";

export function useMyHrisProfile() {
  const hydrated = useHydrated();
  return useQuery({ ...myHrisProfileQuery(), enabled: hydrated });
}

export function useAttendanceDay(businessDate: string | null) {
  return useQuery({
    ...attendanceDayQuery(businessDate ?? "none"),
    enabled: businessDate !== null,
  });
}

export function useShiftToday(businessDate: string | null) {
  const day = businessDate ?? "none";
  return useQuery({
    ...shiftAssignmentsQuery(day, day),
    enabled: businessDate !== null,
  });
}

export function useAnnouncements(enabled = true) {
  return useQuery({ ...announcementsQuery(), enabled });
}

/** The employee's position name for the greeting (reference data). */
export function usePositions(enabled = true) {
  return useQuery({ ...positionsQuery(), enabled });
}

export function usePendingCorrections(enabled = true) {
  return useQuery({ ...pendingCorrectionsQuery(), enabled });
}

export function useAttendanceHistory(enabled = true) {
  const query = useInfiniteQuery({
    ...attendanceLogPagesQuery(),
    enabled,
  });
  const logs: AttendanceLog[] =
    query.data?.pages.flatMap((page) => page.data) ?? [];
  return { ...query, logs };
}

export function useCorrectionHistory(enabled = true) {
  const query = useInfiniteQuery({
    ...attendanceCorrectionPagesQuery(),
    enabled,
  });
  const corrections: AttendanceCorrection[] =
    query.data?.pages.flatMap((page) => page.data) ?? [];
  return { ...query, corrections };
}

/** Today's shift, if the roster published one for this business date. */
export function useClockAttendance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ClockAttendanceInput) => submitClockAttendance(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: hrisKeys.all }),
  });
}

export type CorrectionSubmitResult =
  | { status: "sent"; correction: AttendanceCorrection }
  | { status: "queued"; key: string };

function isOfflineError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.code === "NETWORK_ERROR")
  );
}

/**
 * Sends a correction; when the device is offline (or the call fails for lack
 * of a connection) the request joins the on-device queue with its idempotency
 * key and is replayed by `useFlushCorrectionQueue`. The component decides the
 * copy for "sent" vs "queued" — this hook never reports a queue as a success.
 */
export function useSubmitCorrection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: AttendanceCorrectionInput,
    ): Promise<CorrectionSubmitResult> => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        enqueueCorrection(body);
        return { status: "queued", key: body.idempotencyKey };
      }
      try {
        const correction = await submitAttendanceCorrection(body);
        return { status: "sent", correction };
      } catch (error) {
        if (!isOfflineError(error)) throw error;
        enqueueCorrection(body);
        return { status: "queued", key: body.idempotencyKey };
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: hrisKeys.all }),
  });
}

/** The on-device queue, reactive to this tab and to `storage` events. */
export function useQueuedCorrections(): QueuedCorrection[] {
  return useSyncExternalStore(
    subscribeCorrectionQueue,
    correctionQueueSnapshot,
    () => [],
  );
}

/**
 * Replays queued corrections once the browser reports it is online. Replaying
 * is safe: the same idempotency key makes the API answer with the original
 * request. A failed replay stays queued (and is retried on the next success),
 * because only a connection failure is guaranteed to be temporary-safe here.
 */
export function useFlushCorrectionQueue() {
  const online = useOnline();
  const queryClient = useQueryClient();
  const flushing = useRef(false);
  useEffect(() => {
    if (!online || flushing.current) return;
    const queue = readCorrectionQueue();
    if (queue.length === 0) return;
    flushing.current = true;
    void (async () => {
      let sent = 0;
      for (const row of queue) {
        try {
          await submitAttendanceCorrection(row.body);
          removeQueuedCorrection(row.key);
          sent += 1;
        } catch {
          // Keep it queued; the next online event retries with the same key.
          break;
        }
      }
      flushing.current = false;
      if (sent > 0)
        await queryClient.invalidateQueries({ queryKey: hrisKeys.all });
    })();
  }, [online, queryClient]);
}
