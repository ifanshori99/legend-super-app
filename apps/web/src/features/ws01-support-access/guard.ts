// Page guards (docs/frontend.md "Page guard"). The platform and kelola layouts
// already run the area guard; these add the page permission. The API
// re-checks every request.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export function supportAccessGuard(
  surface: "dashboard" | "back_office",
  anyOf: readonly PermissionCode[],
) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface, anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}
