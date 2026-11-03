// Page-level guard for the platform ops screens: the platform area already
// requires a platform permission + MFA (lib/areas/definitions.ts); each page
// narrows it (docs/frontend.md "Page guard"). The API re-checks every request.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export const PAKET_PERMISSIONS = [
  "platform.package.manage",
  "platform.tenant.manage",
] as const satisfies readonly PermissionCode[];
export const KESEHATAN_PERMISSIONS = [
  "platform.health.view",
] as const satisfies readonly PermissionCode[];
// No dedicated cross-tenant audit permission exists in the catalog; the audit
// view is read-only platform data, so either platform read permission opens it.
export const AUDIT_PERMISSIONS = [
  "platform.health.view",
  "platform.tenant.manage",
] as const satisfies readonly PermissionCode[];

export function opsGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "back_office", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}
