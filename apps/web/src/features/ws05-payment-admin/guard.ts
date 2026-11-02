// Page guard for the payment back office: the kelola area already requires
// dashboard.management.view + MFA; this page additionally needs one of the
// payment permissions (docs/frontend.md "Page guard"). The API re-checks every
// request — this only hides a screen the caller could not use.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export function paymentAdminGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}
