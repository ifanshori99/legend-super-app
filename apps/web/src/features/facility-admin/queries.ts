// Query keys and queryOptions for the facility admin screens. Custom keys (not
// endpointQueryKey) because a mutation patches the whole config document in one
// place: the mock contract read always serves seed fixtures, so the cache is
// updated from each mutation response instead of re-reading it.
import { queryOptions } from "@tanstack/react-query";
import * as api from "./api.ts";
import type { FacilitiesQuery } from "./api.ts";

export const facilityAdminKeys = {
  all: ["facility-admin"] as const,
  lists: () => [...facilityAdminKeys.all, "list"] as const,
  list: (query: FacilitiesQuery) =>
    [...facilityAdminKeys.lists(), query] as const,
  configs: () => [...facilityAdminKeys.all, "config"] as const,
  config: (facilityId: string) =>
    [...facilityAdminKeys.configs(), facilityId] as const,
  menuItems: () => [...facilityAdminKeys.all, "menu-items"] as const,
  inventoryItems: () => [...facilityAdminKeys.all, "inventory-items"] as const,
};

/** GET /api/facility/facilities — the config index (contract added for er32). */
export function facilitiesListQuery(input: FacilitiesQuery) {
  return queryOptions({
    queryKey: facilityAdminKeys.list(input),
    queryFn: ({ signal }) => api.fetchFacilities(input, signal),
  });
}

/** GET /api/facility/config — facility, areas, units, products, rules, plans. */
export function facilityConfigQuery(facilityId: string) {
  return queryOptions({
    queryKey: facilityAdminKeys.config(facilityId),
    queryFn: ({ signal }) => api.fetchFacilityConfig(facilityId, signal),
  });
}

/** Menu packages for the product/rule editor (WS-03 read, no own mock). */
export function menuItemsQuery() {
  return queryOptions({
    queryKey: facilityAdminKeys.menuItems(),
    queryFn: ({ signal }) => api.fetchMenuItems(signal),
    staleTime: 60_000,
  });
}

/** Inventory items an add-on can consume (WS-06 read, no own mock). */
export function inventoryItemsQuery() {
  return queryOptions({
    queryKey: facilityAdminKeys.inventoryItems(),
    queryFn: ({ signal }) => api.fetchInventoryItems(signal),
    staleTime: 60_000,
  });
}
