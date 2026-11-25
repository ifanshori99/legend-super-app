// Query keys and options for the ordering screens. Every key carries the
// outlet: a cashier or captain who switches outlet must never see another
// outlet's catalog, tables or calls from the cache.
import { queryOptions } from "@tanstack/react-query";
import {
  fetchCaptainTables,
  fetchCatalog,
  fetchNextCallNumber,
  fetchParkedDrafts,
  fetchReservationHold,
  fetchServiceCalls,
  fetchTableOrder,
} from "./api";

export const posOrderKeys = {
  all: ["pos-order"] as const,
  catalog: (outletId: string) => ["pos-order", outletId, "catalog"] as const,
  callNumber: (outletId: string) =>
    ["pos-order", outletId, "call-number"] as const,
  parked: (outletId: string) => ["pos-order", outletId, "parked"] as const,
  tables: (outletId: string) => ["pos-order", outletId, "tables"] as const,
  tableOrder: (outletId: string, tableId: string) =>
    ["pos-order", outletId, "table-order", tableId] as const,
  calls: (outletId: string) => ["pos-order", outletId, "calls"] as const,
  hold: (outletId: string, tableId: string, date: string) =>
    ["pos-order", outletId, "hold", tableId, date] as const,
};

/** The waiter inbox refreshes itself every 10 seconds. */
export const SERVICE_CALLS_POLL_MS = 10_000;

export function catalogQuery(outletId: string) {
  return queryOptions({
    queryKey: posOrderKeys.catalog(outletId),
    queryFn: () => fetchCatalog(outletId),
    retry: false,
  });
}

export function callNumberQuery(outletId: string) {
  return queryOptions({
    queryKey: posOrderKeys.callNumber(outletId),
    queryFn: () => fetchNextCallNumber(outletId),
    retry: false,
  });
}

export function parkedDraftsQuery(outletId: string) {
  return queryOptions({
    queryKey: posOrderKeys.parked(outletId),
    queryFn: () => fetchParkedDrafts(outletId),
    retry: false,
  });
}

export function captainTablesQuery(outletId: string) {
  return queryOptions({
    queryKey: posOrderKeys.tables(outletId),
    queryFn: () => fetchCaptainTables(outletId),
    retry: false,
  });
}

export function tableOrderQuery(outletId: string, tableId: string) {
  return queryOptions({
    queryKey: posOrderKeys.tableOrder(outletId, tableId),
    queryFn: () => fetchTableOrder(outletId, tableId),
    retry: false,
  });
}

export function serviceCallsQuery(outletId: string) {
  return queryOptions({
    queryKey: posOrderKeys.calls(outletId),
    queryFn: () => fetchServiceCalls(outletId),
    refetchInterval: SERVICE_CALLS_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** A reservation holding the table, read when the captain is about to seat. */
export function reservationHoldQuery(
  outletId: string,
  tableId: string,
  date: string,
) {
  return queryOptions({
    queryKey: posOrderKeys.hold(outletId, tableId, date),
    queryFn: () => fetchReservationHold(outletId, tableId, date),
    retry: false,
    staleTime: 0,
  });
}
