// The only way components touch delivery data: queries keep their endpoint
// keys, every write invalidates the channels or the order lists it can change.
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  getDeliveryOrder,
  listDeliveryChannels,
  listDeliveryOrders,
} from "@starter/shared/delivery";
import type {
  CreateManualDeliveryOrderInput,
  DeliveryOrderStatus,
  DeliveryPlatform,
  DeliveryReconciliationQuery,
  MapDeliveryOrderLinesInput,
  ResolveDeliveryOrderSyncInput,
  SetDeliveryChannelStateInput,
  UpdateDeliveryOrderStatusInput,
} from "@starter/shared/delivery";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";
import { DELIVERY_ORDER_PAGE_SIZE } from "./lib";
import {
  DELIVERY_REFETCH_MS,
  channelsQuery,
  itemVariantsQuery,
  menuItemsQuery,
  orderQuery,
  priceListItemsQuery,
  priceListsQuery,
  reconciliationQuery,
} from "./queries";

export type DeliveryOrderFilters = {
  platform?: DeliveryPlatform;
  status?: DeliveryOrderStatus;
};

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

/** Channel writes change the board only; order writes touch both lists. */
const CHANNEL_WRITES = [listDeliveryChannels] as const;
const ORDER_WRITES = [listDeliveryOrders, getDeliveryOrder] as const;

export function useChannels(outletId: string | undefined) {
  return useQuery({
    ...channelsQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

/**
 * Incoming orders, newest first, as an infinite cursor list. Filters are part
 * of the key, so switching the status or platform starts a clean page chain.
 */
export function useDeliveryOrders(
  outletId: string | undefined,
  filters: DeliveryOrderFilters,
) {
  const query = { ...filters, limit: DELIVERY_ORDER_PAGE_SIZE };
  return useInfiniteQuery({
    queryKey: endpointQueryKey(listDeliveryOrders, {
      params: { outletId: outletId ?? "" },
      query,
    }),
    queryFn: ({ signal, pageParam }) =>
      api.fetchOrders(
        { outletId: outletId ?? "" },
        pageParam === undefined ? query : { ...query, cursor: pageParam },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.meta.nextCursor ?? undefined,
    enabled: Boolean(outletId),
    refetchInterval: DELIVERY_REFETCH_MS,
    staleTime: DELIVERY_REFETCH_MS / 3,
    retry: 1,
  });
}

export function useDeliveryOrder(
  outletId: string | undefined,
  deliveryOrderId: string | null,
) {
  return useQuery({
    ...orderQuery(outletId ?? "", deliveryOrderId ?? ""),
    enabled: Boolean(outletId && deliveryOrderId),
  });
}

export function useReconciliation(
  outletId: string | undefined,
  query: DeliveryReconciliationQuery,
  enabled = true,
) {
  return useQuery({
    ...reconciliationQuery(outletId ?? "", query),
    enabled: Boolean(outletId) && enabled,
  });
}

export function useMenuItems(enabled = true) {
  return useQuery({ ...menuItemsQuery(), enabled });
}

/**
 * Variants of each picked menu item, in the same order as `itemIds`; a `null`
 * entry (nothing picked yet) stays idle.
 */
export function useItemVariantsFor(itemIds: readonly (string | null)[]) {
  return useQueries({
    queries: itemIds.map((itemId) => ({
      ...itemVariantsQuery(itemId ?? ""),
      enabled: itemId !== null,
    })),
  });
}

/**
 * Channel prices of one platform for the manual form: the latest price list of
 * that channel and its item prices. A platform without a price list leaves the
 * map empty; the form then says so instead of inventing one.
 */
export function useChannelPrices(
  outletId: string | undefined,
  platform: DeliveryPlatform,
  enabled = true,
) {
  const lists = useQuery({
    ...priceListsQuery(outletId ?? "", platform),
    enabled: Boolean(outletId) && enabled,
  });
  const priceList = [...(lists.data?.data ?? [])].sort((left, right) =>
    right.effectiveFrom.localeCompare(left.effectiveFrom),
  )[0];
  const priceListId = priceList?.id;
  const items = useQuery({
    ...priceListItemsQuery(priceListId ?? ""),
    enabled: Boolean(priceListId) && enabled,
  });
  const prices = new Map<string, number>();
  for (const row of items.data?.data ?? [])
    prices.set(row.itemId, row.priceIdr);
  return {
    prices,
    hasPriceList: Boolean(priceListId),
    isPending: lists.isPending || (Boolean(priceListId) && items.isPending),
  };
}

export function useSetChannelState() {
  const refresh = useInvalidate(CHANNEL_WRITES);
  return useMutation({
    mutationFn: (input: {
      outletId: string;
      platform: DeliveryPlatform;
      body: SetDeliveryChannelStateInput;
    }) =>
      api.setChannelState(
        { outletId: input.outletId, platform: input.platform },
        input.body,
      ),
    onSettled: () => refresh(),
  });
}

export function useSyncChannelMenu() {
  const refresh = useInvalidate(CHANNEL_WRITES);
  return useMutation({
    mutationFn: (input: { outletId: string; platform: DeliveryPlatform }) =>
      api.syncChannelMenu({
        outletId: input.outletId,
        platform: input.platform,
      }),
    onSettled: () => refresh(),
  });
}

export function useUpdateOrderStatus() {
  const refresh = useInvalidate(ORDER_WRITES);
  return useMutation({
    mutationFn: (input: {
      outletId: string;
      deliveryOrderId: string;
      body: UpdateDeliveryOrderStatusInput;
    }) =>
      api.updateOrderStatus(
        {
          outletId: input.outletId,
          deliveryOrderId: input.deliveryOrderId,
        },
        input.body,
      ),
    onSettled: () => refresh(),
  });
}

/** Q58: staff resend of a needs_action order. Resolves with the new order. */
export function useResendOrderSync() {
  const refresh = useInvalidate(ORDER_WRITES);
  return useMutation({
    mutationFn: (input: { outletId: string; deliveryOrderId: string }) =>
      api.resendOrderSync({
        outletId: input.outletId,
        deliveryOrderId: input.deliveryOrderId,
      }),
    onSettled: () => refresh(),
  });
}

/** Q58: staff marks a needs_action order as handled in the partner app. */
export function useResolveOrderSync() {
  const refresh = useInvalidate(ORDER_WRITES);
  return useMutation({
    mutationFn: (input: {
      outletId: string;
      deliveryOrderId: string;
      body: ResolveDeliveryOrderSyncInput;
    }) =>
      api.resolveOrderSync(
        {
          outletId: input.outletId,
          deliveryOrderId: input.deliveryOrderId,
        },
        input.body,
      ),
    onSettled: () => refresh(),
  });
}

/** legend-5d76: staff map the unmatched lines of a needs_review order. */
export function useMapOrderLines() {
  const refresh = useInvalidate(ORDER_WRITES);
  return useMutation({
    mutationFn: (input: {
      outletId: string;
      deliveryOrderId: string;
      body: MapDeliveryOrderLinesInput;
    }) =>
      api.mapOrderLines(
        {
          outletId: input.outletId,
          deliveryOrderId: input.deliveryOrderId,
        },
        input.body,
      ),
    onSettled: () => refresh(),
  });
}

/** D12: the cashier records the platform order; the server prices it. */
export function useCreateManualOrder() {
  const refresh = useInvalidate(ORDER_WRITES);
  return useMutation({
    mutationFn: (input: {
      outletId: string;
      body: CreateManualDeliveryOrderInput;
    }) => api.createManualOrder({ outletId: input.outletId }, input.body),
    onSettled: () => refresh(),
  });
}
