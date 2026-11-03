// Page guard for the tenant screens (list, detail, create wizard). The
// platform area admits either platform.tenant.manage or platform.health.view
// (lib/areas/definitions.ts); tenant data and tenant creation need the former,
// so a health-only platform viewer gets a 404 here. Fails closed when the
// access context is missing. Presentation only: the API re-checks each call.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export const TENANT_PERMISSIONS = [
  "platform.tenant.manage",
] as const satisfies readonly PermissionCode[];

export function tenantGuard({
  context,
}: {
  context: { access?: AreaAccess | null };
}) {
  if (!context.access) throw notFound();
  const gate = evaluateGuard(
    { kind: "permission", surface: "back_office", anyOf: TENANT_PERMISSIONS },
    context.access,
  );
  if (gate.status !== "allowed") throw notFound();
}
