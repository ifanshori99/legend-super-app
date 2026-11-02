// Query keys and options for stock opname and waste. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes every
// page of that list (docs/frontend.md).
import { queryOptions } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getStockCount,
  listInventoryItems,
  listStockCounts,
  listStockLocations,
  listUoms,
  listWasteLogs,
} from "@starter/shared/inventory";
import { listItems as listMenuItemsEndpoint } from "@starter/shared/menu";
import { endpointQueryOptions, endpointQueryKey } from "@/lib/api/endpoint";
import { getCount } from "./api";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

/** Every list this feature owns refetches as a group after a write. */
export const opnameKeys = {
  all: ["ws06-opname"] as const,
};

export const itemsQuery = (query: Query<typeof listInventoryItems>) =>
  endpointQueryOptions(listInventoryItems, { query });

export const locationsQuery = (query: Query<typeof listStockLocations>) =>
  endpointQueryOptions(listStockLocations, { query });

export const unitsQuery = (query: Query<typeof listUoms>) =>
  endpointQueryOptions(listUoms, { query });

export const menuQuery = (query: Query<typeof listMenuItemsEndpoint>) =>
  endpointQueryOptions(listMenuItemsEndpoint, { query });

export const countsQuery = (query: Query<typeof listStockCounts>) =>
  endpointQueryOptions(listStockCounts, { query });

export function countQuery(params: Params<typeof getStockCount>) {
  return queryOptions({
    queryKey: endpointQueryKey(getStockCount, { params }),
    queryFn: ({ signal }) => getCount(params, signal),
  });
}

export const wasteQuery = (query: Query<typeof listWasteLogs>) =>
  endpointQueryOptions(listWasteLogs, { query });
