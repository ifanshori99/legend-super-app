// Page guard for the payout screen. The kelola area already requires
// dashboard.management.view + MFA; this page additionally needs one payroll or
// payout permission. Every write stays server-checked (the API answers 403);
// the flags below only decide which buttons are pressable (AUTH-05).
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";

/** Anyone who may read payroll or take part in a disbursement sees the page. */
export const PAYOUT_VIEW_PERMISSIONS = [
  "payroll.view",
  "payroll.run",
  "payroll.approve",
  "payroll.lock",
  "payroll.payout.configure",
  "payroll.disburse.request",
  "payroll.disburse.approve",
] as const satisfies readonly PermissionCode[];

export function payoutGuard({
  context,
}: {
  context: { access: AreaAccess };
}): void {
  const gate = evaluateGuard(
    {
      kind: "permission",
      surface: "dashboard",
      anyOf: PAYOUT_VIEW_PERMISSIONS,
    },
    context.access,
  );
  if (gate.status !== "allowed") throw notFound();
}

export function payoutAccess(access: AreaAccess) {
  return {
    canView: holdsAny(access, PAYOUT_VIEW_PERMISSIONS),
    canConfigure: holdsAny(access, ["payroll.payout.configure"]),
    canRequest: holdsAny(access, ["payroll.disburse.request"]),
    canApprove: holdsAny(access, ["payroll.disburse.approve"]),
  };
}

export type PayoutAccess = ReturnType<typeof payoutAccess>;
