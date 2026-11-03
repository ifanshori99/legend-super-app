// Page-level guard for the payroll configuration screen: the kelola area
// already requires dashboard.management.view + MFA; this page additionally
// needs payroll.view, and its write controls need payroll.run (docs/frontend.md
// "Page guard"). The API re-checks everything, so this only hides what a
// visitor cannot use.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";

export const PAYROLL_VIEW_PERMISSION = "payroll.view" as const;
export const PAYROLL_RUN_PERMISSION = "payroll.run" as const;

export function payrollConfigGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

/**
 * What this visitor may do (PAYR-02): every payroll role reads the tables;
 * only payroll.run edits drafts, publishes, archives, sets salary amounts and
 * changes policies/components.
 */
export function payrollConfigAccess(access: AreaAccess) {
  return {
    canView: holdsAny(access, [PAYROLL_VIEW_PERMISSION]),
    canRun: holdsAny(access, [PAYROLL_RUN_PERMISSION]),
  };
}
