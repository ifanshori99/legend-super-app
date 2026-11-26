// The data door of the order detail screen: components import these hooks and
// never touch the endpoints or the mock.
import { useMemo, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PosOrderStatus } from "@starter/shared/pos";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import { useActorId } from "@/features/ws04-pos-kasir/hooks";
import { openOrdersKeys } from "@/features/ws04-pos-open-orders/queries";
import { fireHeldItems, pendingFireOf } from "./api";
import { kitchenVoidsQuery, orderDetailKeys, orderQuery } from "./queries";

/** The outlet this screen works in; "" when none (queries stay idle). */
function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

function useReady(orderId: string): { outletId: string; enabled: boolean } {
  const outletId = useOutletId();
  return { outletId, enabled: (API_MOCK || outletId !== "") && orderId !== "" };
}

export function useOrderDetail(orderId: string) {
  const { outletId, enabled } = useReady(orderId);
  return useQuery({ ...orderQuery(outletId, orderId), enabled });
}

export function useKitchenVoids(orderId: string) {
  const { outletId, enabled } = useReady(orderId);
  return useQuery({ ...kitchenVoidsQuery(outletId, orderId), enabled });
}

// Sends on this screen and other tabs (the storage event) re-read the slot.
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function notify() {
  for (const listener of listeners) listener();
}

/**
 * The fire of this order whose answer is unknown (the key lives in
 * sessionStorage, so the server render has none), re-read after every send.
 */
export function usePendingFire(orderId: string) {
  const outletId = useOutletId();
  const actorId = useActorId();
  const text = useSyncExternalStore(
    subscribe,
    () => JSON.stringify(pendingFireOf(outletId, actorId, orderId)),
    () => "null",
  );
  const itemIds = useMemo(() => JSON.parse(text) as string[] | null, [text]);
  return { itemIds, refresh: notify };
}

/**
 * Send held items. On success the detail shows the server's order; the list
 * of open orders is read again (its held counts changed).
 */
export function useFireHeld(orderId: string, onSettled: () => void) {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useActorId();
  return useMutation({
    mutationFn: (input: {
      itemIds: readonly string[];
      status: PosOrderStatus;
    }) =>
      fireHeldItems(outletId, actorId, orderId, input.itemIds, input.status),
    onSuccess: (order) => {
      queryClient.setQueryData(orderDetailKeys.order(outletId, orderId), order);
      void queryClient.invalidateQueries({ queryKey: openOrdersKeys.all });
    },
    onError: () =>
      void queryClient.invalidateQueries({
        queryKey: orderDetailKeys.order(outletId, orderId),
      }),
    onSettled,
  });
}
