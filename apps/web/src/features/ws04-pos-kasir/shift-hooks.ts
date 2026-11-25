// Shift, supervisor and end-of-day hooks of the POS kasir (split from
// ./hooks.ts, brief 1268 W0). Same rules as ./hooks.ts: components import
// hooks and never touch the api or the query cache directly.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { businessDateOf } from "@starter/shared/core";
import { useOutletClock } from "@/lib/tenant-context";
import { useIntentKey, useOutletId, useReady } from "./hooks";
import {
  approveShiftClose,
  closeDay,
  closeShiftWithApproval,
  discardOwnCount,
  openShift,
  recordCashMovement,
  requestOverride,
  submitBlindCount,
} from "./shift-api";
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
  forceCloseViewQuery,
  heldCashOutsQuery,
  ownCountSummaryQuery,
  posKasirKeys,
  registeredTerminalsQuery,
  shiftReviewQuery,
  supervisorsQuery,
  witnessesQuery,
} from "./queries";
import type {
  DecideHeldCashInput,
  ForceCloseInput,
  SubmitForcedCountInput,
  WitnessForcedCountInput,
} from "./shift-extra-types";
import type {
  ApproveShiftCloseInput,
  CloseDayInput,
  CloseShiftWithApprovalInput,
  OpenShiftInput,
  OverrideAction,
  RecordCashMovementInput,
  RequestOverrideInput,
  SubmitBlindCountInput,
} from "./types";
import { ApiError } from "@/lib/api/errors";

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
  const intent = useIntentKey("shift-count");
  return useMutation({
    mutationFn: async (input: SubmitBlindCountInput) => {
      const receipt = await submitBlindCount(
        outletId,
        input,
        intent.keyFor(input),
      );
      intent.clear();
      return receipt;
    },
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

/** The cashier starts a new count; the one on this device stops counting. */
export function useStartRecount() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  return (shiftId: string) => {
    discardOwnCount(outletId, shiftId);
    void queryClient.invalidateQueries({
      queryKey: posKasirKeys.ownCount(outletId, shiftId),
    });
    void queryClient.invalidateQueries({
      queryKey: posKasirKeys.shift(outletId),
    });
  };
}

/** Answers that mean the stored count or approval cannot be used any more. */
const CLOSE_STALE_CODES = new Set([
  "SHIFT_COUNT_STALE",
  "SHIFT_COUNT_SUPERSEDED",
]);
export const isCloseStale = (error: unknown): boolean =>
  error instanceof ApiError && CLOSE_STALE_CODES.has(error.code);
export const isQrisHoldBlock = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "QRIS_HOLD_ACTIVE";

/**
 * The supervisor closes the shift on the cashier's device: PIN override of the
 * count, then the close. Retries repeat the same close key and reuse the
 * approval that was already given (a lost answer closes once, never twice, and
 * does not ask for the PIN again). A stale count drops both, so the next try
 * needs a fresh count and a fresh approval.
 */
export function useCloseShiftWithApproval() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const intent = useIntentKey("shift-close");
  const approval = useRef<{ countId: string; overrideId: string } | null>(null);
  return useMutation({
    mutationFn: async (input: CloseShiftWithApprovalInput) => {
      const reuse =
        approval.current?.countId === input.countId
          ? { overrideId: approval.current.overrideId }
          : null;
      await closeShiftWithApproval(
        outletId,
        input,
        reuse,
        intent.keyFor({ shiftId: input.shiftId, countId: input.countId }),
        (overrideId) => {
          approval.current = { countId: input.countId, overrideId };
        },
      );
      intent.clear();
      approval.current = null;
    },
    onError: (error) => {
      // A refusal is final for this count; only a lost answer may repeat.
      if (error instanceof ApiError && error.status < 500 && error.status > 0) {
        intent.clear();
        approval.current = null;
      }
    },
    onSuccess: (_result, input) => {
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

export function useSupervisorOptions(action?: OverrideAction) {
  return useQuery(supervisorsQuery(useOutletId(), action));
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
