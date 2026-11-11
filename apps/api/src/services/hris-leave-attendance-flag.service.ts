// Approving a leave flags the clock-ins it now covers (bead legend-7o3hd,
// founder W8). The mirror of the clock-in check in hris-attendance.service.ts
// (clock-in AFTER approval): here the clock-in came BEFORE the approval, so the
// log must go to HR review or the day is paid twice (leave and work).
import { sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { Tx } from "./hris-access.ts";

/** The part of an approved `leave_requests` row this check reads. */
export interface ApprovedLeaveRange {
  readonly employeeId: string;
  /** Inclusive, `YYYY-MM-DD`. */
  readonly startDate: string;
  /** Inclusive, `YYYY-MM-DD`. */
  readonly endDate: string;
  /** Home outlet of the leave (the outlet the context is scoped to). */
  readonly outletId: string;
}

/** One log the approval moved to HR review. */
export interface FlaggedAttendanceLog {
  readonly logId: string;
  readonly outletId: string;
}

/**
 * Flags the employee's `in` logs inside the approved leave range (by business
 * date, any outlet) as flagged and pending with reason `leave_approved`. Only
 * a valid or flagged log whose review is not decided is touched: a rejected
 * log and a log HR already accepted stay as they are. A log that already holds
 * the reason is skipped, so a second call changes nothing. Runs in the
 * caller's transaction (the leave approval), so a failure rolls both back.
 *
 * Goes through `app.flag_attendance_for_leave` (SECURITY DEFINER, tenant-bound,
 * no outlet limit): `attendance_logs` RLS is per outlet of the log, while the
 * context here is scoped to the leave's home outlet, so a clock-in made at
 * another outlet would not be reachable through the table.
 */
export async function flagAttendanceForApprovedLeave(
  tx: Tx,
  context: ScopedTenantContext,
  leave: ApprovedLeaveRange,
): Promise<FlaggedAttendanceLog[]> {
  const result = await tx.execute(
    sql`SELECT log_id, outlet_id FROM app.flag_attendance_for_leave(${context.tenant.tenantId}::uuid, ${leave.employeeId}::uuid, ${leave.startDate}::date, ${leave.endDate}::date)`,
  );
  return result.rows.map((row) => ({
    logId: String(row.log_id),
    outletId: String(row.outlet_id),
  }));
}
