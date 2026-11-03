// Page-level guard for the attendance screens: the kelola area already
// requires dashboard.management.view + MFA; a page additionally needs its own
// attendance permission (docs/frontend.md "Page guard"). The API re-checks
// everything, so this only hides what a visitor cannot use.
import { notFound, useRouteContext } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";

/** Reading selfies (PII `attendancePhotoUrl`) and deciding samples. */
export const ATTENDANCE_REVIEW: readonly PermissionCode[] = [
  "hr.attendance.manage",
];

export function attendanceGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

/**
 * Whether the visitor may record a sample decision. Fails closed when the
 * route context carries no access; the future review endpoint re-checks it.
 */
export function useCanReviewAttendance(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access ? holdsAny(context.access, ATTENDANCE_REVIEW) : false;
}
