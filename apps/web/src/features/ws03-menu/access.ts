// Menu back-office write gates (bead legend-5a74; PRD v1.7 §3.7 RBAC).
// Presentation only: the API re-checks menu.item.manage / menu.price.manage /
// menu.availability.toggle on every write. The access object is the one the
// root route already resolved (lib/areas/load-access.ts) and the kelola area
// guard used; a shared feature component has no route file of its own, so the
// router's `strict: false` context read is the same source, not a new store.
import { useRouteContext } from "@tanstack/react-router";
import { holdsAny } from "@/lib/areas/guard";
import type { AreaAccess } from "@/lib/areas/access";
import { ANONYMOUS_ACCESS } from "@/lib/areas/access";

export function useMenuAccess(): AreaAccess {
  const context = useRouteContext({ strict: false }) as {
    readonly access?: AreaAccess;
  };
  // Fail closed: a screen rendered without the root context shows no writes.
  return context.access ?? ANONYMOUS_ACCESS;
}

/**
 * Which write families this visitor holds. Combos and stations have no own
 * permission code in the catalog; their API routes authorize with
 * menu.item.manage, so content management covers them here too.
 */
export function useMenuWrites(): {
  readonly canManageItems: boolean;
  /**
   * Rename, retype, create and delete stations: needs menu.item.manage at
   * tenant or outlet scope (GET /api/me/access `canManageStationConfig`), not
   * a grant held only at one station, which keeps target time and printer.
   */
  readonly canManageStationConfig: boolean;
  readonly canManagePrices: boolean;
  readonly canToggleAvailability: boolean;
} {
  const access = useMenuAccess();
  return {
    canManageItems: holdsAny(access, ["menu.item.manage"]),
    // Fail closed: an access object without the flag keeps the config hidden.
    canManageStationConfig:
      holdsAny(access, ["menu.item.manage"]) &&
      access.canManageStationConfig === true,
    canManagePrices: holdsAny(access, ["menu.price.manage"]),
    canToggleAvailability: holdsAny(access, ["menu.availability.toggle"]),
  };
}
