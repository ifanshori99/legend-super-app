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
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import { useActiveStaff } from "@/features/ws01-device-pin/storage";
import { noteCatalogSalesBlocked } from "@/features/ws02-edge/hooks";
import { MOCK_SUPERVISOR_ID } from "./fixtures";
import {
  applyVoucherCode,
  cancelAttempt,
  checkPaymentStatus,
  completePaidOrder,
  confirmCash,
  fetchReceiptPdf,
  lookupCashierCode,
  printReceipt,
  quotePointsValue,
  recordEdcStandalone,
  redeemPointsValue,
  removeVoucherCode,
  replayPayment,
  resolvePayment,
  requestEdcApproval,
  startPayment,
  validateVoucherCode,
} from "./api";
import {
  isSendingIntent,
  rawIntent,
  subscribeIntents,
} from "./payment-intent-browser";
import { parseIntent, type IntentState } from "./payment-intent-store";
import {
  edcApproversQuery,
  edcTerminalsQuery,
  ewalletsQuery,
  paymentMethodsQuery,
  paymentSessionQuery,
  pointsAccountQuery,
  posKasirKeys,
  resolveApproversQuery,
  vaBanksQuery,
} from "./queries";
import {
  CONTRACT_PENDING,
  type AttemptRef,
  type CashierCodeOrder,
  type ConfirmCashInput,
  type PaymentMethodCode,
  type PaymentSession,
  type PointsQuote,
  type RecordEdcStandaloneInput,
  type StartPaymentInput,
  type VoucherCheck,
  type ResolvePaymentInput,
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

/** Who the server records: the cashier on duty, else the signed-in user. */
export function useActorId(): string {
  const userId = useCurrentUserId();
  return useActiveStaff()?.userId ?? userId;
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
    completion: query.data?.completion,
    partialAllowed: query.data?.partialAllowed ?? true,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

export function usePaymentMethods(orderId: string) {
  return useQuery({
    ...paymentMethodsQuery(useOutletId(), orderId),
    enabled: useReady(),
  });
}

export function useEdcTerminals() {
  return useQuery({
    ...edcTerminalsQuery(useOutletId()),
    enabled: useReady(),
  });
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
  const outletId = useOutletId();
  const actorId = useActorId();
  return useSessionMutation<StartPaymentInput>((input) =>
    startPayment(outletId, actorId, input),
  );
}

export function useCheckPaymentStatus() {
  const outletId = useOutletId();
  return useSessionMutation<AttemptRef>((ref) =>
    checkPaymentStatus(outletId, ref),
  );
}

export function useCancelAttempt() {
  const outletId = useOutletId();
  return useSessionMutation<AttemptRef & { method: PaymentMethodCode }>((ref) =>
    cancelAttempt(outletId, ref),
  );
}

export function useConfirmCash() {
  const outletId = useOutletId();
  const actorId = useActorId();
  return useSessionMutation<ConfirmCashInput>((input) =>
    confirmCash(outletId, actorId, input),
  );
}

export function useRecordEdcStandalone() {
  const outletId = useOutletId();
  const actorId = useActorId();
  return useSessionMutation<RecordEdcStandaloneInput>((input) =>
    recordEdcStandalone(outletId, actorId, input),
  );
}

/** Supervisors who may approve a hand-keyed EDC payment here. */
export function useEdcApprovers() {
  return useQuery(edcApproversQuery(useOutletId()));
}

export function useRequestEdcApproval() {
  const outletId = useOutletId();
  return useMutation({
    mutationFn: (input: Parameters<typeof requestEdcApproval>[1]) =>
      requestEdcApproval(outletId, input),
  });
}

// ---- Payment request without a known answer (1268 W2) ------------------------

const NO_INTENT: IntentState = { status: "none" };

export type UnresolvedPayment = NonNullable<
  ReturnType<typeof useUnresolvedPayment>
>;

/**
 * The payment request of this bill that has no known answer, from any tab;
 * `sending` while this tab still waits for it, whichever screen sent it.
 */
export function useUnresolvedPayment(orderId: string) {
  const outletId = useOutletId();
  const actorId = useActorId();
  const scope = { outletId, orderId, slot: "payment" as const };
  const raw = useSyncExternalStore(
    subscribeIntents,
    () => (API_MOCK ? null : rawIntent(scope)),
    () => null,
  );
  const sending = useSyncExternalStore(
    subscribeIntents,
    () => !API_MOCK && isSendingIntent(scope),
    () => false,
  );
  const state = raw === null ? NO_INTENT : parseIntent(raw);
  if (sending) return { status: "sending" as const };
  if (state.status === "none") return null;
  if (state.status === "corrupt") return { status: "corrupt" as const };
  return {
    status: "pending" as const,
    kind: state.intent.kind,
    /** The server repeats a request only for the cashier who sent it. */
    mine: state.intent.actorId === actorId,
  };
}

/** Send the unresolved request again, byte for byte. */
export function useReplayPayment() {
  const outletId = useOutletId();
  const actorId = useActorId();
  return useSessionMutation<{ orderId: string }>(({ orderId }) =>
    replayPayment(outletId, orderId, actorId),
  );
}

/** Supervisors for the request above; an EDC one needs the EDC approval. */
export function useResolveApprovers(
  action: "void" | "edc_standalone",
  enabled: boolean,
) {
  return useQuery({
    ...resolveApproversQuery(useOutletId(), action),
    enabled,
  });
}

/** Settle the unresolved request with a supervisor's PIN. */
export function useResolvePayment() {
  const outletId = useOutletId();
  const actorId = useActorId();
  return useSessionMutation<ResolvePaymentInput>((input) =>
    resolvePayment(outletId, actorId, input),
  );
}

/**
 * A paid order is completed on its own, once per screen. A refusal is not shown
 * here: the bill is paid, and printing the receipt tries again and says why.
 */
export function useCompleteWhenPaid(
  orderId: string,
  completion: PaymentSession["completion"],
) {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useActorId();
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (completion !== "ready" || tried.current === orderId) return;
    tried.current = orderId;
    completePaidOrder(outletId, orderId, actorId).then(
      (session) => putSession(queryClient, outletId, orderId, session),
      () =>
        void queryClient.invalidateQueries({
          queryKey: posKasirKeys.session(outletId, orderId),
        }),
    );
  }, [completion, orderId, outletId, actorId, queryClient]);
}

export function usePrintReceipt() {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useActorId();
  return useMutation<
    Awaited<ReturnType<typeof printReceipt>>,
    ApiError,
    { orderId: string }
  >({
    mutationFn: ({ orderId }) => printReceipt(outletId, orderId, actorId),
    onSettled: (_result, _error, { orderId }) => {
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.session(outletId, orderId),
      });
    },
  });
}

/** Opens the receipt PDF as a download. */
export function useReceiptPdf() {
  const outletId = useOutletId();
  return useMutation<void, ApiError, { receiptId: string; receiptNo: string }>({
    mutationFn: async ({ receiptId, receiptNo }) => {
      const url = URL.createObjectURL(
        await fetchReceiptPdf(outletId, receiptId),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${receiptNo}.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
  const outletId = useOutletId();
  const actorId = useActorId();
  const refresh = useRefreshBill(orderId);
  const intent = useIntentKey("points");
  return useMutation<PaymentSession, Error, { points: number }>({
    mutationFn: async (input) => {
      const session = await redeemPointsValue(
        outletId,
        orderId,
        actorId,
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
