// The only way components touch accounting data: queries keep their endpoint
// keys, mutations invalidate every endpoint whose rows a write can change.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type {
  createAccount as createAccountEndpoint,
  createManualJournal as createManualJournalEndpoint,
  createRecurringJournal as createRecurringJournalEndpoint,
  transitionRecurringJournalEndpoint,
  updateAccount as updateAccountEndpoint,
  updateManualJournal as updateManualJournalEndpoint,
} from "@starter/shared/accounting";
import type { EndpointInput } from "@starter/shared/api";
import * as api from "./api";
import {
  accountingKeys,
  accountsQuery,
  fiscalPeriodsQuery,
  JOURNAL_PAGE_SIZE,
  MANUAL_PAGE_SIZE,
  journalQuery,
  legalEntitiesQuery,
  manualJournalQuery,
  outletsQuery,
  recurringJournalsQuery,
  type JournalListFilters,
  type ManualJournalListFilters,
} from "./queries";

// ---- Queries --------------------------------------------------------------

export function useLegalEntities() {
  return useQuery(legalEntitiesQuery());
}

export function useOutlets() {
  return useQuery(outletsQuery());
}

export function useAccounts(legalEntityId: string | undefined) {
  return useQuery(accountsQuery(legalEntityId));
}

export function useFiscalPeriods(legalEntityId: string | undefined) {
  return useQuery(fiscalPeriodsQuery(legalEntityId));
}

/**
 * The entity the screens work on: the picker's value, or the first legal
 * entity once the list arrives (Cafe Legend has one). Screens never hard-code
 * an id; an empty list renders the entity empty state.
 */
export function useSelectedEntity(
  entities: readonly { id: string; name: string }[],
  selectedId: string | null,
) {
  return useMemo(() => {
    const match = entities.find((entity) => entity.id === selectedId);
    return match ?? entities[0];
  }, [entities, selectedId]);
}

/** The picker's state: list, current entity and a setter, in one hook. */
export function useEntityPicker() {
  const entitiesQuery = useLegalEntities();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const entities = entitiesQuery.data ?? [];
  const entity = useSelectedEntity(entities, selectedId);
  return {
    entitiesQuery,
    entities,
    entity,
    selectEntity: setSelectedId,
  };
}

/** Cursor pages appended as the user asks for more (D-CORE-5). */
export function useJournalsInfinite(filters: JournalListFilters) {
  return useInfiniteQuery({
    queryKey: accountingKeys.journalList(filters),
    queryFn: ({ pageParam, signal }) =>
      api.fetchJournals(
        {
          legalEntityId: filters.legalEntityId,
          from: filters.from,
          to: filters.to,
          limit: JOURNAL_PAGE_SIZE,
          ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
          ...(filters.accountId ? { accountId: filters.accountId } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    enabled: Boolean(filters.legalEntityId && filters.from && filters.to),
  });
}

export function useJournal(journalEntryId: string | undefined) {
  return useQuery(journalQuery(journalEntryId));
}

export function useManualJournalsInfinite(filters: ManualJournalListFilters) {
  return useInfiniteQuery({
    queryKey: accountingKeys.manualJournalList(filters),
    queryFn: ({ pageParam, signal }) =>
      api.fetchManualJournals(
        {
          legalEntityId: filters.legalEntityId,
          limit: MANUAL_PAGE_SIZE,
          ...(filters.status ? { status: filters.status } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    enabled: Boolean(filters.legalEntityId),
  });
}

export function useManualJournal(manualJournalId: string | undefined) {
  return useQuery(manualJournalQuery(manualJournalId));
}

export function useRecurringJournals(legalEntityId: string | undefined) {
  return useQuery(recurringJournalsQuery(legalEntityId));
}

// ---- Mutations ------------------------------------------------------------

function useInvalidate() {
  const queryClient = useQueryClient();
  return (queryKey: readonly unknown[]) =>
    queryClient.invalidateQueries({ queryKey });
}

export type CreateAccountBody = EndpointInput<
  typeof createAccountEndpoint
>["body"];
export type UpdateAccountBody = EndpointInput<
  typeof updateAccountEndpoint
>["body"];
export type CreateManualJournalBody = Omit<
  EndpointInput<typeof createManualJournalEndpoint>["body"],
  "idempotencyKey"
>;
export type UpdateManualJournalBody = EndpointInput<
  typeof updateManualJournalEndpoint
>["body"];
export type CreateRecurringJournalBody = Omit<
  EndpointInput<typeof createRecurringJournalEndpoint>["body"],
  "idempotencyKey"
>;
export type RecurringTransitionBody = EndpointInput<
  typeof transitionRecurringJournalEndpoint
>["body"];

export function useCreateAccount(legalEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateAccountBody) =>
      api.createAccount(legalEntityId ?? "", body),
    onSuccess: () =>
      invalidate(accountingKeys.accounts(legalEntityId ?? "none")),
  });
}

export function useUpdateAccount(legalEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      accountId,
      body,
    }: {
      accountId: string;
      body: UpdateAccountBody;
    }) => api.updateAccount(accountId, body),
    onSuccess: () =>
      invalidate(accountingKeys.accounts(legalEntityId ?? "none")),
  });
}

export function useCreateManualJournal() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateManualJournalBody) =>
      api.createManualJournal(body),
    onSuccess: () => invalidate(accountingKeys.manualJournals()),
  });
}

export function useUpdateManualJournal(manualJournalId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: UpdateManualJournalBody) =>
      api.updateManualJournal(manualJournalId ?? "", body),
    onSuccess: () =>
      Promise.all([
        invalidate(accountingKeys.manualJournal(manualJournalId ?? "none")),
        invalidate(accountingKeys.manualJournals()),
      ]),
  });
}

/** Save the form as a draft, then submit it for approval in one go. */
export function useSaveAndSubmitManualJournal() {
  const invalidate = useInvalidate();
  const refresh = (journalId: string | undefined) =>
    Promise.all([
      invalidate(accountingKeys.manualJournal(journalId ?? "none")),
      invalidate(accountingKeys.manualJournals()),
      invalidate(accountingKeys.journals()),
    ]);
  return useMutation({
    mutationFn: api.saveAndSubmitManualJournal,
    onSuccess: (_journal, input) => refresh(input.journalId),
    // A saved draft exists even when the submit step failed.
    onError: (error, input) => {
      if (error instanceof api.SubmitAfterSaveError)
        return refresh(input.journalId);
    },
  });
}

/** Approve posts the entry in the same transaction (ACC-01 / AUTH-06). */
export function useManualJournalCommand(manualJournalId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      command,
      reason,
    }: {
      command: api.ManualJournalCommand;
      reason?: string;
    }) =>
      api.runManualJournalCommand(command, manualJournalId ?? "", { reason }),
    onSuccess: () =>
      Promise.all([
        invalidate(accountingKeys.manualJournal(manualJournalId ?? "none")),
        invalidate(accountingKeys.manualJournals()),
        invalidate(accountingKeys.journals()),
      ]),
  });
}

export function useReverseJournal(journalEntryId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { entryDate: string; reason: string }) =>
      api.reverseJournal(journalEntryId ?? "", body),
    onSuccess: (entry) =>
      Promise.all([
        invalidate(accountingKeys.journals()),
        invalidate(accountingKeys.journal(journalEntryId ?? "none")),
        invalidate(accountingKeys.journal(entry.id)),
      ]),
  });
}

export function useCreateRecurringJournal(legalEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateRecurringJournalBody) =>
      api.createRecurringJournal(body),
    onSuccess: () =>
      invalidate(accountingKeys.recurringJournals(legalEntityId ?? "none")),
  });
}

export function useTransitionRecurringJournal(
  legalEntityId: string | undefined,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      recurringJournalId,
      body,
    }: {
      recurringJournalId: string;
      body: RecurringTransitionBody;
    }) => api.transitionRecurringJournal(recurringJournalId, body),
    onSuccess: () =>
      invalidate(accountingKeys.recurringJournals(legalEntityId ?? "none")),
  });
}
