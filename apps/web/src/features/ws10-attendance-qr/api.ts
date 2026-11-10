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
import type { BusinessDate, CursorPage, OutletId } from "@starter/shared/core";
import { callEndpoint } from "@/lib/api/endpoint";

/** One page holds a full day of outlet logs for the review screen. */
export const REVIEW_LOG_LIMIT = 100;
export const REVIEW_EMPLOYEE_LIMIT = 100;

/** The token plus the device-clock times around the call (skew estimate). */
export type AttendanceQrResponse = {
  qr: AttendanceQrToken;
  sentAt: number;
  receivedAt: number;
};

export async function fetchAttendanceQr(
  outletId: OutletId,
  signal?: AbortSignal,
): Promise<AttendanceQrResponse> {
  const sentAt = Date.now();
  const response = await callEndpoint(
    getAttendanceQr,
    { query: { outletId } },
    { signal },
  );
  return { qr: response.data, sentAt, receivedAt: Date.now() };
}

export async function fetchAttendanceDay(
  outletId: OutletId,
  businessDate: BusinessDate,
  signal?: AbortSignal,
): Promise<CursorPage<AttendanceLog>> {
  return callEndpoint(
    listAttendanceLogs,
    {
      query: {
        outletId,
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
