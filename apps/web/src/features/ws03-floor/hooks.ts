// The only way components touch floor data: queries keep their endpoint keys,
// every write invalidates the board and any bill it can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  getFloorBoard,
  getSessionBill,
  type TableSessionId,
} from "@starter/shared/qr-order";
import * as api from "./api";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { floorBoardQuery, outletsQuery, sessionBillQuery } from "./queries";

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

const BOARD_AND_BILLS = [getFloorBoard, getSessionBill] as const;

function useBoardMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const refresh = useInvalidate(BOARD_AND_BILLS);
  return useMutation({ mutationFn, onSuccess: () => refresh() });
}

/** Accessible outlets until the outlet-context bead supplies the assignment. */
export function useOutlets() {
  return useQuery(outletsQuery());
}

/** Live floor board for one outlet (zones, tables, sessions, open calls). */
export function useFloorBoard(outletId: string | undefined) {
  return useQuery({
    ...floorBoardQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

/** Bill of one session, fetched only while an item-move dialog is open. */
export function useSessionBill(sessionId: TableSessionId | undefined) {
  return useQuery({
    ...sessionBillQuery(sessionId ?? ("" as TableSessionId)),
    enabled: Boolean(sessionId),
  });
}

export function useConfirmSession() {
  return useBoardMutation((sessionId: TableSessionId) =>
    api.confirmOpenBillSession({ sessionId }),
  );
}

export function useCloseSession() {
  return useBoardMutation(
    (input: {
      sessionId: TableSessionId;
      tableCleaned: boolean;
      waiterConfirmedEmpty: boolean;
      note?: string;
    }) =>
      api.closeTableSession(
        { sessionId: input.sessionId },
        {
          tableCleaned: input.tableCleaned,
          waiterConfirmedEmpty: input.waiterConfirmedEmpty,
          note: input.note,
        },
      ),
  );
}

export function useTableStatus() {
  return useBoardMutation(
    (input: {
      tableId: string;
      action:
        | "mark_available"
        | "mark_dirty"
        | "reserve"
        | "release_reservation"
        | "deactivate"
        | "activate";
      note?: string;
    }) =>
      api.updateTableStatus(
        { tableId: input.tableId },
        { action: input.action, note: input.note },
      ),
  );
}

export function useMoveSession() {
  return useBoardMutation(
    (input: { sessionId: TableSessionId; toTableId: string; note?: string }) =>
      api.moveTableSession(
        { sessionId: input.sessionId },
        { toTableId: input.toTableId, note: input.note },
      ),
  );
}

export function useMergeTables() {
  return useBoardMutation(
    (input: {
      sessionId: TableSessionId;
      sourceSessionId: TableSessionId;
      note?: string;
    }) =>
      api.mergeTableSessions(
        { sessionId: input.sessionId },
        { sourceSessionId: input.sourceSessionId, note: input.note },
      ),
  );
}

export function useMoveItems() {
  return useBoardMutation(
    (input: {
      sessionId: TableSessionId;
      toSessionId: TableSessionId;
      orderItemIds: string[];
    }) =>
      api.moveSessionItems(
        { sessionId: input.sessionId },
        {
          toSessionId: input.toSessionId,
          orderItemIds: input.orderItemIds,
        },
      ),
  );
}

export function useSplitBill() {
  return useBoardMutation(
    (input: { sessionId: TableSessionId; parts: number }) =>
      api.createSessionSplits(
        { sessionId: input.sessionId },
        {
          method: "equal",
          parts: input.parts,
          idempotencyKey: newIdempotencyKey(),
        },
      ),
  );
}

export function useIssueTableQr() {
  return useBoardMutation((tableId: string) => api.issueTableQr({ tableId }));
}

/** Manual refresh for the board header. */
export function useRefreshBoard() {
  return useInvalidate([getFloorBoard]);
}
