// Who may clock attendance (phase 1 of the clock): an active (or onboarding)
// employee who holds `self.attendance.clock`. Shared by the staff PIN proof
// issue (before the PIN is checked) and the outlet-clock route, so a user who
// may not clock never gets a "PIN correct" signal or a proof (legend-u7g9w).

import { and, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { employees } from "../db/schema/hris.ts";
import { HttpError } from "../lib/http-error.ts";
import { loadHrisAccess, type Tx } from "./hris-access.ts";

const HRIS_ATTENDANCE_CLOCK_CODE = "self.attendance.clock";

export const ATTENDANCE_NOT_ALLOWED_CODE = "ATTENDANCE_NOT_ALLOWED";

function notAllowed(): HttpError {
  return new HttpError(
    403,
    ATTENDANCE_NOT_ALLOWED_CODE,
    "Akun ini tidak bisa absen di outlet ini.",
  );
}

/**
 * The user must be an active (or onboarding) employee holding
 * `self.attendance.clock` at `outletId`. Runs inside the caller's transaction, which must be
 * scoped to the outlet the clock happens at. 403 ATTENDANCE_NOT_ALLOWED
 * otherwise.
 */
export async function assertAttendanceClockAllowed(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  /** The outlet the clock happens at (the device outlet). */
  outletId: string,
  now: Date,
): Promise<{ employeeId: string }> {
  const access = await loadHrisAccess(tx, context, userId, now);
  const own = access.own;
  if (
    own === null ||
    !access.snapshot.allows(HRIS_ATTENDANCE_CLOCK_CODE, {
      type: "outlet",
      id: outletId,
    })
  )
    throw notAllowed();
  const [employee] = await tx
    .select({ status: employees.status })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, own.id),
      ),
    )
    .limit(1);
  if (
    !employee ||
    (employee.status !== "active" && employee.status !== "onboarding")
  )
    throw notAllowed();
  return { employeeId: own.id };
}
