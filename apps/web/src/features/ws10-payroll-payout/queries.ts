// Query keys and options for the payout screens. Endpoint-backed keys sit under
// their endpoint id, so a mutation invalidates `[endpoint.id]`.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getDisbursementBatch,
  getPayoutApprovalLog,
  getPayoutConfig,
  listPayoutBatches,
  listResolutionProposals,
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

/** Page size of the per-PT batch list (the API maximum). */
export const BATCH_LIST_LIMIT = 20;

/**
 * Batches of one PT across runs, newest first, a page at a time. The key sits
 * under the endpoint id so a write can invalidate `[listPayoutBatches.id]`.
 */
export const entityBatchesQuery = (legalEntityId: string) =>
  infiniteQueryOptions({
    queryKey: [
      ...endpointQueryKey(listPayoutBatches, {
        query: { legalEntityId, limit: BATCH_LIST_LIMIT },
      }),
      "pages",
    ] as const,
    queryFn: ({ pageParam, signal }) =>
      api.fetchPayoutBatches(
        {
          legalEntityId,
          limit: BATCH_LIST_LIMIT,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.nextCursor,
  });

export const batchQuery = (batchId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getDisbursementBatch, {
      params: { id: batchId },
    }),
    queryFn: ({ signal }) => api.fetchBatch(batchId, signal),
    select: (response) => response.data,
  });

export const approvalLogQuery = (logId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getPayoutApprovalLog, { params: { logId } }),
    queryFn: ({ signal }) => api.fetchApprovalLog(logId, signal),
    select: (response) => response.data,
    // A 404 means "not yours or not there"; asking again changes nothing.
    retry: false,
  });

export const resolutionProposalsQuery = (batchId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(listResolutionProposals, {
      params: { id: batchId },
    }),
    queryFn: ({ signal }) => api.fetchResolutionProposals(batchId, signal),
    select: (response) => response.data,
  });

export const employeesQuery = () =>
  queryOptions({
    queryKey: payoutKeys.employees(),
    queryFn: ({ signal }) => api.fetchPayoutEmployees(signal),
    staleTime: 60_000,
  });
