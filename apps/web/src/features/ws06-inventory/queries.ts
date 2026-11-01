// Query keys and options for the inventory back office. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes every
// page of that list (docs/frontend.md).
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getInventoryItem,
  listInventoryItemAlternates,
  listInventoryItems,
  listStockBalances,
  listStockLocations,
  listStockTransfers,
  listUomConversions,
  listUoms,
} from "@starter/shared/inventory";
import { endpointQueryOptions } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

/** Everything under one prefix, for a screen that opens a different area. */
export const inventoryKeys = { all: ["inventory"] as const };

export const itemsQuery = (query: Query<typeof listInventoryItems>) =>
  endpointQueryOptions(listInventoryItems, { query });

export const itemQuery = (params: Params<typeof getInventoryItem>) =>
  endpointQueryOptions(getInventoryItem, { params });

export const unitsQuery = (query: Query<typeof listUoms>) =>
  endpointQueryOptions(listUoms, { query });

export const conversionsQuery = (params: Params<typeof listUomConversions>) =>
  endpointQueryOptions(listUomConversions, { params });

export const locationsQuery = (query: Query<typeof listStockLocations>) =>
  endpointQueryOptions(listStockLocations, { query });

export const balancesQuery = (query: Query<typeof listStockBalances>) =>
  endpointQueryOptions(listStockBalances, { query });

export const alternatesQuery = (
  params: Params<typeof listInventoryItemAlternates>,
) => endpointQueryOptions(listInventoryItemAlternates, { params });

export const transfersQuery = (query: Query<typeof listStockTransfers>) =>
  endpointQueryOptions(listStockTransfers, { query });
