// The data door of the order detail screen: components import these hooks and
// never touch the endpoints or the mock.
import { useCallback, useEffect, useState } from "react";
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

/**
 * The fire of this order whose answer is unknown, read after hydration (the
 * key lives in sessionStorage) and again after every send.
 */
export function usePendingFire(orderId: string) {
  const outletId = useOutletId();
  const actorId = useActorId();
  const [itemIds, setItemIds] = useState<string[] | null>(null);
  const refresh = useCallback(
    () => setItemIds(pendingFireOf(outletId, actorId, orderId)),
    [outletId, actorId, orderId],
  );
  useEffect(refresh, [refresh]);
  return { itemIds, refresh };
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
