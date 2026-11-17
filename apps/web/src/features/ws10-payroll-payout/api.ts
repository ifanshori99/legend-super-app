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
  disownPayoutApproval,
  exportDisbursementBatch,
  getDisbursementBatch,
  getPayoutApprovalLog,
  getPayoutConfig,
  listPayoutBatches,
  listResolutionProposals,
  listRunDisbursementBatches,
  PAYOUT_EVIDENCE_UPLOAD_PATH,
  payoutEvidenceUploadResponseSchema,
  readPayoutEvidence,
  resolveDisbursementItems,
  returnDisbursementItems,
  submitDisbursementBatch,
  unfreezeDisbursementBatch,
  upsertPayoutConfig,
  withdrawFailedCorrection,
  withdrawOverpaidProposal,
} from "@starter/shared/hris/payroll/payout";
import { orgEndpoints } from "@starter/shared/platform";
import type {
  PayoutReconFlagDto,
  PayoutReturnClaimDto,
  PayrollPayoutEvidenceUploadDto,
} from "@starter/shared/types";
import type { PayoutBankFormat } from "@starter/shared/validators/payroll-payout";
import { apiErrorBodySchema } from "@starter/shared/core";
import { z } from "zod";
import { defineEndpoint } from "@starter/shared/api";
import {
  approvePayoutReconClearanceInputSchema,
  payoutReconClearanceParamsSchema,
  payoutReconFlagParamsSchema,
  proposePayoutReconClearanceInputSchema,
} from "@starter/shared/validators/payroll-payout-recon-clearance";
import {
  approvePayoutReturnWithdrawInputSchema,
  payoutReturnClaimBatchParamsSchema,
  payoutReturnClaimParamsSchema,
  payoutReturnWithdrawalParamsSchema,
  proposePayoutReturnWithdrawInputSchema,
} from "@starter/shared/validators/payroll-payout-return-withdraw";
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
export type ReturnItemsInput = Body<typeof returnDisbursementItems>;
export type ConfirmCashInput = Body<typeof confirmDisbursementCash>;
export type DisownApprovalInput = Body<typeof disownPayoutApproval>;
export type UnfreezeBatchInput = Body<typeof unfreezeDisbursementBatch>;
export type WithdrawProposalInput = Body<typeof withdrawFailedCorrection>;
export type ListBatchesQuery = EndpointInput<typeof listPayoutBatches>["query"];
export type ListBatchesPage = EndpointOutput<typeof listPayoutBatches>;
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
  /** Null when the run has no totals: show "Tidak tersedia", never Rp0. */
  employeeCount: number | null;
  /** Gaji bersih of the whole run (bank + cash), whole rupiah. */
  netIdr: number | null;
  /** Part of the net paid by bank transfer; the only part a bank batch pays. */
  bankTransferIdr: number | null;
  /** Head count of the bank-transfer part; the run totals do not carry it. */
  bankEmployeeCount: number | null;
};

export type PayoutEmployee = {
  id: string;
  /** Login account, to name the person who requested a batch. */
  userId: string | null;
  name: string;
  subtitle: string;
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

function toPayableRun(run: PayrollRun, code: string): PayableRun {
  return {
    id: run.id,
    legalEntityId: run.legalEntityId,
    code,
    runType: run.runType,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    lockedAt: run.lockedAt,
    employeeCount: run.totals?.employeeCount ?? null,
    netIdr: run.totals?.netIdr ?? null,
    bankTransferIdr: run.totals?.bankTransferIdr ?? null,
    bankEmployeeCount: null,
  };
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
    .map((run) => toPayableRun(run, codes.get(run.id) ?? run.id))
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
    .map((run) => toPayableRun(run, codes.get(run.id) ?? run.id))
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

/** One page of the PT's batches across runs, newest first (max 20). */
export const fetchPayoutBatches = (
  query: ListBatchesQuery,
  signal?: AbortSignal,
) => callEndpoint(listPayoutBatches, { query }, { signal });

export const fetchBatch = (batchId: string, signal?: AbortSignal) =>
  callEndpoint(getDisbursementBatch, { params: { id: batchId } }, { signal });

/** First steps of resolve/return waiting for their second person. */
export const fetchResolutionProposals = (
  batchId: string,
  signal?: AbortSignal,
) =>
  callEndpoint(
    listResolutionProposals,
    { params: { id: batchId } },
    { signal },
  );

/** One logged step of the caller: the page the receipt notification links to. */
export const fetchApprovalLog = (logId: string, signal?: AbortSignal) =>
  callEndpoint(getPayoutApprovalLog, { params: { logId } }, { signal });

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
  // The payee's bank account comes from the item's locked snapshot, never from
  // the HR profile.
  return page.data.map((employee) => ({
    id: employee.id,
    userId: employee.userId,
    name: employee.fullName,
    subtitle: employee.employeeNo,
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

export const postReturnItems = (batchId: string, body: ReturnItemsInput) =>
  callEndpoint(returnDisbursementItems, { params: { id: batchId }, body });

/** "Not me": freezes the batch of that logged step. Repeating is harmless. */
export const postDisownApproval = (logId: string, body: DisownApprovalInput) =>
  callEndpoint(disownPayoutApproval, { params: { logId }, body });

/** Releases every open "not me" claim of the batch. */
export const postUnfreezeBatch = (batchId: string, body: UnfreezeBatchInput) =>
  callEndpoint(unfreezeDisbursementBatch, { params: { id: batchId }, body });

/** Takes back a step-one proposal that corrects a failed item. */
export const postWithdrawCorrection = (
  batchId: string,
  body: WithdrawProposalInput,
) => callEndpoint(withdrawFailedCorrection, { params: { id: batchId }, body });

/** Takes back a step-one proposal that records overpaid items. */
export const postWithdrawOverpaid = (
  batchId: string,
  body: WithdrawProposalInput,
) => callEndpoint(withdrawOverpaidProposal, { params: { id: batchId }, body });

export const postConfirmCash = (batchId: string, body: ConfirmCashInput) =>
  callEndpoint(confirmDisbursementCash, { params: { id: batchId }, body });

/**
 * A signed link (60 seconds) to one stored proof. Read it when the person
 * clicks and open it at once; do not keep it.
 */
export const fetchPayoutEvidenceLink = (batchId: string, key: string) =>
  callEndpoint(readPayoutEvidence, { params: { id: batchId }, query: { key } });

/**
 * Uploads a resolve/return proof (multipart `file`, sent without a JSON
 * content type so the browser sets the boundary). The server sniffs the bytes;
 * a failure becomes an `ApiError` carrying the server's status and code.
 */
export async function uploadPayoutEvidence(
  batchId: string,
  file: File,
  password?: string,
): Promise<PayrollPayoutEvidenceUploadDto> {
  if (API_MOCK) {
    // The mock registry carries JSON only, so the mock answers here. A PDF
    // mimics the server while the PDF scanner is not wired (503).
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf")
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "Pemindai malware belum tersedia.",
      );
    return {
      evidenceKey: `tenants/mock/payroll-payout/${batchId}/evidence/mock.png`,
      contentType: file.type === "image/jpeg" ? "image/jpeg" : "image/png",
      sizeBytes: file.size,
    };
  }
  const body = new FormData();
  // Text fields go before the file part so the server reads them first.
  if (password) body.set("password", password);
  body.set("file", file);
  const path = PAYOUT_EVIDENCE_UPLOAD_PATH.replace(
    ":id",
    encodeURIComponent(batchId),
  );
  let response: Response;
  try {
    response = await fetch(new URL(path, API_URL), {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json" },
      body,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorBodySchema.safeParse(payload);
    const error = parsed.success ? parsed.data.error : undefined;
    throw new ApiError(
      response.status,
      error?.code ?? "HTTP_ERROR",
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details,
    );
  }
  return payoutEvidenceUploadResponseSchema.parse(payload).data;
}

export type ExportedFile = { filename: string; checksumSha256: string };

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Not right after the click: some browsers start the download later.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * The manual bank file leaves the server once (a second call answers 409
 * PAYOUT_EXPORT_ALREADY_DOWNLOADED), so this reads the answer as a file and
 * saves it in the same step. Browser only.
 */
export async function postExportBatch(
  batchId: string,
  bankFormat: PayoutBankFormat | null = null,
  password?: string,
): Promise<ExportedFile> {
  if (API_MOCK) {
    const { data } = await callEndpoint(exportDisbursementBatch, {
      params: { id: batchId },
      body: password ? { password } : {},
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
      body: JSON.stringify(password ? { password } : {}),
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
  try {
    saveBlob(await response.blob(), filename);
  } catch {
    // The server already marked the batch exported and keeps no copy.
    throw new ApiError(
      500,
      "PAYOUT_EXPORT_FILE_LOST",
      "Berkas sudah dibuat server tetapi gagal tersimpan. Hubungi admin.",
    );
  }
  return {
    filename,
    checksumSha256: response.headers.get("x-content-checksum-sha256") ?? "",
  };
}

// ---- Recon flags and return-claim withdrawal -----------------------------------
// The wire of two routers the shared payout contract does not list yet
// (payroll-payout-recon-clearance.routes.ts, payroll-payout-return-withdraw
// .routes.ts). Declared here so `callEndpoint` and `registerMock` still type
// them; the bodies reuse the API's own validators. Both need `payroll.disburse
// .approve`; the POSTs re-ask the password (the grant accepts it only).

const PAYROLL_BASE = "/api/hris/payroll";
const instant = z.string();

const reconFlagSchema = z.object({
  id: z.string(),
  kind: z.string(),
  itemId: z.string(),
  payslipId: z.string(),
  batchId: z.string(),
  reason: z.string(),
  flaggedAt: instant,
  reopened: z.boolean(),
  clearance: z
    .object({
      id: z.string(),
      status: z.enum(["proposed", "approved"]),
      reason: z.string(),
      proposedBy: z.string(),
      proposedAt: instant,
      approvedBy: z.string().nullable(),
      approvedAt: instant.nullable(),
    })
    .nullable(),
});

const returnClaimSchema = z.object({
  id: z.string(),
  status: z.enum(["open", "consumed", "withdrawn"]),
  bankRef: z.string().nullable(),
  itemCount: z.number().int(),
  createdBy: z.string(),
  createdAt: instant,
  withdrawal: z
    .object({
      id: z.string(),
      reason: z.string(),
      proposedBy: z.string(),
      proposedAt: instant,
    })
    .nullable(),
});

export const listPayoutReconFlagsEndpoint = defineEndpoint({
  method: "GET",
  path: `${PAYROLL_BASE}/payout-recon-flags`,
  response: z.object({ data: z.array(reconFlagSchema) }),
});

/** 201 `{ clearanceId }`. */
export const proposeReconClearanceEndpoint = defineEndpoint({
  method: "POST",
  path: `${PAYROLL_BASE}/payout-recon-flags/:flagId/clearance`,
  params: payoutReconFlagParamsSchema,
  body: proposePayoutReconClearanceInputSchema,
  response: z.object({ data: z.object({ clearanceId: z.string() }) }),
});

export const approveReconClearanceEndpoint = defineEndpoint({
  method: "POST",
  path: `${PAYROLL_BASE}/payout-recon-clearances/:clearanceId/approve`,
  params: payoutReconClearanceParamsSchema,
  body: approvePayoutReconClearanceInputSchema,
  response: z.object({ data: z.object({ clearanceId: z.string() }) }),
});

export const listBatchReturnClaimsEndpoint = defineEndpoint({
  method: "GET",
  path: `${PAYROLL_BASE}/disbursement-batches/:id/return-claims`,
  params: payoutReturnClaimBatchParamsSchema,
  response: z.object({ data: z.array(returnClaimSchema) }),
});

/** 201 `{ withdrawalId }`. */
export const proposeReturnWithdrawalEndpoint = defineEndpoint({
  method: "POST",
  path: `${PAYROLL_BASE}/payout-return-claims/:claimId/withdrawal`,
  params: payoutReturnClaimParamsSchema,
  body: proposePayoutReturnWithdrawInputSchema,
  response: z.object({ data: z.object({ withdrawalId: z.string() }) }),
});

export const approveReturnWithdrawalEndpoint = defineEndpoint({
  method: "POST",
  path: `${PAYROLL_BASE}/payout-return-withdrawals/:withdrawalId/approve`,
  params: payoutReturnWithdrawalParamsSchema,
  body: approvePayoutReturnWithdrawInputSchema,
  response: z.object({
    data: z.object({
      withdrawalId: z.string(),
      restoredItems: z.number().int(),
    }),
  }),
});

/** Reason (10 to 500 characters) plus the password the grant re-asks. */
export type ReconClearanceProposalInput = { reason: string; password?: string };
export type PasswordStepInput = { password?: string };

/** Every flag of the tenant with its clearance state, newest first. */
export async function listPayoutReconFlags(
  signal?: AbortSignal,
): Promise<PayoutReconFlagDto[]> {
  const response = await callEndpoint(
    listPayoutReconFlagsEndpoint,
    {},
    { signal },
  );
  return response.data;
}

/** First person: proposes closing a flag. Closes nothing by itself. */
export async function proposeReconClearance(
  flagId: string,
  body: ReconClearanceProposalInput,
): Promise<{ clearanceId: string }> {
  const response = await callEndpoint(proposeReconClearanceEndpoint, {
    params: { flagId },
    body,
  });
  return response.data;
}

/** Second person (not the proposer): approves the proposal. */
export async function approveReconClearance(
  clearanceId: string,
  body: PasswordStepInput = {},
): Promise<{ clearanceId: string }> {
  const response = await callEndpoint(approveReconClearanceEndpoint, {
    params: { clearanceId },
    body,
  });
  return response.data;
}

/** Return claims of one batch with their open withdrawal proposal. */
export async function listBatchReturnClaims(
  batchId: string,
  signal?: AbortSignal,
): Promise<PayoutReturnClaimDto[]> {
  const response = await callEndpoint(
    listBatchReturnClaimsEndpoint,
    { params: { id: batchId } },
    { signal },
  );
  return response.data;
}

/** First person: proposes withdrawing an open claim. Withdraws nothing yet. */
export async function proposeReturnWithdrawal(
  claimId: string,
  body: ReconClearanceProposalInput,
): Promise<{ withdrawalId: string }> {
  const response = await callEndpoint(proposeReturnWithdrawalEndpoint, {
    params: { claimId },
    body,
  });
  return response.data;
}

/** Second person (not the proposer): approves; the claim's items are restored. */
export async function approveReturnWithdrawal(
  withdrawalId: string,
  body: PasswordStepInput = {},
): Promise<{ withdrawalId: string; restoredItems: number }> {
  const response = await callEndpoint(approveReturnWithdrawalEndpoint, {
    params: { withdrawalId },
    body,
  });
  return response.data;
}
