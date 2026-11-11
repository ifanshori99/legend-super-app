import { sql } from "drizzle-orm";

import type { Database } from "../db/index.ts";

type Executor = Pick<Database, "execute">;

/**
 * legend-x0avw (Codex P1): one advisory lock per tenant and employee that every
 * path touching "approved leave" or "attendance of a leave day" takes FIRST:
 * clock-in (online, offline and edge replay share recordAttendanceLog), leave
 * approval (applyOutcome and approved-on-filing), and manual correction. It
 * serialises "is there an approved leave on this day?" against "approve a leave
 * and flag the logs of those days", so a clock-in racing an approval can never
 * leave an approved leave next to an unflagged valid `in` log (paid twice).
 * Per employee, not per date: a leave covers a range. Held until the
 * transaction ends. Always take this lock before any other attendance or leave
 * lock so the order stays acyclic.
 */
export async function lockEmployeeLeaveAttendance(
  tx: Executor,
  tenantId: string,
  employeeId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:leave-attendance:${tenantId}:${employeeId.toLowerCase()}`}, 0))`,
  );
}
