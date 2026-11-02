// Custom hooks of the employee PWA: the only way components touch its data.
// Query keys, cache updates and invalidation live here (docs/frontend.md).
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useT } from "@/components/i18n";
import { useToast } from "@/components/ui/toast";
import type { AttendanceCorrection, AttendanceLog } from "@starter/shared/hris";
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
  isRetryableReplayError,
  queuedFor,
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

/** The session employee's own id, once `/api/hris/me` answered (HR-01). */
function useMyEmployeeId(): string | null {
  return useMyHrisProfile().data?.employee.id ?? null;
}

export function useAttendanceDay(businessDate: string | null) {
  const employeeId = useMyEmployeeId();
  return useQuery({
    ...attendanceDayQuery(employeeId ?? "none", businessDate ?? "none"),
    enabled: businessDate !== null && employeeId !== null,
  });
}

export function useShiftToday(businessDate: string | null) {
  const employeeId = useMyEmployeeId();
  const day = businessDate ?? "none";
  return useQuery({
    ...shiftAssignmentsQuery(employeeId ?? "none", day, day),
    enabled: businessDate !== null && employeeId !== null,
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
  const employeeId = useMyEmployeeId();
  return useQuery({
    ...pendingCorrectionsQuery(employeeId ?? "none"),
    enabled: enabled && employeeId !== null,
  });
}

export function useAttendanceHistory(enabled = true) {
  const employeeId = useMyEmployeeId();
  const query = useInfiniteQuery({
    ...attendanceLogPagesQuery(employeeId ?? "none"),
    enabled: enabled && employeeId !== null,
  });
  const logs: AttendanceLog[] =
    query.data?.pages.flatMap((page) => page.data) ?? [];
  return { ...query, logs };
}

export function useCorrectionHistory(enabled = true) {
  const employeeId = useMyEmployeeId();
  const query = useInfiniteQuery({
    ...attendanceCorrectionPagesQuery(employeeId ?? "none"),
    enabled: enabled && employeeId !== null,
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: hrisKeys.all }),
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
  const employeeId = useMyEmployeeId();
  return useMutation({
    mutationFn: async (
      body: AttendanceCorrectionInput,
    ): Promise<CorrectionSubmitResult> => {
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      if (offline && employeeId !== null) {
        enqueueCorrection(body, employeeId);
        return { status: "queued", key: body.idempotencyKey };
      }
      try {
        const correction = await submitAttendanceCorrection(body);
        return { status: "sent", correction };
      } catch (error) {
        if (!isOfflineError(error) || employeeId === null) throw error;
        enqueueCorrection(body, employeeId);
        return { status: "queued", key: body.idempotencyKey };
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: hrisKeys.all }),
  });
}

const EMPTY_QUEUE: QueuedCorrection[] = [];

/**
 * The signed-in employee's own entries of the on-device queue, reactive to
 * this tab and to `storage` events.
 */
export function useQueuedCorrections(): QueuedCorrection[] {
  const employeeId = useMyEmployeeId();
  const queue = useSyncExternalStore(
    subscribeCorrectionQueue,
    correctionQueueSnapshot,
    () => EMPTY_QUEUE,
  );
  return useMemo(() => queuedFor(queue, employeeId), [queue, employeeId]);
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
  const employeeId = useMyEmployeeId();
  const toast = useToast();
  const t = useT();
  const flushing = useRef(false);
  useEffect(() => {
    if (!online || employeeId === null || flushing.current) return;
    // Only this session's own entries (HR-01): another employee's queued
    // request waits for that employee to sign in on this device again.
    const queue = queuedFor(readCorrectionQueue(), employeeId);
    if (queue.length === 0) return;
    flushing.current = true;
    void (async () => {
      let settled = 0;
      let dropped = 0;
      for (const row of queue) {
        try {
          await submitAttendanceCorrection(row.body);
          removeQueuedCorrection(row.key);
          settled += 1;
        } catch (error) {
          const status = error instanceof ApiError ? error.status : undefined;
          // Still offline or the server is down: keep it, retry next time.
          if (isRetryableReplayError(status)) break;
          // A final answer (validation, not found, key reused): replaying it
          // can never succeed, and keeping it would block the rest forever.
          removeQueuedCorrection(row.key);
          settled += 1;
          dropped += 1;
        }
      }
      flushing.current = false;
      if (dropped > 0)
        toast({
          title: t("hris.correction.errorTitle"),
          description: t("hris.correction.replayDropped", { count: dropped }),
          tone: "danger",
        });
      if (settled > 0)
        await queryClient.invalidateQueries({ queryKey: hrisKeys.all });
    })();
  }, [online, employeeId, queryClient, toast, t]);
}
