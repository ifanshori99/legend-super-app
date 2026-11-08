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
import { useMemo } from "react";
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
  return useQuery(paymentMethodsQuery(orderId));
}

export function useEdcTerminals() {
  return useQuery(edcTerminalsQuery());
}

export function useVaBanks() {
  return useQuery(vaBanksQuery());
}

export function useEwallets() {
  return useQuery(ewalletsQuery());
}

function putSession(
  queryClient: QueryClient,
  orderId: string,
  session: PaymentSession,
) {
  queryClient.setQueryData(posKasirKeys.session(orderId), session);
}

/** A mutation that answers with the fresh session of one order. */
function useSessionMutation<TInput extends { orderId: string }>(
  run: (input: TInput) => Promise<PaymentSession>,
) {
  const queryClient = useQueryClient();
  return useMutation<PaymentSession, ApiError, TInput>({
    mutationFn: run,
    onSuccess: (session, input) =>
      putSession(queryClient, input.orderId, session),
    // A refused call can still change what the screen must show.
    onError: (_error, input) =>
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.session(input.orderId),
      }),
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
  return useSessionMutation<ConfirmCashInput>((input) =>
    confirmCash(outletId, input),
  );
}

export function useRecordEdcStandalone() {
  return useSessionMutation<RecordEdcStandaloneInput>((input) =>
    recordEdcStandalone(input),
  );
}

export function usePrintReceipt() {
  const outletId = useOutletId();
  return useMutation<
    Awaited<ReturnType<typeof printReceipt>>,
    ApiError,
    { orderId: string }
  >({ mutationFn: ({ orderId }) => printReceipt(outletId, orderId) });
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
  return useMutation({
    mutationFn: (input: OpenShiftInput) => openShift(outletId, input),
    onSuccess: (shift) => queryClient.setQueryData(posKasirKeys.shift, shift),
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
  return useMutation({
    mutationFn: (input: RecordCashMovementInput) =>
      recordCashMovement(outletId, input),
    onSuccess: (_movement, input) =>
      queryClient.invalidateQueries({
        queryKey: posKasirKeys.movements(input.shiftId),
      }),
  });
}

/** Per-denomination blind count; the answer never carries a system figure. */
export function useSubmitBlindCount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitBlindCountInput) => submitBlindCount(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: posKasirKeys.shift }),
  });
}

export function useRegisteredTerminals() {
  return useQuery(registeredTerminalsQuery());
}

// ---- Supervisor ------------------------------------------------------------

export function useSupervisorOptions() {
  return useQuery(supervisorsQuery());
}

/** After the cashier sent the count: counted, system figure and variance. */
export function useShiftReview(shiftId: string) {
  return useQuery({ ...shiftReviewQuery(shiftId), enabled: shiftId !== "" });
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApproveShiftCloseInput) => approveShiftClose(input),
    onSuccess: (review, input) => {
      queryClient.setQueryData(posKasirKeys.review(input.shiftId), review);
      void queryClient.invalidateQueries({ queryKey: posKasirKeys.shift });
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
  return useMutation({
    mutationFn: (input: CloseDayInput) =>
      closeDay(outletId, businessDate, cutoff, input),
    onSuccess: (recap) =>
      queryClient.setQueryData(
        dayCloseRecapQuery(outletId, businessDate, cutoff).queryKey,
        recap,
      ),
  });
}
