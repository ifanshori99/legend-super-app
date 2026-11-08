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
import { useMemo, useRef } from "react";
import { businessDateOf } from "@starter/shared/core";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import {
  approveShiftClose,
  cancelAttempt,
  checkPaymentStatus,
  closeDay,
  confirmCash,
  lookupCashierCode,
  openShift,
  printReceipt,
  recordCashMovement,
  recordEdcStandalone,
  refreshQris,
  requestOverride,
  startPayment,
  submitBlindCount,
} from "./api";
import {
  activeShiftQuery,
  cashMovementsQuery,
  dayCloseRecapQuery,
  edcTerminalsQuery,
  ewalletsQuery,
  paymentMethodsQuery,
  paymentSessionQuery,
  posKasirKeys,
  registeredTerminalsQuery,
  shiftReviewQuery,
  supervisorsQuery,
  vaBanksQuery,
} from "./queries";
import {
  CONTRACT_PENDING,
  type ApproveShiftCloseInput,
  type AttemptRef,
  type CashierCodeOrder,
  type CloseDayInput,
  type ConfirmCashInput,
  type OpenShiftInput,
  type PaymentSession,
  type RecordCashMovementInput,
  type RecordEdcStandaloneInput,
  type RequestOverrideInput,
  type StartPaymentInput,
  type SubmitBlindCountInput,
} from "./types";

/** True when the server has no contract for the call yet (show "belum tersambung"). */
export function isContractPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONTRACT_PENDING;
}

/** The outlet this screen works in; "" when none (queries stay idle). */
function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

/** Mock mode needs no outlet; real calls do. */
function useReady(): boolean {
  const outletId = useOutletId();
  return API_MOCK || outletId !== "";
}

/**
 * One idempotency key per intent. The same input keeps the same key until the
 * call succeeds (`clear`), so a retry after a timeout or a double tap is
 * recognised by the server; a changed input is a new intent and a new key.
 */
function useIntentKey(prefix: string) {
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
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.session(outletId, input.orderId),
      });
      // The server says there is no open shift: the cached shift is stale (for
      // example closed on another terminal), so "Buka shift" must not land on
      // an active-shift screen.
      if (error.status === 409 && error.code === "SHIFT_NOT_OPEN")
        void queryClient.invalidateQueries({
          queryKey: posKasirKeys.shift(outletId),
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

// ---- Cashier code ----------------------------------------------------------

/** Mutation: input is the code as typed ("0044" or "LG-0044"); a miss is `NOT_FOUND`. */
export function useCashierCodeLookup() {
  return useMutation<CashierCodeOrder, ApiError, string>({
    mutationFn: (code) => lookupCashierCode(code),
  });
}

// ---- Shift -----------------------------------------------------------------

export function useActiveShift() {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({ ...activeShiftQuery(outletId), enabled: ready });
}

export function useOpenShift() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const intent = useIntentKey("shift");
  return useMutation({
    mutationFn: async (input: OpenShiftInput) => {
      const shift = await openShift(outletId, input, intent.keyFor(input));
      intent.clear();
      return shift;
    },
    onSuccess: (shift) =>
      queryClient.setQueryData(posKasirKeys.shift(outletId), shift),
  });
}

export function useCashMovements(shiftId: string | undefined) {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({
    ...cashMovementsQuery(outletId, shiftId ?? ""),
    enabled: ready && Boolean(shiftId),
  });
}

export function useRecordCashMovement() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const intent = useIntentKey("cash-move");
  return useMutation({
    mutationFn: async (input: RecordCashMovementInput) => {
      const movement = await recordCashMovement(
        outletId,
        input,
        intent.keyFor(input),
      );
      intent.clear();
      return movement;
    },
    onSuccess: (_movement, input) =>
      queryClient.invalidateQueries({
        queryKey: posKasirKeys.movements(outletId, input.shiftId),
      }),
  });
}

/** Per-denomination blind count; the answer never carries a system figure. */
export function useSubmitBlindCount() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitBlindCountInput) => submitBlindCount(input),
    onSuccess: (_receipt, input) => {
      // A recount replaces the old one: the review must carry the new countId.
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.review(outletId, input.shiftId),
      });
      return queryClient.invalidateQueries({
        queryKey: posKasirKeys.shift(outletId),
      });
    },
  });
}

export function useRegisteredTerminals() {
  return useQuery(registeredTerminalsQuery(useOutletId()));
}

// ---- Supervisor ------------------------------------------------------------

export function useSupervisorOptions() {
  return useQuery(supervisorsQuery(useOutletId()));
}

/** After the cashier sent the count: counted, system figure and variance. */
export function useShiftReview(shiftId: string) {
  return useQuery({
    ...shiftReviewQuery(useOutletId(), shiftId),
    enabled: shiftId !== "",
  });
}

/** Reason + supervisor PIN in, `overrideId` out (never an approvalRequestId). */
export function useRequestOverride() {
  const outletId = useOutletId();
  return useMutation({
    mutationFn: (input: RequestOverrideInput) =>
      requestOverride(outletId, input),
  });
}

export function useApproveShiftClose() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApproveShiftCloseInput) => approveShiftClose(input),
    onSuccess: (review, input) => {
      queryClient.setQueryData(
        posKasirKeys.review(outletId, input.shiftId),
        review,
      );
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.shift(outletId),
      });
    },
  });
}

// ---- End of day ------------------------------------------------------------

/** The business date follows the outlet clock and its cutoff (04:00 default). */
function useBusinessDay() {
  const { clock, businessDayCutoff } = useOutletClock();
  return useMemo(
    () => ({
      businessDate: businessDateOf(new Date(), clock),
      cutoff: businessDayCutoff,
    }),
    [clock, businessDayCutoff],
  );
}

export function useDayCloseRecap() {
  const outletId = useOutletId();
  const ready = useReady();
  const { businessDate, cutoff } = useBusinessDay();
  return useQuery({
    ...dayCloseRecapQuery(outletId, businessDate, cutoff),
    enabled: ready,
  });
}

/** Outlet manager closes the day; the answer is the closed recap with its result. */
export function useCloseDay() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const { businessDate, cutoff } = useBusinessDay();
  const intent = useIntentKey("day");
  return useMutation({
    mutationFn: async (input: CloseDayInput) => {
      const recap = await closeDay(
        outletId,
        businessDate,
        cutoff,
        input,
        intent.keyFor({ businessDate, input }),
      );
      intent.clear();
      return recap;
    },
    onSuccess: (recap) =>
      queryClient.setQueryData(
        dayCloseRecapQuery(outletId, businessDate, cutoff).queryKey,
        recap,
      ),
  });
}
