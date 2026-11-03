// Page-level guard for the employee money screens (bead legend-23nc): the
// karyawan area already requires `self.profile.view`; each page additionally
// needs its own self-service permission (docs/frontend.md "Page guard"). The
// API re-checks everything, so this only hides what a visitor cannot use.
//
// PRD §3 F30/F31 names `self.payslip.view` and `self.reimbursement.request`;
// the PRD is silent on a self loan permission, so kasbon reuses the area's
// `self.profile.view` (see the bead report).
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export function selfServiceGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "hris", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}
