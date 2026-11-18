// One typed caller per payroll endpoint this feature uses (docs/frontend.md
// "Typed endpoints and mock mode"). Components never call these directly: the
// hooks in ./hooks.ts own cache keys and invalidation.
//
// Data endpoints come from the client-safe barrel `@starter/shared/hris/payroll`.
// The employee directory (`@starter/shared/hris`) only supplies names for the
// service-charge allocation table.
import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
} from "@starter/shared/api";
import { listEmployees, listPositions } from "@starter/shared/hris";
import {
  approvePayrollRunFinal,
  approvePayrollRunHr,
  approveServiceChargePool,
  calculateServiceChargePool,
  createPayrollRun,
  createPayrollTaxExport,
  createServiceChargePool,
  decidePayrollRunReversal,
  getPayrollRun,
  listBankTransferFiles,
  listPayrollRunEmployeeResults,
  listPayrollRunPayslips,
  listPayrollRuns,
  listServiceChargeAllocations,
  listServiceChargePools,
  lockPayrollRun,
  markPayrollRunPaid,
  requestPayrollRunReversal,
  returnPayrollRunToDraft,
  simulatePayrollRun,
  type PayrollRun,
} from "@starter/shared/hris/payroll";
import { callEndpoint } from "@/lib/api/endpoint";
import { LIST_LIMIT } from "./lib";

type QueryOf<E extends AnyEndpoint> = EndpointInput<E>["query"];
type BodyOf<E extends AnyEndpoint> = EndpointInput<E>["body"];

// Request bodies the screens build (mints its idempotency key per attempt).
export type CreateRunInput = BodyOf<typeof createPayrollRun>;
export type CreateTaxExportInput = BodyOf<typeof createPayrollTaxExport>;
export type CreatePoolInput = BodyOf<typeof createServiceChargePool>;

// ---- Reads --------------------------------------------------------------

export async function fetchRuns(
  query: QueryOf<typeof listPayrollRuns>,
  signal?: AbortSignal,
): Promise<EndpointOutput<typeof listPayrollRuns>> {
  return callEndpoint(listPayrollRuns, { query }, { signal });
}

export async function fetchRun(
  runId: string,
  signal?: AbortSignal,
): Promise<PayrollRun> {
  const response = await callEndpoint(
    getPayrollRun,
    { params: { payrollRunId: runId } },
    { signal },
  );
  return response.data;
}

export async function fetchRunResults(
  runId: string,
  cursor?: string,
  signal?: AbortSignal,
) {
  return callEndpoint(
    listPayrollRunEmployeeResults,
    {
      params: { payrollRunId: runId },
      query: { limit: LIST_LIMIT, cursor },
    },
    { signal },
  );
}

export async function fetchRunPayslips(
  runId: string,
  cursor?: string,
  signal?: AbortSignal,
) {
  return callEndpoint(
    listPayrollRunPayslips,
    { params: { payrollRunId: runId }, query: { limit: LIST_LIMIT, cursor } },
    { signal },
  );
}

export async function fetchBankFiles(
  runId: string,
  cursor?: string,
  signal?: AbortSignal,
) {
  return callEndpoint(
    listBankTransferFiles,
    { params: { payrollRunId: runId }, query: { limit: LIST_LIMIT, cursor } },
    { signal },
  );
}

export async function fetchPools(
  query: QueryOf<typeof listServiceChargePools>,
  signal?: AbortSignal,
) {
  return callEndpoint(listServiceChargePools, { query }, { signal });
}

export async function fetchAllocations(
  poolId: string,
  cursor?: string,
  signal?: AbortSignal,
) {
  return callEndpoint(
    listServiceChargeAllocations,
    { params: { poolId }, query: { limit: LIST_LIMIT, cursor } },
    { signal },
  );
}

export async function fetchEmployees(
  cursor?: string,
  signal?: AbortSignal,
): Promise<EndpointOutput<typeof listEmployees>> {
  return callEndpoint(
    listEmployees,
    { query: { limit: LIST_LIMIT, cursor } },
    { signal },
  );
}

export async function fetchPositions(
  cursor?: string,
  signal?: AbortSignal,
): Promise<EndpointOutput<typeof listPositions>> {
  return callEndpoint(
    listPositions,
    { query: { limit: LIST_LIMIT, cursor } },
    { signal },
  );
}

// ---- Run actions --------------------------------------------------------

/** Actions whose route only needs an idempotency key (mark_paid adds a file). */
export type SimpleRunAction =
  "simulate" | "approve_hr" | "approve_final" | "lock";

const SIMPLE_ACTIONS = {
  simulate: simulatePayrollRun,
  approve_final: approvePayrollRunFinal,
  lock: lockPayrollRun,
} as const;

/** `expectedSimulationCount` is the run's count as the reviewer loaded it. */
export async function runAction(
  action: SimpleRunAction,
  runId: string,
  idempotencyKey: string,
  expectedSimulationCount: number,
): Promise<PayrollRun> {
  if (action === "approve_hr") {
    const approval = await callEndpoint(approvePayrollRunHr, {
      params: { payrollRunId: runId },
      body: { expectedSimulationCount, idempotencyKey },
    });
    return approval.data;
  }
  const response = await callEndpoint(SIMPLE_ACTIONS[action], {
    params: { payrollRunId: runId },
    body: { idempotencyKey },
  });
  return response.data;
}

export async function createRun(
  body: BodyOf<typeof createPayrollRun>,
): Promise<PayrollRun> {
  const response = await callEndpoint(createPayrollRun, { body });
  return response.data;
}

export async function returnToDraft(
  runId: string,
  reason: string,
  idempotencyKey: string,
): Promise<PayrollRun> {
  const response = await callEndpoint(returnPayrollRunToDraft, {
    params: { payrollRunId: runId },
    body: { reason, idempotencyKey },
  });
  return response.data;
}

export async function markPaid(
  runId: string,
  bankTransferFileId: string | null,
  idempotencyKey: string,
): Promise<PayrollRun> {
  const response = await callEndpoint(markPayrollRunPaid, {
    params: { payrollRunId: runId },
    body: { bankTransferFileId, idempotencyKey },
  });
  return response.data;
}

export async function requestReversal(
  runId: string,
  reason: string,
  idempotencyKey: string,
): Promise<PayrollRun> {
  const response = await callEndpoint(requestPayrollRunReversal, {
    params: { payrollRunId: runId },
    body: { reason, idempotencyKey },
  });
  return response.data;
}

export async function decideReversal(
  runId: string,
  action: "approve" | "reject",
  idempotencyKey: string,
): Promise<PayrollRun> {
  const response = await callEndpoint(decidePayrollRunReversal, {
    params: { payrollRunId: runId },
    body: { action, idempotencyKey },
  });
  return response.data;
}

// ---- Exports ------------------------------------------------------------

export async function createTaxExport(
  body: BodyOf<typeof createPayrollTaxExport>,
) {
  const response = await callEndpoint(createPayrollTaxExport, { body });
  return response.data;
}

// ---- Service-charge pools ----------------------------------------------

export async function createPool(body: BodyOf<typeof createServiceChargePool>) {
  const response = await callEndpoint(createServiceChargePool, { body });
  return response.data;
}

export async function calculatePool(poolId: string, idempotencyKey: string) {
  const response = await callEndpoint(calculateServiceChargePool, {
    params: { poolId },
    body: { idempotencyKey },
  });
  return response.data;
}

export async function approvePool(poolId: string, idempotencyKey: string) {
  const response = await callEndpoint(approveServiceChargePool, {
    params: { poolId },
    body: { idempotencyKey },
  });
  return response.data;
}
