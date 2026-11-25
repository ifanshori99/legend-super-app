// Hooks for the facility screens: components never call the API or useQuery
// directly (docs/frontend.md, "Custom hooks"). Mutations invalidate the keys
// they can change, so a new ticket also refreshes the queue and the quota.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/errors.ts";
import * as api from "./api";
import { facilityKeys } from "./queries";
import { cancelWhatsAppLogin, startWhatsAppLogin } from "./wa-login";
import {
  isFacilityTypeReleased,
  type CreateBreakfastOrderBody,
} from "@starter/shared/facility";
import {
  breakfastMenuQuery,
  loginChallengeQuery,
  availabilityQuery,
  currentSubscriptionQuery,
  facilityCatalogQuery,
  facilityEntryQuery,
  queueEntryQuery,
  subscriptionPlansQuery,
  ticketQuery,
  ticketsQuery,
} from "./queries";

export function useAvailability(facilityId: string, date: string) {
  return useQuery(availabilityQuery(facilityId, date));
}

export function useFacilityCatalog(facilityId: string) {
  return useQuery(facilityCatalogQuery(facilityId));
}

/**
 * Whether this facility takes bookings (1269 F0): a deferred shower does not.
 * `closed` is only true once known, so an offline read never hides a facility
 * on its booking page; `open` is only true once known, for links to that page.
 */
export function useFacilityOpen(facilityId: string | null) {
  const entry = useQuery({
    ...facilityEntryQuery(facilityId ?? ""),
    enabled: facilityId !== null,
  });
  const released =
    entry.data && isFacilityTypeReleased(entry.data.facility.type);
  return {
    open: released === true,
    closed:
      released === false ||
      (entry.error instanceof ApiError &&
        entry.error.code === "FACILITY_SHOWER_DISABLED"),
  };
}

export function useQueueEntry(facilityId: string) {
  return useQuery(queueEntryQuery(facilityId));
}

export function useJoinQueue(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.JoinQueueBody) => api.joinQueue(body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: facilityKeys.queue(facilityId),
        }),
        queryClient.invalidateQueries({
          queryKey: ["facility", "availability"],
        }),
      ]),
  });
}

export function useLeaveQueue(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) => api.leaveQueue(entryId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: facilityKeys.queue(facilityId),
      }),
  });
}

export function useBookTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.BookTicketBody) => api.bookTicket(body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: facilityKeys.tickets() }),
        queryClient.invalidateQueries({
          queryKey: facilityKeys.subscription(),
        }),
        queryClient.invalidateQueries({
          queryKey: ["facility", "availability"],
        }),
      ]),
  });
}

export function useTickets(limit = 20) {
  return useQuery(ticketsQuery(limit));
}

export function useTicket(ticketId: string) {
  return useQuery(ticketQuery(ticketId));
}

export function useCancelTicket(ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => api.cancelTicket(ticketId, { reason }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: facilityKeys.ticket(ticketId),
        }),
        queryClient.invalidateQueries({ queryKey: facilityKeys.tickets() }),
      ]),
  });
}

export function useCurrentSubscription() {
  return useQuery(currentSubscriptionQuery());
}

export function useSubscriptionPlans(facilityId: string | null) {
  return useQuery({
    ...subscriptionPlansQuery(facilityId ?? ""),
    enabled: Boolean(facilityId),
  });
}

export function useStartSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.StartSubscriptionBody) =>
      api.startSubscription(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: facilityKeys.subscription() }),
  });
}

export function useUpdateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      subscriptionId: string;
      body: api.UpdateSubscriptionBody;
    }) => api.updateSubscription(input.subscriptionId, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: facilityKeys.subscription() }),
  });
}

/** Creates the WhatsApp challenge (code + deep link, shown once). */
export function useStartWhatsAppLogin() {
  return useMutation({
    mutationFn: (returnTo?: string) => startWhatsAppLogin(returnTo),
  });
}

export function useLoginChallenge(challengeId: string | null) {
  return useQuery({
    ...loginChallengeQuery(challengeId ?? ""),
    enabled: challengeId !== null,
  });
}

/** "Bukan saya / batal": cancels the challenge from this browser. */
export function useCancelWhatsAppLogin() {
  return useMutation({
    mutationFn: (challengeId: string) => cancelWhatsAppLogin(challengeId),
  });
}

export function useBreakfastMenu(ticketId: string, enabled = true) {
  return useQuery({ ...breakfastMenuQuery(ticketId), enabled });
}

export function useOrderBreakfast(ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBreakfastOrderBody) =>
      api.orderBreakfast(ticketId, body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: facilityKeys.breakfast(ticketId),
      }),
    // 409: the ticket already has an order (another tab). Refetch so the held
    // order shows instead of the form with an error.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409)
        return queryClient.invalidateQueries({
          queryKey: facilityKeys.breakfast(ticketId),
        });
    },
  });
}

/** Resolves with the payment link token; the screen then opens `/bayar/$token`. */
export function usePayBreakfast(ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      idempotencyKey,
    }: {
      orderId: string;
      idempotencyKey: string;
    }) => api.payBreakfast(ticketId, orderId, { idempotencyKey }),
    // The order may already be paid or cancelled elsewhere: refetch either way.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: facilityKeys.breakfast(ticketId),
      }),
  });
}

export function useCancelBreakfast(ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      idempotencyKey,
    }: {
      orderId: string;
      idempotencyKey: string;
    }) => api.cancelBreakfast(ticketId, orderId, { idempotencyKey }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: facilityKeys.breakfast(ticketId),
      }),
  });
}
