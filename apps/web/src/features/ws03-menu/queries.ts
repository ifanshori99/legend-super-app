// Query keys and options for the menu back office. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes every
// page of that list (docs/frontend.md).
import { endpointQueryOptions } from "@/lib/api/endpoint";
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
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

/** Everything under one prefix, for a screen that opens a different area. */
export const menuKeys = { all: ["menu"] as const };

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
) => endpointQueryOptions(listPriceListItems, { params, query });

export const availabilityQuery = (query: Query<typeof listAvailability>) =>
  endpointQueryOptions(listAvailability, { query });
