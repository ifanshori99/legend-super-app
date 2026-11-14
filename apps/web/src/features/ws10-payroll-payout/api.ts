// One typed caller per payout endpoint (docs/frontend.md "Typed endpoints and
// mock mode"). Components never call these: ./hooks.ts owns cache keys and
// invalidation. The payout contract is in @starter/shared/hris/payroll/payout;
// reference data (legal entities, bank accounts, runs, employees) comes from
// the org, accounting, payroll and HR contracts.
import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
} from "@starter/shared/api";
import { listBankAccounts } from "@starter/shared/accounting";
import { listEmployees } from "@starter/shared/hris";
import { listPayrollRuns, type PayrollRun } from "@starter/shared/hris/payroll";
import {
  approveDisbursementBatch,
  cancelDisbursementBatch,
  confirmDisbursementCash,
  confirmDisbursementItems,
  createDisbursementBatch,
  exportDisbursementBatch,
  getDisbursementBatch,
  getPayoutConfig,
  listRunDisbursementBatches,
  resolveDisbursementItems,
  submitDisbursementBatch,
  upsertPayoutConfig,
} from "@starter/shared/hris/payroll/payout";
import { orgEndpoints } from "@starter/shared/platform";
import type { PayoutBankFormat } from "@starter/shared/validators/payroll-payout";
import { apiFetch } from "@/lib/api/client";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/lib/api/errors";
import { callEndpoint } from "@/lib/api/endpoint";
import { API_MOCK } from "@/lib/api/mock-flag";
import { API_URL } from "@/lib/env";
import { collectAllPages, LIST_LIMIT } from "../ws10-payroll-run/lib";
import { bankFileFallbackName } from "./lib";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export type UpsertConfigInput = Body<typeof upsertPayoutConfig>;
export type CreateBatchInput = Body<typeof createDisbursementBatch>;
export type ApproveBatchInput = Body<typeof approveDisbursementBatch>;
export type CancelBatchInput = Body<typeof cancelDisbursementBatch>;
export type ConfirmItemsInput = Body<typeof confirmDisbursementItems>;
export type ResolveItemsInput = Body<typeof resolveDisbursementItems>;
export type ConfirmCashInput = Body<typeof confirmDisbursementCash>;
export type SubmitBatchResult = EndpointOutput<
  typeof submitDisbursementBatch
>["data"];

/** A locked, not yet fully paid run, ready for a disbursement batch. */
export type PayableRun = {
  id: string;
  legalEntityId: string;
  /** Display number, e.g. "PAY-2026-11-01" (the run itself has none). */
  code: string;
  runType: PayrollRun["runType"];
  periodStart: string;
  periodEnd: string;
  lockedAt: string | null;
  employeeCount: number;
  /** Gaji bersih of the whole run, whole rupiah. */
  netIdr: number;
};

export type PayoutEmployee = {
  id: string;
  /** Login account, to name the person who requested a batch. */
  userId: string | null;
  name: string;
  subtitle: string;
  bankLabel: string | null;
};

export type PayoutSourceAccountRow = {
  id: string;
  label: string;
  maskedNumber: string;
  active: boolean;
};

// ---- Reads -----------------------------------------------------------------

export const fetchLegalEntities = (signal?: AbortSignal) =>
  callEndpoint(orgEndpoints.listLegalEntities, {}, { signal });

export const fetchConfig = (legalEntityId: string, signal?: AbortSignal) =>
  callEndpoint(getPayoutConfig, { params: { legalEntityId } }, { signal });

export async function fetchSourceAccounts(
  legalEntityId: string,
  signal?: AbortSignal,
): Promise<PayoutSourceAccountRow[]> {
  if (API_MOCK) {
    const response = await apiFetch<{ data: PayoutSourceAccountRow[] }>(
      "/api/mock/payout/source-accounts",
      { query: { legalEntityId }, signal },
    );
    return response.data;
  }
  const response = await callEndpoint(
    listBankAccounts,
    { params: { legalEntityId } },
    { signal },
  );
  return response.data.map((account) => ({
    id: account.id,
    label: `${account.bank} · ${account.accountName}`,
    maskedNumber: account.accountNumberMasked,
    active: account.isActive,
  }));
}

/** "PAY-2026-11-01": period month plus the order of the month's runs. */
export function payableRunCodes(runs: readonly PayrollRun[]) {
  const seen = new Map<string, number>();
  const codes = new Map<string, string>();
  for (const run of [...runs].sort((a, b) =>
    `${a.periodStart}${a.createdAt}`.localeCompare(
      `${b.periodStart}${b.createdAt}`,
    ),
  )) {
    const month = run.periodStart.slice(0, 7);
    const order = (seen.get(month) ?? 0) + 1;
    seen.set(month, order);
    codes.set(run.id, `PAY-${month}-${String(order).padStart(2, "0")}`);
  }
  return codes;
}

export async function fetchPayableRuns(
  legalEntityId: string,
  signal?: AbortSignal,
): Promise<PayableRun[]> {
  if (API_MOCK) {
    const response = await apiFetch<{ data: PayableRun[] }>(
      "/api/mock/payout/payable-runs",
      { query: { legalEntityId }, signal },
    );
    return response.data;
  }
  const page = await collectAllPages((cursor) =>
    callEndpoint(
      listPayrollRuns,
      { query: { legalEntityId, status: "locked", limit: LIST_LIMIT, cursor } },
      { signal },
    ),
  );
  const codes = payableRunCodes(page.data);
  return page.data
    .map((run) => ({
      id: run.id,
      legalEntityId: run.legalEntityId,
      code: codes.get(run.id) ?? run.id,
      runType: run.runType,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      lockedAt: run.lockedAt,
      employeeCount: run.totals?.employeeCount ?? 0,
      netIdr: run.totals?.netIdr ?? 0,
    }))
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
}

/**
 * The newest few paid runs of the PT. A batch can outlive its run's "locked"
 * state, so the Status tab still has to find it there.
 */
export async function fetchRecentPaidRuns(
  legalEntityId: string,
  signal?: AbortSignal,
): Promise<PayableRun[]> {
  if (API_MOCK) return [];
  const page = await callEndpoint(
    listPayrollRuns,
    { query: { legalEntityId, status: "paid", limit: LIST_LIMIT } },
    { signal },
  );
  const codes = payableRunCodes(page.data);
  return page.data
    .map((run) => ({
      id: run.id,
      legalEntityId: run.legalEntityId,
      code: codes.get(run.id) ?? run.id,
      runType: run.runType,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      lockedAt: run.lockedAt,
      employeeCount: run.totals?.employeeCount ?? 0,
      netIdr: run.totals?.netIdr ?? 0,
    }))
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart))
    .slice(0, RECENT_PAID_RUNS);
}

const RECENT_PAID_RUNS = 3;

export const fetchRunBatches = (runId: string, signal?: AbortSignal) =>
  callEndpoint(
    listRunDisbursementBatches,
    { params: { id: runId } },
    { signal },
  );

export const fetchBatch = (batchId: string, signal?: AbortSignal) =>
  callEndpoint(getDisbursementBatch, { params: { id: batchId } }, { signal });

/** Names for the payee rows (the payout items carry only employee ids). */
export async function fetchPayoutEmployees(
  signal?: AbortSignal,
): Promise<PayoutEmployee[]> {
  if (API_MOCK) {
    const response = await apiFetch<{ data: PayoutEmployee[] }>(
      "/api/mock/payout/employees",
      { signal },
    );
    return response.data;
  }
  const page = await collectAllPages((cursor) =>
    callEndpoint(
      listEmployees,
      { query: { limit: LIST_LIMIT, cursor } },
      { signal },
    ),
  );
  // The bank account number is masked PII behind its own endpoint; the payee
  // row shows the employee number and, from the item, the bank code.
  return page.data.map((employee) => ({
    id: employee.id,
    userId: employee.userId,
    name: employee.fullName,
    subtitle: employee.employeeNo,
    bankLabel: null,
  }));
}

// ---- Writes ----------------------------------------------------------------

export const putConfig = (legalEntityId: string, body: UpsertConfigInput) =>
  callEndpoint(upsertPayoutConfig, { params: { legalEntityId }, body });

export const postCreateBatch = (runId: string, body: CreateBatchInput) =>
  callEndpoint(createDisbursementBatch, { params: { id: runId }, body });

// Every POST sends a JSON body: the API answers 415 without one.
export const postSubmitBatch = (batchId: string) =>
  callEndpoint(submitDisbursementBatch, {
    params: { id: batchId },
    body: {},
  });

export const postApproveBatch = (batchId: string, body: ApproveBatchInput) =>
  callEndpoint(approveDisbursementBatch, { params: { id: batchId }, body });

export const postCancelBatch = (batchId: string, body: CancelBatchInput) =>
  callEndpoint(cancelDisbursementBatch, { params: { id: batchId }, body });

export const postConfirmItems = (batchId: string, body: ConfirmItemsInput) =>
  callEndpoint(confirmDisbursementItems, { params: { id: batchId }, body });

export const postResolveItems = (batchId: string, body: ResolveItemsInput) =>
  callEndpoint(resolveDisbursementItems, { params: { id: batchId }, body });

export const postConfirmCash = (batchId: string, body: ConfirmCashInput) =>
  callEndpoint(confirmDisbursementCash, { params: { id: batchId }, body });

export type ExportedFile = { filename: string; checksumSha256: string };

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * The manual bank file leaves the server once (a second call answers 409
 * PAYOUT_EXPORT_ALREADY_DOWNLOADED), so this reads the answer as a file and
 * saves it in the same step. Browser only.
 */
export async function postExportBatch(
  batchId: string,
  bankFormat: PayoutBankFormat | null = null,
): Promise<ExportedFile> {
  if (API_MOCK) {
    const { data } = await callEndpoint(exportDisbursementBatch, {
      params: { id: batchId },
      body: {},
    });
    saveBlob(
      new Blob([data.content], { type: data.contentType }),
      data.filename,
    );
    return { filename: data.filename, checksumSha256: data.checksumSha256 };
  }
  const path = exportDisbursementBatch.path.replace(
    ":id",
    encodeURIComponent(batchId),
  );
  let response: Response;
  try {
    response = await fetch(new URL(path, API_URL), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "HTTP_ERROR",
      payload?.error?.message ??
        `Request failed with status ${response.status}.`,
    );
  }
  // The API does not expose these headers cross-origin (CORS), so the name
  // falls back to one built from the batch and its bank format.
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename =
    /filename="([^"]+)"/.exec(disposition)?.[1] ??
    bankFileFallbackName(batchId, bankFormat);
  saveBlob(await response.blob(), filename);
  return {
    filename,
    checksumSha256: response.headers.get("x-content-checksum-sha256") ?? "",
  };
}
