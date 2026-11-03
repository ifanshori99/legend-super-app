// Delivery ops write gates (bead legend-e8oa; PRD v1.7 §3.7 RBAC, §3.23).
// Presentation only: the API re-checks delivery.channel.manage and
// delivery.order.handle on every request. The access object is the one the
// root route resolved and the kelola area guard used; a feature component has
// no route file of its own, so the router's `strict: false` context read is the
// same source, not a new store.
import { useRouteContext } from "@tanstack/react-router";
import type { AreaAccess } from "@/lib/areas/access";
import { ANONYMOUS_ACCESS } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";

export function useDeliveryAccess(): AreaAccess {
  const context = useRouteContext({ strict: false }) as {
    readonly access?: AreaAccess;
  };
  // Fail closed: a screen rendered without the root context shows no writes.
  return context.access ?? ANONYMOUS_ACCESS;
}

export function useDeliveryWrites(): {
  readonly canManageChannels: boolean;
  readonly canHandleOrders: boolean;
} {
  const access = useDeliveryAccess();
  return {
    canManageChannels: holdsAny(access, ["delivery.channel.manage"]),
    canHandleOrders: holdsAny(access, ["delivery.order.handle"]),
  };
}
