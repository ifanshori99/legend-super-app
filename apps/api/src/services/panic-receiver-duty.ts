// "On duty" of a staff member at one outlet, computed from edge-local data
// (bead legend-bod; design docs/design/edge-emergency.md D-04). Used by the
// emergency receiver session (open and every re-check) and by the relay.
//
// Staff is on duty at outlet O at time t when either:
//   (a) a published (or swapped) shift_assignments row for O has a segment that
//       covers t with 30 minutes of grace before its start and after its end
//       (segments hold absolute startsAt/endsAt, so overnight shifts need no
//       business-date arithmetic); or
//   (b) the latest valid clock-in or clock-out of O is a clock-in less than
//       14 hours old.
// A clock-out ends (b) but never (a) (CTO decision).
//
// Pure reads on the caller's outlet-scoped transaction; no writes.
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { TenantId, UserId } from "@starter/shared/core";
import { attendanceLogs } from "../db/schema/hris-attendance.ts";
import { employees } from "../db/schema/hris.ts";
import { shiftAssignments } from "../db/schema/hris-scheduling.ts";
import type { Tx } from "./permission-resolver.ts";

export const DUTY_SHIFT_GRACE_MS = 30 * 60_000;
export const DUTY_CLOCK_IN_MAX_MS = 14 * 60 * 60_000;
/** Shifts are read for business dates around `now`; an overnight shift starts a day earlier. */
const SHIFT_LOOKBACK_DAYS = 3;
const SHIFT_LOOKAHEAD_DAYS = 2;
const DAY_MS = 24 * 60 * 60_000;

const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The employee row of a staff account: id and whether it may still work. */
export async function employeeOfStaff(
  tx: Tx,
  input: { tenantId: string; userId: string },
): Promise<{ id: string; active: boolean } | null> {
  const [row] = await tx
    .select({ id: employees.id, status: employees.status })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, input.tenantId as TenantId),
        eq(employees.userId, input.userId as UserId),
      ),
    )
    .orderBy(desc(employees.createdAt))
    .limit(1);
  return row ? { id: row.id, active: row.status === "active" } : null;
}

/**
 * The end of the staff member's duty window at `now`, or null when not on
 * duty. When both (a) and (b) hold, the later end wins.
 */
export async function dutyWindowEnd(
  tx: Tx,
  input: {
    tenantId: string;
    outletId: string;
    employeeId: string;
    now: Date;
  },
): Promise<Date | null> {
  const nowMs = input.now.getTime();
  let end: number | null = null;

  const shifts = await tx
    .select({ segments: shiftAssignments.segments })
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, input.tenantId as TenantId),
        eq(shiftAssignments.outletId, input.outletId),
        eq(shiftAssignments.employeeId, input.employeeId),
        inArray(shiftAssignments.status, ["published", "swapped"]),
        sql`${shiftAssignments.businessDate} BETWEEN ${dateOnly(nowMs - SHIFT_LOOKBACK_DAYS * DAY_MS)}::date AND ${dateOnly(nowMs + SHIFT_LOOKAHEAD_DAYS * DAY_MS)}::date`,
      ),
    );
  for (const shift of shifts)
    for (const segment of shift.segments) {
      const startsAt = Date.parse(segment.startsAt);
      const endsAt = Date.parse(segment.endsAt);
      if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) continue;
      const windowEnd = endsAt + DUTY_SHIFT_GRACE_MS;
      if (startsAt - DUTY_SHIFT_GRACE_MS <= nowMs && nowMs < windowEnd)
        end = Math.max(end ?? windowEnd, windowEnd);
    }

  const [latest] = await tx
    .select({
      type: attendanceLogs.type,
      occurredAt: attendanceLogs.occurredAt,
    })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.tenantId, input.tenantId as TenantId),
        eq(attendanceLogs.outletId, input.outletId),
        eq(attendanceLogs.employeeId, input.employeeId),
        inArray(attendanceLogs.type, ["in", "out"]),
        ne(attendanceLogs.validity, "rejected"),
        sql`${attendanceLogs.occurredAt} <= ${input.now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(attendanceLogs.occurredAt), desc(attendanceLogs.id))
    .limit(1);
  if (latest?.type === "in") {
    const windowEnd = latest.occurredAt.getTime() + DUTY_CLOCK_IN_MAX_MS;
    if (nowMs < windowEnd) end = Math.max(end ?? windowEnd, windowEnd);
  }
  return end === null ? null : new Date(end);
}
