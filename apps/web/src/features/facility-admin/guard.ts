// Page guard for the facility admin screens: the kelola area already requires
// dashboard.management.view + MFA; these pages additionally need
// facility.config.manage (PRD §3 RBAC; docs/frontend.md "Page guard"). The API
// re-checks every request, so this only hides a screen the visitor cannot use.
import { notFound } from "@tanstack/react-router";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export function facilityAdminGuard({
  context,
}: {
  context: { access: AreaAccess };
}) {
  const gate = evaluateGuard(
    {
      kind: "permission",
      surface: "dashboard",
      anyOf: ["facility.config.manage"],
    },
    context.access,
  );
  if (gate.status !== "allowed") throw notFound();
}
