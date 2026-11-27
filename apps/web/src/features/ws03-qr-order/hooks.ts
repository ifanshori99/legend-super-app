// Hooks of the QR order journey. Components never call apiFetch or useQuery
// directly (docs/frontend.md). One session view query holds the shared cart,
// the server quote, the orders and the open waiter calls, so every screen
// reads the same state.
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api/errors";
import type {
  CreateSplitsInput,
  CustomerOrderIssueResolution,
  GuestPaymentMethod,
  GuestPaymentOptionsQuery,
  GuestPaymentTarget,
  TableSessionView,
} from "@starter/shared/qr-order";
import {
  addToCart,
  changeCartLine,
  chooseIssueResolution,
  claimPoints,
  createSplits,
  deleteCartLine,
  fetchSplitClaim,
  placeOrder,
  scanTable,
  sendServiceRequest,
  startPayment,
  submitReview,
  type CartItemInput,
} from "./api";
import {
  billEndpointId,
  menuQuery,
  orderIssuesEndpointId,
  orderEtasQuery,
  orderIssuesQuery,
  paymentOptionsQuery,
  paymentQuery,
  pointClaimEndpointId,
  pointClaimQuery,
  quoteQuery,
  reviewEligibilityQuery,
  reviewEndpointId,
  billQuery,
  sessionEndpointId,
  sessionKey,
  sessionViewQuery,
  suggestionsQuery,
  type QuoteCodes,
} from "./queries";
import { currentDeviceHash, saveGuestSession } from "./session-store";

export { useStoredGuestSession } from "./session-store";

export function useQrMenu(qrToken: string) {
  return useSuspenseQuery(menuQuery(qrToken));
}

export function useSessionView(sessionId: string | null) {
  return useQuery({
    ...sessionViewQuery(sessionId ?? "none"),
    enabled: sessionId !== null,
  });
}

export function useMenuSuggestions(
  sessionId: string | null,
  menuItemId?: string,
) {
  return useQuery({
    ...suggestionsQuery(sessionId ?? "none", menuItemId),
    enabled: sessionId !== null,
    staleTime: 60_000,
  });
}

/** Server quote for the codes the guest typed; recomputed on each cart version. */
export function useQuote(
  sessionId: string | null,
  cartVersion: number,
  codes: QuoteCodes,
) {
  return useQuery({
    ...quoteQuery(sessionId ?? "none", cartVersion, codes),
    enabled: sessionId !== null,
  });
}

export function useSessionBill(sessionId: string | null) {
  return useQuery({
    ...billQuery(sessionId ?? "none"),
    enabled: sessionId !== null,
  });
}

export function useOrderEtas(sessionId: string | null) {
  return useQuery({
    ...orderEtasQuery(sessionId ?? "none"),
    enabled: sessionId !== null,
  });
}

export function useReviewEligibility(sessionId: string | null) {
  return useQuery({
    ...reviewEligibilityQuery(sessionId ?? "none"),
    enabled: sessionId !== null,
  });
}

export function useOrderIssues(sessionId: string | null) {
  return useQuery({
    ...orderIssuesQuery(sessionId ?? "none"),
    enabled: sessionId !== null,
  });
}

export function usePointClaim(sessionId: string | null) {
  return useQuery({
    ...pointClaimQuery(sessionId ?? "none"),
    enabled: sessionId !== null,
  });
}

export function useGuestPayment(sessionId: string, paymentId: string | null) {
  return useQuery({
    ...paymentQuery(sessionId, paymentId ?? "none"),
    enabled: paymentId !== null,
  });
}

const NO_TARGET: GuestPaymentOptionsQuery = {};

/**
 * Which online methods are on and, for VA, the provider's bank list. With a
 * target (the order or split part the create call names) each bank and
 * method also carries its service fee and charged total (1272 K3).
 */
export function useGuestPaymentOptions(
  sessionId: string | null,
  target: GuestPaymentOptionsQuery = NO_TARGET,
) {
  return useQuery({
    ...paymentOptionsQuery(sessionId ?? "none", target),
    enabled: sessionId !== null,
  });
}

// ---- Mutations -------------------------------------------------------------

function refreshSession(queryClient: QueryClient, sessionId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) }),
    queryClient.invalidateQueries({ queryKey: ["qr-quote", sessionId] }),
    // A placed order changes the bill (checkout "Bagi tagihan" opens it next).
    queryClient.invalidateQueries({ queryKey: [billEndpointId] }),
  ]);
}

/** Scan: the first guest opens the session, the next ones join it. */
export function useJoinTable(qrToken: string) {
  return useMutation({
    mutationFn: (pax: number) => {
      const hash = currentDeviceHash();
      return scanTable({ qrToken, pax, deviceHash: hash }).then((result) => ({
        result,
        hash,
      }));
    },
    onSuccess: ({ result, hash }) => {
      const me = result.data.session.participants.find(
        (participant) => participant.deviceHash === hash,
      );
      saveGuestSession({
        qrToken,
        sessionId: result.data.session.id,
        sessionToken: result.data.sessionToken,
        sessionTokenExpiresAt: result.data.sessionTokenExpiresAt,
        participantId: me?.id ?? null,
        pax: result.data.session.pax,
        outcome: result.data.outcome,
      });
    },
  });
}

function isConflict(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

export function useAddToCart(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      line,
      cartVersion,
    }: {
      line: CartItemInput;
      cartVersion: number;
    }) => addToCart(sessionId, cartVersion, line),
    onSuccess: (result) => {
      queryClient.setQueryData<{ data: TableSessionView }>(
        sessionKey(sessionId),
        (view) =>
          view ? { data: { ...view.data, cart: result.data.cart } } : view,
      );
    },
    // A stale cart version means another guest changed the cart first: reload
    // it and let the guest repeat the tap against the new state.
    onSettled: (_data, error) =>
      refreshSession(queryClient, sessionId).then(() => {
        if (isConflict(error)) return undefined;
        return undefined;
      }),
  });
}

export function useChangeCartLine(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      lineId: string;
      cartVersion: number;
      patch: { quantity?: number; note?: string | null };
    }) =>
      changeCartLine(sessionId, input.lineId, input.cartVersion, input.patch),
    onSettled: () => refreshSession(queryClient, sessionId),
  });
}

export function useRemoveCartLine(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { lineId: string; cartVersion: number }) =>
      deleteCartLine(sessionId, input.lineId, input.cartVersion),
    onSettled: () => refreshSession(queryClient, sessionId),
  });
}

export function usePlaceOrder(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      expectedCartVersion: number;
      idempotencyKey: string;
      note?: string;
    }) => placeOrder(sessionId, input),
    onSettled: () => refreshSession(queryClient, sessionId),
  });
}

export function useCreateSplits(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSplitsInput) => createSplits(sessionId, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [billEndpointId] }),
        queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) }),
      ]),
  });
}

export function useSendServiceRequest(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof sendServiceRequest>[1]) =>
      sendServiceRequest(sessionId, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) }),
  });
}

export function useSubmitReview(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { rating: number; comment?: string }) =>
      submitReview(sessionId, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [reviewEndpointId] }),
  });
}

export function useChooseIssueResolution(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      orderIssueId: string;
      choice: CustomerOrderIssueResolution;
      replacementItemId?: string;
    }) =>
      chooseIssueResolution(input.orderIssueId, {
        choice: input.choice,
        ...(input.replacementItemId
          ? { replacementItemId: input.replacementItemId }
          : {}),
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [orderIssuesEndpointId] }),
        queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) }),
        queryClient.invalidateQueries({ queryKey: [billEndpointId] }),
      ]),
  });
}

export function useStartPayment(sessionId: string) {
  return useMutation({
    mutationFn: (input: {
      target: GuestPaymentTarget;
      method: GuestPaymentMethod;
      bankCode?: string;
      idempotencyKey: string;
    }) => startPayment(sessionId, input),
  });
}

/** Fetches the claim token of one paid split part with the kept payer secret. */
export function useSplitClaim(sessionId: string) {
  return useMutation({
    mutationFn: (splitId: string) => fetchSplitClaim(sessionId, splitId),
  });
}

export function useClaimPoints(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => claimPoints(sessionId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [pointClaimEndpointId] }),
  });
}

/** Refreshes everything the session screens show (after a payment settles). */
export function useRefreshSession(sessionId: string | null) {
  const queryClient = useQueryClient();
  return () => {
    if (sessionId === null) return Promise.resolve();
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: [sessionEndpointId] }),
      queryClient.invalidateQueries({ queryKey: [billEndpointId] }),
      queryClient.invalidateQueries({ queryKey: [pointClaimEndpointId] }),
      queryClient.invalidateQueries({ queryKey: [reviewEndpointId] }),
    ]);
  };
}
