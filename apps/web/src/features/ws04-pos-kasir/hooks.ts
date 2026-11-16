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
import { useMemo, useRef } from "react";
import { businessDateOf } from "@starter/shared/core";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import { noteCatalogSalesBlocked } from "@/features/ws02-edge/hooks";
import { MOCK_SUPERVISOR_ID } from "./fixtures";
import {
  applyVoucherCode,
  approveShiftClose,
  cancelAttempt,
  checkPaymentStatus,
  closeDay,
  confirmCash,
  lookupCashierCode,
  openShift,
  printReceipt,
  quotePointsValue,
  recordCashMovement,
  recordEdcStandalone,
  redeemPointsValue,
  refreshQris,
  removeVoucherCode,
  requestOverride,
  startPayment,
  submitBlindCount,
  validateVoucherCode,
} from "./api";
import {
  decideHeldCashMovement,
  forceCloseShift,
  submitForcedCount,
  witnessForcedCount,
} from "./shift-extra-api";
import {
  activeShiftQuery,
  cashMovementsQuery,
  dayCloseRecapQuery,
  edcTerminalsQuery,
  ewalletsQuery,
  forceCloseViewQuery,
  heldCashOutsQuery,
  ownCountSummaryQuery,
  paymentMethodsQuery,
  paymentSessionQuery,
  pointsAccountQuery,
  posKasirKeys,
  registeredTerminalsQuery,
  shiftReviewQuery,
  supervisorsQuery,
  vaBanksQuery,
  witnessesQuery,
} from "./queries";
import type {
  DecideHeldCashInput,
  ForceCloseInput,
  SubmitForcedCountInput,
  WitnessForcedCountInput,
} from "./shift-extra-types";
import {
  CONTRACT_PENDING,
  type ApproveShiftCloseInput,
  type AttemptRef,
  type CashierCodeOrder,
  type CloseDayInput,
  type ConfirmCashInput,
  type OpenShiftInput,
  type PaymentSession,
  type PointsQuote,
  type RecordCashMovementInput,
  type RecordEdcStandaloneInput,
  type RequestOverrideInput,
  type StartPaymentInput,
  type SubmitBlindCountInput,
  type VoucherCheck,
} from "./types";

/** True when the server has no contract for the call yet (show "belum tersambung"). */
export function isContractPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONTRACT_PENDING;
}

/** The outlet this screen works in; "" when none (queries stay idle). */
function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

/** The signed-in user; mock mode acts as the mock supervisor. "" when unknown. */
export function useCurrentUserId(): string {
  const session = useRouteContext({ strict: false, select: (c) => c.session });
  if (API_MOCK) return MOCK_SUPERVISOR_ID;
  return session?.user.id ?? "";
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
  const refresh = useRefreshBill(orderId);
  const intent = useIntentKey("voucher");
  return useMutation<PaymentSession, Error, { code: string }>({
    mutationFn: async (input) => {
      const session = await applyVoucherCode(
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
  const refresh = useRefreshBill(orderId);
  return useMutation<PaymentSession, Error, void>({
    mutationFn: () => removeVoucherCode(orderId),
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
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.ownCount(outletId, input.shiftId),
      });
      return queryClient.invalidateQueries({
        queryKey: posKasirKeys.shift(outletId),
      });
    },
  });
}

/** The cashier's latest count (number and counted figure; never a system figure). */
export function useOwnCountSummary(shiftId: string | undefined) {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({
    ...ownCountSummaryQuery(outletId, shiftId ?? ""),
    enabled: ready && Boolean(shiftId),
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

/** Cash outs held for review, with the physical and book variance (legend-pspy). */
export function useHeldCashOuts(shiftId: string) {
  return useQuery({
    ...heldCashOutsQuery(useOutletId(), shiftId),
    enabled: shiftId !== "",
  });
}

/**
 * Supervisor approves or rejects a held cash out. Refreshes the held list, the
 * review and the shift: an approval moves the amount into the drawer figures.
 */
export function useDecideHeldCashMovement() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DecideHeldCashInput) =>
      decideHeldCashMovement(outletId, input),
    // Settled, not success: a CONFLICT means someone else decided first and
    // the list must catch up. Not awaited: the verdict is already saved, and a
    // failed refetch must not hold the dialog open or hide the result.
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.held(outletId, input.shiftId),
      });
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.review(outletId, input.shiftId),
      });
      void queryClient.invalidateQueries({
        queryKey: posKasirKeys.shift(outletId),
      });
    },
  });
}

/** Other supervisors who may witness a force close. */
export function useForceCloseWitnesses() {
  return useQuery(witnessesQuery(useOutletId()));
}

/** Force close of a shift after the cashier's recount limit (legend-7mlf). */
export function useForceCloseView(shiftId: string) {
  return useQuery({
    ...forceCloseViewQuery(useOutletId(), shiftId),
    enabled: shiftId !== "",
  });
}

function useForceCloseWrite<Input extends { shiftId: string }>(
  call: (input: Input) => Promise<unknown>,
) {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    // A refused write (stale count, spent approval) means the stored state moved.
    onError: (_error, input) =>
      queryClient.invalidateQueries({
        queryKey: posKasirKeys.forceClose(outletId, input.shiftId),
      }),
    onSuccess: async (_view, input) => {
      await queryClient.invalidateQueries({
        queryKey: posKasirKeys.forceClose(outletId, input.shiftId),
      });
      await queryClient.invalidateQueries({
        queryKey: posKasirKeys.held(outletId, input.shiftId),
      });
      await queryClient.invalidateQueries({
        queryKey: posKasirKeys.review(outletId, input.shiftId),
      });
      await queryClient.invalidateQueries({
        queryKey: posKasirKeys.shift(outletId),
      });
    },
  });
}

/** The supervisor counts the drawer; the server stores a forced count. */
export function useSubmitForcedCount() {
  return useForceCloseWrite((input: SubmitForcedCountInput) =>
    submitForcedCount(input),
  );
}

/** A third person (not cashier, not counter) approves that count by PIN. */
export function useWitnessForcedCount() {
  return useForceCloseWrite((input: WitnessForcedCountInput) =>
    witnessForcedCount(input),
  );
}

/** Closes the shift with the approved forced count; once only (button locks while pending). */
export function useForceCloseShift() {
  return useForceCloseWrite((input: ForceCloseInput) => forceCloseShift(input));
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
