// Query keys and options for the attendance QR display and the supervisor
// selfie review. Hierarchical under "attendance-qr" so one invalidation
// refreshes every screen of the feature.
//
// The QR query is deliberately not prefetched during SSR: the token is a live
// 30-second window minted from the browser clock, and the server render must
// not guess it (docs/frontend.md "Server rendering with data").
import { queryOptions, skipToken } from "@tanstack/react-query";
import type { BusinessDate } from "@starter/shared/core";
import {
  ATTENDANCE_QR_ROTATION_SECONDS,
  type AttendanceQrToken,
} from "@starter/shared/hris";
import {
  fetchAttendanceDay,
  fetchAttendanceQr,
  fetchReviewEmployees,
} from "./api.ts";
import { ATTENDANCE_OUTLET_ID } from "./outlet.ts";

export const attendanceQrKeys = {
  all: ["attendance-qr"] as const,
  token: () =>
    [...attendanceQrKeys.all, "token", ATTENDANCE_OUTLET_ID] as const,
  dayLogs: (businessDate: BusinessDate | "unknown") =>
    [
      ...attendanceQrKeys.all,
      "day-logs",
      ATTENDANCE_OUTLET_ID,
      businessDate,
    ] as const,
  employees: () => [...attendanceQrKeys.all, "employees"] as const,
};

/**
 * The current outlet token. `refetchInterval` is a function of the previous
 * response, so the next poll lands just after `expiresAt` instead of drifting
 * away from the 30-second window (F25).
 */
export function attendanceQrQuery() {
  return queryOptions({
    queryKey: attendanceQrKeys.token(),
    queryFn: ({ signal }) => fetchAttendanceQr(signal),
    staleTime: 0,
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const data: AttendanceQrToken | undefined = query.state.data;
      if (!data) return ATTENDANCE_QR_ROTATION_SECONDS * 1_000;
      const remaining = Date.parse(data.expiresAt) - Date.now();
      return Math.max(1_000, remaining + 500);
    },
  });
}

/** The outlet's logs for one business date (client-only business date). */
export function attendanceDayQuery(businessDate: BusinessDate | null) {
  return queryOptions({
    queryKey: attendanceQrKeys.dayLogs(businessDate ?? "unknown"),
    queryFn:
      businessDate === null
        ? skipToken
        : ({ signal }) => fetchAttendanceDay(businessDate, signal),
    staleTime: 0,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
}

/** Employee names for the review rows (reference data). */
export function reviewEmployeesQuery() {
  return queryOptions({
    queryKey: attendanceQrKeys.employees(),
    queryFn: ({ signal }) => fetchReviewEmployees(signal),
    staleTime: 5 * 60_000,
  });
}
