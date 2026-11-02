// Page-level guards for the tax screens: the kelola area already requires
// dashboard.management.view + MFA; configuration additionally needs
// org.tax_config.manage, the PBJT recap accounting.tax_report.manage
// (docs/frontend.md "Page guard"). The API re-checks everything.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";

export const TAX_CONFIG_PERMISSION = "org.tax_config.manage" as const;
export const TAX_REPORT_PERMISSION = "accounting.tax_report.manage" as const;

function permissionGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

export const taxConfigGuard = permissionGuard([TAX_CONFIG_PERMISSION]);
export const taxReportGuard = permissionGuard([TAX_REPORT_PERMISSION]);

/** Which sections this visitor may open (tabs and links fail closed). */
export function taxSectionAccess(access: AreaAccess) {
  return {
    canConfigure: holdsAny(access, [TAX_CONFIG_PERMISSION]),
    canReport: holdsAny(access, [TAX_REPORT_PERMISSION]),
  };
}
