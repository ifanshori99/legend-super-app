// Typed calls for the facility endpoints the customer screens use (WS-09,
// PRD §3 F22/F23). Every function goes through the shared contract object, so
// mock mode and the future API validate the same shapes (docs/frontend.md
// "Typed endpoints and mock mode"), and returns the `data` payload — the
// envelope is a wire detail the screens should not repeat.
import {
  bookAccessTicket,
  cancelAccessTicket,
  cancelBreakfastOrder,
  createBreakfastOrder,
  getBreakfastMenu,
  payBreakfastOrder,
  type CancelBreakfastOrderBody,
  type CreateBreakfastOrderBody,
  type PayBreakfastOrderBody,
  getAccessTicket,
  getCurrentFacilityQueueEntry,
  getCurrentFacilitySubscription,
  getFacilityAvailability,
  getFacilityConfig,
  joinFacilityQueue,
  leaveFacilityQueue,
  resolveFacilityEntry,
  listAccessTickets,
  listSubscriptionPlans,
  startFacilitySubscription,
  updateFacilitySubscription,
} from "@starter/shared/facility";
import type { EndpointInput } from "@starter/shared/api";
import { callEndpoint } from "@/lib/api/endpoint.ts";

/** Request bodies exactly as the contract accepts them (branded ids parsed). */
export type BookTicketBody = EndpointInput<typeof bookAccessTicket>["body"];
export type CancelTicketBody = EndpointInput<typeof cancelAccessTicket>["body"];
export type JoinQueueBody = EndpointInput<typeof joinFacilityQueue>["body"];
export type StartSubscriptionBody = EndpointInput<
  typeof startFacilitySubscription
>["body"];
export type UpdateSubscriptionBody = EndpointInput<
  typeof updateFacilitySubscription
>["body"];

export async function fetchAvailability(
  input: { facilityId: string; date: string; areaId?: string },
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getFacilityAvailability,
    { query: input },
    { signal },
  );
  return response.data;
}

/**
 * The facility catalog (products, add-ons, plans) still lives on the admin
 * config endpoint: the contract has no customer-facing catalog read yet
 * (follow-up bead). Mock mode serves it; the real API will authorize it for
 * staff only until that endpoint exists.
 */
export async function fetchFacilityCatalog(
  facilityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getFacilityConfig,
    { query: { facilityId } },
    { signal },
  );
  return response.data;
}

/** Public door-QR lookup: the facility and its type (shower closed: 403). */
export async function fetchFacilityEntry(
  facilityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    resolveFacilityEntry,
    { params: { token: facilityId } },
    { signal },
  );
  return response.data;
}

export async function bookTicket(body: BookTicketBody) {
  const response = await callEndpoint(bookAccessTicket, { body });
  return response.data;
}

export async function fetchTickets(
  input: { limit: number; cursor?: string },
  signal?: AbortSignal,
) {
  return callEndpoint(listAccessTickets, { query: input }, { signal });
}

export async function fetchTicket(ticketId: string, signal?: AbortSignal) {
  const response = await callEndpoint(
    getAccessTicket,
    { params: { ticketId } },
    { signal },
  );
  return response.data;
}

export async function cancelTicket(ticketId: string, body: CancelTicketBody) {
  const response = await callEndpoint(cancelAccessTicket, {
    params: { ticketId },
    body,
  });
  return response.data;
}

export async function fetchQueueEntry(
  facilityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getCurrentFacilityQueueEntry,
    { query: { facilityId } },
    { signal },
  );
  return response.data;
}

export async function joinQueue(body: JoinQueueBody) {
  const response = await callEndpoint(joinFacilityQueue, { body });
  return response.data;
}

export async function leaveQueue(entryId: string) {
  await callEndpoint(leaveFacilityQueue, { params: { entryId } });
}

export async function fetchSubscriptionPlans(
  facilityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listSubscriptionPlans,
    { query: { facilityId } },
    { signal },
  );
  return response.data.plans;
}

export async function fetchCurrentSubscription(signal?: AbortSignal) {
  const response = await callEndpoint(
    getCurrentFacilitySubscription,
    {},
    { signal },
  );
  return response.data;
}

export async function startSubscription(body: StartSubscriptionBody) {
  const response = await callEndpoint(startFacilitySubscription, { body });
  return response.data;
}

export async function updateSubscription(
  subscriptionId: string,
  body: UpdateSubscriptionBody,
) {
  const response = await callEndpoint(updateFacilitySubscription, {
    params: { subscriptionId },
    body,
  });
  return response.data;
}

/** Breakfast menu, tables and the ticket's existing order (`@starter/shared/facility` breakfast contract). */
export async function fetchBreakfastMenu(
  ticketId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getBreakfastMenu,
    { params: { ticketId } },
    { signal },
  );
  return response.data;
}

export async function orderBreakfast(
  ticketId: string,
  body: CreateBreakfastOrderBody,
) {
  const response = await callEndpoint(createBreakfastOrder, {
    params: { ticketId },
    body,
  });
  return response.data;
}

/** Starts (or reuses) the payment link of an unpaid breakfast order. */
export async function payBreakfast(
  ticketId: string,
  orderId: string,
  body: PayBreakfastOrderBody,
) {
  const response = await callEndpoint(payBreakfastOrder, {
    params: { ticketId, orderId },
    body,
  });
  return response.data;
}

export async function cancelBreakfast(
  ticketId: string,
  orderId: string,
  body: CancelBreakfastOrderBody,
) {
  const response = await callEndpoint(cancelBreakfastOrder, {
    params: { ticketId, orderId },
    body,
  });
  return response.data;
}
