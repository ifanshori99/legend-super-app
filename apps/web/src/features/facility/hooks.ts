// Hooks for the facility screens: components never call the API or useQuery
// directly (docs/frontend.md, "Custom hooks"). Mutations invalidate the keys
// they can change, so a new ticket also refreshes the queue and the quota.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import { facilityKeys } from "./queries";
import { cancelWhatsAppLogin, startWhatsAppLogin } from "./wa-login";
import {
  loginChallengeQuery,
  availabilityQuery,
  currentSubscriptionQuery,
  facilityCatalogQuery,
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
