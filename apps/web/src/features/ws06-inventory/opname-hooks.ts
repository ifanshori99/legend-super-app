// The only way the opname and waste components touch data. Kept beside
// `hooks.ts` / `stock-hooks.ts` so parallel WS-06 FE beads never edited one
// hooks file. Writes invalidate the ledgers they can change: a posted count
// and a waste entry both append stock movements (INV-01).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getStockCount,
  listStockBalances,
  listStockCounts,
  listStockLedger,
  listWasteLogs,
  type StockCountAction,
  type StockCountStatus,
  type StockCountType,
} from "@starter/shared/inventory";
import * as api from "./opname-api";
import {
  countQuery,
  countsQuery,
  menuQuery,
  wasteQuery,
} from "./opname-queries";
import { STOCK_LIST_LIMIT } from "./stock-lib";

export function useMenuItems() {
  return useQuery(menuQuery({ limit: STOCK_LIST_LIMIT, status: "active" }));
}

// ---- Stock counts --------------------------------------------------------

export function useStockCounts(
  outletId: string | undefined,
  filter?: {
    status?: StockCountStatus;
    type?: StockCountType;
  },
) {
  return useQuery({
    ...countsQuery({
      outletId: outletId ?? "",
      limit: STOCK_LIST_LIMIT,
      ...filter,
    }),
    enabled: Boolean(outletId),
  });
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
    onSuccess: (_response, variables) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [
            getStockCount.id,
            { params: { stockCountId: variables.stockCountId } },
          ],
        }),
        queryClient.invalidateQueries({ queryKey: [listStockCounts.id] }),
      ]),
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
    onSuccess: (_response, variables) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [
            getStockCount.id,
            { params: { stockCountId: variables.stockCountId } },
          ],
        }),
        queryClient.invalidateQueries({ queryKey: [listStockCounts.id] }),
        // Posting appends adjustment rows and refolds the balances.
        queryClient.invalidateQueries({ queryKey: [listStockLedger.id] }),
        queryClient.invalidateQueries({ queryKey: [listStockBalances.id] }),
      ]),
  });
}

// ---- Waste ---------------------------------------------------------------

export function useWasteLogs(outletId: string | undefined) {
  return useQuery({
    ...wasteQuery({ outletId: outletId ?? "", limit: STOCK_LIST_LIMIT }),
    enabled: Boolean(outletId),
  });
}

export function useCreateWasteLog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.recordWaste,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [listWasteLogs.id] }),
        // A waste entry writes a `waste` movement and lowers the balance.
        queryClient.invalidateQueries({ queryKey: [listStockLedger.id] }),
        queryClient.invalidateQueries({ queryKey: [listStockBalances.id] }),
      ]),
  });
}
