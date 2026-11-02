// Display and decision helpers for the employee attendance PWA (bead
// legend-nv3y; PRD v1.7 §3 Kelompok D 33 "HRIS Self-Service Karyawan", F25,
// §4 Alur L, HR-02).
//
// Everything here is pure (no React, no `@/` alias) so the root node tests can
// load it: `tests/legend-nv3y.test.mjs`. The safety decisions themselves stay on
// the server (`evaluateAttendanceSubmission` in @starter/shared/hris); this file
// only names states the screen renders and the next action the employee takes.

import { businessDateOf } from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";
import type {
  AttendanceCorrectionStatus,
  AttendanceFlagReason,
  AttendanceLog,
  AttendanceType,
  AttendanceValidity,
  ShiftAssignment,
} from "@starter/shared/hris";

/** What today looks like from the employee's own log stream (Alur L). */
export type AttendanceDayStatus =
  "not_started" | "working" | "on_break" | "finished";

const TYPE_ORDER: Record<AttendanceType, number> = {
  in: 0,
  break_start: 1,
  break_end: 2,
  out: 3,
};

/** Oldest first; equal instants keep the day's natural order (in → out). */
export function sortLogsAsc(
  logs: readonly AttendanceLog[],
): readonly AttendanceLog[] {
  return [...logs].sort((left, right) => {
    const diff = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
    return diff !== 0 ? diff : TYPE_ORDER[left.type] - TYPE_ORDER[right.type];
  });
}

/** Logs that belong to one business date in the outlet's time zone. */
export function logsForBusinessDate(
  logs: readonly AttendanceLog[],
  businessDate: string,
  timeZone: string,
): readonly AttendanceLog[] {
  return sortLogsAsc(logs).filter(
    (log) => businessDateOf(log.occurredAt, timeZone) === businessDate,
  );
}

/** The business date of an instant, named the way the attendance service does. */
export function businessDateIn(timeZone: string, now: Date = new Date()) {
  return businessDateOf(now, timeZone);
}

/**
 * The day's state from the last log. A rejected log never counts as presence:
 * the server decided it is invalid, so the employee is still "not started".
 */
export function dayStatus(logs: readonly AttendanceLog[]): AttendanceDayStatus {
  const last = sortLogsAsc(logs)
    .filter((log) => log.validity !== "rejected")
    .at(-1);
  if (!last) return "not_started";
  switch (last.type) {
    case "in":
      return "working";
    case "break_start":
      return "on_break";
    case "break_end":
      return "working";
    case "out":
      return "finished";
  }
}

/** The one primary clock action the home offers for this state. */
export function primaryClockType(status: AttendanceDayStatus): AttendanceType {
  switch (status) {
    case "not_started":
    case "finished":
      return "in";
    case "working":
      return "out";
    case "on_break":
      return "break_end";
  }
}

/** Secondary action: only offered while a shift is running and not on break. */
export function secondaryClockType(
  status: AttendanceDayStatus,
): AttendanceType | null {
  return status === "working" ? "break_start" : null;
}

export function dayStatusTitleKey(status: AttendanceDayStatus): MessageKey {
  switch (status) {
    case "not_started":
      return "hris.home.notStarted";
    case "working":
      return "hris.home.working";
    case "on_break":
      return "hris.home.onBreak";
    case "finished":
      return "hris.home.finished";
  }
}

export function validityStatus(
  validity: AttendanceValidity,
): "success" | "warning" | "danger" {
  switch (validity) {
    case "valid":
      return "success";
    case "flagged":
      return "warning";
    case "rejected":
      return "danger";
  }
}

export function validityLabelKey(validity: AttendanceValidity): MessageKey {
  return `hris.validity.${validity}`;
}

export function typeLabelKey(type: AttendanceType): MessageKey {
  return `hris.type.${type}`;
}

export function typeShortLabelKey(type: AttendanceType): MessageKey {
  return `hris.typeShort.${type}`;
}

/** Page title of the clock screen: "Absen masuk", "Selesai istirahat". */
export function typeTitleKey(type: AttendanceType): MessageKey {
  return `hris.attendance.typeTitle.${type}`;
}

export function methodLabelKey(
  method: "selfie_geo" | "rotating_qr" | "manual_correction",
): MessageKey {
  return `hris.method.${method}`;
}

export function reasonLabelKey(reason: AttendanceFlagReason): MessageKey {
  return `hris.reason.${reason}`;
}

export function reasonFixKey(reason: AttendanceFlagReason): MessageKey {
  return `hris.reason.${reason}Fix`;
}

/**
 * HR-02 copy: the server's reasons, each with what the employee can do next.
 * A rejection is hard (selfie missing, QR disabled/invalid); a flag is a
 * supervisor review, so the copy says so instead of pretending it failed.
 */
export function submissionHeadlineKey(
  validity: AttendanceValidity,
): MessageKey {
  switch (validity) {
    case "valid":
      return "hris.result.validTitle";
    case "flagged":
      return "hris.result.flaggedTitle";
    case "rejected":
      return "hris.result.rejectedTitle";
  }
}

export function submissionHintKey(validity: AttendanceValidity): MessageKey {
  switch (validity) {
    case "valid":
      return "hris.result.validHint";
    case "flagged":
      return "hris.result.flaggedHint";
    case "rejected":
      return "hris.result.rejectedHint";
  }
}

export function correctionStatusTone(
  status: AttendanceCorrectionStatus,
): "warning" | "success" | "danger" {
  switch (status) {
    case "pending":
      return "warning";
    case "approved":
      return "success";
    case "rejected":
      return "danger";
  }
}

export function correctionStatusKey(
  status: AttendanceCorrectionStatus,
): MessageKey {
  return `hris.correctionStatus.${status}`;
}

/**
 * The contract's clock response carries the decision's validity but not its
 * reason list. These are the reasons that *can* produce that validity for the
 * method that was sent, from `attendanceFlagReasonSchema` — labelled as
 * possible causes so the screen never claims a cause it was not told (HR-02).
 */
export function possibleCauses(
  validity: AttendanceValidity,
  submitted: {
    method: "selfie_geo" | "rotating_qr" | "manual_correction";
    selfie: boolean;
  },
): AttendanceFlagReason[] {
  if (validity === "valid") return [];
  const reasons: AttendanceFlagReason[] = [];
  // A missing selfie and the two QR failures are rejections by contract, so
  // they can never explain a flag; geofence and device binding can flag or
  // reject depending on the tenant policy.
  if (validity === "rejected") {
    if (!submitted.selfie) reasons.push("selfie_missing");
    if (submitted.method === "rotating_qr")
      reasons.push("rotating_qr_disabled", "qr_token_invalid");
  }
  if (submitted.method === "selfie_geo") reasons.push("outside_geofence");
  reasons.push("device_not_bound");
  return reasons;
}

/** The published assignment for one business date, if the roster has one. */
export function shiftForDate(
  assignments: readonly ShiftAssignment[],
  businessDate: string,
): ShiftAssignment | null {
  return (
    assignments.find(
      (assignment) =>
        assignment.businessDate === businessDate &&
        (assignment.status === "published" || assignment.status === "swapped"),
    ) ?? null
  );
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function timeFormat(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(`time|${timeZone}`);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("id-ID", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(`time|${timeZone}`, formatter);
  }
  return formatter;
}

function dateFormat(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `date|${timeZone}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("id-ID", { timeZone, ...options });
    formatters.set(key, formatter);
  }
  return formatter;
}

/** "08.05" in the outlet's time zone, never the device's. */
export function formatTime(iso: string, timeZone: string): string {
  return timeFormat(timeZone).format(new Date(iso));
}

/** "Min, 1 Nov 2026". */
export function formatDate(iso: string, timeZone: string): string {
  return dateFormat(timeZone, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

/** "1 Nov". */
export function formatDateShort(iso: string, timeZone: string): string {
  return dateFormat(timeZone, { day: "numeric", month: "short" }).format(
    new Date(iso),
  );
}

/** Shift hours for the Beranda: "08.00–16.00", split shifts joined with " · ". */
export function formatShiftRange(
  shift: Pick<ShiftAssignment, "segments">,
  timeZone: string,
): string {
  return shift.segments
    .map(
      (segment) =>
        `${formatTime(segment.startsAt, timeZone)}–${formatTime(segment.endsAt, timeZone)}`,
    )
    .join(" · ");
}

/** Trim the code the employee reads off the outlet screen; never rewrite it. */
export function normalizeQrToken(raw: string): string {
  return raw.trim();
}

/** A code the outlet QR could plausibly carry, for client-side checks only. */
export function looksLikeQrToken(raw: string): boolean {
  const token = normalizeQrToken(raw);
  return token.length >= 16 && token.length <= 128;
}

export type LogDayGroup = {
  businessDate: string;
  logs: AttendanceLog[];
};

/** History groups: days newest first, the day's own events oldest first. */
export function groupLogsByDate(
  logs: readonly AttendanceLog[],
  timeZone: string,
): LogDayGroup[] {
  const groups = new Map<string, AttendanceLog[]>();
  for (const log of logs) {
    const date = businessDateOf(log.occurredAt, timeZone);
    const bucket = groups.get(date);
    if (bucket) bucket.push(log);
    else groups.set(date, [log]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([businessDate, rows]) => ({
      businessDate,
      logs: [...sortLogsAsc(rows)],
    }));
}

/** A business date as a readable day label ("Min, 1 Nov 2026"). */
export function formatBusinessDate(
  businessDate: string,
  timeZone: string,
): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  // Noon UTC so the calendar date cannot slip across the zone boundary.
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  return formatDate(instant.toISOString(), timeZone);
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * `datetime-local` value for the device's wall clock. The correction form
 * edits the phone's own time; the employee clocks at the outlet, so the two
 * agree in the normal case and the server still validates the instant.
 */
export function toDateTimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parses a `datetime-local` value back to an ISO instant, or null. */
export function fromDateTimeLocalValue(value: string): string | null {
  if (value.length < 10) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
