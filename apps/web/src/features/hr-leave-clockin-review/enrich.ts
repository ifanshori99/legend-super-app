// Pure enrichment of a review-queue item into the `LeaveClockinCase` view model
// (bead legend-3jem1). The queue item carries only the log; the employee name,
// the approved leave, the leave type name and the same-day clock-out come from
// other endpoints (server-side enrichment: legend-eps6t). Everything here is a
// pure function of already-fetched rows, so a failed lookup is passed in as
// `null` and only blanks its own field, never the whole row.
import { localDateOf } from "@starter/shared/core";
import type {
  AttendanceLog,
  AttendanceReviewItem,
  AttendanceReviewStatus,
  Employee,
  LeaveRequest,
  LeaveType,
} from "@starter/shared/hris";
import type {
  LeaveClockinCase,
  LeaveClockinCaseKind,
  LeaveClockinDecision,
  LeaveClockinLeave,
} from "./types.ts";

/** Review-queue flag reason that marks a clock-in on an approved leave day. */
export const LEAVE_APPROVED_FLAG = "leave_approved";

/** A queue item belongs to this feature when it carries the leave flag. */
export function isLeaveClockinItem(item: AttendanceReviewItem): boolean {
  return item.flagReasons.includes(LEAVE_APPROVED_FLAG);
}

/** Business date (YYYY-MM-DD) of an instant in the outlet time zone. */
export function businessDateOfLog(
  occurredAt: string,
  timeZone: string,
): string {
  return localDateOf(occurredAt, timeZone);
}

/** The calendar day before an ISO business date (YYYY-MM-DD). */
function previousDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * Business dates a log can belong to. The server uses the shift's business
 * date when the log has a shift, else the outlet-zone calendar date; a night
 * shift clock-in after midnight therefore belongs to the day before.
 */
export function candidateBusinessDates(
  log: Pick<AttendanceLog, "occurredAt" | "shiftAssignmentId">,
  timeZone: string,
): string[] {
  const local = businessDateOfLog(log.occurredAt, timeZone);
  return log.shiftAssignmentId == null ? [local] : [local, previousDate(local)];
}

/**
 * Business date of a log: for a log with a shift, the date whose day list holds
 * the log; the pure calendar date when no list does (or none was read).
 */
export function resolveBusinessDate(
  log: Pick<AttendanceLog, "id" | "occurredAt" | "shiftAssignmentId">,
  timeZone: string,
  dayLogsOf: (
    businessDate: string,
  ) => readonly Pick<AttendanceLog, "id">[] | null | undefined,
): string {
  const [local, ...earlier] = candidateBusinessDates(log, timeZone);
  for (const date of [local, ...earlier])
    if (dayLogsOf(date)?.some((row) => row.id === log.id)) return date;
  return local;
}

/** Queue status → decision shown to HR. `rejected` means "kept leave". */
export function decisionOfReviewStatus(
  status: AttendanceReviewStatus,
): LeaveClockinDecision {
  if (status === "rejected") return "kept_leave";
  if (status === "accepted") return "cancelled_leave";
  return "pending";
}

/**
 * The approved leave that covers `businessDate`. When several rows cover it
 * (should not happen) the most recently decided one wins, which is the one a
 * later approval reopened the log for.
 */
export function findCoveringLeave(
  leaves: readonly LeaveRequest[],
  businessDate: string,
  status: LeaveRequest["status"] = "approved",
): LeaveRequest | null {
  let best: LeaveRequest | null = null;
  for (const leave of leaves) {
    if (leave.status !== status) continue;
    if (leave.startDate > businessDate || leave.endDate < businessDate)
      continue;
    if (
      best === null ||
      Date.parse(leave.decidedAt ?? "") > Date.parse(best.decidedAt ?? "")
    )
      best = leave;
  }
  return best;
}

/**
 * The clock-out that closes the clock-in: the first `out` of the employee after
 * it and before their next `in` (a split day has several), or null ("Belum
 * absen keluar"). Rejected rows are not real punches and are skipped. `dayLogs`
 * may hold other employees; they are ignored.
 */
export function findClockOut(
  dayLogs: readonly AttendanceLog[],
  employeeId: string,
  clockInAt: string,
): string | null {
  const clockInMs = Date.parse(clockInAt);
  const later = dayLogs
    .filter(
      (log) =>
        log.employeeId === employeeId &&
        log.validity !== "rejected" &&
        Date.parse(log.occurredAt) > clockInMs,
    )
    .sort(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
    );
  for (const log of later) {
    if (log.type === "in") return null;
    if (log.type === "out") return log.occurredAt;
  }
  return null;
}

/**
 * Why the case is in the queue. A manual correction wins; a leave approved
 * after the clock-in is a re-review; everything else is a plain clock-in on a
 * leave day.
 */
export function leaveClockinKind(
  log: Pick<AttendanceLog, "method" | "occurredAt">,
  leave: Pick<LeaveRequest, "decidedAt"> | null,
): LeaveClockinCaseKind {
  if (log.method === "manual_correction") return "manual_correction";
  if (
    leave?.decidedAt != null &&
    Date.parse(leave.decidedAt) > Date.parse(log.occurredAt)
  )
    return "re_review";
  return "clock_in_on_leave";
}

/** Everything `buildLeaveClockinCase` needs; `null` = that lookup failed. */
export type LeaveClockinLookups = {
  /** Employee directory rows; null when the directory call failed. */
  employees: readonly Employee[] | null;
  /** Leave type rows keyed by id; null when the types call failed. */
  leaveTypes: readonly LeaveType[] | null;
  /** Approved leave of THIS employee; null when the call failed. */
  leaves: readonly LeaveRequest[] | null;
  /** Logs of the outlet on the case's business date; null when it failed. */
  dayLogs: readonly AttendanceLog[] | null;
  /**
   * Business date resolved from the day lists (night shift = D-1); the
   * calendar date in the outlet zone when omitted.
   */
  businessDate?: string;
  /** Cancelled leave of THIS employee, read for a cancelled decision only. */
  cancelledLeaves?: readonly LeaveRequest[] | null;
};

export function buildLeaveClockinCase(
  item: AttendanceReviewItem,
  timeZone: string,
  lookups: LeaveClockinLookups,
): LeaveClockinCase {
  const { log } = item;
  const businessDate =
    lookups.businessDate ?? businessDateOfLog(log.occurredAt, timeZone);
  const decision = decisionOfReviewStatus(item.reviewStatus);
  const employee =
    lookups.employees?.find((row) => row.id === log.employeeId) ?? null;
  // After "cancel leave" the leave is no longer approved: a deep link to the
  // decided case still shows the original leave from the cancelled rows.
  const request =
    (lookups.leaves === null
      ? null
      : findCoveringLeave(lookups.leaves, businessDate)) ??
    (decision === "cancelled_leave" && lookups.cancelledLeaves != null
      ? findCoveringLeave(lookups.cancelledLeaves, businessDate, "cancelled")
      : null);
  const leave: LeaveClockinLeave | null =
    request === null
      ? null
      : {
          leaveRequestId: request.id,
          typeName:
            lookups.leaveTypes?.find((type) => type.id === request.leaveTypeId)
              ?.name ?? null,
          startDate: request.startDate,
          endDate: request.endDate,
          multiDay: request.startDate !== request.endDate,
        };
  return {
    logId: log.id,
    employeeId: log.employeeId,
    employeeName: employee?.fullName ?? null,
    outletId: log.outletId,
    businessDate,
    clockInAt: log.occurredAt,
    clockOutAt:
      lookups.dayLogs === null
        ? null
        : findClockOut(lookups.dayLogs, log.employeeId, log.occurredAt),
    leave,
    // A cancelled row's decidedAt is the cancellation, not the approval.
    kind: leaveClockinKind(
      log,
      request?.status === "approved" ? request : null,
    ),
    decision,
    timeZone,
    item,
  };
}

/** Decision a confirmed action records; never "pending". */
export function decisionOfAction(
  action: "keep_leave" | "cancel_leave",
): LeaveClockinDecision {
  return action === "keep_leave" ? "kept_leave" : "cancelled_leave";
}

/**
 * Case after a successful decision: the returned item replaces the raw one and
 * the decision follows the CONFIRMED action (not the item's status, which a
 * lagging read could still show as pending).
 */
export function applyDecidedItem(
  current: LeaveClockinCase,
  decided: AttendanceReviewItem,
  action: "keep_leave" | "cancel_leave",
): LeaveClockinCase {
  return {
    ...current,
    decision: decisionOfAction(action),
    item: decided,
  };
}

/**
 * A refetch of a decided case must not blank its leave: once the leave is
 * cancelled the approved-leave lookup finds nothing, so the cached leave and
 * kind (from before the decision) are kept.
 */
export function keepDecidedLeave(
  previous: LeaveClockinCase | null | undefined,
  next: LeaveClockinCase | null | undefined,
): LeaveClockinCase | null | undefined {
  if (
    previous == null ||
    next == null ||
    next.decision === "pending" ||
    next.leave !== null ||
    previous.leave === null
  )
    return next;
  return { ...next, leave: previous.leave, kind: previous.kind };
}

/** Queue order: newest business date first, then latest clock-in, then id. */
export function compareLeaveClockinCases(
  left: LeaveClockinCase,
  right: LeaveClockinCase,
): number {
  return (
    right.businessDate.localeCompare(left.businessDate) ||
    Date.parse(right.clockInAt) - Date.parse(left.clockInAt) ||
    left.logId.localeCompare(right.logId)
  );
}
