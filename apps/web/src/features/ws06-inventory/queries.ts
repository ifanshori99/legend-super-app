// Query keys and options for the stock-control screens. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes every
// page of that list (docs/frontend.md).
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  listInventoryItems,
  listParLevels,
  listStockBalances,
  listStockBatches,
  listStockLedger,
  listStockLocations,
  listUoms,
} from "@starter/shared/inventory";
import { endpointQueryOptions } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

/** Everything under one prefix, for a screen that invalidates inventory data. */
export const inventoryKeys = { all: ["inventory"] as const };

export const itemsQuery = (query: Query<typeof listInventoryItems>) =>
  endpointQueryOptions(listInventoryItems, { query });

export const unitsQuery = (query: Query<typeof listUoms>) =>
  endpointQueryOptions(listUoms, { query });

export const locationsQuery = (query: Query<typeof listStockLocations>) =>
  endpointQueryOptions(listStockLocations, { query });

export const balancesQuery = (query: Query<typeof listStockBalances>) =>
  endpointQueryOptions(listStockBalances, { query });

export const parLevelsQuery = (query: Query<typeof listParLevels>) =>
  endpointQueryOptions(listParLevels, { query });

export const batchesQuery = (query: Query<typeof listStockBatches>) =>
  endpointQueryOptions(listStockBatches, { query });

export const ledgerQuery = (query: Query<typeof listStockLedger>) =>
  endpointQueryOptions(listStockLedger, { query });
