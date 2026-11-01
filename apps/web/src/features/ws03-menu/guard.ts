// Page-level guard for the menu screens: the kelola area already requires
// dashboard.management.view + MFA; a page additionally needs its own menu
// permission (docs/frontend.md "Page guard"). The API re-checks everything.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export function menuGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}
