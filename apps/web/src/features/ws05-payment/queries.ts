// Query keys and options for the payment link and its intent. The intent
// query polls only while the intent is pending: a paid, expired or failed
// status is final for this screen (PAY-02).
import { queryOptions } from "@tanstack/react-query";
import { getPaymentIntent, getPaymentLink } from "@starter/shared/payment";
import { endpointQueryKey } from "@/lib/api/endpoint";
import { fetchPaymentIntent, fetchPaymentLink } from "./api";
import { INTENT_POLL_MS, shouldPoll } from "./status";

/** Cache key of the link view, for invalidation after a mutation. */
export const paymentLinkKey = (token: string) =>
  endpointQueryKey(getPaymentLink, { params: { token } });

export const paymentIntentKey = (token: string, intentId: string) =>
  endpointQueryKey(getPaymentIntent, { params: { token, intentId } });

export function paymentLinkQuery(token: string) {
  return queryOptions({
    queryKey: paymentLinkKey(token),
    queryFn: ({ signal }) => fetchPaymentLink(token, signal),
    // A payment screen shows its error state quickly; the guest retries by hand.
    retry: 1,
    retryDelay: 600,
  });
}

export function paymentIntentQuery(token: string, intentId: string) {
  return queryOptions({
    queryKey: paymentIntentKey(token, intentId),
    queryFn: ({ signal }) => fetchPaymentIntent(token, intentId, signal),
    refetchInterval: (query) =>
      shouldPoll(query.state.data?.status) ? INTENT_POLL_MS : false,
    refetchIntervalInBackground: false,
    // The next poll is the retry; do not stack three retries on top of it.
    retry: false,
  });
}
