// Query keys and options for the delivery channel ops screen. Keys are
// `[endpoint.id, input]` (docs/frontend.md), so invalidating `[endpoint.id]`
// refreshes every view of that resource.
import { queryOptions } from "@tanstack/react-query";
import { listExampleOutlets } from "@starter/shared/api";
import {
  getDeliveryOrder,
  getDeliveryReconciliation,
  listDeliveryChannels,
} from "@starter/shared/delivery";
import type {
  DeliveryPlatform,
  DeliveryReconciliationQuery,
} from "@starter/shared/delivery";
import {
  listItems,
  listPriceListItems,
  listPriceLists,
} from "@starter/shared/menu";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";

/**
 * The board is live: platform orders arrive without a page reload, so poll
 * slowly enough to stay quiet and fast enough to trust (Alur G step 1).
 */
export const DELIVERY_REFETCH_MS = 30_000;

const MENU_QUERY = {
  limit: api.DELIVERY_LIST_LIMIT,
  status: "active",
} as const;

export const outletsQuery = () =>
  queryOptions({
    queryKey: endpointQueryKey(listExampleOutlets, { query: { limit: 20 } }),
    queryFn: ({ signal }) => api.fetchOutlets({ signal }),
    // One quick retry, then the error state with its own "Coba lagi" button.
    retry: 1,
  });

export const channelsQuery = (outletId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(listDeliveryChannels, {
      params: { outletId },
    }),
    queryFn: ({ signal }) => api.fetchChannels({ outletId }, { signal }),
    refetchInterval: DELIVERY_REFETCH_MS,
    staleTime: DELIVERY_REFETCH_MS / 3,
    retry: 1,
  });

export const orderQuery = (outletId: string, deliveryOrderId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getDeliveryOrder, {
      params: { outletId, deliveryOrderId },
    }),
    queryFn: ({ signal }) =>
      api.fetchOrder({ outletId, deliveryOrderId }, { signal }),
    retry: 1,
  });

export const reconciliationQuery = (
  outletId: string,
  query: DeliveryReconciliationQuery,
) =>
  queryOptions({
    queryKey: endpointQueryKey(getDeliveryReconciliation, {
      params: { outletId },
      query,
    }),
    queryFn: ({ signal }) =>
      api.fetchReconciliation({ outletId }, query, { signal }),
    retry: 1,
  });

/** Menu picks for the D12 manual form (WS-03 read model). */
export const menuItemsQuery = () =>
  queryOptions({
    queryKey: endpointQueryKey(listItems, { query: MENU_QUERY }),
    queryFn: ({ signal }) => api.fetchMenuItems(MENU_QUERY, { signal }),
    staleTime: DELIVERY_REFETCH_MS,
    retry: 1,
  });

/** Channel price list of one platform (WS-03 price list per channel). */
export const priceListsQuery = (outletId: string, platform: DeliveryPlatform) =>
  queryOptions({
    queryKey: endpointQueryKey(listPriceLists, {
      query: { outletId, channel: platform, limit: 10 },
    }),
    queryFn: ({ signal }) =>
      api.fetchPriceLists(
        { outletId, channel: platform, limit: 10 },
        { signal },
      ),
    retry: 1,
  });

export const priceListItemsQuery = (priceListId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(listPriceListItems, {
      params: { priceListId },
      query: { limit: api.DELIVERY_LIST_LIMIT },
    }),
    queryFn: ({ signal }) =>
      api.fetchPriceListItems({ priceListId }, { signal }),
    retry: 1,
  });
