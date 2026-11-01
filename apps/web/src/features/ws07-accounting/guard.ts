// Page-level guard for the accounting screens: the kelola area already
// requires dashboard.management.view + MFA; a page additionally needs its own
// accounting permission (docs/frontend.md "Page guard"). The API re-checks
// everything; this only avoids showing a screen the visitor cannot use.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

/** Journal viewers need `accounting.journal.view`; posting adds `.post`. */
export const ACCOUNTING_VIEW: readonly PermissionCode[] = [
  "accounting.journal.view",
];
export const ACCOUNTING_POST: readonly PermissionCode[] = [
  "accounting.journal.post",
];

export function accountingGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}
