// Query keys and queryOptions for the facility screens. Hierarchical keys keep
// invalidation precise: a new ticket refreshes the lists, a subscription action
// refreshes only the subscription data.
import { queryOptions } from "@tanstack/react-query";
import * as api from "./api";
import { fetchLoginChallenge } from "./wa-login";

export const facilityKeys = {
  all: ["facility"] as const,
  availability: (facilityId: string, date: string) =>
    [...facilityKeys.all, "availability", facilityId, date] as const,
  catalog: (facilityId: string) =>
    [...facilityKeys.all, "catalog", facilityId] as const,
  entry: (facilityId: string) =>
    [...facilityKeys.all, "entry", facilityId] as const,
  queue: (facilityId: string) =>
    [...facilityKeys.all, "queue", facilityId] as const,
  tickets: () => [...facilityKeys.all, "tickets"] as const,
  ticket: (ticketId: string) =>
    [...facilityKeys.all, "ticket", ticketId] as const,
  breakfast: (ticketId: string) =>
    [...facilityKeys.all, "breakfast", ticketId] as const,
  subscription: () => [...facilityKeys.all, "subscription"] as const,
  plans: (facilityId: string) =>
    [...facilityKeys.all, "plans", facilityId] as const,
  loginChallenge: (challengeId: string) =>
    [...facilityKeys.all, "login-challenge", challengeId] as const,
};

/** Interval at which this browser polls its WhatsApp challenge (AUTH-01). */
export const LOGIN_POLL_MS = 2_000;

/**
 * GET /api/auth/login-challenges/:id — polled while the guest sends the
 * message; polling stops once the challenge leaves `pending`.
 */
export function loginChallengeQuery(challengeId: string) {
  return queryOptions({
    queryKey: facilityKeys.loginChallenge(challengeId),
    queryFn: ({ signal }) => fetchLoginChallenge(challengeId, signal),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.challenge.status === "pending" ? LOGIN_POLL_MS : false,
  });
}

/** GET /api/facility/availability — live data, so never served from stale cache. */
export function availabilityQuery(facilityId: string, date: string) {
  return queryOptions({
    queryKey: facilityKeys.availability(facilityId, date),
    queryFn: ({ signal }) =>
      api.fetchAvailability({ facilityId, date }, signal),
    // Availability decides whether a slot can be sold; a stale copy would
    // offer an occupied unit (FAC-02).
    staleTime: 0,
  });
}

/** Products, add-ons and plans of one facility (see api.ts on the gap). */
export function facilityCatalogQuery(facilityId: string) {
  return queryOptions({
    queryKey: facilityKeys.catalog(facilityId),
    queryFn: ({ signal }) => api.fetchFacilityCatalog(facilityId, signal),
    staleTime: 5 * 60_000,
  });
}

export function facilityEntryQuery(facilityId: string) {
  return queryOptions({
    queryKey: facilityKeys.entry(facilityId),
    queryFn: ({ signal }) => api.fetchFacilityEntry(facilityId, signal),
    staleTime: 5 * 60_000,
  });
}

export function queueEntryQuery(facilityId: string) {
  return queryOptions({
    queryKey: facilityKeys.queue(facilityId),
    queryFn: ({ signal }) => api.fetchQueueEntry(facilityId, signal),
  });
}

export function ticketQuery(ticketId: string) {
  return queryOptions({
    queryKey: facilityKeys.ticket(ticketId),
    queryFn: ({ signal }) => api.fetchTicket(ticketId, signal),
    // The session timer needs a fresh server clock when the tab returns.
    staleTime: 0,
  });
}

export function ticketsQuery(limit = 20) {
  return queryOptions({
    queryKey: [...facilityKeys.tickets(), { limit }] as const,
    queryFn: ({ signal }) => api.fetchTickets({ limit }, signal),
  });
}

export function currentSubscriptionQuery() {
  return queryOptions({
    queryKey: facilityKeys.subscription(),
    queryFn: ({ signal }) => api.fetchCurrentSubscription(signal),
  });
}

export function subscriptionPlansQuery(facilityId: string) {
  return queryOptions({
    queryKey: facilityKeys.plans(facilityId),
    queryFn: ({ signal }) => api.fetchSubscriptionPlans(facilityId, signal),
  });
}

/** Breakfast menu of one ticket; the order must be fresh, so never stale. */
export function breakfastMenuQuery(ticketId: string) {
  return queryOptions({
    queryKey: facilityKeys.breakfast(ticketId),
    queryFn: ({ signal }) => api.fetchBreakfastMenu(ticketId, signal),
    staleTime: 0,
  });
}
