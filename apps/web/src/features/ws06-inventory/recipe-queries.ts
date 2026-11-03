// Query keys and options for recipes and production orders. Kept beside the
// other inventory query modules so parallel WS-06 FE beads never edited one
// file. Lists follow `meta.nextCursor` to the last page (docs allPagesQuery);
// the detail unwraps `{ data }` so its key is built by hand.
import { queryOptions } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { listExampleOutlets } from "@starter/shared/api";
import {
  getRecipe,
  listProductionOrders,
  listRecipes,
} from "@starter/shared/inventory";
import { endpointQueryKey, endpointQueryOptions } from "@/lib/api/endpoint";
import { getRecipeDetail } from "./recipe-api";
import { allPagesQuery } from "./queries";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const recipesQuery = (query: Query<typeof listRecipes>) =>
  allPagesQuery(listRecipes, query);

/** Recipe detail; the API call unwraps `{ data }`, so the key is by hand. */
export function recipeQuery(params: Params<typeof getRecipe>) {
  return queryOptions({
    queryKey: endpointQueryKey(getRecipe, { params }),
    queryFn: ({ signal }) => getRecipeDetail(params, signal),
  });
}

export const productionOrdersQuery = (
  query: Query<typeof listProductionOrders>,
) => allPagesQuery(listProductionOrders, query);

/**
 * Outlet names for the production table. The outlet context has not landed
 * (see ./outlet.ts), so the screens read the reference outlet list the other
 * back-office screens already use; an id without a name falls back to its
 * short form instead of a fake label.
 */
export const productionOutletsQuery = () =>
  endpointQueryOptions(listExampleOutlets, { query: { limit: 100 } });
