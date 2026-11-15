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

import { hrisKeys } from "./keys.ts";

export { hrisKeys };

export function myHrisProfileQuery(userId: string) {
  return queryOptions({
    queryKey: hrisKeys.profile(userId),
    queryFn: ({ signal }) => fetchMyHrisProfile(signal),
    staleTime: 5 * 60_000,
  });
}

/** The employee's own logs for one business date (home timeline). */
export function attendanceDayQuery(employeeId: string, businessDate: string) {
  return queryOptions({
    queryKey: hrisKeys.dayLogs(employeeId, businessDate),
    queryFn: ({ signal }) =>
      fetchAttendanceLogs(
        { employeeId, limit: HOME_LOG_LIMIT, businessDate },
        signal,
      ),
    staleTime: 0,
  });
}

/** Every own log, newest first (history tab, cursor paginated). */
export function attendanceLogPagesQuery(employeeId: string) {
  return infiniteQueryOptions({
    queryKey: hrisKeys.logPages(employeeId),
    queryFn: ({ pageParam, signal }) =>
      fetchAttendanceLogs(
        { employeeId, limit: HISTORY_PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
}

/** Corrections this employee sent, newest first. */
export function attendanceCorrectionPagesQuery(employeeId: string) {
  return infiniteQueryOptions({
    queryKey: hrisKeys.correctionPages(employeeId),
    queryFn: ({ pageParam, signal }) =>
      fetchAttendanceCorrections(
        { employeeId, limit: HISTORY_PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
}

/** The pending corrections shown on the Beranda. */
export function pendingCorrectionsQuery(employeeId: string) {
  return queryOptions({
    queryKey: hrisKeys.pendingCorrections(employeeId),
    queryFn: ({ signal }) =>
      fetchAttendanceCorrections(
        { employeeId, limit: HOME_CORRECTION_LIMIT, status: "pending" },
        signal,
      ),
    staleTime: 0,
  });
}

/** Published shifts of one business date (normally zero or one). */
export function shiftAssignmentsQuery(
  employeeId: string,
  from: string,
  to: string,
) {
  return queryOptions({
    queryKey: hrisKeys.shifts(employeeId, from, to),
    queryFn: ({ signal }) =>
      fetchShiftAssignments({ employeeId, from, to, limit: 10 }, signal),
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
