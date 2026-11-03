// Page-level guards for the payroll screens: the kelola area already requires
// dashboard.management.view + MFA (AUTH-05); a page additionally needs one of
// the payroll permissions below (docs/frontend.md "Page guard", PRD §3 Matriks
// Approval). The API — and the mock, which mirrors it — re-checks every
// request; this only hides what a visitor cannot use.
//
// Decision legend-t3f5: a holder of payroll.approve or payroll.lock may READ
// the run list and a run's detail without payroll.run (the Finance template is
// the second approver and the locker but does not run payroll). Every write
// still needs its own permission (`payrollAccess`). Per-employee salary rows
// and payslips are personal data (HR-03): they need payroll.view or
// payroll.run, never approve/lock alone.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";

export const PAYROLL_VIEW_PERMISSION = "payroll.view" as const;
export const PAYROLL_RUN_PERMISSION = "payroll.run" as const;
export const PAYROLL_APPROVE_PERMISSION = "payroll.approve" as const;
export const PAYROLL_LOCK_PERMISSION = "payroll.lock" as const;
export const PAYROLL_CANCEL_PERMISSION = "payroll.cancel.approve" as const;

/** legend-t3f5: who may read the run list and a run row (totals only). */
export const PAYROLL_RUN_READ_PERMISSIONS = [
  PAYROLL_RUN_PERMISSION,
  PAYROLL_APPROVE_PERMISSION,
  PAYROLL_LOCK_PERMISSION,
] as const satisfies readonly PermissionCode[];

/** Service-charge pools: payroll.run prepares them, payroll.approve approves. */
export const SERVICE_CHARGE_PERMISSIONS = [
  PAYROLL_RUN_PERMISSION,
  PAYROLL_APPROVE_PERMISSION,
] as const satisfies readonly PermissionCode[];

/** Per-employee amounts (review rows, payslips, allocations): HR-03 PII. */
export const PAYROLL_SALARY_PERMISSIONS = [
  PAYROLL_VIEW_PERMISSION,
  PAYROLL_RUN_PERMISSION,
] as const satisfies readonly PermissionCode[];

function permissionGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

export const payrollRunGuard = permissionGuard(PAYROLL_RUN_READ_PERMISSIONS);
export const serviceChargeGuard = permissionGuard(SERVICE_CHARGE_PERMISSIONS);

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
    canViewSalaries: holdsAny(access, PAYROLL_SALARY_PERMISSIONS),
  };
}

export type PayrollAccess = ReturnType<typeof payrollAccess>;
