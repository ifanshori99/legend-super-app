// Page guard for the recon flag screen. It needs the same permission as the
// API routes behind it (`payroll.disburse.approve`); the guard only decides
// what the visitor sees, the API still answers 403 to anyone else (AUTH-05).
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export const RECON_PERMISSIONS = [
  "payroll.disburse.approve",
] as const satisfies readonly PermissionCode[];

export function reconGuard({
  context,
}: {
  context: { access: AreaAccess };
}): void {
  const gate = evaluateGuard(
    { kind: "permission", surface: "dashboard", anyOf: RECON_PERMISSIONS },
    context.access,
  );
  if (gate.status !== "allowed") throw notFound();
}
