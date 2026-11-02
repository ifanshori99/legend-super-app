// Page-level guard for the payroll screens: the kelola area already requires
// dashboard.management.view + MFA (AUTH-05); a page additionally needs
// payroll.run (docs/frontend.md "Page guard", PRD §3 Matriks Approval). The
// API re-checks everything; this only hides what a visitor cannot use.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";

export const PAYROLL_RUN_PERMISSION = "payroll.run" as const;
export const PAYROLL_APPROVE_PERMISSION = "payroll.approve" as const;
export const PAYROLL_LOCK_PERMISSION = "payroll.lock" as const;
export const PAYROLL_CANCEL_PERMISSION = "payroll.cancel.approve" as const;

function permissionGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

export const payrollRunGuard = permissionGuard([PAYROLL_RUN_PERMISSION]);

/**
 * Which payroll actions this visitor may press (AUTH-05 visible gates). Every
 * gate fails closed: an action whose permission is missing stays disabled and
 * the screen says which permission it needs.
 */
export function payrollAccess(access: AreaAccess) {
  return {
    canRun: holdsAny(access, [PAYROLL_RUN_PERMISSION]),
    canApprove: holdsAny(access, [PAYROLL_APPROVE_PERMISSION]),
    canLock: holdsAny(access, [PAYROLL_LOCK_PERMISSION]),
    canDecideReversal: holdsAny(access, [PAYROLL_CANCEL_PERMISSION]),
  };
}

export type PayrollAccess = ReturnType<typeof payrollAccess>;
