// The only way components touch payroll data: queries keep their endpoint
// keys, mutations write the returned run straight into the detail cache and
// invalidate every list a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  getPayrollRun,
  listBankTransferFiles,
  listPayrollRunEmployeeResults,
  listPayrollRunPayslips,
  listPayrollRuns,
  listServiceChargeAllocations,
  listServiceChargePools,
  type PayrollRun,
} from "@starter/shared/hris/payroll";
import { endpointQueryKey } from "@/lib/api/endpoint";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import * as api from "./api";
import type { SimpleRunAction } from "./api";
import {
  allocationsQuery,
  bankFilesQuery,
  employeesQuery,
  poolsQuery,
  positionsQuery,
  runPayslipsQuery,
  runQuery,
  runResultsQuery,
  runsQuery,
} from "./queries";

function useRefresh(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

/** Writes the fresh run into the detail cache, so the header advances at once. */
function useStoreRun() {
  const queryClient = useQueryClient();
  return (run: PayrollRun) => {
    queryClient.setQueryData(
      endpointQueryKey(getPayrollRun, { params: { payrollRunId: run.id } }),
      run,
    );
  };
}

// ---- Queries -------------------------------------------------------------

export function useRuns(query: {
  limit: number;
  status?: Parameters<typeof runsQuery>[0]["status"];
}) {
  return useQuery(runsQuery(query));
}

export function useRun(runId: string | undefined) {
  return useQuery({
    ...runQuery(runId ?? ""),
    enabled: Boolean(runId),
  });
}

/** `allowed` = the caller holds the read permission (no request otherwise). */
export function useRunResults(runId: string | undefined, allowed = true) {
  return useQuery({
    ...runResultsQuery(runId ?? ""),
    enabled: allowed && Boolean(runId),
  });
}

/** `allowed` = the caller holds the read permission (no request otherwise). */
export function useRunPayslips(runId: string | undefined, allowed = true) {
  return useQuery({
    ...runPayslipsQuery(runId ?? ""),
    enabled: allowed && Boolean(runId),
  });
}

/** `allowed` = the caller holds the read permission (no request otherwise). */
export function useBankFiles(runId: string | undefined, allowed = true) {
  return useQuery({
    ...bankFilesQuery(runId ?? ""),
    enabled: allowed && Boolean(runId),
  });
}

export function usePools(outletId: string | undefined) {
  return useQuery({
    ...poolsQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

export function useAllocations(poolId: string | undefined, allowed = true) {
  return useQuery({
    ...allocationsQuery(poolId ?? ""),
    enabled: allowed && Boolean(poolId),
  });
}

export function useEmployees() {
  return useQuery(employeesQuery());
}

export function usePositions() {
  return useQuery(positionsQuery());
}

// ---- Run mutations -------------------------------------------------------

const RUN_LISTS = [
  listPayrollRuns,
  listPayrollRunEmployeeResults,
  listPayrollRunPayslips,
  listBankTransferFiles,
  listServiceChargePools,
] as const;

export function useCreateRun() {
  const refresh = useRefresh([listPayrollRuns, getPayrollRun]);
  const storeRun = useStoreRun();
  return useMutation({
    mutationFn: (body: api.CreateRunInput) => api.createRun(body),
    onSuccess: (run) => {
      storeRun(run);
      return refresh();
    },
  });
}

export function useRunAction() {
  const refresh = useRefresh(RUN_LISTS);
  const storeRun = useStoreRun();
  return useMutation({
    mutationFn: (variables: { action: SimpleRunAction; runId: string }) =>
      api.runAction(variables.action, variables.runId, newIdempotencyKey()),
    onSuccess: (run) => {
      storeRun(run);
      return refresh();
    },
  });
}

export function useReturnToDraft() {
  const refresh = useRefresh(RUN_LISTS);
  const storeRun = useStoreRun();
  return useMutation({
    mutationFn: (variables: { runId: string; reason: string }) =>
      api.returnToDraft(variables.runId, variables.reason, newIdempotencyKey()),
    onSuccess: (run) => {
      storeRun(run);
      return refresh();
    },
  });
}

export function useMarkPaid() {
  const refresh = useRefresh([...RUN_LISTS, getPayrollRun]);
  const storeRun = useStoreRun();
  return useMutation({
    mutationFn: (variables: {
      runId: string;
      bankTransferFileId: string | null;
    }) =>
      api.markPaid(
        variables.runId,
        variables.bankTransferFileId,
        newIdempotencyKey(),
      ),
    onSuccess: (run) => {
      storeRun(run);
      return refresh();
    },
  });
}

export function useRequestReversal() {
  const refresh = useRefresh([...RUN_LISTS, getPayrollRun]);
  const storeRun = useStoreRun();
  return useMutation({
    mutationFn: (variables: { runId: string; reason: string }) =>
      api.requestReversal(
        variables.runId,
        variables.reason,
        newIdempotencyKey(),
      ),
    onSuccess: (run) => {
      storeRun(run);
      return refresh();
    },
  });
}

export function useDecideReversal() {
  const refresh = useRefresh([...RUN_LISTS, getPayrollRun]);
  const storeRun = useStoreRun();
  return useMutation({
    mutationFn: (variables: { runId: string; action: "approve" | "reject" }) =>
      api.decideReversal(
        variables.runId,
        variables.action,
        newIdempotencyKey(),
      ),
    onSuccess: (run) => {
      storeRun(run);
      return refresh();
    },
  });
}

// ---- Exports -------------------------------------------------------------

export function useCreateTaxExport() {
  return useMutation({
    mutationFn: (body: api.CreateTaxExportInput) => api.createTaxExport(body),
  });
}

// ---- Service-charge pools ------------------------------------------------

export function useCreatePool() {
  const refresh = useRefresh([listServiceChargePools]);
  return useMutation({
    mutationFn: (body: api.CreatePoolInput) => api.createPool(body),
    onSuccess: () => refresh(),
  });
}

export function useCalculatePool() {
  const refresh = useRefresh([
    listServiceChargePools,
    listServiceChargeAllocations,
  ]);
  return useMutation({
    mutationFn: (poolId: string) =>
      api.calculatePool(poolId, newIdempotencyKey()),
    onSuccess: () => refresh(),
  });
}

export function useApprovePool() {
  const refresh = useRefresh([listServiceChargePools]);
  return useMutation({
    mutationFn: (poolId: string) =>
      api.approvePool(poolId, newIdempotencyKey()),
    onSuccess: () => refresh(),
  });
}
