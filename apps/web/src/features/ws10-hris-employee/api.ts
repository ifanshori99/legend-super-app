// Typed calls for the employee PWA (bead legend-nv3y). One function per
// endpoint of the HRIS contract (@starter/shared/hris); responses are unwrapped
// so hooks and components never see the `{ data }` envelope.
//
// HR-01: the self-scoped endpoints resolve the employee from the signed-in
// session. No function here accepts an employee id from the screen.

import type { z } from "zod";
import type {
  Announcement,
  AttendanceCorrection,
  AttendanceCorrectionStatus,
  AttendanceLog,
  Position,
  ShiftAssignment,
} from "@starter/shared/hris";
import {
  clockAttendance,
  getMyHrisProfile,
  listAnnouncements,
  listAttendanceCorrections,
  listAttendanceLogs,
  listPositions,
  listShiftAssignments,
  requestAttendanceCorrection,
} from "@starter/shared/hris";
import type { CursorPage } from "@starter/shared/core";
import { callEndpoint } from "@/lib/api/endpoint";

export type ClockAttendanceInput = z.input<typeof clockAttendance.body>;
export type AttendanceCorrectionInput = z.input<
  typeof requestAttendanceCorrection.body
>;

export type AttendanceLogQuery = {
  limit: number;
  cursor?: string;
  businessDate?: string;
};

export type AttendanceCorrectionQuery = {
  limit: number;
  cursor?: string;
  status?: AttendanceCorrectionStatus;
};

export async function fetchMyHrisProfile(signal?: AbortSignal) {
  const response = await callEndpoint(getMyHrisProfile, {}, { signal });
  return response.data;
}

export async function fetchAttendanceLogs(
  query: AttendanceLogQuery,
  signal?: AbortSignal,
): Promise<CursorPage<AttendanceLog>> {
  return callEndpoint(listAttendanceLogs, { query }, { signal });
}

export async function fetchAttendanceCorrections(
  query: AttendanceCorrectionQuery,
  signal?: AbortSignal,
): Promise<CursorPage<AttendanceCorrection>> {
  return callEndpoint(listAttendanceCorrections, { query }, { signal });
}

export async function fetchShiftAssignments(
  query: { from: string; to: string; limit: number },
  signal?: AbortSignal,
): Promise<CursorPage<ShiftAssignment>> {
  return callEndpoint(listShiftAssignments, { query }, { signal });
}

export async function fetchAnnouncements(
  limit: number,
  signal?: AbortSignal,
): Promise<CursorPage<Announcement>> {
  return callEndpoint(listAnnouncements, { query: { limit } }, { signal });
}

/** The employee's position is a reference; its name comes from this list. */
export async function fetchPositions(
  signal?: AbortSignal,
): Promise<CursorPage<Position>> {
  return callEndpoint(listPositions, { query: { limit: 100 } }, { signal });
}

export async function submitClockAttendance(
  body: ClockAttendanceInput,
): Promise<AttendanceLog> {
  const response = await callEndpoint(clockAttendance, { body });
  return response.data;
}

export async function submitAttendanceCorrection(
  body: AttendanceCorrectionInput,
): Promise<AttendanceCorrection> {
  const response = await callEndpoint(requestAttendanceCorrection, { body });
  return response.data;
}
