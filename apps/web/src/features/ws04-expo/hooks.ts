import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OutletId } from "@starter/shared/core";
import type { ExpoRunner, ExpoTicket } from "@starter/shared/kitchen";
import { assignRunner, callPickup } from "./api.ts";
import {
  expoBoardQuery,
  expoKeys,
  expoRunnersQuery,
  pickupDisplayQuery,
  pickupKeys,
} from "./queries.ts";

// Hooks are the only way components touch this feature's data; they own the
// cache updates and invalidation (docs/frontend.md, "Custom hooks").

/** `outletId` undefined (no outlet selected): the query does not run. */
export function useExpoBoard(outletId: OutletId | undefined) {
  return useQuery(expoBoardQuery(outletId));
}

/** Runner names for the cards and the assignment dialog. */
export function useExpoRunners(
  outletId: OutletId | undefined,
  options?: { enabled?: boolean },
) {
  const query = expoRunnersQuery(outletId);
  return useQuery({
    ...query,
    enabled: query.enabled && (options?.enabled ?? true),
  });
}

export function useAssignRunner(outletId: OutletId | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      runnerId,
    }: {
      orderId: ExpoTicket["orderId"];
      runnerId: ExpoRunner["userId"];
    }) => {
      if (!outletId) return Promise.reject(new Error("No outlet selected"));
      return assignRunner(outletId, orderId, runnerId);
    },
    onSuccess: () =>
      // The board refetches on its own interval; refresh now so the card shows
      // the runner the moment the assignment is accepted.
      queryClient.invalidateQueries({ queryKey: expoKeys.board(outletId) }),
  });
}

export function usePickupDisplay(outletId: OutletId | undefined) {
  return useQuery(pickupDisplayQuery(outletId));
}

export function useCallPickup(outletId: OutletId | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) => {
      if (!outletId) return Promise.reject(new Error("No outlet selected"));
      return callPickup(outletId, callId);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pickupKeys.display(outletId) }),
  });
}
