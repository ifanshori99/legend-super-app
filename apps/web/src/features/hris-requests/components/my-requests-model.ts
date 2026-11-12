// Pure logic of the employee "Pengajuan saya" list (bead legend-ydf2): merges
// the three own-request lists into one newest-first list and formats dates. No
// React and no device time zone, so the server render matches the browser.
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import type {
  LeaveRequest,
  OvertimeRequest,
  ShiftSwapRequest,
} from "@starter/shared/hris";

export type MyRequestKind = "swap" | "cover" | "leave" | "overtime";
export type MyRequestStatus =
  "pending" | "approved" | "rejected" | "cancelled" | "expired";

export type MyRequestItem = {
  /** Unique across kinds, e.g. "leave:<id>". */
  key: string;
  kind: MyRequestKind;
  id: string;
  status: MyRequestStatus;
  /** Leave type name when known; the card falls back to the kind label. */
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Leave days as a display string ("2", "1,5"), null for other kinds. */
  days: string | null;
  minutes: number | null;
  submittedAt: string;
  decidedAt: string | null;
};

export type MyRequestSources = {
  swaps?: readonly ShiftSwapRequest[];
  leaves?: readonly LeaveRequest[];
  overtimes?: readonly OvertimeRequest[];
  /** leaveTypeId -> name. */
  leaveTypeNames?: ReadonlyMap<string, string>;
  /** assignmentId -> business date, for the shifts the employee still has. */
  assignmentDates?: ReadonlyMap<string, string>;
};

/** "2.0000" / "1.5000" -> "2" / "1,5" (day counts are not money). */
export function formatDays(days: string): string {
  const value = Number(days);
  if (!Number.isFinite(value)) return days;
  return String(Math.round(value * 100) / 100).replace(".", ",");
}

export function buildMyRequests(sources: MyRequestSources): MyRequestItem[] {
  const items: MyRequestItem[] = [];
  for (const swap of sources.swaps ?? []) {
    const date = sources.assignmentDates?.get(swap.fromAssignmentId) ?? null;
    items.push({
      key: `swap:${swap.id}`,
      kind: swap.toAssignmentId === null ? "cover" : "swap",
      id: swap.id,
      status: swap.status,
      title: null,
      startDate: date,
      endDate: date,
      days: null,
      minutes: null,
      submittedAt: swap.requestedAt,
      decidedAt: swap.decidedAt,
    });
  }
  for (const leave of sources.leaves ?? []) {
    items.push({
      key: `leave:${leave.id}`,
      kind: "leave",
      id: leave.id,
      status: leave.status,
      title: sources.leaveTypeNames?.get(leave.leaveTypeId) ?? null,
      startDate: leave.startDate,
      endDate: leave.endDate,
      days: formatDays(leave.days),
      minutes: null,
      submittedAt: leave.requestedAt,
      decidedAt: leave.decidedAt,
    });
  }
  for (const overtime of sources.overtimes ?? []) {
    items.push({
      key: `overtime:${overtime.id}`,
      kind: "overtime",
      id: overtime.id,
      status: overtime.status,
      title: null,
      startDate: overtime.date,
      endDate: overtime.date,
      days: null,
      minutes: overtime.minutes,
      submittedAt: overtime.requestedAt,
      decidedAt: overtime.decidedAt,
    });
  }
  // Newest submission first; the key breaks ties so the order is stable.
  return items.sort((a, b) => {
    const diff = Date.parse(b.submittedAt) - Date.parse(a.submittedAt);
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  });
}

export function countRejected(items: readonly MyRequestItem[]): number {
  return items.filter((item) => item.status === "rejected").length;
}

const LONG_DATE = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const SHORT_DAY_MONTH = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const SHORT_DATE = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const INSTANT_DATE = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: DEFAULT_TIME_ZONE,
});

function parseBusinessDate(value: string): Date | null {
  const [year, month, day] = value.split("-").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  )
    return null;
  // Noon UTC so the calendar date cannot slip across a zone boundary.
  return new Date(Date.UTC(year, month - 1, day, 12));
}

/**
 * "18–19 November 2026" for one month, "28 Nov – 2 Des 2026" across months,
 * "18 November 2026" for a single day. Unparseable input comes back as given.
 */
export function formatPeriod(startDate: string, endDate: string): string {
  const start = parseBusinessDate(startDate);
  const end = parseBusinessDate(endDate);
  if (!start || !end)
    return startDate === endDate ? startDate : `${startDate} – ${endDate}`;
  if (startDate === endDate) return LONG_DATE.format(start);
  if (
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth()
  ) {
    const month = LONG_DATE.format(end).replace(/^\d+\s/, "");
    return `${start.getUTCDate()}–${end.getUTCDate()} ${month}`;
  }
  if (start.getUTCFullYear() === end.getUTCFullYear())
    return `${SHORT_DAY_MONTH.format(start)} – ${SHORT_DATE.format(end)}`;
  return `${SHORT_DATE.format(start)} – ${SHORT_DATE.format(end)}`;
}

/** "12 Nov 2026" for an instant, in the default business time zone. */
export function formatInstantDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : INSTANT_DATE.format(new Date(time));
}
