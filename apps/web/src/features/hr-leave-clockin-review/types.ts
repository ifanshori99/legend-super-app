// View model for the HR review of a clock-in on an approved leave day
// (bead legend-3jem1; API legend-9y6ri, 5nt2z, 7o3hd, em8y2). The review queue
// item (`AttendanceReviewItem`) carries only the log; api.ts enriches it with
// the employee, the approved leave and the same-day clock-out so components
// never see raw contract rows (server-side enrichment: legend-eps6t).
import type { AttendanceReviewItem } from "@starter/shared/hris";

/** The two decisions HR can record; named after the business outcome. */
export type LeaveClockinAction = "keep_leave" | "cancel_leave";

/**
 * Why the case is in the queue.
 * - `clock_in_on_leave`: the employee clocked in on a day already on leave.
 * - `re_review`: the leave was approved after the clock-in (the log was
 *   reopened by the later approval, legend-7o3hd).
 * - `manual_correction`: the log was written by a manual attendance correction.
 */
export type LeaveClockinCaseKind =
  | "clock_in_on_leave"
  | "re_review"
  | "manual_correction";

/** Decision state shown to HR. `kept_leave` is never rendered as "Ditolak". */
export type LeaveClockinDecision = "pending" | "kept_leave" | "cancelled_leave";

export type LeaveClockinLeave = {
  leaveRequestId: string;
  /** Leave type name, e.g. "Cuti tahunan"; null when the type is unknown. */
  typeName: string | null;
  /** ISO business dates (YYYY-MM-DD), inclusive. */
  startDate: string;
  endDate: string;
  /** More than one calendar day: cancelling only removes the reviewed date. */
  multiDay: boolean;
};

export type LeaveClockinCase = {
  logId: string;
  employeeId: string;
  /** Null when the employee directory has no row for the id. */
  employeeName: string | null;
  outletId: string;
  /** Business date of the clock-in (YYYY-MM-DD) in the outlet time zone. */
  businessDate: string;
  /** ISO instant of the clock-in. */
  clockInAt: string;
  /** ISO instant of the same-day clock-out; null = "Belum absen keluar". */
  clockOutAt: string | null;
  /** Null when no approved leave covering the date could be found. */
  leave: LeaveClockinLeave | null;
  kind: LeaveClockinCaseKind;
  decision: LeaveClockinDecision;
  /** Raw queue item, for the decision mutation only. */
  item: AttendanceReviewItem;
};

/** What the signed-in reviewer may do (server re-checks per outlet). */
export type LeaveClockinPermissions = {
  canKeepLeave: boolean;
  canCancelLeave: boolean;
};
