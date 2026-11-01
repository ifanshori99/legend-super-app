import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export function useExpoBoard() {
  return useQuery(expoBoardQuery());
}

/** Runner names for the cards and the assignment dialog. */
export function useExpoRunners(options?: { enabled?: boolean }) {
  return useQuery({ ...expoRunnersQuery(), enabled: options?.enabled ?? true });
}

export function useAssignRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      runnerId,
    }: {
      orderId: ExpoTicket["orderId"];
      runnerId: ExpoRunner["userId"];
    }) => assignRunner(orderId, runnerId),
    onSuccess: () =>
      // The board refetches on its own interval; refresh now so the card shows
      // the runner the moment the assignment is accepted.
      queryClient.invalidateQueries({ queryKey: expoKeys.board() }),
  });
}

export function usePickupDisplay() {
  return useQuery(pickupDisplayQuery());
}

export function useCallPickup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) => callPickup(callId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pickupKeys.display() }),
  });
}
