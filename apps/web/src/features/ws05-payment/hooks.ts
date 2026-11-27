// Data hooks for the customer payment page. Components never touch the API
// client or TanStack Query directly; keys, polling and cache updates live here.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreatePaymentIntentInput,
  CustomerPaymentIntent,
} from "@starter/shared/payment";
import {
  refreshIntentCode,
  requestCashierPayment,
  startPaymentIntent,
} from "./api";
import { isFeeChangedError } from "./errors";
import {
  paymentIntentKey,
  paymentIntentQuery,
  paymentLinkKey,
  paymentLinkQuery,
} from "./queries";
import {
  MAX_AUTO_REFRESHES,
  nextRefreshCount,
  remainingMs,
  shouldAutoRefresh,
} from "./status";

export function usePaymentLink(token: string) {
  return useQuery(paymentLinkQuery(token));
}

/** The intent is fetched only when the link already has one. */
export function usePaymentIntent(token: string, intentId: string | null) {
  return useQuery({
    ...paymentIntentQuery(token, intentId ?? ""),
    enabled: intentId !== null,
  });
}

export function useStartPayment(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentIntentInput) =>
      startPaymentIntent(token, input),
    onSuccess: (intent) => {
      queryClient.setQueryData(paymentIntentKey(token, intent.id), intent);
      return queryClient.invalidateQueries({
        queryKey: paymentLinkKey(token),
      });
    },
  });
}

export function useRefreshIntent(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (intentId: string) => refreshIntentCode(token, intentId),
    onSuccess: (intent) => {
      queryClient.setQueryData(paymentIntentKey(token, intent.id), intent);
      return queryClient.invalidateQueries({
        queryKey: paymentLinkKey(token),
      });
    },
    // 1272 fee second opinion re-review P2: a code that would be replaced at
    // another price is refused (409 FEE_CHANGED); load the new prices so the
    // guest sees them before choosing again.
    onError: (error) => {
      if (isFeeChangedError(error))
        return queryClient.invalidateQueries({
          queryKey: paymentLinkKey(token),
        });
    },
  });
}

export function usePayAtCashier(token: string) {
  return useMutation({
    mutationFn: () => requestCashierPayment(token),
  });
}

/**
 * After the intent settles or expires, refetch the link so the bill and the
 * active intent on screen match the server. The polled status itself already
 * comes from the API (PAY-02) — this only keeps the two queries in step.
 */
export function useSettledIntentSync(
  token: string,
  intent: CustomerPaymentIntent | null,
) {
  const queryClient = useQueryClient();
  const status = intent?.status;
  useEffect(() => {
    if (!status || status === "pending") return;
    void queryClient.invalidateQueries({ queryKey: paymentLinkKey(token) });
  }, [queryClient, token, status]);
}

/**
 * PRD "QRIS Dinamis": refresh the code once its clock runs out while the guest
 * is still on the page. Never silently mints a code for a link that was
 * already expired on first render — then the guest taps "Buat kode baru".
 */
export function useAutoRefreshIntent(
  token: string,
  intent: CustomerPaymentIntent | null,
  remaining: number,
) {
  const refresh = useRefreshIntent(token);
  const state = useRef({ intentId: "", refreshes: 0, inFlight: false });
  const { mutate, isPending } = refresh;
  const intentId = intent?.id ?? null;
  const status = intent?.status;

  useEffect(() => {
    if (!intentId || !status) return;
    // The cap counts refreshes that came back without a live code. A new
    // intent id alone must not reset it: a server that mints an already
    // expired intent on every refresh would otherwise loop forever.
    if (state.current.intentId !== intentId)
      state.current = { ...state.current, intentId, inFlight: false };
    state.current.refreshes = nextRefreshCount(
      state.current.refreshes,
      remaining,
    );
    if (isPending || state.current.inFlight) return;
    if (!shouldAutoRefresh(status, remaining, state.current.refreshes)) return;
    state.current.refreshes = Math.min(
      state.current.refreshes + 1,
      MAX_AUTO_REFRESHES,
    );
    state.current.inFlight = true;
    mutate(intentId, {
      onError: (error) => {
        // A changed price is not retried by the clock: the guest chooses.
        if (isFeeChangedError(error))
          state.current.refreshes = MAX_AUTO_REFRESHES;
      },
      onSettled: () => {
        state.current.inFlight = false;
      },
    });
  }, [intentId, status, remaining, isPending, mutate]);

  return refresh;
}

/** Re-renders once a second while a code is live; stops at zero. */
export function useCountdown(
  expiresAt: string | null | undefined,
  skewMs: number,
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return remainingMs(expiresAt ?? null, now, skewMs);
}
