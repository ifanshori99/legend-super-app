// The retained idempotency attempt for the signed-in user, tenant and outlet
// reach (see retained-attempt-key.ts). Fails closed: with no session the owner
// is empty, which matches no signed-in owner.
import { useRouteContext } from "@tanstack/react-router";
import type { AttemptKeyTracker } from "@/features/ws05-payment-admin/attempt-key";
import type { AreaAccess } from "@/lib/areas/access";
import { retainedAttempt, retainedOwnerKey } from "@/lib/retained-attempt-key";

export function useRetainedAttempt(scope: string): AttemptKeyTracker {
  const context = useRouteContext({ strict: false }) as {
    session?: { user?: { id?: string } } | null;
    access?: AreaAccess;
  };
  // One web origin serves one tenant, so the host names the tenant.
  const tenant = typeof location === "undefined" ? "" : location.host;
  const owner = retainedOwnerKey({
    tenant,
    userId: context.session?.user?.id ?? "",
    outletIds: (context.access?.outlets ?? []).map((outlet) => outlet.id),
  });
  return retainedAttempt(scope, owner);
}
