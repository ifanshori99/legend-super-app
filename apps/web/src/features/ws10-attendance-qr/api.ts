// Typed calls for the attendance QR display and the supervisor selfie review
// (bead legend-0z5k; PRD v1.7 §3 F27, F25). One function per contract endpoint
// (@starter/shared/hris); responses are unwrapped so hooks and components never
// see the `{ data }` envelope.
import type {
  AttendanceLog,
  AttendanceQrToken,
  Employee,
} from "@starter/shared/hris";
import {
  getAttendanceQr,
  listAttendanceLogs,
  listEmployees,
} from "@starter/shared/hris";
import type { BusinessDate, CursorPage } from "@starter/shared/core";
import { callEndpoint } from "@/lib/api/endpoint";
import { ATTENDANCE_OUTLET_ID } from "./outlet.ts";

/** One page holds a full day of outlet logs for the review screen. */
export const REVIEW_LOG_LIMIT = 100;
export const REVIEW_EMPLOYEE_LIMIT = 100;

export async function fetchAttendanceQr(
  signal?: AbortSignal,
): Promise<AttendanceQrToken> {
  const response = await callEndpoint(
    getAttendanceQr,
    { query: { outletId: ATTENDANCE_OUTLET_ID } },
    { signal },
  );
  return response.data;
}

export async function fetchAttendanceDay(
  businessDate: BusinessDate,
  signal?: AbortSignal,
): Promise<CursorPage<AttendanceLog>> {
  return callEndpoint(
    listAttendanceLogs,
    {
      query: {
        outletId: ATTENDANCE_OUTLET_ID,
        businessDate,
        limit: REVIEW_LOG_LIMIT,
      },
    },
    { signal },
  );
}

/** Names for the review rows; the log carries only the employee id. */
export async function fetchReviewEmployees(
  signal?: AbortSignal,
): Promise<Employee[]> {
  const response = await callEndpoint(
    listEmployees,
    { query: { limit: REVIEW_EMPLOYEE_LIMIT } },
    { signal },
  );
  return response.data;
}
