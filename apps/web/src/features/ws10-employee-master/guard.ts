// Page-level guard for the employee master screens: the kelola area already
// requires dashboard.management.view + MFA; a page additionally needs
// `hr.employee.view` (docs/frontend.md "Page guard"). The API re-checks
// everything, so this only hides what a visitor cannot use.
//
// The profile is the one screen that does not throw: HR-03 asks the UI to show
// a locked PII panel for a visitor without the permission, and the E2E spec
// covers that state with `legend-mock-role=tenant_admin`. It still refuses to
// render employee data, and the loader skips every request (`canViewEmployees`).
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";

/** PRD RBAC §3.7: the permission the employee master pages require. */
export const EMPLOYEE_MASTER_PERMISSIONS = ["hr.employee.view"] as const;

export function employeeMasterGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

/** HR-03: writing personal data (the API re-checks the viewer kind too). */
export const EMPLOYEE_PII_EDIT_PERMISSIONS = ["hr.employee.manage"] as const;

/** True when the visitor may open the PII edit flow (presentation only). */
export function canEditEmployeePii(access: AreaAccess): boolean {
  return holdsAny(access, EMPLOYEE_PII_EDIT_PERMISSIONS);
}

/**
 * Ubah atasan: the server says whether the caller's assignments can ever pass
 * PATCH /employees/:id/manager (`canChangeEmployeeManager` in GET /api/me/access:
 * HR, or a GM with brand/tenant scope). An outlet manager or supervisor holds
 * `hr.attendance.manage` but is always refused, so permissions alone would
 * show a dead button. Presentation only: the API still answers 403.
 */
export function canChangeEmployeeManager(access: AreaAccess): boolean {
  return access.canChangeEmployeeManager === true;
}

/** True when the visitor may read the employee master (presentation only). */
export function canViewEmployees(access: AreaAccess): boolean {
  return holdsAny(access, EMPLOYEE_MASTER_PERMISSIONS);
}

/** Payslip PIN reset (bead legend-ilzrj): HR with payroll access only. */
export const PAYSLIP_PIN_RESET_PERMISSIONS = ["payroll.run"] as const;

/** True when the visitor may reset an employee's payslip PIN (presentation only). */
export function canResetPayslipPin(access: AreaAccess): boolean {
  return holdsAny(access, PAYSLIP_PIN_RESET_PERMISSIONS);
}

/**
 * Koreksi status PTKP (bead 1223): the API needs `hr.employee.manage` and
 * `payroll.run` together on the employee's home outlet. Presentation only.
 */
export function canCorrectEmployeePtkp(access: AreaAccess): boolean {
  return (
    holdsAny(access, ["hr.employee.manage"]) &&
    holdsAny(access, ["payroll.run"])
  );
}
