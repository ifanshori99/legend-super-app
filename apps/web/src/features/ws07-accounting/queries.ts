// Query keys and options of the accounting back office. Hierarchical under
// "accounting" so one invalidation refreshes every screen a write can affect.
import { queryOptions } from "@tanstack/react-query";
import type {
  JournalSourceType,
  ManualJournalStatus,
} from "@starter/shared/accounting";
import {
  fetchAccounts,
  fetchFiscalPeriods,
  fetchJournal,
  fetchLegalEntities,
  fetchManualJournal,
  fetchManualJournals,
  fetchOutlets,
  fetchRecurringJournals,
} from "./api";

export const JOURNAL_PAGE_SIZE = 20;
export const MANUAL_PAGE_SIZE = 20;

export type JournalListFilters = {
  legalEntityId: string;
  from: string;
  to: string;
  sourceType?: JournalSourceType;
  accountId?: string;
};

export type ManualJournalListFilters = {
  legalEntityId: string;
  status?: ManualJournalStatus;
};

export const accountingKeys = {
  all: ["accounting"] as const,
  legalEntities: () => [...accountingKeys.all, "legal-entities"] as const,
  outlets: () => [...accountingKeys.all, "outlets"] as const,
  accounts: (legalEntityId: string) =>
    [...accountingKeys.all, "accounts", legalEntityId] as const,
  fiscalPeriods: (legalEntityId: string) =>
    [...accountingKeys.all, "fiscal-periods", legalEntityId] as const,
  journals: () => [...accountingKeys.all, "journals"] as const,
  journalList: (filters: JournalListFilters) =>
    [...accountingKeys.journals(), filters] as const,
  journal: (journalEntryId: string) =>
    [...accountingKeys.all, "journal", journalEntryId] as const,
  manualJournals: () => [...accountingKeys.all, "manual-journals"] as const,
  manualJournalList: (filters: ManualJournalListFilters) =>
    [...accountingKeys.manualJournals(), filters] as const,
  manualJournal: (manualJournalId: string) =>
    [...accountingKeys.all, "manual-journal", manualJournalId] as const,
  recurringJournals: (legalEntityId: string) =>
    [...accountingKeys.all, "recurring-journals", legalEntityId] as const,
};

export function legalEntitiesQuery() {
  return queryOptions({
    queryKey: accountingKeys.legalEntities(),
    queryFn: ({ signal }) => fetchLegalEntities(signal),
    staleTime: 5 * 60 * 1000,
  });
}

/** Outlet reference data: names and codes for journal-line attribution. */
export function outletsQuery() {
  return queryOptions({
    queryKey: accountingKeys.outlets(),
    queryFn: ({ signal }) => fetchOutlets(signal),
    staleTime: 5 * 60 * 1000,
  });
}

export function accountsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: accountingKeys.accounts(legalEntityId ?? "none"),
    queryFn: ({ signal }) => fetchAccounts(legalEntityId ?? "", signal),
    enabled: Boolean(legalEntityId),
  });
}

export function fiscalPeriodsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: accountingKeys.fiscalPeriods(legalEntityId ?? "none"),
    queryFn: ({ signal }) => fetchFiscalPeriods(legalEntityId ?? "", signal),
    enabled: Boolean(legalEntityId),
    staleTime: 60 * 1000,
  });
}

export function journalQuery(journalEntryId: string | undefined) {
  return queryOptions({
    queryKey: accountingKeys.journal(journalEntryId ?? "none"),
    queryFn: ({ signal }) => fetchJournal(journalEntryId ?? "", signal),
    enabled: Boolean(journalEntryId),
  });
}

export function manualJournalsQuery(filters: ManualJournalListFilters) {
  return queryOptions({
    queryKey: accountingKeys.manualJournalList(filters),
    queryFn: ({ signal }) =>
      fetchManualJournals(
        {
          legalEntityId: filters.legalEntityId,
          limit: MANUAL_PAGE_SIZE,
          ...(filters.status ? { status: filters.status } : {}),
        },
        signal,
      ),
    enabled: Boolean(filters.legalEntityId),
  });
}

export function manualJournalQuery(manualJournalId: string | undefined) {
  return queryOptions({
    queryKey: accountingKeys.manualJournal(manualJournalId ?? "none"),
    queryFn: ({ signal }) => fetchManualJournal(manualJournalId ?? "", signal),
    enabled: Boolean(manualJournalId),
  });
}

export function recurringJournalsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: accountingKeys.recurringJournals(legalEntityId ?? "none"),
    queryFn: ({ signal }) =>
      fetchRecurringJournals(legalEntityId ?? "", signal),
    enabled: Boolean(legalEntityId),
  });
}
