// Query keys and options of the AP/AR, fixed-asset and budget screens (bead
// legend-m4zn). Keys sit under "accounting" so the back office's broad
// invalidations also refresh these screens.
import { queryOptions } from "@tanstack/react-query";
import type { OpenItemKind } from "@starter/shared/accounting";
import {
  fetchAgingReport,
  fetchBudgetVsActual,
  fetchBudgets,
  fetchDepreciationRuns,
  fetchFixedAssetDetail,
  fetchFixedAssets,
} from "./api";

export type AgingFiltersQuery = {
  legalEntityId: string;
  kind: OpenItemKind;
  asOf: string;
};

export type BudgetQuery = {
  legalEntityId: string;
  period: string;
  outletId?: string;
};

export const apAssetsKeys = {
  all: ["accounting", "ap-assets"] as const,
  aging: (filters: AgingFiltersQuery) =>
    [...apAssetsKeys.all, "aging", filters] as const,
  assets: (legalEntityId: string) =>
    [...apAssetsKeys.all, "assets", legalEntityId] as const,
  asset: (fixedAssetId: string) =>
    [...apAssetsKeys.all, "asset", fixedAssetId] as const,
  depreciationRuns: (legalEntityId: string) =>
    [...apAssetsKeys.all, "depreciation-runs", legalEntityId] as const,
  budgets: (query: BudgetQuery) =>
    [...apAssetsKeys.all, "budgets", query] as const,
  budgetVsActual: (query: BudgetQuery) =>
    [...apAssetsKeys.all, "budget-vs-actual", query] as const,
};

export function agingReportQuery(filters: AgingFiltersQuery) {
  return queryOptions({
    queryKey: apAssetsKeys.aging(filters),
    queryFn: ({ signal }) =>
      fetchAgingReport(
        {
          legalEntityId: filters.legalEntityId,
          kind: filters.kind,
          asOf: filters.asOf,
        },
        signal,
      ),
    enabled: Boolean(filters.legalEntityId && filters.asOf),
  });
}

export function fixedAssetsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: apAssetsKeys.assets(legalEntityId ?? "none"),
    queryFn: ({ signal }) => fetchFixedAssets(legalEntityId ?? "", signal),
    enabled: Boolean(legalEntityId),
  });
}

export function fixedAssetDetailQuery(fixedAssetId: string | undefined) {
  return queryOptions({
    queryKey: apAssetsKeys.asset(fixedAssetId ?? "none"),
    queryFn: ({ signal }) => fetchFixedAssetDetail(fixedAssetId ?? "", signal),
    enabled: Boolean(fixedAssetId),
  });
}

export function depreciationRunsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: apAssetsKeys.depreciationRuns(legalEntityId ?? "none"),
    queryFn: ({ signal }) => fetchDepreciationRuns(legalEntityId ?? "", signal),
    enabled: Boolean(legalEntityId),
  });
}

export function budgetsQuery(query: BudgetQuery) {
  return queryOptions({
    queryKey: apAssetsKeys.budgets(query),
    queryFn: ({ signal }) =>
      fetchBudgets(
        {
          legalEntityId: query.legalEntityId,
          period: query.period,
          ...(query.outletId ? { outletId: query.outletId } : {}),
        },
        signal,
      ),
    enabled: Boolean(query.legalEntityId && query.period),
  });
}

export function budgetVsActualQuery(query: BudgetQuery) {
  return queryOptions({
    queryKey: apAssetsKeys.budgetVsActual(query),
    queryFn: ({ signal }) =>
      fetchBudgetVsActual(
        {
          legalEntityId: query.legalEntityId,
          period: query.period,
          ...(query.outletId ? { outletId: query.outletId } : {}),
        },
        signal,
      ),
    enabled: Boolean(query.legalEntityId && query.period),
  });
}
