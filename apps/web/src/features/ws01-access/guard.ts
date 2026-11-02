// Page-level guard for the RBAC admin screens: the kelola area already
// requires dashboard.management.view + MFA; these pages additionally need one
// of the access permissions (docs/frontend.md "Page guard"). The API re-checks
// every request.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";
import { holdsAny } from "@/lib/areas/guard";

export function accessGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

/** True when the visitor may change roles, assignments or the matrix. */
export function canManageAccess(
  access: AreaAccess,
  permission: PermissionCode,
): boolean {
  return holdsAny(access, [permission]);
}
