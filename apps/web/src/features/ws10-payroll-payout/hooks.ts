// The only way components touch payout data. Queries keep their endpoint keys;
// every write refreshes the batch, the run's batch list and the payable runs,
// because a settled batch can make its run paid.
//
// Mutation arguments are objects that carry the batch id next to the request
// body, e.g. `useConfirmBatch().mutate({ batchId, results, password })`.
import * as React from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getDisbursementBatch,
  getPayoutConfig,
  listRunDisbursementBatches,
} from "@starter/shared/hris/payroll/payout";
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
  UpsertConfigInput,
} from "./api";
import { maskedAccountDisplay } from "./lib";
import {
  bankLabelQuery,
  batchQuery,
  configQuery,
  employeesQuery,
  legalEntitiesQuery,
  paidRunsQuery,
  payableRunsQuery,
  payoutKeys,
  runBatchesQuery,
  sourceAccountsQuery,
} from "./queries";

// ---- Queries ---------------------------------------------------------------

/** The tenant's legal entities (PT). */
export function usePayoutLegalEntities() {
  return useQuery(legalEntitiesQuery());
}

/** `data` is null until the PT has saved a config. */
export function usePayoutConfig(legalEntityId: string | undefined) {
  return useQuery({
    ...configQuery(legalEntityId ?? ""),
    enabled: Boolean(legalEntityId),
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
 * Every batch of every payable run of the PT (there is no per-PT list route),
 * one request per run. `entries` pairs each run with its batches.
 * `includePaid` adds the newest paid runs, for screens that follow a batch
 * after its run left the "locked" list (the Status tab).
 */
export function useEntityBatches(
  legalEntityId: string | undefined,
  options: { includePaid?: boolean } = {},
) {
  const runs = usePayableRuns(legalEntityId);
  const paid = useQuery({
    ...paidRunsQuery(legalEntityId ?? ""),
    enabled: Boolean(legalEntityId) && options.includePaid === true,
  });
  const allRuns = [
    ...(runs.data ?? []),
    ...(options.includePaid ? (paid.data ?? []) : []),
  ];
  const results = useQueries({
    queries: allRuns.map((run) => runBatchesQuery(run.id)),
  });
  const entries = allRuns.map((run, index) => ({
    run,
    batches: results[index]?.data ?? [],
  }));
  const paidPending = options.includePaid === true && paid.isPending;
  return {
    entries,
    isPending:
      runs.isPending || paidPending || results.some((r) => r.isPending),
    isError: runs.isError || paid.isError || results.some((r) => r.isError),
    error:
      runs.error ?? paid.error ?? results.find((r) => r.error)?.error ?? null,
    refetch: () =>
      Promise.all([
        runs.refetch(),
        ...(options.includePaid ? [paid.refetch()] : []),
        ...results.map((r) => r.refetch()),
      ]),
  };
}

const EMPTY_EMPLOYEES = new Map<string, PayoutEmployeeView>();
export type PayoutEmployeeView = Omit<PayoutEmployee, "id" | "userId">;

/** Most payees whose masked account is read in one screen. */
const MAX_BANK_LABEL_LOOKUPS = 50;

/**
 * Employee id → name, subtitle and bank label. Empty until loaded. Pass the
 * batch's employee ids to fill `bankLabel` ("BCA ●●●● 4821") from the masked
 * HR-03 profile (one request per payee, at most 50); a payee whose profile
 * cannot be read keeps `bankLabel: null`, and the screen shows the item's bank
 * code and says the number is not shown.
 */
export function usePayoutEmployees(
  employeeIds: readonly string[] = [],
): Map<string, PayoutEmployeeView> {
  const query = useQuery(employeesQuery());
  const ids = [...new Set(employeeIds)].slice(0, MAX_BANK_LABEL_LOOKUPS);
  const labels = useQueries({ queries: ids.map((id) => bankLabelQuery(id)) });
  const labelKey = labels.map((result) => result.data ?? "").join("|");
  const idsKey = ids.join(",");
  return React.useMemo(() => {
    if (!query.data) return EMPTY_EMPLOYEES;
    const fetched = new Map(ids.map((id, index) => [id, labels[index]?.data]));
    return new Map(
      query.data.map(
        ({ id, name, subtitle, bankLabel }) =>
          [
            id,
            { name, subtitle, bankLabel: fetched.get(id) ?? bankLabel },
          ] as const,
      ),
    );
    // `labelKey` stands for the label results; `labels` itself is a new array
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, idsKey, labelKey]);
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

/** `mutate({ batchId, contentHash })`; the server demands MFA and a second person. */
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

/** `mutate({ batchId })`: downloads the bank file, once. */
export function useExportBatch() {
  const refresh = useRefreshPayout();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ batchId }: { batchId: string }) => {
      const cached = queryClient.getQueryData<{
        data: { bankFormat: PayoutBankFormat | null };
      }>(endpointQueryKey(getDisbursementBatch, { params: { id: batchId } }));
      return api.postExportBatch(batchId, cached?.data.bankFormat ?? null);
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

/** `mutate({ batchId, itemIds, outcome, evidenceKey, note, password? })`. */
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
