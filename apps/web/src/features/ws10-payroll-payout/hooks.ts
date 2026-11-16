// The only way components touch payout data. Queries keep their endpoint keys;
// every write refreshes the batch, the run's batch list and the payable runs,
// because a settled batch can make its run paid.
//
// Mutation arguments are objects that carry the batch id next to the request
// body, e.g. `useConfirmBatch().mutate({ batchId, results, password })`.
import * as React from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getDisbursementBatch,
  getPayoutConfig,
  listPayoutBatches,
  listResolutionProposals,
  listRunDisbursementBatches,
} from "@starter/shared/hris/payroll/payout";
import type {
  PayrollPayoutEvidenceUploadDto,
  PayrollPayoutProposalDto,
} from "@starter/shared/types";
import type { PayoutBankFormat } from "@starter/shared/validators/payroll-payout";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";
import type {
  ApproveBatchInput,
  CancelBatchInput,
  ConfirmCashInput,
  ConfirmItemsInput,
  CreateBatchInput,
  PayableRun,
  PayoutEmployee,
  ResolveItemsInput,
  ReturnItemsInput,
  UpsertConfigInput,
  WithdrawProposalInput,
} from "./api";
import { maskedAccountDisplay } from "./lib";
import {
  batchQuery,
  configQuery,
  employeesQuery,
  entityBatchesQuery,
  legalEntitiesQuery,
  paidRunsQuery,
  payableRunsQuery,
  payoutKeys,
  resolutionProposalsQuery,
  runBatchesQuery,
  sourceAccountsQuery,
} from "./queries";

// ---- Queries ---------------------------------------------------------------

/** The tenant's legal entities (PT). */
export function usePayoutLegalEntities() {
  return useQuery(legalEntitiesQuery());
}

/**
 * `data` is null until the PT has saved a config. `fresh` never trusts the
 * cache: the screen refetches on open and on window focus, because a person is
 * about to approve what they see (the source account is frozen at approval).
 */
export function usePayoutConfig(
  legalEntityId: string | undefined,
  options: { fresh?: boolean } = {},
) {
  return useQuery({
    ...configQuery(legalEntityId ?? ""),
    enabled: Boolean(legalEntityId),
    ...(options.fresh
      ? {
          staleTime: 0,
          refetchOnMount: "always" as const,
          refetchOnWindowFocus: "always" as const,
        }
      : {}),
  });
}

/** Bank accounts of the PT; `maskedNumber` reads "●●●● 4821". */
export function usePayoutSourceAccounts(legalEntityId: string | undefined) {
  return useQuery({
    ...sourceAccountsQuery(legalEntityId ?? ""),
    enabled: Boolean(legalEntityId),
    select: (rows) =>
      rows.map((row) => ({
        ...row,
        maskedNumber: maskedAccountDisplay(row.maskedNumber),
      })),
  });
}

/** Locked runs of the PT that are not paid yet, newest period first. */
export function usePayableRuns(legalEntityId: string | undefined) {
  return useQuery({
    ...payableRunsQuery(legalEntityId ?? ""),
    enabled: Boolean(legalEntityId),
  });
}

export function useRunBatches(runId: string | undefined) {
  return useQuery({ ...runBatchesQuery(runId ?? ""), enabled: Boolean(runId) });
}

export function useBatch(batchId: string | undefined) {
  return useQuery({ ...batchQuery(batchId ?? ""), enabled: Boolean(batchId) });
}

/**
 * Batches of the PT, newest first, a page of 20 at a time (one list request,
 * not one per run). `entries` pairs each payable run with the batches loaded so
 * far. A batch is always created after its run is locked, so pages load by
 * themselves until the oldest loaded batch is older than the oldest lock of the
 * shown runs (at most MAX_AUTO_PAGES pages); after that every batch of a shown
 * run is loaded, and `fetchNextPage()` ("Muat lagi") only reaches older history.
 * `includePaid` adds the newest paid runs, for screens that follow a batch after
 * its run left the "locked" list (the Status tab).
 */
const MAX_AUTO_PAGES = 10;

export function useEntityBatches(
  legalEntityId: string | undefined,
  options: { includePaid?: boolean } = {},
) {
  const runs = usePayableRuns(legalEntityId);
  const paid = useQuery({
    ...paidRunsQuery(legalEntityId ?? ""),
    enabled: Boolean(legalEntityId) && options.includePaid === true,
  });
  const list = useInfiniteQuery({
    ...entityBatchesQuery(legalEntityId ?? ""),
    enabled: Boolean(legalEntityId),
  });
  const allRuns = [
    ...(runs.data ?? []),
    ...(options.includePaid ? (paid.data ?? []) : []),
  ];
  const loaded = list.data?.pages.flatMap((page) => page.data) ?? [];
  const runsReady = !runs.isPending && !(options.includePaid && paid.isPending);
  const oldestLock = Math.min(
    ...allRuns.map((run) =>
      Date.parse(run.lockedAt ?? `${run.periodStart}T00:00:00.000Z`),
    ),
  );
  const oldestLoaded = Math.min(
    ...loaded.map((row) => Date.parse(row.createdAt)),
  );
  const needsMore =
    runsReady &&
    allRuns.length > 0 &&
    list.hasNextPage &&
    !list.isFetchNextPageError &&
    !list.isError &&
    (list.data?.pages.length ?? 0) < MAX_AUTO_PAGES &&
    !(oldestLoaded < oldestLock);
  const { fetchNextPage, isFetchingNextPage } = list;
  React.useEffect(() => {
    if (needsMore && !isFetchingNextPage) void fetchNextPage();
  }, [needsMore, isFetchingNextPage, fetchNextPage, loaded.length]);
  // A failed "load more" is not a failed tab: only the first page (or the runs)
  // failing replaces the content with an error.
  const listFailed = list.isError && !list.isFetchNextPageError;
  const entries = allRuns.map((run) => ({
    run,
    batches: loaded.filter((batch) => batch.payrollRunId === run.id),
  }));
  const paidPending = options.includePaid === true && paid.isPending;
  return {
    entries,
    isPending: runs.isPending || paidPending || list.isPending || needsMore,
    isError: runs.isError || paid.isError || listFailed,
    error: runs.error ?? paid.error ?? (listFailed ? list.error : null) ?? null,
    loadMoreError: list.isFetchNextPageError,
    refetch: () =>
      Promise.all([
        runs.refetch(),
        ...(options.includePaid ? [paid.refetch()] : []),
        list.refetch(),
      ]),
    hasNextPage: list.hasNextPage,
    fetchNextPage: () => list.fetchNextPage(),
    isFetchingNextPage: list.isFetchingNextPage,
  };
}

const EMPTY_PROPOSALS = new Map<string, PayrollPayoutProposalDto>();

/**
 * Item id → the first step still waiting for its second person (resolve or
 * return; an item has at most one). Empty until loaded. Refreshed with every
 * payout write.
 */
export function useResolutionProposals(
  batchId: string | undefined,
): Map<string, PayrollPayoutProposalDto> {
  const query = useQuery({
    ...resolutionProposalsQuery(batchId ?? ""),
    enabled: Boolean(batchId),
  });
  return React.useMemo(
    () =>
      query.data
        ? new Map(query.data.map((row) => [row.itemId, row] as const))
        : EMPTY_PROPOSALS,
    [query.data],
  );
}

const EMPTY_EMPLOYEES = new Map<string, PayoutEmployeeView>();
export type PayoutEmployeeView = Omit<PayoutEmployee, "id" | "userId">;

/**
 * Employee id → name and subtitle. Empty until loaded. The payee's bank account
 * is not read here: it comes from the item's locked snapshot.
 */
export function usePayoutEmployees(): Map<string, PayoutEmployeeView> {
  const query = useQuery(employeesQuery());
  return React.useMemo(
    () =>
      query.data
        ? new Map(
            query.data.map(
              ({ id, name, subtitle }) => [id, { name, subtitle }] as const,
            ),
          )
        : EMPTY_EMPLOYEES,
    [query.data],
  );
}

const EMPTY_NAMES = new Map<string, string>();

/** Login user id → employee name (who requested or approved a batch). */
export function usePayoutUserNames(): Map<string, string> {
  const query = useQuery(employeesQuery());
  return React.useMemo(
    () =>
      query.data
        ? new Map(
            query.data
              .filter((row) => row.userId !== null)
              .map((row) => [row.userId as string, row.name] as const),
          )
        : EMPTY_NAMES,
    [query.data],
  );
}

// ---- Mutations -------------------------------------------------------------

function useRefreshPayout() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [getDisbursementBatch.id] }),
      queryClient.invalidateQueries({
        queryKey: [listRunDisbursementBatches.id],
      }),
      queryClient.invalidateQueries({ queryKey: [listPayoutBatches.id] }),
      queryClient.invalidateQueries({
        queryKey: [listResolutionProposals.id],
      }),
      queryClient.invalidateQueries({ queryKey: [payoutKeys.all[0]] }),
    ]);
}

export function useUpsertPayoutConfig(legalEntityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertConfigInput) => api.putConfig(legalEntityId, body),
    onSuccess: async (response) => {
      queryClient.setQueryData(
        endpointQueryKey(getPayoutConfig, { params: { legalEntityId } }),
        response,
      );
      await queryClient.invalidateQueries({
        queryKey: [payoutKeys.all[0]],
      });
    },
  });
}

export function useCreateBatch(runId: string) {
  const refresh = useRefreshPayout();
  return useMutation({
    mutationFn: (body: CreateBatchInput) => api.postCreateBatch(runId, body),
    onSuccess: refresh,
  });
}

/** `mutate({ batchId })`. Items that cannot be paid leave the batch. */
export function useSubmitBatch() {
  const refresh = useRefreshPayout();
  return useMutation({
    mutationFn: ({ batchId }: { batchId: string }) =>
      api.postSubmitBatch(batchId),
    onSuccess: refresh,
  });
}

/**
 * `mutate({ batchId, contentHash, sourceBankAccountId })`: the source account
 * the person saw (null for a batch without one); the server refuses with 409
 * PAYOUT_SOURCE_MISMATCH when it would freeze another. It also demands MFA and a
 * second person.
 */
export function useApproveBatch() {
  const refresh = useRefreshPayout();
  return useMutation({
    mutationFn: ({
      batchId,
      ...body
    }: { batchId: string } & ApproveBatchInput) =>
      api.postApproveBatch(batchId, body),
    onSuccess: refresh,
  });
}

/** `mutate({ batchId, reason })`. */
export function useCancelBatch() {
  const refresh = useRefreshPayout();
  return useMutation({
    mutationFn: ({
      batchId,
      ...body
    }: { batchId: string } & CancelBatchInput) =>
      api.postCancelBatch(batchId, body),
    onSuccess: refresh,
  });
}

/** `mutate({ batchId, password? })`: downloads the bank file, once. */
export function useExportBatch() {
  const refresh = useRefreshPayout();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      batchId,
      password,
    }: {
      batchId: string;
      password?: string;
    }) => {
      const cached = queryClient.getQueryData<{
        data: { bankFormat: PayoutBankFormat | null };
      }>(endpointQueryKey(getDisbursementBatch, { params: { id: batchId } }));
      return api.postExportBatch(
        batchId,
        cached?.data.bankFormat ?? null,
        password,
      );
    },
    onSettled: refresh,
  });
}

/** `mutate({ batchId, results, password? })`. */
export function useConfirmBatch() {
  const refresh = useRefreshPayout();
  return useMutation({
    mutationFn: ({
      batchId,
      ...body
    }: { batchId: string } & ConfirmItemsInput) =>
      api.postConfirmItems(batchId, body),
    onSuccess: refresh,
  });
}

/** `mutate({ batchId, itemIds, outcome, evidenceKey, note, password? })`; `data.proposed` counts first proposals, `data.resolved` items moved. */
export function useResolveBatch() {
  const refresh = useRefreshPayout();
  return useMutation({
    mutationFn: ({
      batchId,
      ...body
    }: { batchId: string } & ResolveItemsInput) =>
      api.postResolveItems(batchId, body),
    onSuccess: refresh,
  });
}

/**
 * `mutate({ batchId, file, password? })`: stores a resolve/return proof and
 * answers its `evidenceKey`. Changes no batch, so nothing is refreshed.
 */
export function useUploadPayoutEvidence() {
  return useMutation<
    PayrollPayoutEvidenceUploadDto,
    Error,
    { batchId: string; file: File; password?: string }
  >({
    mutationFn: ({ batchId, file, password }) =>
      api.uploadPayoutEvidence(batchId, file, password),
  });
}

/**
 * `mutate({ batchId, key })`: answers `{ evidenceKey, url, expiresAt }`, a signed
 * link of a stored proof (valid 60 seconds). Fetched on the click and never cached; changes no batch.
 */
export function useOpenPayoutEvidence() {
  return useMutation({
    mutationFn: async ({ batchId, key }: { batchId: string; key: string }) =>
      (await api.fetchPayoutEvidenceLink(batchId, key)).data,
    gcTime: 0,
  });
}

/** `mutate({ batchId, itemIds, evidenceKey, note, password? })`. */
export function useReturnBatch() {
  const refresh = useRefreshPayout();
  return useMutation({
    mutationFn: ({
      batchId,
      ...body
    }: { batchId: string } & ReturnItemsInput) =>
      api.postReturnItems(batchId, body),
    onSuccess: refresh,
  });
}

/**
 * `mutate({ batchId, kind, itemIds, password? })`: takes back the first
 * person's correction or overpaid proposal (`itemIds` = all of its group).
 * Pays nothing and changes no item; the proof is spent. Refreshes the batch
 * and the proposal list.
 */
export function useWithdrawProposal() {
  const refresh = useRefreshPayout();
  return useMutation({
    mutationFn: ({
      batchId,
      kind,
      ...body
    }: {
      batchId: string;
      kind: "correction" | "overpaid";
    } & WithdrawProposalInput) =>
      kind === "correction"
        ? api.postWithdrawCorrection(batchId, body)
        : api.postWithdrawOverpaid(batchId, body),
    onSuccess: refresh,
  });
}

/** `mutate({ batchId, itemIds, evidenceKey?, password? })`. */
export function useConfirmCash() {
  const refresh = useRefreshPayout();
  return useMutation({
    mutationFn: ({
      batchId,
      ...body
    }: { batchId: string } & ConfirmCashInput) =>
      api.postConfirmCash(batchId, body),
    onSuccess: refresh,
  });
}

export type { PayableRun };
