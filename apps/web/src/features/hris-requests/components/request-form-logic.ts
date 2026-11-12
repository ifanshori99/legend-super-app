// Pure rules of the employee request forms (legend-ydf2): validation, the
// payloads handed to the create hooks (the hooks mint the idempotency key),
// leave balance and overtime duration maths. No React, so node:test loads it.
// Errors are message keys, not text: the components translate them.
import type { MessageKey } from "@starter/shared/i18n";

export type FormTab = "swap" | "leave" | "overtime";
export const FORM_TABS: readonly FormTab[] = ["swap", "leave", "overtime"];

export function isFormTab(value: unknown): value is FormTab {
  return value === "swap" || value === "leave" || value === "overtime";
}

/** `?jenis=` search value of the route; anything else falls back to swap. */
export function parseFormTab(value: unknown): FormTab {
  return isFormTab(value) ? value : "swap";
}

/** Permissions that open each tab; the API checks again on submit. */
export const TAB_PERMISSIONS: Record<FormTab, readonly string[]> = {
  swap: ["self.shift_swap.request"],
  leave: ["self.leave.request"],
  // POST /api/hris/overtime-requests accepts these three.
  overtime: ["self.attendance.clock", "self.profile.view", "hr.employee.manage"],
};

/** Tabs the account may use, in display order. */
export function allowedTabs(permissions: readonly string[]): FormTab[] {
  return FORM_TABS.filter((tab) =>
    TAB_PERMISSIONS[tab].some((code) => permissions.includes(code)),
  );
}

/** The wanted tab when allowed, else the first allowed one (null = none). */
export function pickTab(
  wanted: FormTab,
  allowed: readonly FormTab[],
): FormTab | null {
  return allowed.includes(wanted) ? wanted : (allowed[0] ?? null);
}

export const REASON_MAX = 500;
export const OVERTIME_MAX_MINUTES = 720;

/**
 * A hook list result is a plain array, a `{ data }` page, or infinite-query
 * `{ pages }`; screens only need the rows.
 */
export function rowsOf<T>(source: unknown): T[] {
  if (Array.isArray(source)) return source as T[];
  if (typeof source !== "object" || source === null) return [];
  const record = source as { data?: unknown; pages?: unknown };
  if (Array.isArray(record.pages))
    return record.pages.flatMap((page) => rowsOf<T>(page));
  if (Array.isArray(record.data)) return record.data as T[];
  return [];
}

/** True when the request never reached the server (no network). */
export function isNetworkFailure(error: unknown, online = true): boolean {
  if (!online) return true;
  if (typeof error !== "object" || error === null) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === "NETWORK_ERROR" || status === 0;
}

// ---- Shift swap / cover ---------------------------------------------------

export type SwapKind = "swap" | "cover";

export type SwapValues = {
  kind: SwapKind;
  fromAssignmentId: string;
  toEmployeeId: string;
  toAssignmentId: string;
};

export type SwapErrors = Partial<
  Record<"fromAssignmentId" | "toEmployeeId" | "toAssignmentId", MessageKey>
>;

export type SwapPayload = {
  outletId: string;
  fromAssignmentId: string;
  toEmployeeId: string;
  /** Null = cover ("ganti shift"); set = a true swap. */
  toAssignmentId: string | null;
};

type OutletOwned = { id: string; outletId: string };

export function validateSwap(
  values: SwapValues,
  myAssignments: readonly OutletOwned[],
): { errors: SwapErrors; payload: SwapPayload | null } {
  const errors: SwapErrors = {};
  const mine = myAssignments.find(
    (assignment) => assignment.id === values.fromAssignmentId,
  );
  if (!mine)
    errors.fromAssignmentId =
      "hrisRequestsEmployee.swap.errors.myShiftRequired";
  if (values.toEmployeeId === "")
    errors.toEmployeeId = "hrisRequestsEmployee.swap.errors.peerRequired";
  if (values.kind === "swap" && values.toAssignmentId === "")
    errors.toAssignmentId =
      "hrisRequestsEmployee.swap.errors.peerShiftRequired";
  if (Object.keys(errors).length > 0 || !mine) return { errors, payload: null };
  return {
    errors,
    payload: {
      outletId: mine.outletId,
      fromAssignmentId: mine.id,
      toEmployeeId: values.toEmployeeId,
      toAssignmentId: values.kind === "swap" ? values.toAssignmentId : null,
    },
  };
}

// ---- Leave ----------------------------------------------------------------

export type LeaveValues = {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason: string;
};

export type LeaveErrors = Partial<
  Record<"leaveTypeId" | "startDate" | "endDate" | "reason", MessageKey>
>;

export type LeavePayload = {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(date: string): number | null {
  if (!DATE_PATTERN.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const value = Date.UTC(year, month - 1, day);
  const check = new Date(value);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  return value / 86_400_000;
}

/** Calendar days from start to end, both included; null when invalid. */
export function leaveDayCount(start: string, end: string): number | null {
  const from = dayNumber(start);
  const to = dayNumber(end);
  if (from === null || to === null || to < from) return null;
  return to - from + 1;
}

/**
 * `requiresAttachment`: the type needs a file and no upload endpoint exists
 * yet, so the request is held back instead of sent without it.
 */
export function validateLeave(
  values: LeaveValues,
  options: { requiresAttachment?: boolean } = {},
): {
  errors: LeaveErrors;
  payload: LeavePayload | null;
} {
  const errors: LeaveErrors = {};
  if (values.leaveTypeId === "")
    errors.leaveTypeId = "hrisRequestsEmployee.leave.errors.typeRequired";
  else if (options.requiresAttachment)
    errors.leaveTypeId = "hrisRequestsEmployee.leave.errors.attachmentBlocked";
  if (dayNumber(values.startDate) === null)
    errors.startDate = "hrisRequestsEmployee.leave.errors.startRequired";
  if (dayNumber(values.endDate) === null)
    errors.endDate = "hrisRequestsEmployee.leave.errors.endRequired";
  else if (
    !errors.startDate &&
    leaveDayCount(values.startDate, values.endDate) === null
  )
    errors.endDate = "hrisRequestsEmployee.leave.errors.endBeforeStart";
  const reason = values.reason.trim();
  if (reason === "")
    errors.reason = "hrisRequestsEmployee.leave.errors.reasonRequired";
  else if (reason.length > REASON_MAX)
    errors.reason = "hrisRequestsEmployee.leave.errors.reasonTooLong";
  if (Object.keys(errors).length > 0) return { errors, payload: null };
  return {
    errors,
    payload: {
      leaveTypeId: values.leaveTypeId,
      startDate: values.startDate,
      endDate: values.endDate,
      reason,
    },
  };
}

type BalanceLike = {
  leaveTypeId: string;
  periodYear: number;
  entitledDays: string;
  carriedOverDays: string;
  usedDays: string;
  pendingDays: string;
};

/** decimal4 string ("8.0000") in 1/10000 days, so sums never drift. */
function scaled(value: string): number {
  return Math.round(Number(value) * 10_000);
}

/**
 * Remaining days of a leave type this year (entitled + carried over - used -
 * pending, the contract's `leaveDaysRemaining`); null when no balance row
 * exists (a type that does not track a balance).
 */
export function remainingLeaveDays(
  balances: readonly BalanceLike[],
  leaveTypeId: string,
  year: number,
): number | null {
  const balance = balances.find(
    (row) => row.leaveTypeId === leaveTypeId && row.periodYear === year,
  );
  if (!balance) return null;
  return (
    (scaled(balance.entitledDays) +
      scaled(balance.carriedOverDays) -
      scaled(balance.usedDays) -
      scaled(balance.pendingDays)) /
    10_000
  );
}

/** "8", "7,5": whole days stay whole, halves keep one comma digit. */
export function formatDays(days: number): string {
  const rounded = Math.round(days * 100) / 100;
  return String(rounded).replace(".", ",");
}

// ---- Overtime -------------------------------------------------------------

export type OvertimeValues = {
  date: string;
  startTime: string;
  endTime: string;
  reason: string;
};

export type OvertimeErrors = Partial<
  Record<"date" | "startTime" | "endTime" | "reason", MessageKey>
>;

export type OvertimePayload = {
  outletId: string;
  date: string;
  minutes: number;
  reason: string;
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minuteOfDay(time: string): number | null {
  const match = TIME_PATTERN.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Minutes between two "HH:mm" times of the same day; null when not after. */
export function overtimeMinutes(start: string, end: string): number | null {
  const from = minuteOfDay(start);
  const to = minuteOfDay(end);
  if (from === null || to === null || to <= from) return null;
  return to - from;
}

export function validateOvertime(
  values: OvertimeValues,
  outletId: string | undefined,
): { errors: OvertimeErrors; payload: OvertimePayload | null } {
  const errors: OvertimeErrors = {};
  if (dayNumber(values.date) === null)
    errors.date = "hrisRequestsEmployee.overtime.errors.dateRequired";
  if (minuteOfDay(values.startTime) === null)
    errors.startTime = "hrisRequestsEmployee.overtime.errors.startRequired";
  if (minuteOfDay(values.endTime) === null)
    errors.endTime = "hrisRequestsEmployee.overtime.errors.endRequired";
  const minutes = overtimeMinutes(values.startTime, values.endTime);
  if (!errors.startTime && !errors.endTime) {
    if (minutes === null)
      errors.endTime = "hrisRequestsEmployee.overtime.errors.endBeforeStart";
    else if (minutes > OVERTIME_MAX_MINUTES)
      errors.endTime = "hrisRequestsEmployee.overtime.errors.tooLong";
  }
  const reason = values.reason.trim();
  if (reason === "")
    errors.reason = "hrisRequestsEmployee.overtime.errors.reasonRequired";
  else if (reason.length > REASON_MAX)
    errors.reason = "hrisRequestsEmployee.overtime.errors.reasonTooLong";
  if (Object.keys(errors).length > 0 || minutes === null || !outletId)
    return { errors, payload: null };
  return {
    errors,
    payload: { outletId, date: values.date, minutes, reason },
  };
}

// ---- Shift label ----------------------------------------------------------

type SegmentLike = { startsAt: string; endsAt: string };

/** "08.00-16.00" in the outlet zone; split shifts join with " / ". */
export function shiftTimeRange(
  segments: readonly SegmentLike[],
  timeZone: string,
): string {
  const format = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });
  const clock = (iso: string) => format.format(new Date(iso)).replace(":", ".");
  return segments
    .map((segment) => `${clock(segment.startsAt)}–${clock(segment.endsAt)}`)
    .join(" / ");
}

/** "18 Nov 2026 · 08.00-16.00" for a select option. */
export function shiftOptionLabel(
  assignment: { businessDate: string; segments: readonly SegmentLike[] },
  timeZone: string,
): string {
  const [year, month, day] = assignment.businessDate.split("-").map(Number);
  const date = new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
  return `${date} · ${shiftTimeRange(assignment.segments, timeZone)}`;
}

/** Peer data the swap form reads from `useSwapCandidates`. */
export type SwapCandidate = {
  employeeId: string;
  employeeName: string;
  /** The peer's own upcoming shifts (what a true swap takes in return). */
  assignments: readonly {
    id: string;
    businessDate: string;
    segments: readonly SegmentLike[];
  }[];
};

// ---- Idempotency ----------------------------------------------------------

export type DraftKey = { fingerprint: string; key: string };

/**
 * One idempotency key per draft: the same request content (a retry after a
 * network failure) keeps its key, so a request that did reach the server is
 * not created twice; changed content gets a new key. Call `null` after a
 * success to start the next draft fresh.
 */
export function keyForDraft(
  previous: DraftKey | null,
  type: string,
  payload: unknown,
  makeKey: () => string,
): DraftKey {
  const fingerprint = `${type}:${JSON.stringify(payload)}`;
  return previous && previous.fingerprint === fingerprint
    ? previous
    : { fingerprint, key: makeKey() };
}
