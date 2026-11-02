// Query keys and options of the employee PWA. Hierarchical under "hris" so one
// invalidation (after a clock or a correction) refreshes the whole Beranda.
//
// Every query is disabled until hydration: "today" is named in the outlet's
// time zone from the device clock, and the server render must not guess it
// (docs/frontend.md "Server rendering with data" + no hydration drift). This
// area is a noindex PWA behind a guard, so a client-side read is the honest
// choice; the Beranda skeleton is the SSR output.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  fetchAnnouncements,
  fetchAttendanceCorrections,
  fetchAttendanceLogs,
  fetchMyHrisProfile,
  fetchPositions,
  fetchShiftAssignments,
} from "./api.ts";

export const HOME_LOG_LIMIT = 50;
export const HISTORY_PAGE_SIZE = 30;
export const HOME_CORRECTION_LIMIT = 3;
export const HOME_ANNOUNCEMENT_LIMIT = 3;

export const hrisKeys = {
  all: ["hris"] as const,
  profile: () => [...hrisKeys.all, "profile"] as const,
  dayLogs: (businessDate: string) =>
    [...hrisKeys.all, "day-logs", businessDate] as const,
  logPages: () => [...hrisKeys.all, "log-pages"] as const,
  correctionPages: () => [...hrisKeys.all, "correction-pages"] as const,
  pendingCorrections: () =>
    [...hrisKeys.all, "corrections", "pending"] as const,
  shifts: (from: string, to: string) =>
    [...hrisKeys.all, "shifts", from, to] as const,
  announcements: () => [...hrisKeys.all, "announcements"] as const,
  positions: () => [...hrisKeys.all, "positions"] as const,
};

export function myHrisProfileQuery() {
  return queryOptions({
    queryKey: hrisKeys.profile(),
    queryFn: ({ signal }) => fetchMyHrisProfile(signal),
    staleTime: 5 * 60_000,
  });
}

/** The employee's own logs for one business date (home timeline). */
export function attendanceDayQuery(businessDate: string) {
  return queryOptions({
    queryKey: hrisKeys.dayLogs(businessDate),
    queryFn: ({ signal }) =>
      fetchAttendanceLogs(
        { limit: HOME_LOG_LIMIT, businessDate },
        signal,
      ),
    staleTime: 0,
  });
}

/** Every own log, newest first (history tab, cursor paginated). */
export function attendanceLogPagesQuery() {
  return infiniteQueryOptions({
    queryKey: hrisKeys.logPages(),
    queryFn: ({ pageParam, signal }) =>
      fetchAttendanceLogs(
        { limit: HISTORY_PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
}

/** Corrections this employee sent, newest first. */
export function attendanceCorrectionPagesQuery() {
  return infiniteQueryOptions({
    queryKey: hrisKeys.correctionPages(),
    queryFn: ({ pageParam, signal }) =>
      fetchAttendanceCorrections(
        { limit: HISTORY_PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
}

/** The pending corrections shown on the Beranda. */
export function pendingCorrectionsQuery() {
  return queryOptions({
    queryKey: hrisKeys.pendingCorrections(),
    queryFn: ({ signal }) =>
      fetchAttendanceCorrections(
        { limit: HOME_CORRECTION_LIMIT, status: "pending" },
        signal,
      ),
    staleTime: 0,
  });
}

/** Published shifts of one business date (normally zero or one). */
export function shiftAssignmentsQuery(from: string, to: string) {
  return queryOptions({
    queryKey: hrisKeys.shifts(from, to),
    queryFn: ({ signal }) =>
      fetchShiftAssignments({ from, to, limit: 10 }, signal),
    staleTime: 5 * 60_000,
  });
}

export function announcementsQuery() {
  return queryOptions({
    queryKey: hrisKeys.announcements(),
    queryFn: ({ signal }) =>
      fetchAnnouncements(HOME_ANNOUNCEMENT_LIMIT, signal),
    staleTime: 5 * 60_000,
  });
}

/** Reference data for the greeting: the employee's position name. */
export function positionsQuery() {
  return queryOptions({
    queryKey: hrisKeys.positions(),
    queryFn: ({ signal }) => fetchPositions(signal),
    staleTime: 30 * 60_000,
  });
}
