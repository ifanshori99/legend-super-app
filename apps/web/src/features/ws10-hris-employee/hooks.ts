// Custom hooks of the employee PWA: the only way components touch its data.
// Query keys, cache updates and invalidation live here (docs/frontend.md).
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useT } from "@/components/i18n";
import { useToast } from "@/components/ui/toast";
import type { AttendanceCorrection, AttendanceLog } from "@starter/shared/hris";
import { ApiError } from "@/lib/api/errors";
import { useOnline } from "@/lib/use-online";
import {
  fetchMyHrisProfile,
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
  clearCorrectionRefusal,
  enqueueCorrection,
  hasQueuedCorrection,
  isRefused,
  queuedFor,
  readCorrectionQueue,
  removeQueuedCorrection,
  replaceQueuedCorrection,
  replayCorrectionQueue,
  replayQueuedCorrection,
  subscribeCorrectionQueue,
  type QueuedCorrection,
  type ReplayOutcome,
} from "./queue.ts";
import { canActOnQueued } from "./identity.ts";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useHydrated } from "./use-hydrated.ts";

export function useMyHrisProfile() {
  const hydrated = useHydrated();
  // The session user id comes from the root route context; without a session
  // the query stays off. It keys the cache, so profiles never cross accounts.
  const { session } = useRouteContext({ strict: false }) as {
    session?: { user?: { id?: string } } | null;
  };
  // Mock mode has no API, so no session: one fixed key stands in for the user
  // (the flag is compiled out of a real build, where a missing session keeps
  // the query off).
  const userId = session?.user?.id ?? (API_MOCK ? "mock" : null);
  return useQuery({
    ...myHrisProfileQuery(userId ?? ""),
    enabled: hydrated && userId !== null,
  });
}

/** The session employee's own id, once `/api/hris/me` answered (HR-01). */
export function useMyEmployeeId(): string | null {
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
    mutationFn: async ({
      body,
      replaces,
    }: {
      body: AttendanceCorrectionInput;
      /** Key of the queued entry an edit ("Ubah") supersedes (legend-l5tvy). */
      replaces?: string;
    }): Promise<CorrectionSubmitResult> => {
      // Queues the attempt; an edit swaps the old entry in one write. Throws
      // `CorrectionQueueFullError` instead of reporting a lost request.
      const queueAttempt = (owner: string): CorrectionSubmitResult => {
        if (replaces !== undefined && hasQueuedCorrection(replaces, owner))
          replaceQueuedCorrection(replaces, body, owner);
        else enqueueCorrection(body, owner);
        return { status: "queued", key: body.idempotencyKey };
      };
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      if (offline && employeeId !== null) return queueAttempt(employeeId);
      try {
        // The session cookie is shared by every tab: POST only when the server
        // proved this tab's employee still holds the session, or the request
        // would be filed under whoever signed in last. No answer ("unknown")
        // queues it: it is replayed once the identity can be proven.
        if (employeeId !== null) {
          const owner = await sessionOwnership(employeeId);
          if (owner === "no") throw identityChangedError();
          if (owner === "unknown") return queueAttempt(employeeId);
        }
        const correction = await submitAttendanceCorrection(body);
        // The response names its owner: a correction filed under someone else
        // neither counts as sent nor discards the queued original.
        if (employeeId !== null && correction.employeeId !== employeeId)
          throw identityChangedError();
        // The server has the edit: only now does the refused original go.
        if (
          replaces !== undefined &&
          employeeId !== null &&
          hasQueuedCorrection(replaces, employeeId)
        )
          removeQueuedCorrection(replaces);
        return { status: "sent", correction };
      } catch (error) {
        if (!isOfflineError(error) || employeeId === null) throw error;
        return queueAttempt(employeeId);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: hrisKeys.all }),
  });
}

/**
 * "yes" only when the server's own answer for the current cookie is this
 * employee; "no" when it names someone else; "unknown" on any failure
 * (offline, 5xx), so the entry stays queued and a later attempt tries again.
 */
type SessionOwnership = "yes" | "no" | "unknown";
async function sessionOwnership(employeeId: string): Promise<SessionOwnership> {
  try {
    const fresh = await fetchMyHrisProfile();
    return fresh.employee.id === employeeId ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

/**
 * Submit for a replay of `ownerId`'s queued entry: a response that names
 * another owner is not a success, so the entry is neither removed nor marked
 * refused (no status: the replay counts it as "retry later").
 */
function submitForOwner(
  ownerId: string,
): (body: AttendanceCorrectionInput) => Promise<AttendanceCorrection> {
  return async (body) => {
    const correction = await submitAttendanceCorrection(body);
    if (correction.employeeId !== ownerId)
      throw new Error("Correction was filed under another employee.");
    return correction;
  };
}

function identityChangedError(): ApiError {
  return new ApiError(
    409,
    "IDENTITY_CHANGED",
    "The signed-in account changed; reload and try again.",
  );
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
    // Entries the server already refused wait for the employee's decision
    // (retry, edit or discard); they are not replayed automatically.
    if (queue.every(isRefused)) return;
    flushing.current = true;
    void (async () => {
      // The session cookie is shared by every tab: another tab may have signed
      // in as someone else since this one loaded its profile. Replay only when
      // the server still names the same employee, or the request would be
      // filed under the wrong person.
      if ((await sessionOwnership(employeeId)) !== "yes") {
        flushing.current = false;
        return;
      }
      // A final answer (validation, not found, key reused) keeps the entry,
      // marked refused, and does not block the entries behind it.
      const { sent, refused } = await replayCorrectionQueue(
        queue,
        submitForOwner(employeeId),
      );
      flushing.current = false;
      if (refused > 0)
        toast({
          title: t("hris.correction.errorTitle"),
          description: t("hris.correction.replayDropped", { count: refused }),
          tone: "danger",
        });
      if (sent > 0)
        await queryClient.invalidateQueries({ queryKey: hrisKeys.all });
    })();
  }, [online, employeeId, queryClient, toast, t]);
}

/**
 * "Coba lagi" on a refused entry: clears the flag, then replays it once. A
 * new refusal marks it again with the fresh reason; a connection failure
 * leaves it waiting for the automatic flush.
 */
export function useRetryCorrection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useT();
  const employeeId = useMyEmployeeId();
  return useMutation({
    mutationFn: async (
      row: QueuedCorrection,
    ): Promise<ReplayOutcome | "skipped"> => {
      // Read at action time: a row of another account is never retried here.
      if (!canActOnQueued(row, employeeId)) return "skipped";
      // Same check against the server's current session (a stale second tab).
      const owner = await sessionOwnership(row.employeeId);
      if (owner === "no") return "skipped";
      // Could not prove it (offline or a server fault): keep the refusal as is
      // and say so, instead of a silent no-op.
      if (owner === "unknown") return "retryLater";
      clearCorrectionRefusal(row.key);
      // Replay reads only `key` and `body`, so the stale flag on `row` is moot.
      return replayQueuedCorrection(row, submitForOwner(row.employeeId));
    },
    onSuccess: (outcome) => {
      if (outcome === "skipped") return undefined;
      // No connection or a server fault: the entry waits again, and the
      // employee must hear it instead of seeing the buttons just vanish.
      if (outcome === "retryLater")
        toast({
          title: t("hris.correction.retryLaterTitle"),
          description: t("hris.correction.retryLater"),
        });
      return outcome === "sent"
        ? queryClient.invalidateQueries({ queryKey: hrisKeys.all })
        : undefined;
    },
  });
}

/** "Buang" on a queued entry: a local action, no server data is lost. */
export function useDiscardCorrection() {
  const employeeId = useMyEmployeeId();
  return useMutation({
    mutationFn: async (row: QueuedCorrection) => {
      if (!canActOnQueued(row, employeeId)) return;
      // Same server check as retry: a stale second tab must not discard the
      // entry of the account that now holds the session.
      if ((await sessionOwnership(row.employeeId)) !== "yes") return;
      removeQueuedCorrection(row.key);
    },
  });
}
