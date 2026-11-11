// Query keys and options for the menu back office. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes every
// page of that list (docs/frontend.md).
import { queryOptions } from "@tanstack/react-query";
import {
  callEndpoint,
  endpointQueryKey,
  endpointQueryOptions,
  type CallArgs,
} from "@/lib/api/endpoint";
import {
  getItem,
  getItemModifierGroups,
  listAvailability,
  listCategories,
  listCombos,
  listItems,
  listModifierGroups,
  listModifiers,
  listPriceListItems,
  listPriceLists,
  listStations,
  listVariants,
} from "@starter/shared/menu";
import { orgEndpoints } from "@starter/shared/platform";
import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
} from "@starter/shared/api";
import { collectAllPages } from "./pages.ts";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

/** Everything under one prefix, for a screen that opens a different area. */
export const menuKeys = { all: ["menu"] as const };

/**
 * queryOptions for a cursor list that is read in full (printable menu, price
 * grid): follows `meta.nextCursor` to the last page, so a menu over one page
 * (100 rows, PAGE_LIMIT_MAX) is never silently truncated. Keyed under the
 * endpoint id, so `invalidateQueries({ queryKey: [endpoint.id] })` still
 * refreshes it.
 */
function allPagesQuery<E extends AnyEndpoint & { method: "GET" }>(
  endpoint: E,
  input: { params?: Params<E>; query: Query<E> },
) {
  type Page = EndpointOutput<E> & {
    data: unknown[];
    meta: { limit: number; nextCursor: string | null };
  };
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(endpoint, ...([input] as unknown as CallArgs<E>)),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages<unknown, Page>(
        (cursor) =>
          callEndpoint(
            endpoint,
            ...([
              { ...input, query: { ...(input.query as object), cursor } },
              { signal },
            ] as unknown as CallArgs<E>),
          ) as Promise<Page>,
      ) as Promise<EndpointOutput<E>>,
  });
}

export const itemsQuery = (query: Query<typeof listItems>) =>
  endpointQueryOptions(listItems, { query });

export const itemQuery = (params: Params<typeof getItem>) =>
  endpointQueryOptions(getItem, { params });

export const itemModifierGroupsQuery = (
  params: Params<typeof getItemModifierGroups>,
) => endpointQueryOptions(getItemModifierGroups, { params });

export const categoriesQuery = (query: Query<typeof listCategories>) =>
  endpointQueryOptions(listCategories, { query });

export const stationsQuery = (query: Query<typeof listStations>) =>
  endpointQueryOptions(listStations, { query });

export const outletsQuery = (query: Query<typeof orgEndpoints.listOutlets>) =>
  endpointQueryOptions(orgEndpoints.listOutlets, { query });

export const variantsQuery = (
  params: Params<typeof listVariants>,
  query: Query<typeof listVariants>,
) => endpointQueryOptions(listVariants, { params, query });

export const modifierGroupsQuery = (query: Query<typeof listModifierGroups>) =>
  endpointQueryOptions(listModifierGroups, { query });

export const modifiersQuery = (
  params: Params<typeof listModifiers>,
  query: Query<typeof listModifiers>,
) => endpointQueryOptions(listModifiers, { params, query });

export const combosQuery = (query: Query<typeof listCombos>) =>
  endpointQueryOptions(listCombos, { query });

export const priceListsQuery = (query: Query<typeof listPriceLists>) =>
  endpointQueryOptions(listPriceLists, { query });

export const priceListItemsQuery = (
  params: Params<typeof listPriceListItems>,
  query: Query<typeof listPriceListItems>,
) => allPagesQuery(listPriceListItems, { params, query });

/** Full reads for the printable menu: no page limit on what gets printed. */
export const allItemsQuery = (query: Query<typeof listItems>) =>
  allPagesQuery(listItems, { query });

export const allCategoriesQuery = (query: Query<typeof listCategories>) =>
  allPagesQuery(listCategories, { query });

export const allPriceListsQuery = (query: Query<typeof listPriceLists>) =>
  allPagesQuery(listPriceLists, { query });

export const availabilityQuery = (query: Query<typeof listAvailability>) =>
  endpointQueryOptions(listAvailability, { query });
