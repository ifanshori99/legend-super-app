// Query keys and options for the financial statements and period close
// screens. Keys hang under the existing accounting root, so one invalidation
// from the back office refreshes these screens too.
import { queryOptions } from "@tanstack/react-query";
import { accountingKeys } from "../ws07-accounting/queries";
import {
  fetchBalanceSheet,
  fetchCashFlow,
  fetchEquityChanges,
  fetchManualJournals,
  fetchMultiEntityProfitAndLoss,
  fetchPeriodCloseBlockers,
  fetchPeriodReopenRequests,
  fetchPeriodSnapshot,
  fetchProfitAndLoss,
  fetchTrialBalance,
} from "./api";
import type {
  BalanceSheetQuery,
  MultiEntityQuery,
  OutletStatementQuery,
  PeriodStatementQuery,
} from "./lib";

/** The checklist needs every manual journal of the entity, not one page. */
export const CLOSE_CHECKLIST_JOURNAL_LIMIT = 100;

export const statementKeys = {
  all: [...accountingKeys.all, "statements"] as const,
  trialBalance: (legalEntityId: string, asOf: string) =>
    [...statementKeys.all, "trial-balance", legalEntityId, asOf] as const,
  balanceSheet: (query: BalanceSheetQuery) =>
    [...statementKeys.all, "balance-sheet", query] as const,
  profitAndLoss: (query: OutletStatementQuery) =>
    [...statementKeys.all, "profit-and-loss", query] as const,
  cashFlow: (query: PeriodStatementQuery) =>
    [...statementKeys.all, "cash-flow", query] as const,
  equityChanges: (query: PeriodStatementQuery) =>
    [...statementKeys.all, "equity-changes", query] as const,
  multiEntity: (query: MultiEntityQuery) =>
    [...statementKeys.all, "multi-entity", query] as const,
  drillDown: (query: {
    legalEntityId: string;
    accountId: string;
    from: string;
    to: string;
    outletId?: string;
  }) => [...statementKeys.all, "drill-down", query] as const,
  snapshot: (fiscalPeriodId: string) =>
    [...statementKeys.all, "period-snapshot", fiscalPeriodId] as const,
  closeBlockers: (fiscalPeriodId: string) =>
    [...statementKeys.all, "close-blockers", fiscalPeriodId] as const,
  reopenRequests: (legalEntityId: string) =>
    [...statementKeys.all, "reopen-requests", legalEntityId] as const,
  closeManualJournals: (legalEntityId: string) =>
    [...statementKeys.all, "close-manual-journals", legalEntityId] as const,
};

export function trialBalanceQuery(
  legalEntityId: string | undefined,
  asOf: string | undefined,
  enabled = true,
) {
  return queryOptions({
    queryKey: statementKeys.trialBalance(
      legalEntityId ?? "none",
      asOf ?? "none",
    ),
    queryFn: ({ signal }) =>
      fetchTrialBalance(
        { legalEntityId: legalEntityId ?? "", asOf: asOf ?? "" },
        signal,
      ),
    enabled: enabled && Boolean(legalEntityId && asOf),
  });
}

export function balanceSheetStatementQuery(query: BalanceSheetQuery) {
  return queryOptions({
    queryKey: statementKeys.balanceSheet(query),
    queryFn: ({ signal }) => fetchBalanceSheet(query, signal),
    enabled: Boolean(query.legalEntityId && query.asOf),
  });
}

export function profitAndLossStatementQuery(query: OutletStatementQuery) {
  return queryOptions({
    queryKey: statementKeys.profitAndLoss(query),
    queryFn: ({ signal }) => fetchProfitAndLoss(query, signal),
    enabled: Boolean(query.legalEntityId && query.from && query.to),
  });
}

export function cashFlowStatementQuery(query: PeriodStatementQuery) {
  return queryOptions({
    queryKey: statementKeys.cashFlow(query),
    queryFn: ({ signal }) => fetchCashFlow(query, signal),
    enabled: Boolean(query.legalEntityId && query.from && query.to),
  });
}

export function equityChangesStatementQuery(query: PeriodStatementQuery) {
  return queryOptions({
    queryKey: statementKeys.equityChanges(query),
    queryFn: ({ signal }) => fetchEquityChanges(query, signal),
    enabled: Boolean(query.legalEntityId && query.from && query.to),
  });
}

export function multiEntityStatementQuery(query: MultiEntityQuery) {
  return queryOptions({
    queryKey: statementKeys.multiEntity(query),
    queryFn: ({ signal }) => fetchMultiEntityProfitAndLoss(query, signal),
    enabled: Boolean(query.from && query.to),
  });
}

export function periodSnapshotQuery(
  fiscalPeriodId: string | undefined,
  enabled = true,
) {
  return queryOptions({
    queryKey: statementKeys.snapshot(fiscalPeriodId ?? "none"),
    queryFn: ({ signal }) => fetchPeriodSnapshot(fiscalPeriodId ?? "", signal),
    enabled: enabled && Boolean(fiscalPeriodId),
  });
}

export function reopenRequestsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: statementKeys.reopenRequests(legalEntityId ?? "none"),
    queryFn: ({ signal }) =>
      fetchPeriodReopenRequests(legalEntityId ?? "", signal),
    enabled: Boolean(legalEntityId),
  });
}

export function closeManualJournalsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: statementKeys.closeManualJournals(legalEntityId ?? "none"),
    queryFn: ({ signal }) =>
      fetchManualJournals(
        {
          legalEntityId: legalEntityId ?? "",
          limit: CLOSE_CHECKLIST_JOURNAL_LIMIT,
        },
        signal,
      ),
    enabled: Boolean(legalEntityId),
  });
}

/**
 * The list is only meaningful at the moment of a refused close and an override
 * sends exactly what it shows, so it is never served from cache.
 */
export function periodCloseBlockersQuery(
  fiscalPeriodId: string | undefined,
  enabled = true,
) {
  return queryOptions({
    queryKey: statementKeys.closeBlockers(fiscalPeriodId ?? "none"),
    queryFn: ({ signal }) =>
      fetchPeriodCloseBlockers(fiscalPeriodId ?? "", signal),
    enabled: enabled && Boolean(fiscalPeriodId),
    staleTime: 0,
    gcTime: 0,
    // The closer acknowledges the list on screen: it must not change by itself
    // behind an open confirmation. It is read again after a refusal.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
