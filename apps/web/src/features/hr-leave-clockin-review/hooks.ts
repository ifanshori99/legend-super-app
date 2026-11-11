// Custom hooks of the HR review of clock-ins on approved leave days (bead
// legend-3jem1): the only way the screens touch its data (docs/frontend.md
// "Custom hooks"). Components never see raw contract rows, only
// `LeaveClockinCase` from types.ts.
import { useSyncExternalStore } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { DEFAULT_TIME_ZONE, type OutletId } from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import type { AreaAccess } from "@/lib/areas/access";
import { useTenantContext } from "@/lib/tenant-context";
import { useHydrated } from "../ws10-attendance-qr/use-hydrated.ts";
import { postLeaveClockinDecision } from "./api.ts";
import { applyDecidedItem } from "./enrich.ts";
import { leaveClockinPermissions } from "./guard.ts";
import { mockLeaveKeepOnly } from "./mock-switches.ts";
import {
  findCachedCase,
  leaveClockinCaseQuery,
  leaveClockinCasesQuery,
  leaveClockinKeys,
} from "./queries.ts";
import type {
  LeaveClockinAction,
  LeaveClockinCase,
  LeaveClockinPermissions,
} from "./types.ts";

/** The outlet the review works in: id and time zone from the tenant context. */
function useReviewOutlet(): {
  outletId: OutletId | undefined;
  timeZone: string;
  enabled: boolean;
} {
  const { outlet } = useTenantContext();
  const hydrated = useHydrated();
  return {
    outletId: outlet?.id,
    timeZone: outlet?.timeZone ?? DEFAULT_TIME_ZONE,
    // No outlet still runs the query: it answers empty / not found.
    enabled: hydrated,
  };
}

/** Cases waiting for an HR decision in the current outlet (pending, newest first). */
export function useLeaveClockinCases(): UseQueryResult<LeaveClockinCase[]> {
  const { outletId, timeZone, enabled } = useReviewOutlet();
  return useQuery({
    ...leaveClockinCasesQuery(outletId, timeZone),
    enabled,
  });
}

/**
 * One case by log id, decided or not. Starts from the queue cache when the
 * case is there (no spinner when coming from the queue), otherwise loads it.
 * `data === null` means no such case.
 */
export function useLeaveClockinCase(
  logId: string,
): UseQueryResult<LeaveClockinCase | null> {
  const { outletId, timeZone, enabled } = useReviewOutlet();
  const queryClient = useQueryClient();
  return useQuery({
    ...leaveClockinCaseQuery(outletId, timeZone, logId),
    enabled,
    initialData: () =>
      findCachedCase(
        queryClient.getQueryData<LeaveClockinCase[]>(
          leaveClockinKeys.cases(outletId),
        ),
        logId,
      ),
    initialDataUpdatedAt: () =>
      queryClient.getQueryState(leaveClockinKeys.cases(outletId))
        ?.dataUpdatedAt,
  });
}

export type DecideLeaveClockinInput = {
  case: LeaveClockinCase;
  action: LeaveClockinAction;
  /**
   * Owned by the caller: one key per confirmation session, reused when the
   * same confirmation is retried (so a replay never records two decisions).
   */
  idempotencyKey: string;
};

/**
 * Records the decision. The caller supplies the idempotency key. Success
 * returns the updated case (decision follows the confirmed action), stores it
 * in the detail cache so the result page survives the pending queue dropping
 * it, and refreshes the queue without waiting. A 409 means the server state
 * moved on: the case and the queue are refreshed.
 */
export function useDecideLeaveClockin(): UseMutationResult<
  LeaveClockinCase,
  ApiError,
  DecideLeaveClockinInput
> {
  const queryClient = useQueryClient();
  return useMutation<LeaveClockinCase, ApiError, DecideLeaveClockinInput>({
    mutationFn: async ({ case: current, action, idempotencyKey }) => {
      const decided = await postLeaveClockinDecision(
        current.item,
        action,
        idempotencyKey,
      );
      return applyDecidedItem(current, decided, action);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(
        leaveClockinKeys.detail(updated.outletId, updated.logId),
        updated,
      );
      void queryClient.invalidateQueries({
        queryKey: leaveClockinKeys.cases(updated.outletId),
      });
    },
    onError: (error, { case: current }) => {
      if (error.status !== 409) return;
      void queryClient.invalidateQueries({
        queryKey: leaveClockinKeys.detail(current.outletId, current.logId),
      });
      void queryClient.invalidateQueries({
        queryKey: leaveClockinKeys.cases(current.outletId),
      });
    },
  });
}

function subscribeNever() {
  return () => {};
}

/** Mock-only "cannot cancel leave" switch; false on the server and in real mode. */
function useMockKeepOnly(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => API_MOCK && mockLeaveKeepOnly(),
    () => false,
  );
}

/**
 * What the signed-in reviewer may decide. Fails closed when the route context
 * carries no access. The server re-checks per outlet; a 403 is still handled
 * through `leaveClockinErrorKey`.
 */
export function useLeaveClockinPermissions(): LeaveClockinPermissions {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  const keepOnly = useMockKeepOnly();
  const permissions = leaveClockinPermissions(context.access);
  return keepOnly ? { ...permissions, canCancelLeave: false } : permissions;
}

/** Contract 409 codes that have their own human message. */
const SPECIFIC_ERROR_CODES = [
  "ATTENDANCE_LEAVE_MULTI_DAY",
  "ATTENDANCE_LEAVE_DECISION_NOT_ALLOWED",
  "ATTENDANCE_LEAVE_NOT_APPROVED",
  "ATTENDANCE_LEAVE_NOT_REACHABLE",
  "ATTENDANCE_LEAVE_DAYS_MISMATCH",
  "ATTENDANCE_LEAVE_STILL_APPROVED",
  "ATTENDANCE_LEAVE_DECISION_REQUIRED",
  "ATTENDANCE_REVIEW_NOT_ALLOWED",
  "ATTENDANCE_CORRECTION_LEAVE_DAY",
] as const;

/**
 * i18n key of the message for a failed decision: the specific 409 codes, 403
 * (no right), 404, and a network failure (there is no `errors.network` in the
 * catalog; the confirm dialog's offline line is the same sentence). Anything
 * else is the generic message. Never the raw code or server text.
 */
export function leaveClockinErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 0 || error.code === "NETWORK_ERROR")
      return "leaveClockinReview.confirmFailed.offline";
    const code = SPECIFIC_ERROR_CODES.find((known) => known === error.code);
    if (code !== undefined) return `leaveClockinReview.errors.${code}`;
    if (error.status === 403) return "leaveClockinReview.errors.forbidden";
    if (error.status === 404) return "leaveClockinReview.errors.notFound";
  }
  return "leaveClockinReview.errors.unknown";
}
