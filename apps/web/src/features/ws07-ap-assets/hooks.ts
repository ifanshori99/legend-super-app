// The only way components touch AP/AR, fixed-asset and budget data: queries
// keep their endpoint keys, mutations invalidate every endpoint whose rows a
// write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  createFixedAsset as createFixedAssetEndpoint,
  disposeFixedAsset as disposeFixedAssetEndpoint,
  revalueFixedAsset as revalueFixedAssetEndpoint,
  runDepreciation as runDepreciationEndpoint,
} from "@starter/shared/accounting";
import type { EndpointInput } from "@starter/shared/api";
import * as api from "./api";
import {
  agingReportQuery,
  apAssetsKeys,
  budgetVsActualQuery,
  budgetsQuery,
  depreciationRunsQuery,
  fixedAssetDetailQuery,
  fixedAssetsQuery,
  type AgingFiltersQuery,
  type BudgetQuery,
} from "./queries";
import {
  accountingKeys,
  accountsQuery,
  outletsQuery,
} from "../ws07-accounting/queries";

// ---- Queries --------------------------------------------------------------

export function useAgingReport(filters: AgingFiltersQuery) {
  return useQuery(agingReportQuery(filters));
}

export function useFixedAssets(legalEntityId: string | undefined) {
  return useQuery(fixedAssetsQuery(legalEntityId));
}

export function useFixedAssetDetail(fixedAssetId: string | undefined) {
  return useQuery(fixedAssetDetailQuery(fixedAssetId));
}

export function useDepreciationRuns(legalEntityId: string | undefined) {
  return useQuery(depreciationRunsQuery(legalEntityId));
}

export function useBudgets(query: BudgetQuery) {
  return useQuery(budgetsQuery(query));
}

export function useBudgetVsActual(query: BudgetQuery) {
  return useQuery(budgetVsActualQuery(query));
}

/**
 * Outlet reference data for the budget scope. Imported read-only from the
 * accounting back office, which owns the endpoint caller and mock.
 */
export function useAccountingOutlets() {
  return useQuery(outletsQuery());
}

/** Postable accounts for the budget dialog (revenue and expense only). */
export function useBudgetAccounts(legalEntityId: string | undefined) {
  return useQuery(accountsQuery(legalEntityId));
}

// ---- Mutations ------------------------------------------------------------

function useInvalidateApAssets() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: apAssetsKeys.all });
}

/** A depreciation run or a disposal posts a journal: refresh the ledger too. */
function useInvalidateApAssetsAndJournals() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: apAssetsKeys.all }),
      queryClient.invalidateQueries({ queryKey: accountingKeys.journals() }),
    ]);
}

export type CreateFixedAssetBody = Omit<
  EndpointInput<typeof createFixedAssetEndpoint>["body"],
  "idempotencyKey"
>;
export type DisposeFixedAssetBody = Omit<
  EndpointInput<typeof disposeFixedAssetEndpoint>["body"],
  "idempotencyKey"
>;
export type RevalueFixedAssetBody = Omit<
  EndpointInput<typeof revalueFixedAssetEndpoint>["body"],
  "idempotencyKey"
>;
export type RunDepreciationBody = Omit<
  EndpointInput<typeof runDepreciationEndpoint>["body"],
  "idempotencyKey"
>;

export function useCreateFixedAsset() {
  const invalidate = useInvalidateApAssets();
  return useMutation({
    mutationFn: (body: CreateFixedAssetBody) => api.createFixedAsset(body),
    onSuccess: () => invalidate(),
  });
}

export function useDisposeFixedAsset() {
  const invalidate = useInvalidateApAssetsAndJournals();
  return useMutation({
    mutationFn: ({
      fixedAssetId,
      body,
    }: {
      fixedAssetId: string;
      body: DisposeFixedAssetBody;
    }) => api.disposeFixedAsset(fixedAssetId, body),
    onSuccess: () => invalidate(),
  });
}

export function useRevalueFixedAsset() {
  const invalidate = useInvalidateApAssets();
  return useMutation({
    mutationFn: ({
      fixedAssetId,
      body,
    }: {
      fixedAssetId: string;
      body: RevalueFixedAssetBody;
    }) => api.revalueFixedAsset(fixedAssetId, body),
    onSuccess: () => invalidate(),
  });
}

export function useRunDepreciation() {
  const invalidate = useInvalidateApAssetsAndJournals();
  return useMutation({
    mutationFn: (body: RunDepreciationBody) => api.runDepreciation(body),
    onSuccess: () => invalidate(),
  });
}

export function useUpsertBudgets() {
  const invalidate = useInvalidateApAssets();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.upsertBudgets>[0]) =>
      api.upsertBudgets(body),
    onSuccess: () => invalidate(),
  });
}
