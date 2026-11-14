// Query keys and options for the payout screens. Endpoint-backed keys sit under
// their endpoint id, so a mutation invalidates `[endpoint.id]`.
import { queryOptions } from "@tanstack/react-query";
import {
  getDisbursementBatch,
  getPayoutConfig,
  listRunDisbursementBatches,
} from "@starter/shared/hris/payroll/payout";
import { orgEndpoints } from "@starter/shared/platform";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";

export const payoutKeys = {
  all: ["payroll-payout"] as const,
  sourceAccounts: (legalEntityId: string) =>
    [...payoutKeys.all, "source-accounts", legalEntityId] as const,
  payableRuns: (legalEntityId: string) =>
    [...payoutKeys.all, "payable-runs", legalEntityId] as const,
  paidRuns: (legalEntityId: string) =>
    [...payoutKeys.all, "paid-runs", legalEntityId] as const,
  employees: () => [...payoutKeys.all, "employees"] as const,
};

export const legalEntitiesQuery = () =>
  queryOptions({
    queryKey: endpointQueryKey(orgEndpoints.listLegalEntities, {}),
    queryFn: ({ signal }) => api.fetchLegalEntities(signal),
    select: (response) => response.data,
  });

export const configQuery = (legalEntityId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getPayoutConfig, {
      params: { legalEntityId },
    }),
    queryFn: ({ signal }) => api.fetchConfig(legalEntityId, signal),
    select: (response) => response.data,
  });

export const sourceAccountsQuery = (legalEntityId: string) =>
  queryOptions({
    queryKey: payoutKeys.sourceAccounts(legalEntityId),
    queryFn: ({ signal }) => api.fetchSourceAccounts(legalEntityId, signal),
  });

export const payableRunsQuery = (legalEntityId: string) =>
  queryOptions({
    queryKey: payoutKeys.payableRuns(legalEntityId),
    queryFn: ({ signal }) => api.fetchPayableRuns(legalEntityId, signal),
  });

export const paidRunsQuery = (legalEntityId: string) =>
  queryOptions({
    queryKey: payoutKeys.paidRuns(legalEntityId),
    queryFn: ({ signal }) => api.fetchRecentPaidRuns(legalEntityId, signal),
  });

export const runBatchesQuery = (runId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(listRunDisbursementBatches, {
      params: { id: runId },
    }),
    queryFn: ({ signal }) => api.fetchRunBatches(runId, signal),
    select: (response) => response.data,
  });

export const batchQuery = (batchId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getDisbursementBatch, {
      params: { id: batchId },
    }),
    queryFn: ({ signal }) => api.fetchBatch(batchId, signal),
    select: (response) => response.data,
  });

export const employeesQuery = () =>
  queryOptions({
    queryKey: payoutKeys.employees(),
    queryFn: ({ signal }) => api.fetchPayoutEmployees(signal),
    staleTime: 60_000,
  });
