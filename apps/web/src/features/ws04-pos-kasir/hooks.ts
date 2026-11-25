// The only data door for the POS kasir screens (docs/frontend.md): components
// import hooks from here and never touch apiFetch, useQuery or mock data.
//
// List hooks (`usePaymentMethods`, `useEdcTerminals`, ...) return the TanStack
// query result, so the list is `.data`. `usePaymentSession` flattens the
// session (`bill`, `activeAttempt`, `cash`, `receiptNo`) next to the query
// state. Every mutation updates the cache, so a screen rerenders from the hook
// result alone. Outside mock mode, a call without a contract fails with an
// ApiError whose code is CONTRACT_PENDING (see `isContractPending`).
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useRef } from "react";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import { noteCatalogSalesBlocked } from "@/features/ws02-edge/hooks";
import { MOCK_SUPERVISOR_ID } from "./fixtures";
import {
  applyVoucherCode,
  cancelAttempt,
  checkPaymentStatus,
  confirmCash,
  lookupCashierCode,
  printReceipt,
  quotePointsValue,
  recordEdcStandalone,
  redeemPointsValue,
  refreshQris,
  removeVoucherCode,
  startPayment,
  validateVoucherCode,
} from "./api";
import {
  edcTerminalsQuery,
  ewalletsQuery,
  paymentMethodsQuery,
  paymentSessionQuery,
  pointsAccountQuery,
  posKasirKeys,
  vaBanksQuery,
} from "./queries";
import {
  CONTRACT_PENDING,
  type AttemptRef,
  type CashierCodeOrder,
  type ConfirmCashInput,
  type PaymentSession,
  type PointsQuote,
  type RecordEdcStandaloneInput,
  type StartPaymentInput,
  type VoucherCheck,
} from "./types";

/** True when the server has no contract for the call yet (show "belum tersambung"). */
export function isContractPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONTRACT_PENDING;
}

/** The outlet this screen works in; "" when none (queries stay idle). */
export function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

/** The signed-in user; mock mode acts as the mock supervisor. "" when unknown. */
export function useCurrentUserId(): string {
  const session = useRouteContext({ strict: false, select: (c) => c.session });
  if (API_MOCK) return MOCK_SUPERVISOR_ID;
  return session?.user.id ?? "";
}

/** Mock mode needs no outlet; real calls do. */
export function useReady(): boolean {
  const outletId = useOutletId();
  return API_MOCK || outletId !== "";
}

/**
 * One idempotency key per intent. The same input keeps the same key until the
 * call succeeds (`clear`), so a retry after a timeout or a double tap is
 * recognised by the server; a changed input is a new intent and a new key.
 */
export function useIntentKey(prefix: string) {
  const current = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    keyFor(input: unknown): string {
      const fingerprint = JSON.stringify(input);
      if (current.current?.fingerprint !== fingerprint)
        current.current = {
          fingerprint,
          key: `${prefix}:${globalThis.crypto.randomUUID()}`,
        };
      return current.current.key;
    },
    clear() {
      current.current = null;
    },
  };
}

// ---- Payment ---------------------------------------------------------------

export function usePaymentSession(orderId: string) {
  const outletId = useOutletId();
  const ready = useReady();
  const query = useQuery({
    ...paymentSessionQuery(outletId, orderId),
    enabled: ready && orderId !== "",
  });
  return {
    bill: query.data?.bill,
    activeAttempt: query.data?.activeAttempt ?? null,
    cash: query.data?.cash,
    receiptNo: query.data?.receiptNo,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

export function usePaymentMethods(orderId: string) {
  return useQuery(paymentMethodsQuery(useOutletId(), orderId));
}

export function useEdcTerminals() {
  return useQuery(edcTerminalsQuery(useOutletId()));
}

export function useVaBanks() {
  return useQuery(vaBanksQuery(useOutletId()));
}

export function useEwallets() {
  return useQuery(ewalletsQuery(useOutletId()));
}

function putSession(
  queryClient: QueryClient,
  outletId: string,
  orderId: string,
  session: PaymentSession,
) {
  queryClient.setQueryData(posKasirKeys.session(outletId, orderId), session);
}

/** A mutation that answers with the fresh session of one order. */
function useSessionMutation<TInput extends { orderId: string }>(
  run: (input: TInput) => Promise<PaymentSession>,
) {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  return useMutation<PaymentSession, ApiError, TInput>({
    mutationFn: run,
    onSuccess: (session, input) =>
      putSession(queryClient, outletId, input.orderId, session),
    // A refused call can still change what the screen must show.
    onError: (error, input) => {
      // Catalog over 24 hours old (legend-10nex): the notice shows the hold.
      noteCatalogSalesBlocked(queryClient, error);
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.session(outletId, input.orderId),
      });
    },
  });
}

export function useStartPayment() {
  return useSessionMutation<StartPaymentInput>((input) => startPayment(input));
}

export function useCheckPaymentStatus() {
  return useSessionMutation<AttemptRef>((ref) => checkPaymentStatus(ref));
}

export function useRefreshQris() {
  return useSessionMutation<AttemptRef>((ref) => refreshQris(ref));
}

export function useCancelAttempt() {
  return useSessionMutation<AttemptRef>((ref) => cancelAttempt(ref));
}

export function useConfirmCash() {
  const outletId = useOutletId();
  const intent = useIntentKey("cash");
  return useSessionMutation<ConfirmCashInput>(async (input) => {
    const session = await confirmCash(outletId, input, intent.keyFor(input));
    intent.clear();
    return session;
  });
}

export function useRecordEdcStandalone() {
  return useSessionMutation<RecordEdcStandaloneInput>((input) =>
    recordEdcStandalone(input),
  );
}

export function usePrintReceipt() {
  const outletId = useOutletId();
  const intent = useIntentKey("receipt");
  return useMutation<
    Awaited<ReturnType<typeof printReceipt>>,
    ApiError,
    { orderId: string }
  >({
    mutationFn: async (input) => {
      const result = await printReceipt(
        outletId,
        input.orderId,
        intent.keyFor(input),
      );
      intent.clear();
      return result;
    },
  });
}

// ---- Voucher and member points (brief 936) ---------------------------------
// The server prices every discount and redemption. A screen shows the numbers
// these hooks return and never computes them. Apply and redeem keep one
// idempotency key per intent, so a repeated tap is one request on the server.

/** A refused or applied adjustment can change the bill: refresh the screen. */
function useRefreshBill(orderId: string) {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  return {
    put(session: PaymentSession) {
      putSession(queryClient, outletId, orderId, session);
      // The most points a member may spend follows the remaining bill.
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.points(outletId, orderId),
      });
    },
    invalidate() {
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.session(outletId, orderId),
      });
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.points(outletId, orderId),
      });
    },
  };
}

export function useValidateVoucher(orderId: string) {
  const outletId = useOutletId();
  return useMutation<VoucherCheck, Error, { code: string }>({
    mutationFn: ({ code }) => validateVoucherCode(outletId, orderId, code),
  });
}

export function useApplyVoucher(orderId: string) {
  const outletId = useOutletId();
  const refresh = useRefreshBill(orderId);
  const intent = useIntentKey("voucher");
  return useMutation<PaymentSession, Error, { code: string }>({
    mutationFn: async (input) => {
      const session = await applyVoucherCode(
        outletId,
        orderId,
        input.code,
        intent.keyFor({ orderId, ...input }),
      );
      intent.clear();
      return session;
    },
    onSuccess: refresh.put,
    onError: refresh.invalidate,
  });
}

export function useRemoveVoucher(orderId: string) {
  const outletId = useOutletId();
  const refresh = useRefreshBill(orderId);
  const intent = useIntentKey("voucher-remove");
  return useMutation<PaymentSession, Error, void>({
    mutationFn: async () => {
      const session = await removeVoucherCode(
        outletId,
        orderId,
        intent.keyFor({ orderId }),
      );
      intent.clear();
      return session;
    },
    onSuccess: refresh.put,
    onError: refresh.invalidate,
  });
}

/** `data` is null when the order has no member; the panel shows "no member". */
export function usePointsAccount(orderId: string) {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({
    ...pointsAccountQuery(outletId, orderId),
    enabled: ready && orderId !== "",
  });
}

export function useQuotePoints(orderId: string) {
  return useMutation<PointsQuote, Error, { points: number }>({
    mutationFn: ({ points }) => quotePointsValue(orderId, points),
  });
}

export function useRedeemPoints(orderId: string) {
  const refresh = useRefreshBill(orderId);
  const intent = useIntentKey("points");
  return useMutation<PaymentSession, Error, { points: number }>({
    mutationFn: async (input) => {
      const session = await redeemPointsValue(
        orderId,
        input.points,
        intent.keyFor({ orderId, ...input }),
      );
      intent.clear();
      return session;
    },
    onSuccess: refresh.put,
    onError: refresh.invalidate,
  });
}

// ---- Cashier code ----------------------------------------------------------

/** Mutation: input is the code as typed ("0044" or "LG-0044"); a miss is `NOT_FOUND`. */
export function useCashierCodeLookup() {
  return useMutation<CashierCodeOrder, ApiError, string>({
    mutationFn: (code) => lookupCashierCode(code),
  });
}
