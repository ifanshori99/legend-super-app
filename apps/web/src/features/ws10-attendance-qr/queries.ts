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
  CONVERGED_WIDTH_MS,
  estimateOffset,
  nextClockBounds,
  type ClockBounds,
} from "./clock.ts";
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

/** The live token and the estimated server-minus-device clock offset. */
export type AttendanceQrReading = {
  readonly qr: AttendanceQrToken;
  readonly offsetMs: number;
  /** True once the offset is known to within CONVERGED_WIDTH_MS. */
  readonly converged: boolean;
};

/** Short poll while the clock offset is still uncertain (bounds staleness). */
const UNCERTAIN_POLL_MS = 5_000;
/** One display per tab: the bounds live as long as the page. */
let clockBounds: ClockBounds | null = null;

/** Milliseconds left on the token, measured on the server's clock. */
export function qrRemainingMs(reading: AttendanceQrReading, deviceNow: number) {
  return Date.parse(reading.qr.expiresAt) - (deviceNow + reading.offsetMs);
}

/**
 * The current outlet token. The next poll lands just after the token expires
 * on the SERVER clock (skew-corrected, see clock.ts) instead of drifting away
 * from the 30-second window (F25). While the device/server offset is still
 * uncertain the poll is capped at 5 s, so a skewed display never shows a
 * rotated token for long. Polling pauses in a hidden tab; the focus refetch
 * picks up a fresh token when the screen is visible again.
 */
export function attendanceQrQuery() {
  return queryOptions({
    queryKey: attendanceQrKeys.token(),
    queryFn: async ({ signal }): Promise<AttendanceQrReading> => {
      const { qr, sentAt, receivedAt } = await fetchAttendanceQr(signal);
      clockBounds = nextClockBounds(clockBounds, qr, sentAt, receivedAt);
      return {
        qr,
        offsetMs: estimateOffset(clockBounds),
        converged: clockBounds.hi - clockBounds.lo <= CONVERGED_WIDTH_MS,
      };
    },
    staleTime: 0,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return ATTENDANCE_QR_ROTATION_SECONDS * 1_000;
      const untilExpiry = Math.max(
        1_000,
        qrRemainingMs(data, Date.now()) + 250,
      );
      return data.converged
        ? untilExpiry
        : Math.min(untilExpiry, UNCERTAIN_POLL_MS);
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
