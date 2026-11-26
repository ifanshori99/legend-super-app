// Shift, supervisor and end-of-day hooks of the POS kasir (split from
// ./hooks.ts, brief 1268 W0). Same rules as ./hooks.ts: components import
// hooks and never touch the api or the query cache directly.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useMemo } from "react";
import { businessDateOf } from "@starter/shared/core";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOutletClock } from "@/lib/tenant-context";
import { useCurrentUserId, useIntentKey, useOutletId, useReady } from "./hooks";
import type { CloudPrintLoader } from "./print/cloud-print";
import {
  approveShiftClose,
  closeDay,
  discardOwnCount,
  fetchShiftPrint,
  isCloseSettled,
  openShift,
  recordCashMovement,
  requestOverride,
  submitBlindCount,
} from "./shift-api";
import { createCloseFlow } from "./shift-close-flow";
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
import {
  MOCK_COUNTER_NAME,
  type ApproveForcedCountInput,
  type DecideHeldCashInput,
  type ForceCloseInput,
  type ForceCloseViewer,
  type SubmitForcedCountInput,
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

/**
 * The supervisor closes the shift on the cashier's device: PIN override of the
 * count, then the close (`./shift-close-flow.ts`). Once the PIN was accepted a
 * retry (`retry`) sends the stored body again with no new PIN, so a lost answer
 * closes once. A stale count or a definite refusal drops the approval; "already
 * closed" reads the shift again.
 */
export function useCloseShiftWithApproval() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const flow = useMemo(() => createCloseFlow(outletId), [outletId]);
  const refresh = (shiftId: string) => {
    void queryClient.invalidateQueries({
      queryKey: posKasirKeys.ownCount(outletId, shiftId),
    });
    return queryClient.invalidateQueries({
      queryKey: posKasirKeys.shift(outletId),
    });
  };
  const mutation = useMutation({
    mutationFn: (input: CloseShiftWithApprovalInput) => flow.run(input),
    onError: (error, input) => {
      if (isCloseSettled(error)) void refresh(input.shiftId);
    },
    onSuccess: (_result, input) => refresh(input.shiftId),
  });
  const pending = flow.pending();
  return {
    ...mutation,
    /** The approval was given but the answer is unknown: only "retry" is left. */
    canRetry: mutation.isError && pending !== null,
    retry: () => {
      if (pending) mutation.mutate(pending);
    },
  };
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

/** The signed-in supervisor who counts and closes (mock: the mock counter). */
export function useForceCloseViewer(): ForceCloseViewer {
  const userId = useCurrentUserId();
  const name = useRouteContext({
    strict: false,
    select: (context) => context.session?.user.name,
  });
  return { userId, name: API_MOCK ? MOCK_COUNTER_NAME : (name ?? "") };
}

/** Force close of a shift: by the recount limit or a lost tablet (O4). */
export function useForceCloseView(shiftId: string) {
  const viewer = useForceCloseViewer();
  return useQuery({
    ...forceCloseViewQuery(useOutletId(), shiftId, viewer),
    enabled: shiftId !== "" && (API_MOCK || viewer.userId !== ""),
  });
}

function useForceCloseWrite<Input extends { shiftId: string }>(
  call: (outletId: string, input: Input) => Promise<unknown>,
) {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Input) => call(outletId, input),
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
  const intent = useIntentKey("force-count");
  return useForceCloseWrite(async (outletId, input: SubmitForcedCountInput) => {
    const result = await submitForcedCount(
      outletId,
      input,
      intent.keyFor(input),
    );
    intent.clear();
    return result;
  });
}

/** A third person (not cashier, not counter) approves that count by PIN. */
export function useWitnessForcedCount(cashierId?: string) {
  const viewer = useForceCloseViewer();
  return useForceCloseWrite((outletId, input: ApproveForcedCountInput) =>
    witnessForcedCount(outletId, input, viewer, { cashierId }),
  );
}

/** Closes the shift with the approved forced count; once per intent. */
export function useForceCloseShift() {
  const intent = useIntentKey("force-close");
  return useForceCloseWrite(async (outletId, input: ForceCloseInput) => {
    const result = await forceCloseShift(outletId, input, intent.keyFor(input));
    intent.clear();
    return result;
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

/** P3: loads the closing report's ESC/POS bytes for this tablet's printer. */
export function useShiftPrintLoader(shiftId: string): CloudPrintLoader {
  const outletId = useOutletId();
  return ({ paperWidth, reprint }) =>
    fetchShiftPrint(outletId, shiftId, paperWidth, reprint);
}
