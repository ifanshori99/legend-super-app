// The only way components touch opname and waste data: queries keep their
// endpoint keys, mutations invalidate every list or detail a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getStockCount,
  listStockCounts,
  listWasteLogs,
  type StockCountAction,
  type StockCountStatus,
  type StockCountType,
} from "@starter/shared/inventory";
import * as api from "./api";
import { INVENTORY_OUTLET_ID } from "./outlet";
import {
  countQuery,
  countsQuery,
  itemsQuery,
  locationsQuery,
  menuQuery,
  unitsQuery,
  wasteQuery,
} from "./queries";

/** One page of everything; the fixtures are small and the screens filter. */
const LOOKUP_LIMIT = 100;

// ---- Lookups -------------------------------------------------------------

export function useInventoryItems() {
  return useQuery(itemsQuery({ limit: LOOKUP_LIMIT }));
}

export function useStockLocations() {
  return useQuery(
    locationsQuery({ outletId: INVENTORY_OUTLET_ID, limit: LOOKUP_LIMIT }),
  );
}

export function useUnits() {
  return useQuery(unitsQuery({ limit: LOOKUP_LIMIT }));
}

/** Menu items are only needed as a waste target (PRD §16 "Waste"). */
export function useMenuItems() {
  return useQuery(menuQuery({ limit: LOOKUP_LIMIT, status: "active" }));
}

// ---- Stock counts --------------------------------------------------------

export function useStockCounts(filter?: {
  status?: StockCountStatus;
  type?: StockCountType;
}) {
  return useQuery(
    countsQuery({
      outletId: INVENTORY_OUTLET_ID,
      limit: LOOKUP_LIMIT,
      ...filter,
    }),
  );
}

export function useStockCount(stockCountId: string) {
  return useQuery({
    ...countQuery({ stockCountId }),
    enabled: stockCountId !== "",
  });
}

export function useCreateStockCount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createCount,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listStockCounts.id] }),
  });
}

export function useSaveCountLine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      stockCountId: string;
      lineId: string;
      countedQty: string;
    }) =>
      api.updateCountLine(
        { stockCountId: variables.stockCountId, lineId: variables.lineId },
        { countedQty: variables.countedQty },
      ),
    onSuccess: (_response, variables) => {
      void queryClient.invalidateQueries({
        queryKey: [getStockCount.id, { params: { stockCountId: variables.stockCountId } }],
      });
      void queryClient.invalidateQueries({ queryKey: [listStockCounts.id] });
    },
  });
}

export function useCountTransition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      stockCountId: string;
      action: StockCountAction;
      note?: string | null;
      idempotencyKey: string;
    }) =>
      api.transitionCount(
        { stockCountId: variables.stockCountId },
        {
          action: variables.action,
          note: variables.note ?? null,
          idempotencyKey: variables.idempotencyKey,
        },
      ),
    onSuccess: (_response, variables) => {
      void queryClient.invalidateQueries({
        queryKey: [getStockCount.id, { params: { stockCountId: variables.stockCountId } }],
      });
      void queryClient.invalidateQueries({ queryKey: [listStockCounts.id] });
    },
  });
}

// ---- Waste ---------------------------------------------------------------

export function useWasteLogs() {
  return useQuery(
    wasteQuery({ outletId: INVENTORY_OUTLET_ID, limit: LOOKUP_LIMIT }),
  );
}

export function useCreateWasteLog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.recordWaste,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listWasteLogs.id] }),
  });
}
