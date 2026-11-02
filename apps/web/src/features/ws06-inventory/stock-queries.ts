// Query options for the stock-control screens (legend-vxj). Catalog lists come
// from ./queries.ts (legend-qdc) so both halves of the inventory back office
// share one cache entry per list, and every list the screens join in memory
// follows the cursor to its last page (allPagesQuery). The stock card ledger
// stays one server page: it is filtered server-side and the screen says when
// more rows exist.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  listParLevels,
  listStockBatches,
  listStockLedger,
} from "@starter/shared/inventory";
import { endpointQueryOptions } from "@/lib/api/endpoint";
import { allPagesQuery } from "./queries.ts";

export {
  balancesQuery,
  inventoryKeys,
  itemsQuery,
  locationsQuery,
  unitsQuery,
} from "./queries.ts";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export const parLevelsQuery = (query: Query<typeof listParLevels>) =>
  allPagesQuery(listParLevels, query);

export const batchesQuery = (query: Query<typeof listStockBatches>) =>
  allPagesQuery(listStockBatches, query);

export const ledgerQuery = (query: Query<typeof listStockLedger>) =>
  endpointQueryOptions(listStockLedger, { query });
