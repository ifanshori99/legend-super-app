// The only way components touch inventory data: queries keep their endpoint
// keys, mutations invalidate every endpoint whose rows a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  listInventoryItems,
  listPurchaseRequests,
  listUoms,
  type StockMovementType,
} from "@starter/shared/inventory";
import * as api from "./stock-api";
import {
  balancesQuery,
  batchesQuery,
  itemsQuery,
  ledgerQuery,
  locationsQuery,
  parLevelsQuery,
  unitsQuery,
} from "./stock-queries";
import { STOCK_LIST_LIMIT } from "./stock-lib";

type QueryOf<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Reads ---------------------------------------------------------------

export function useInventoryItems(query: QueryOf<typeof listInventoryItems>) {
  return useQuery(itemsQuery(query));
}

export function useUnits(query: QueryOf<typeof listUoms>) {
  return useQuery(unitsQuery(query));
}

export function useStockLocations(outletId: string | undefined) {
  return useQuery({
    ...locationsQuery({ outletId: outletId ?? "", limit: STOCK_LIST_LIMIT }),
    enabled: Boolean(outletId),
  });
}

export function useStockBalances(outletId: string | undefined) {
  return useQuery({
    ...balancesQuery({ outletId: outletId ?? "", limit: STOCK_LIST_LIMIT }),
    enabled: Boolean(outletId),
  });
}

export function useParLevels(outletId: string | undefined) {
  return useQuery({
    ...parLevelsQuery({ outletId: outletId ?? "", limit: STOCK_LIST_LIMIT }),
    enabled: Boolean(outletId),
  });
}

export function useStockBatches(outletId: string | undefined) {
  return useQuery({
    ...batchesQuery({ outletId: outletId ?? "", limit: STOCK_LIST_LIMIT }),
    enabled: Boolean(outletId),
  });
}

export type StockLedgerFilters = {
  locationId?: string;
  inventoryItemId?: string;
  movementType?: StockMovementType;
  fromDate?: string;
  toDate?: string;
};

/** Stock card rows; the filters are server query params (PRD §16 ledger). */
export function useStockLedger(
  outletId: string | undefined,
  filters: StockLedgerFilters = {},
) {
  return useQuery({
    ...ledgerQuery({
      outletId: outletId ?? "",
      limit: STOCK_LIST_LIMIT,
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
      ...(filters.inventoryItemId
        ? { inventoryItemId: filters.inventoryItemId }
        : {}),
      ...(filters.movementType ? { movementType: filters.movementType } : {}),
      ...(filters.fromDate ? { fromDate: filters.fromDate } : {}),
      ...(filters.toDate ? { toDate: filters.toDate } : {}),
    }),
    enabled: Boolean(outletId),
  });
}

// ---- Writes --------------------------------------------------------------

export function useCreatePurchaseRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createPurchaseRequest,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listPurchaseRequests.id] }),
  });
}
