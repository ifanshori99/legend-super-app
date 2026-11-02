// Query keys and options for stock opname and waste. Kept beside `queries.ts`
// and `stock-queries.ts` so the shared inventory queries stay untouched.
import { queryOptions } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getStockCount,
  listStockCounts,
  listWasteLogs,
} from "@starter/shared/inventory";
import { listItems as listMenuItemsEndpoint } from "@starter/shared/menu";
import { endpointQueryKey } from "@/lib/api/endpoint";
import { getCount } from "./opname-api";
import { allPagesQuery } from "./queries";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

// These lists grow over time, so they follow the cursor to the last page
// (docs: allPagesQuery) instead of silently stopping after 100 rows.
export const menuQuery = (query: Query<typeof listMenuItemsEndpoint>) =>
  allPagesQuery(listMenuItemsEndpoint, query);

export const countsQuery = (query: Query<typeof listStockCounts>) =>
  allPagesQuery(listStockCounts, query);

/** The detail call unwraps `{ data }`, so its key is built by hand. */
export function countQuery(params: Params<typeof getStockCount>) {
  return queryOptions({
    queryKey: endpointQueryKey(getStockCount, { params }),
    queryFn: ({ signal }) => getCount(params, signal),
  });
}

export const wasteQuery = (query: Query<typeof listWasteLogs>) =>
  allPagesQuery(listWasteLogs, query);
