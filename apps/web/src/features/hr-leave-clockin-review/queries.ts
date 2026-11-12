// Query keys and options for the HR review of clock-ins on approved leave days
// (bead legend-3jem1). Hierarchical under "leave-clockin-review" so one
// invalidation after a decision refreshes the queue and every open detail.
//
// Not prefetched during SSR: the screens read the outlet from the tenant
// context and the data is behind the HR permission, so they fetch in the
// browser after hydration (hooks.ts).
import { queryOptions, replaceEqualDeep } from "@tanstack/react-query";
import type { OutletId } from "@starter/shared/core";
import type { AttendanceLogId } from "@starter/shared/hris";
import { keepDecidedLeave } from "./enrich.ts";
import {
  fetchLeaveReviewItemByLogId,
  fetchLeaveReviewItems,
  loadLeaveClockinCases,
} from "./api.ts";
import type { LeaveClockinCase } from "./types.ts";

export const leaveClockinKeys = {
  all: ["leave-clockin-review"] as const,
  cases: (outletId: string | undefined) =>
    [...leaveClockinKeys.all, "cases", outletId ?? "none"] as const,
  detail: (outletId: string | undefined, logId: string) =>
    [...leaveClockinKeys.all, "case", outletId ?? "none", logId] as const,
};

/** The queue of cases waiting for an HR decision (pending, leave flag only). */
export function leaveClockinCasesQuery(
  outletId: OutletId | undefined,
  timeZone: string,
) {
  return queryOptions({
    queryKey: leaveClockinKeys.cases(outletId),
    // No outlet (platform account, tenant context missing): an empty queue,
    // not a query that stays pending forever.
    queryFn: async ({ signal }): Promise<LeaveClockinCase[]> => {
      if (outletId === undefined) return [];
      const items = await fetchLeaveReviewItems(outletId, "pending", signal);
      return loadLeaveClockinCases(items, outletId, timeZone, signal);
    },
    staleTime: 15_000,
  });
}

/**
 * One case by log id, open or already decided (the result page and a deep
 * link both need it), read with the server's `logId` filter. Null = not found.
 */
export function leaveClockinCaseQuery(
  outletId: OutletId | undefined,
  timeZone: string,
  logId: string,
) {
  return queryOptions({
    queryKey: leaveClockinKeys.detail(outletId, logId),
    queryFn: async ({ signal }): Promise<LeaveClockinCase | null> => {
      if (outletId === undefined) return null;
      const item = await fetchLeaveReviewItemByLogId(
        outletId,
        logId as AttendanceLogId,
        signal,
      );
      if (item === null) return null;
      const [found] = await loadLeaveClockinCases(
        [item],
        outletId,
        timeZone,
        signal,
      );
      return found ?? null;
    },
    staleTime: 15_000,
    // A refetch after "cancel leave" finds no approved leave any more: keep the
    // leave and kind the screen already shows instead of blanking them.
    structuralSharing: (oldData, newData) =>
      replaceEqualDeep(
        oldData,
        keepDecidedLeave(
          oldData as LeaveClockinCase | null | undefined,
          newData as LeaveClockinCase | null | undefined,
        ),
      ),
  });
}

/** A case from an already-loaded queue, so the detail opens without a fetch. */
export function findCachedCase(
  cases: readonly LeaveClockinCase[] | undefined,
  logId: string,
): LeaveClockinCase | undefined {
  return cases?.find((row) => row.logId === logId);
}
