// Custom hooks for the attendance QR display and the review screen: the only
// way components touch its data (docs/frontend.md "Custom hooks").
import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { localDateOf, type BusinessDate } from "@starter/shared/core";
import {
  attendanceDayQuery,
  attendanceQrQuery,
  reviewEmployeesQuery,
} from "./queries.ts";
import { ATTENDANCE_TIME_ZONE } from "./outlet.ts";
import { useHydrated } from "./use-hydrated.ts";
import {
  reviewDecisionsSnapshot,
  subscribeReviewDecisions,
  type AttendanceReviewState,
} from "./review-store.ts";

/**
 * A ticking clock for the countdown. Returns null until hydration, because the
 * server cannot know the device time; the first client paint shows the
 * skeleton, then the effect starts the interval.
 */
export function useNow(intervalMs: number): number | null {
  const hydrated = useHydrated();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [hydrated, intervalMs]);
  return hydrated ? now : null;
}

/** Today's business date in the outlet time zone, re-checked every minute. */
export function useBusinessDate(): BusinessDate | null {
  const now = useNow(60_000);
  return now === null
    ? null
    : localDateOf(new Date(now), ATTENDANCE_TIME_ZONE);
}

export function useAttendanceQr() {
  const hydrated = useHydrated();
  return useQuery({ ...attendanceQrQuery(), enabled: hydrated });
}

export function useAttendanceDay(businessDate: BusinessDate | null) {
  const hydrated = useHydrated();
  return useQuery({
    ...attendanceDayQuery(businessDate),
    enabled: hydrated && businessDate !== null,
  });
}

export function useReviewEmployees() {
  const hydrated = useHydrated();
  return useQuery({ ...reviewEmployeesQuery(), enabled: hydrated });
}

const EMPTY_DECISIONS: AttendanceReviewState = Object.freeze({});

/** Supervisor decisions kept in this browser tab (no contract endpoint yet). */
export function useReviewDecisions(
  businessDate: BusinessDate | null,
): AttendanceReviewState {
  return useSyncExternalStore(
    subscribeReviewDecisions,
    () =>
      businessDate === null
        ? EMPTY_DECISIONS
        : reviewDecisionsSnapshot(businessDate),
    () => EMPTY_DECISIONS,
  );
}
