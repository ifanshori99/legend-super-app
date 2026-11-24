// The only way components touch statement and period-close data. Queries keep
// endpoint keys; mutations write the period the API returned into the shared
// fiscal-period cache (no refetch race with the read-only list handler) and
// invalidate the requests they change.
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { FiscalPeriod } from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
import { accountingKeys, fiscalPeriodsQuery } from "../ws07-accounting/queries";
import * as api from "./api";
import type {
  BalanceSheetQuery,
  DrillDownQuery,
  MultiEntityQuery,
  OutletStatementQuery,
  PeriodStatementQuery,
} from "./lib";
import { statementKeys } from "./queries";
import {
  balanceSheetStatementQuery,
  cashFlowStatementQuery,
  closeManualJournalsQuery,
  equityChangesStatementQuery,
  multiEntityStatementQuery,
  periodCloseBlockersQuery,
  periodSnapshotQuery,
  profitAndLossStatementQuery,
  reopenRequestsQuery,
  trialBalanceQuery,
} from "./queries";

export {
  useAccounts,
  useFiscalPeriods,
  useLegalEntities,
  useOutlets,
} from "../ws07-accounting/hooks";

export const DRILL_DOWN_PAGE_SIZE = 20;

/** Fiscal periods of several entities (multi-entity official/estimate label). */
export function useEntityFiscalPeriods(legalEntityIds: readonly string[]) {
  return useQueries({
    queries: legalEntityIds.map((legalEntityId) =>
      fiscalPeriodsQuery(legalEntityId),
    ),
  });
}

// ---- Statement queries -----------------------------------------------------

export function useBalanceSheetStatement(
  query: BalanceSheetQuery,
  enabled = true,
) {
  const options = balanceSheetStatementQuery(query);
  return useQuery({ ...options, enabled: options.enabled && enabled });
}

export function useProfitAndLossStatement(
  query: OutletStatementQuery,
  enabled = true,
) {
  const options = profitAndLossStatementQuery(query);
  return useQuery({ ...options, enabled: options.enabled && enabled });
}

export function useCashFlowStatement(
  query: PeriodStatementQuery,
  enabled = true,
) {
  const options = cashFlowStatementQuery(query);
  return useQuery({ ...options, enabled: options.enabled && enabled });
}

export function useEquityChangesStatement(
  query: PeriodStatementQuery,
  enabled = true,
) {
  const options = equityChangesStatementQuery(query);
  return useQuery({ ...options, enabled: options.enabled && enabled });
}

export function useMultiEntityStatement(
  query: MultiEntityQuery,
  enabled = true,
) {
  const options = multiEntityStatementQuery(query);
  return useQuery({ ...options, enabled: options.enabled && enabled });
}

export function useStatementDrillDown(query: DrillDownQuery | null) {
  const fallback: DrillDownQuery = {
    legalEntityId: "none",
    accountId: "none",
    from: "1970-01-01",
    to: "1970-01-01",
  };
  const active = query ?? fallback;
  return useInfiniteQuery({
    queryKey: statementKeys.drillDown(active),
    queryFn: ({ pageParam, signal }) =>
      api.fetchStatementDrillDown(
        {
          legalEntityId: active.legalEntityId,
          accountId: active.accountId,
          from: active.from,
          to: active.to,
          ...(active.outletId ? { outletId: active.outletId } : {}),
          limit: DRILL_DOWN_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    enabled: query !== null,
  });
}

// ---- Close checklist and snapshot -----------------------------------------

export function useTrialBalance(
  legalEntityId: string | undefined,
  asOf: string | undefined,
  enabled = true,
) {
  return useQuery(trialBalanceQuery(legalEntityId, asOf, enabled));
}

export function useCloseManualJournals(
  legalEntityId: string | undefined,
  enabled = true,
) {
  const options = closeManualJournalsQuery(legalEntityId);
  return useQuery({ ...options, enabled: options.enabled && enabled });
}

export function usePeriodSnapshot(
  fiscalPeriodId: string | undefined,
  enabled = true,
) {
  const options = periodSnapshotQuery(fiscalPeriodId, enabled);
  return useQuery(options);
}

/** Parked stock sources of one period; read after a refused close (card 1263). */
export function usePeriodCloseBlockers(
  fiscalPeriodId: string | undefined,
  enabled = true,
) {
  return useQuery(periodCloseBlockersQuery(fiscalPeriodId, enabled));
}

export function useReopenRequests(legalEntityId: string | undefined) {
  return useQuery(reopenRequestsQuery(legalEntityId));
}

// ---- Mutations -------------------------------------------------------------

/**
 * Writes a returned period into the cached list instead of invalidating it:
 * the list read is a shared read-only fixture handler in mock mode, so a
 * refetch would bring back the pre-close row. The API remains the source of
 * the row (status, version, closedAt).
 */
function useApplyPeriod(legalEntityId: string) {
  const queryClient = useQueryClient();
  return (period: FiscalPeriod) => {
    queryClient.setQueryData<FiscalPeriod[]>(
      accountingKeys.fiscalPeriods(legalEntityId),
      (rows) => {
        if (!rows) return rows;
        const next = rows.map((row) => (row.id === period.id ? period : row));
        return next.some((row) => row.id === period.id)
          ? next
          : [...next, period];
      },
    );
  };
}

export function useClosePeriod(legalEntityId: string) {
  const queryClient = useQueryClient();
  const applyPeriod = useApplyPeriod(legalEntityId);
  return useMutation({
    mutationFn: (input: { fiscalPeriodId: string; expectedVersion: number }) =>
      api.closeFiscalPeriod(input.fiscalPeriodId, {
        expectedVersion: input.expectedVersion,
      }),
    onSuccess: (period) => {
      applyPeriod(period);
      void queryClient.invalidateQueries({
        queryKey: statementKeys.snapshot(period.id),
      });
    },
    // The refusal carries no source list: mark the list stale so the dialog
    // reads the current one (refetches at once when it is already showing).
    onError: (error, input) => {
      if (
        error instanceof ApiError &&
        error.code === "PERIOD_INVENTORY_GL_BLOCKED"
      )
        void queryClient.invalidateQueries({
          queryKey: statementKeys.closeBlockers(input.fiscalPeriodId),
        });
    },
  });
}

/**
 * Close over incomplete production batches with a written reason (card 1263).
 * The idempotency key belongs to the attempt, so the caller supplies it.
 */
export function useClosePeriodOverride(legalEntityId: string) {
  const queryClient = useQueryClient();
  const applyPeriod = useApplyPeriod(legalEntityId);
  return useMutation({
    mutationFn: (input: {
      fiscalPeriodId: string;
      expectedVersion: number;
      idempotencyKey: string;
      reason: string;
      sourceIds: string[];
    }) =>
      api.closeFiscalPeriodOverride(input.fiscalPeriodId, {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        sourceIds: input.sourceIds,
      }),
    onSuccess: (period) => {
      applyPeriod(period);
      void queryClient.invalidateQueries({
        queryKey: statementKeys.snapshot(period.id),
      });
      queryClient.removeQueries({
        queryKey: statementKeys.closeBlockers(period.id),
      });
    },
  });
}

export function useRequestPeriodReopen(legalEntityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { fiscalPeriodId: string; reason: string }) =>
      api.requestPeriodReopen(input.fiscalPeriodId, input.reason),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: statementKeys.reopenRequests(legalEntityId),
      }),
  });
}

export function useApprovePeriodReopen(legalEntityId: string) {
  const queryClient = useQueryClient();
  const applyPeriod = useApplyPeriod(legalEntityId);
  return useMutation({
    mutationFn: (input: { requestId: string; note: string | null }) =>
      api.approvePeriodReopen(input.requestId, input.note),
    onSuccess: (result) => {
      applyPeriod(result.period);
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: statementKeys.reopenRequests(legalEntityId),
        }),
        queryClient.invalidateQueries({
          queryKey: statementKeys.snapshot(result.period.id),
        }),
      ]);
    },
  });
}

export function useRejectPeriodReopen(legalEntityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; reason: string }) =>
      api.rejectPeriodReopen(input.requestId, input.reason),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: statementKeys.reopenRequests(legalEntityId),
      }),
  });
}
