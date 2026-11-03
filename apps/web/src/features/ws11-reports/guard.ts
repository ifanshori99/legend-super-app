// Page guard of a report screen (docs/frontend.md "Page guard"): the kelola
// area already needs dashboard.management.view + MFA; a report additionally
// needs every permission its catalog definition lists. The API re-checks; this
// only avoids showing a screen the visitor cannot use.
import { notFound } from "@tanstack/react-router";
import { reportByCode } from "@starter/shared/dashboard";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export function reportGuard(reportCode: string) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const report = reportByCode(reportCode);
    if (report === undefined) throw notFound();
    for (const permission of report.requiredPermissions) {
      const gate = evaluateGuard(
        {
          kind: "permission",
          surface: "dashboard",
          anyOf: [permission as PermissionCode],
        },
        context.access,
      );
      if (gate.status !== "allowed") throw notFound();
    }
  };
}
