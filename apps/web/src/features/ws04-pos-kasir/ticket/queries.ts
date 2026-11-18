// Query keys and options for the POS ticket sale. Every key carries the outlet:
// a cashier who switches outlet must never see another outlet's products.
import { queryOptions } from "@tanstack/react-query";
import {
  fetchOrderTickets,
  fetchTicketProducts,
  fetchTicketSlots,
  searchTicketCustomers,
} from "./api";

export const ticketKeys = {
  products: (outletId: string) =>
    ["pos-kasir", outletId, "ticket", "products"] as const,
  customers: (outletId: string, query: string) =>
    ["pos-kasir", outletId, "ticket", "customers", query] as const,
  slots: (outletId: string, facilityId: string, areaId: string) =>
    ["pos-kasir", outletId, "ticket", "slots", facilityId, areaId] as const,
  orderTickets: (outletId: string, orderId: string) =>
    ["pos-kasir", outletId, "ticket", "order", orderId] as const,
};

export function ticketProductsQuery(outletId: string) {
  return queryOptions({
    queryKey: ticketKeys.products(outletId),
    queryFn: ({ signal }) => fetchTicketProducts(signal),
    staleTime: 60_000,
  });
}

export function ticketCustomersQuery(outletId: string, query: string) {
  return queryOptions({
    queryKey: ticketKeys.customers(outletId, query),
    queryFn: ({ signal }) => searchTicketCustomers(query, signal),
    staleTime: 30_000,
  });
}

/** Live availability decides what can be sold: never served from a stale copy. */
export function ticketSlotsQuery(
  outletId: string,
  facilityId: string,
  areaId: string,
) {
  return queryOptions({
    queryKey: ticketKeys.slots(outletId, facilityId, areaId),
    queryFn: ({ signal }) => fetchTicketSlots({ facilityId, areaId }, signal),
    staleTime: 0,
  });
}

/**
 * The tickets of one bill. Only the ticket lines (status, slot, line total):
 * the door credential is never part of a query, it exists only in the
 * `useIssueTicketCredential` result. Payment moves a ticket to `issued`, so a
 * cached copy is never trusted.
 */
export function orderTicketsQuery(outletId: string, orderId: string) {
  return queryOptions({
    queryKey: ticketKeys.orderTickets(outletId, orderId),
    queryFn: ({ signal }) => fetchOrderTickets(orderId, signal),
    staleTime: 0,
  });
}
