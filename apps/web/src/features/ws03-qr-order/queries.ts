// Query keys and queryOptions. Endpoint ids are the hierarchy root, so
// invalidateQueries({ queryKey: [endpoint.id] }) refreshes one resource.
import { queryOptions } from "@tanstack/react-query";
import type { GuestPaymentOptionsQuery } from "@starter/shared/qr-order";
import { endpointQueryOptions, endpointQueryKey } from "@/lib/api/endpoint";
import {
  billEndpoint,
  menuEndpoint,
  orderEtasEndpoint,
  orderIssuesEndpoint,
  paymentEndpoint,
  paymentOptionsEndpoint,
  pointClaimEndpoint,
  requestQuote,
  reviewEligibilityEndpoint,
  sessionEndpoint,
  suggestionsEndpoint,
} from "./api";

/** Shared cart polling: every guest sees the others' changes within seconds. */
export const SESSION_POLL_MS = 4000;
const STATUS_POLL_MS = 5000;

export const menuQuery = (qrToken: string) =>
  queryOptions({
    ...endpointQueryOptions(menuEndpoint, { params: { qrToken } }),
    // The menu is refreshed when the guest returns (sold-out changes, PRD 86).
    staleTime: 60_000,
  });

export const sessionViewQuery = (sessionId: string) =>
  queryOptions({
    ...endpointQueryOptions(sessionEndpoint, { params: { sessionId } }),
    refetchInterval: SESSION_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 1000,
  });

export const suggestionsQuery = (sessionId: string, menuItemId?: string) =>
  endpointQueryOptions(suggestionsEndpoint, {
    params: { sessionId },
    query: menuItemId ? { menuItemId } : {},
  });

export type QuoteCodes = { promoCode?: string; voucherCode?: string };

export const quoteQuery = (
  sessionId: string,
  cartVersion: number,
  codes: QuoteCodes,
) =>
  queryOptions({
    queryKey: ["qr-quote", sessionId, cartVersion, codes] as const,
    queryFn: () => requestQuote(sessionId, codes),
    // A rejected code is shown beside the field, not retried.
    retry: false,
  });

export const orderEtasQuery = (sessionId: string) =>
  queryOptions({
    ...endpointQueryOptions(orderEtasEndpoint, { params: { sessionId } }),
    refetchInterval: 10_000,
  });

export const billQuery = (sessionId: string) =>
  queryOptions({
    ...endpointQueryOptions(billEndpoint, { params: { sessionId } }),
    refetchInterval: STATUS_POLL_MS,
  });

export const reviewEligibilityQuery = (sessionId: string) =>
  endpointQueryOptions(reviewEligibilityEndpoint, { params: { sessionId } });

export const orderIssuesQuery = (sessionId: string) =>
  queryOptions({
    ...endpointQueryOptions(orderIssuesEndpoint, { params: { sessionId } }),
    // ORD-08: the guest hears about a failed item within a minute.
    refetchInterval: 15_000,
  });

export const pointClaimQuery = (sessionId: string) =>
  endpointQueryOptions(pointClaimEndpoint, {
    params: { sessionId },
    query: {},
  });

/** Polls until the gateway confirms (ORD-02: only a verified webhook marks paid). */
export const paymentQuery = (sessionId: string, paymentId: string) =>
  queryOptions({
    ...endpointQueryOptions(paymentEndpoint, {
      params: { sessionId, paymentId },
    }),
    // Keeps asking while no answer arrived yet (a failed first poll too).
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return 2000;
      return data.data.status === "pending" ? 2000 : false;
    },
  });

/** Online methods the guest may use now; the VA bank list comes from the provider. */
export const paymentOptionsQuery = (
  sessionId: string,
  target: GuestPaymentOptionsQuery = {},
) =>
  queryOptions({
    ...endpointQueryOptions(paymentOptionsEndpoint, {
      params: { sessionId },
      // 1272 K1/K3: the same order or split part the create call names, so
      // each bank carries its service fee; no target, no fees.
      query: target,
    }),
    // A priced list follows the bill, so it goes stale sooner.
    staleTime: Object.keys(target).length > 0 ? 10_000 : 60_000,
  });

export const sessionKey = (sessionId: string) =>
  endpointQueryKey(sessionEndpoint, { params: { sessionId } });
export const sessionEndpointId = sessionEndpoint.id;
export const billEndpointId = billEndpoint.id;
export const orderIssuesEndpointId = orderIssuesEndpoint.id;
export const pointClaimEndpointId = pointClaimEndpoint.id;
export const reviewEndpointId = reviewEligibilityEndpoint.id;
