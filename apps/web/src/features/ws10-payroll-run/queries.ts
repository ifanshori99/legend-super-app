// Query keys and options for the payroll screens. Keys sit under their
// endpoint id, so a mutation invalidates `[endpoint.id]` and every page of that
// list refreshes (docs/frontend.md "Query options and keys").
import { queryOptions } from "@tanstack/react-query";
import { listPositions, listEmployees } from "@starter/shared/hris";
import {
  getPayrollRun,
  listBankTransferFiles,
  listPayrollRunEmployeeResults,
  listPayrollRunPayslips,
  listPayrollRuns,
  listServiceChargeAllocations,
  listServiceChargePools,
  type PayrollRunStatus,
} from "@starter/shared/hris/payroll";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";
import { collectAllPages, LIST_LIMIT } from "./lib";

export const payrollKeys = {
  all: ["payroll-run"] as const,
  pools: () => [...payrollKeys.all, "pools"] as const,
};

export const RUNS_QUERY = { limit: LIST_LIMIT } as const;

/**
 * Every run page in one result, newest first: the list's status band counts
 * and stat strip need the whole set, not the first cursor page.
 */
export function runsQuery(query: {
  limit: number;
  status?: PayrollRunStatus;
  legalEntityId?: string;
}) {
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(listPayrollRuns, { query }),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages((cursor) => api.fetchRuns({ ...query, cursor }, signal)),
  });
}

export function runQuery(runId: string) {
  return queryOptions({
    queryKey: endpointQueryKey(getPayrollRun, {
      params: { payrollRunId: runId },
    }),
    queryFn: ({ signal }) => api.fetchRun(runId, signal),
  });
}

export function runResultsQuery(runId: string) {
  const query = { limit: LIST_LIMIT };
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(listPayrollRunEmployeeResults, {
        params: { payrollRunId: runId },
        query,
      }),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages((cursor) => api.fetchRunResults(runId, cursor, signal)),
  });
}

export function runPayslipsQuery(runId: string) {
  const query = { limit: LIST_LIMIT };
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(listPayrollRunPayslips, {
        params: { payrollRunId: runId },
        query,
      }),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages((cursor) => api.fetchRunPayslips(runId, cursor, signal)),
  });
}

export function bankFilesQuery(runId: string) {
  const query = { limit: LIST_LIMIT };
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(listBankTransferFiles, {
        params: { payrollRunId: runId },
        query,
      }),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages((cursor) => api.fetchBankFiles(runId, cursor, signal)),
  });
}

export function poolsQuery(outletId: string) {
  const query = { outletId, limit: LIST_LIMIT };
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(listServiceChargePools, { query }),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages((cursor) => api.fetchPools({ ...query, cursor }, signal)),
  });
}

export function allocationsQuery(poolId: string) {
  const query = { limit: LIST_LIMIT };
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(listServiceChargeAllocations, {
        params: { poolId },
        query,
      }),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages((cursor) => api.fetchAllocations(poolId, cursor, signal)),
  });
}

export function employeesQuery() {
  const query = { limit: LIST_LIMIT };
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(listEmployees, { query }),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages((cursor) => api.fetchEmployees(cursor, signal)),
  });
}

export function positionsQuery() {
  const query = { limit: LIST_LIMIT };
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(listPositions, { query }),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages((cursor) => api.fetchPositions(cursor, signal)),
  });
}
