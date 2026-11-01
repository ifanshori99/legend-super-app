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
import * as api from "./api";
import {
  balancesQuery,
  batchesQuery,
  itemsQuery,
  ledgerQuery,
  locationsQuery,
  parLevelsQuery,
  unitsQuery,
} from "./queries";
import { INVENTORY_OUTLET_ID } from "./outlet";
import { STOCK_LIST_LIMIT } from "./lib";

type QueryOf<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Reads ---------------------------------------------------------------

export function useInventoryItems(query: QueryOf<typeof listInventoryItems>) {
  return useQuery(itemsQuery(query));
}

export function useUnits(query: QueryOf<typeof listUoms>) {
  return useQuery(unitsQuery(query));
}

export function useStockLocations() {
  return useQuery(
    locationsQuery({ outletId: INVENTORY_OUTLET_ID, limit: STOCK_LIST_LIMIT }),
  );
}

export function useStockBalances() {
  return useQuery(
    balancesQuery({ outletId: INVENTORY_OUTLET_ID, limit: STOCK_LIST_LIMIT }),
  );
}

export function useParLevels() {
  return useQuery(
    parLevelsQuery({ outletId: INVENTORY_OUTLET_ID, limit: STOCK_LIST_LIMIT }),
  );
}

export function useStockBatches() {
  return useQuery(
    batchesQuery({ outletId: INVENTORY_OUTLET_ID, limit: STOCK_LIST_LIMIT }),
  );
}

export type StockLedgerFilters = {
  locationId?: string;
  inventoryItemId?: string;
  movementType?: StockMovementType;
  fromDate?: string;
  toDate?: string;
};

/** Stock card rows; the filters are server query params (PRD §16 ledger). */
export function useStockLedger(filters: StockLedgerFilters = {}) {
  return useQuery(
    ledgerQuery({
      outletId: INVENTORY_OUTLET_ID,
      limit: STOCK_LIST_LIMIT,
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
      ...(filters.inventoryItemId
        ? { inventoryItemId: filters.inventoryItemId }
        : {}),
      ...(filters.movementType ? { movementType: filters.movementType } : {}),
      ...(filters.fromDate ? { fromDate: filters.fromDate } : {}),
      ...(filters.toDate ? { toDate: filters.toDate } : {}),
    }),
  );
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
