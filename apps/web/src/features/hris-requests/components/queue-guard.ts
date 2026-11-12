// Page guard of the supervisor queue (bead legend-ydf2). The kelola area already
// requires dashboard.management.view + MFA; the page needs the right to decide
// at least one request kind. The API re-checks per request, so this only hides
// what a visitor cannot use.
import { notFound } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";
import { QUEUE_ANY_PERMISSION } from "./queue-model.ts";

/** Route `beforeLoad` for the queue and the detail page. */
export function requestQueueGuard() {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "dashboard",
        anyOf: QUEUE_ANY_PERMISSION as readonly PermissionCode[],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}
