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
): LeaveRequest | null {
  let best: LeaveRequest | null = null;
  for (const leave of leaves) {
    if (leave.status !== "approved") continue;
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
 * The last clock-out of the employee after the clock-in, or null ("Belum absen
 * keluar"). `dayLogs` may hold other employees; they are ignored.
 */
export function findClockOut(
  dayLogs: readonly AttendanceLog[],
  employeeId: string,
  clockInAt: string,
): string | null {
  const clockInMs = Date.parse(clockInAt);
  let latest: string | null = null;
  for (const log of dayLogs) {
    if (log.employeeId !== employeeId || log.type !== "out") continue;
    const at = Date.parse(log.occurredAt);
    if (at <= clockInMs) continue;
    if (latest === null || at > Date.parse(latest)) latest = log.occurredAt;
  }
  return latest;
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
};

export function buildLeaveClockinCase(
  item: AttendanceReviewItem,
  timeZone: string,
  lookups: LeaveClockinLookups,
): LeaveClockinCase {
  const { log } = item;
  const businessDate = businessDateOfLog(log.occurredAt, timeZone);
  const employee =
    lookups.employees?.find((row) => row.id === log.employeeId) ?? null;
  const request =
    lookups.leaves === null
      ? null
      : findCoveringLeave(lookups.leaves, businessDate);
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
    kind: leaveClockinKind(log, request),
    decision: decisionOfReviewStatus(item.reviewStatus),
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
