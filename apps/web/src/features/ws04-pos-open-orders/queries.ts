// Query keys and options of the open orders list. Every key carries the outlet,
// so a cashier who switches outlet never reads another outlet's list from the
// cache. The list polls: captains and other tills add and pay orders too.
import { queryOptions } from "@tanstack/react-query";
import { fetchOpenOrders, fetchParkedOrders } from "./api";

export const openOrdersKeys = {
  all: ["pos-open-orders"] as const,
  orders: (outletId: string) =>
    ["pos-open-orders", outletId, "orders"] as const,
  parked: (outletId: string) =>
    ["pos-open-orders", outletId, "parked"] as const,
};

export const OPEN_ORDERS_POLL_MS = 20_000;

export const openOrdersQuery = (outletId: string) =>
  queryOptions({
    queryKey: openOrdersKeys.orders(outletId),
    queryFn: ({ signal }) => fetchOpenOrders(outletId, signal),
    refetchInterval: OPEN_ORDERS_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });

export const parkedOrdersQuery = (outletId: string) =>
  queryOptions({
    queryKey: openOrdersKeys.parked(outletId),
    queryFn: ({ signal }) => fetchParkedOrders(outletId, signal),
    refetchInterval: OPEN_ORDERS_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
