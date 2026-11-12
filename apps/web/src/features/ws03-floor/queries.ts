// Query keys and options for the floor board. Keys are `[endpoint.id, input]`
// (docs/frontend.md), so invalidating `[endpoint.id]` refreshes every view.
import { queryOptions } from "@tanstack/react-query";
import {
  getFloorBoard,
  getSessionBill,
  type TableSessionId,
} from "@starter/shared/qr-order";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";

/** The board is live: poll faster than the default freshness window. */
export const BOARD_REFETCH_MS = 15_000;

export const floorBoardQuery = (outletId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getFloorBoard, {
      params: { outletId },
      query: {},
    }),
    queryFn: ({ signal }) => api.getFloorBoard({ outletId }, { signal }),
    refetchInterval: BOARD_REFETCH_MS,
    // A stale board is better than a spinner while the next poll runs.
    staleTime: BOARD_REFETCH_MS / 3,
    retry: 1,
  });

export const sessionBillQuery = (sessionId: TableSessionId) =>
  queryOptions({
    queryKey: endpointQueryKey(getSessionBill, { params: { sessionId } }),
    queryFn: ({ signal }) => api.getSessionBill({ sessionId }, { signal }),
    retry: 1,
  });
