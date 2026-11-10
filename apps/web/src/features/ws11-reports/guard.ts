// Page guard of a report screen (docs/frontend.md "Page guard"): the kelola
// area already needs dashboard.management.view + MFA; a report additionally
// needs every permission its catalog definition lists, or report.aggregate.view
// for an aggregate-only report a shareholder tile links to (SH-01). The API
// re-checks; this only avoids showing a screen the visitor cannot use.
import { notFound } from "@tanstack/react-router";
import {
  REPORT_AGGREGATE_VIEW_PERMISSION,
  reportAcceptsAggregateView,
  reportByCode,
  reportPermittedFor,
} from "@starter/shared/dashboard";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export function reportGuard(reportCode: string) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const report = reportByCode(reportCode);
    if (report === undefined) throw notFound();
    // Aggregate-only access: the one permission checked is the aggregate one.
    const needed =
      !report.requiredPermissions.every((code) =>
        context.access.permissions.includes(code as PermissionCode),
      ) &&
      reportAcceptsAggregateView(report) &&
      reportPermittedFor(report, context.access.permissions)
        ? [REPORT_AGGREGATE_VIEW_PERMISSION]
        : report.requiredPermissions;
    for (const permission of needed) {
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
