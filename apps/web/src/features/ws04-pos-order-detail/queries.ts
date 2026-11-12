// Query keys and options of the order detail screen. Every key carries the
// outlet: a cashier who switches outlet must never read another outlet's order
// from the cache. The kitchen notices poll, because the kitchen voids while the
// cashier has the order open.
import { queryOptions } from "@tanstack/react-query";
import { fetchKitchenVoids, fetchOrder } from "./api";

export const orderDetailKeys = {
  all: ["pos-order-detail"] as const,
  order: (outletId: string, orderId: string) =>
    ["pos-order-detail", outletId, "order", orderId] as const,
  kitchenVoids: (outletId: string, orderId: string) =>
    ["pos-order-detail", outletId, "kitchen-voids", orderId] as const,
};

export const KITCHEN_NOTICE_POLL_MS = 15_000;

export const orderQuery = (outletId: string, orderId: string) =>
  queryOptions({
    queryKey: orderDetailKeys.order(outletId, orderId),
    queryFn: ({ signal }) => fetchOrder(outletId, orderId, signal),
    retry: false,
  });

export const kitchenVoidsQuery = (outletId: string, orderId: string) =>
  queryOptions({
    queryKey: orderDetailKeys.kitchenVoids(outletId, orderId),
    queryFn: ({ signal }) => fetchKitchenVoids(outletId, orderId, signal),
    refetchInterval: KITCHEN_NOTICE_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
