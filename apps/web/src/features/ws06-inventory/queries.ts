// Query keys and options for the inventory back office. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes every
// page of that list (docs/frontend.md).
import { queryOptions } from "@tanstack/react-query";
import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
} from "@starter/shared/api";
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
import {
  callEndpoint,
  endpointQueryKey,
  endpointQueryOptions,
  type CallArgs,
} from "@/lib/api/endpoint";
import { collectAllPages } from "./pages.ts";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

type CursorListEndpoint = AnyEndpoint & { method: "GET" };

/**
 * queryOptions for a cursor list the screens filter in memory: follows
 * `meta.nextCursor` to the last page, so a catalog over one page (100 rows,
 * PAGE_LIMIT_MAX) is never silently truncated. Keyed under the endpoint id, so
 * `invalidateQueries({ queryKey: [endpoint.id] })` still refreshes it.
 */
export function allPagesQuery<E extends CursorListEndpoint>(
  endpoint: E,
  query: Query<E>,
) {
  type Page = EndpointOutput<E> & {
    data: unknown[];
    meta: { limit: number; nextCursor: string | null };
  };
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(endpoint, ...([{ query }] as unknown as CallArgs<E>)),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages<unknown, Page>(
        (cursor) =>
          callEndpoint(
            endpoint,
            ...([
              { query: { ...(query as object), cursor } },
              { signal },
            ] as unknown as CallArgs<E>),
          ) as Promise<Page>,
      ) as Promise<EndpointOutput<E>>,
  });
}

/** Everything under one prefix, for a screen that opens a different area. */
export const inventoryKeys = { all: ["inventory"] as const };

export const itemsQuery = (query: Query<typeof listInventoryItems>) =>
  allPagesQuery(listInventoryItems, query);

export const itemQuery = (params: Params<typeof getInventoryItem>) =>
  endpointQueryOptions(getInventoryItem, { params });

export const unitsQuery = (query: Query<typeof listUoms>) =>
  allPagesQuery(listUoms, query);

export const conversionsQuery = (params: Params<typeof listUomConversions>) =>
  endpointQueryOptions(listUomConversions, { params });

export const locationsQuery = (query: Query<typeof listStockLocations>) =>
  allPagesQuery(listStockLocations, query);

export const balancesQuery = (query: Query<typeof listStockBalances>) =>
  allPagesQuery(listStockBalances, query);

export const alternatesQuery = (
  params: Params<typeof listInventoryItemAlternates>,
) => endpointQueryOptions(listInventoryItemAlternates, { params });

export const transfersQuery = (query: Query<typeof listStockTransfers>) =>
  endpointQueryOptions(listStockTransfers, { query });
