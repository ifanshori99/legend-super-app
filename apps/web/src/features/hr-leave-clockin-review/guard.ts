// Page-level guard and permissions of the HR leave clock-in review (bead
// legend-3jem1). The kelola area already requires dashboard.management.view +
// MFA; the page additionally needs the attendance review right
// (docs/frontend.md "Page guard"). The API re-checks everything per outlet, so
// this only hides what a visitor cannot use.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";
import type { LeaveClockinPermissions } from "./types.ts";

/** Opens the review pages and records "tetap cuti" (keep_leave). */
export const LEAVE_CLOCKIN_KEEP: readonly PermissionCode[] = [
  "hr.attendance.manage",
];
/** Cancelling a leave day also needs the right to approve leave. */
export const LEAVE_CLOCKIN_CANCEL: readonly PermissionCode[] = [
  "hr.leave.approve",
];

/** Route `beforeLoad` for the queue and the detail page. */
export function leaveClockinGuard() {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "dashboard",
        anyOf: LEAVE_CLOCKIN_KEEP,
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

/**
 * What the visitor may decide. `canCancelLeave` implies `canKeepLeave`; the
 * server still answers 403 for a leave outside the visitor's outlets.
 */
export function leaveClockinPermissions(
  access: AreaAccess | undefined,
): LeaveClockinPermissions {
  if (access === undefined)
    return { canKeepLeave: false, canCancelLeave: false };
  const canKeepLeave = holdsAny(access, LEAVE_CLOCKIN_KEEP);
  return {
    canKeepLeave,
    canCancelLeave: canKeepLeave && holdsAny(access, LEAVE_CLOCKIN_CANCEL),
  };
}
