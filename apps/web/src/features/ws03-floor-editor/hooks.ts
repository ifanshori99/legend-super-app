// The only way components touch floor data: reads keep the endpoint key,
// mutations invalidate the floor snapshot they can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentFloor } from "@starter/shared/qr-order";
import * as api from "./api";
import { currentFloorQuery } from "./queries";

export function useCurrentFloor() {
  const query = useQuery(currentFloorQuery());
  // The contract answers `dataResponseSchema(floorBoardSchema)`; screens want
  // the board itself, so unwrap the envelope once here.
  return { ...query, data: query.data?.data };
}

function useFloorMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [getCurrentFloor.id] }),
  });
}

export type ZoneInput = Parameters<typeof api.createZone>[0];
export type ZonePatch = Parameters<typeof api.updateZone>[1];
export type TableInput = Parameters<typeof api.createTable>[0];
export type TablePatch = Parameters<typeof api.updateTable>[1];

export function useCreateZone() {
  return useFloorMutation(api.createZone);
}

export function useUpdateZone() {
  return useFloorMutation((input: { zoneId: string; body: ZonePatch }) =>
    api.updateZone({ zoneId: input.zoneId }, input.body),
  );
}

export function useDeleteZone() {
  return useFloorMutation((zoneId: string) => api.deleteZone({ zoneId }));
}

export function useCreateTable() {
  return useFloorMutation(api.createTable);
}

export function useUpdateTable() {
  return useFloorMutation((input: { tableId: string; body: TablePatch }) =>
    api.updateTable({ tableId: input.tableId }, input.body),
  );
}

export function useDeleteTable() {
  return useFloorMutation((tableId: string) => api.deleteTable({ tableId }));
}

/** Writes a whole drag session in one request and refreshes the snapshot. */
export function useSaveLayout() {
  return useFloorMutation(api.saveLayout);
}

/**
 * Issues (or reprints) the signed permanent QR of one table. The raw token is
 * returned once, so the result is kept in the caller's state, not the cache.
 */
export function useIssueTableQr() {
  return useMutation({
    mutationFn: (tableId: string) => api.issueTableQr({ tableId }),
  });
}
