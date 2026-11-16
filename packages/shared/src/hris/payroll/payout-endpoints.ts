// Payroll payout (disbursement) endpoint contracts for the typed web client and
// its mock (legend-wnkep.7). The API routes live in
// apps/api/src/routes/payroll-payout*.routes.ts and validate with the schemas in
// validators/payroll-payout.ts; these objects only describe the wire so the
// screens can use `callEndpoint` and `registerMock`. Responses are the DTOs of
// types/api.ts. Every POST sends a JSON body (the API refuses a POST without
// application/json), so bodyless actions declare an empty object.
import { z } from "zod";
import { defineEndpoint } from "../../api/endpoint.ts";
import {
  PAYOUT_BANK_FORMATS,
  PAYOUT_BATCH_STATUSES,
  PAYOUT_CHANNELS,
  PAYOUT_EVIDENCE_CONTENT_TYPES,
  PAYOUT_EXCLUDED_REASONS,
  PAYOUT_ITEM_STATUSES,
  PAYOUT_METHODS,
  approveDisbursementBatchInputSchema,
  cancelDisbursementBatchInputSchema,
  confirmCashHandoverInputSchema,
  confirmManualItemsInputSchema,
  correctFailedItemsSchema,
  createDisbursementBatchInputSchema,
  exportDisbursementBatchInputSchema,
  listPayoutBatchesQuerySchema,
  payoutBatchParamsSchema,
  payoutEvidenceReadQuerySchema,
  payoutLegalEntityParamsSchema,
  payoutRunParamsSchema,
  recordOverpaidItemsSchema,
  resolveManualItemsSchema,
  returnManualItemsSchema,
  upsertPayoutConfigInputSchema,
  withdrawPayoutProposalSchema,
} from "../../validators/payroll-payout.ts";

const BASE = "/api/hris/payroll";

const instant = z.string();
const idr = z.number().int();

export const payoutConfigSchema = z.object({
  id: z.string(),
  legalEntityId: z.string(),
  method: z.enum(PAYOUT_METHODS),
  integrationId: z.string().nullable(),
  manualSourceBankAccountId: z.string(),
  manualBankFormat: z.enum(PAYOUT_BANK_FORMATS),
  maxPerTransferIdr: idr,
  dailyCapIdr: idr.nullable(),
  feePerTransferIdr: idr,
  enabled: z.boolean(),
  updatedBy: z.string().nullable(),
  updatedAt: instant,
  createdAt: instant,
});

export const payoutItemSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  payslipId: z.string(),
  employeeId: z.string(),
  channel: z.enum(PAYOUT_CHANNELS),
  attemptNo: z.number().int(),
  status: z.enum(PAYOUT_ITEM_STATUSES),
  excludedReason: z.enum(PAYOUT_EXCLUDED_REASONS).nullable(),
  amountIdr: idr,
  feeIdr: idr,
  bankCode: z.string().nullable(),
  // Locked when the batch was created; null for cash and for legacy items.
  accountHolderName: z.string().nullable(),
  maskedAccountNumber: z.string().nullable(),
  nameMatch: z.boolean().nullable(),
  providerRef: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  confirmationRef: z.string().nullable(),
  settledAt: instant.nullable(),
  createdAt: instant,
  updatedAt: instant,
});

export const payoutBatchDisputeSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  logId: z.string(),
  createdAt: instant,
  batchStatusAt: z.string(),
  reason: z.string().nullable(),
  mine: z.boolean(),
});

export const payoutBatchFreezeSchema = z.object({
  frozen: z.boolean(),
  disputes: z.array(payoutBatchDisputeSchema),
});

export const payoutApprovalLogSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  kind: z.enum([
    "correction",
    "overpaid",
    "return",
    "posting_source",
    "closure",
    "resolve",
    "bank_confirm",
  ]),
  step: z.enum(["propose", "approve", "record", "confirm", "withdraw"]),
  itemCount: z.number().int(),
  period: z.string(),
  loggedAt: instant,
  disowned: z.boolean(),
  batchFrozen: z.boolean(),
});

export const payoutBatchSchema = z.object({
  id: z.string(),
  legalEntityId: z.string(),
  payrollRunId: z.string(),
  channel: z.enum(PAYOUT_CHANNELS),
  status: z.enum(PAYOUT_BATCH_STATUSES),
  haltReason: z.string().nullable(),
  requestedBy: z.string(),
  requestedAt: instant,
  approvedBy: z.string().nullable(),
  approvedAt: instant.nullable(),
  approvalExpiresAt: instant.nullable(),
  contentHash: z.string().nullable(),
  // The source bank account frozen at approval (null before; legend-3j9yz).
  sourceBankAccountId: z.string().nullable(),
  itemCount: z.number().int(),
  totalIdr: idr,
  bankFormat: z.enum(PAYOUT_BANK_FORMATS).nullable(),
  exportChecksumSha256: z.string().nullable(),
  exportedBy: z.string().nullable(),
  exportedAt: instant.nullable(),
  cancelledBy: z.string().nullable(),
  cancelledAt: instant.nullable(),
  cancelReason: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
  freeze: payoutBatchFreezeSchema,
  items: z.array(payoutItemSchema),
});

const emptyBody = z.strictObject({});

// "Not me" and unfreeze (legend-l2zru). Both re-ask the account password like
// the other payout steps; the reason of an unfreeze is the finance note, so it
// is required (10..500 characters after trimming).
const stepUpPasswordSchema = z.string().min(1).max(128).optional();

export const payoutApprovalLogParamsSchema = z.strictObject({
  logId: z.uuid(),
});

export const disownPayoutApprovalInputSchema = z.strictObject({
  password: stepUpPasswordSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});

export const unfreezePayoutBatchInputSchema = z.strictObject({
  password: stepUpPasswordSchema,
  reason: z.string().trim().min(10).max(500),
});

export type DisownPayoutApprovalInput = z.infer<
  typeof disownPayoutApprovalInputSchema
>;
export type UnfreezePayoutBatchInput = z.infer<
  typeof unfreezePayoutBatchInputSchema
>;
const batchResponse = z.object({ data: payoutBatchSchema });

// ---- Config ----------------------------------------------------------------

/** `data` is null until the PT has saved a config. */
export const getPayoutConfig = defineEndpoint({
  method: "GET",
  path: `${BASE}/payout-configs/:legalEntityId`,
  params: payoutLegalEntityParamsSchema,
  response: z.object({ data: payoutConfigSchema.nullable() }),
});

/** payroll.payout.configure + a recent second factor. */
export const upsertPayoutConfig = defineEndpoint({
  method: "PUT",
  path: `${BASE}/payout-configs/:legalEntityId`,
  params: payoutLegalEntityParamsSchema,
  body: upsertPayoutConfigInputSchema,
  response: z.object({ data: payoutConfigSchema }),
});

// ---- Batches ---------------------------------------------------------------

export const listRunDisbursementBatches = defineEndpoint({
  method: "GET",
  path: `${BASE}/runs/:id/disbursement-batches`,
  params: payoutRunParamsSchema,
  response: z.object({ data: z.array(payoutBatchSchema) }),
});

/**
 * Batches of the tenant across runs, newest first, cursor paged (max 20 per
 * page). Each batch carries its items, like the per-run list.
 */
export const listPayoutBatches = defineEndpoint({
  method: "GET",
  path: `${BASE}/payout-batches`,
  query: listPayoutBatchesQuerySchema,
  response: z.object({
    data: z.array(payoutBatchSchema),
    meta: z.object({
      limit: z.number().int(),
      nextCursor: z.string().nullable(),
    }),
  }),
});

export const createDisbursementBatch = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:id/disbursement-batches`,
  params: payoutRunParamsSchema,
  body: createDisbursementBatchInputSchema,
  response: batchResponse,
});

export const getDisbursementBatch = defineEndpoint({
  method: "GET",
  path: `${BASE}/disbursement-batches/:id`,
  params: payoutBatchParamsSchema,
  response: batchResponse,
});

/** Blocked items leave the batch; `excluded` lists them with the reason. */
export const submitDisbursementBatch = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/submit`,
  params: payoutBatchParamsSchema,
  body: emptyBody,
  response: z.object({
    data: z.object({
      batch: payoutBatchSchema,
      excluded: z.array(
        z.object({
          itemId: z.string(),
          payslipId: z.string(),
          employeeId: z.string(),
          reason: z.string().nullable(),
        }),
      ),
    }),
  }),
});

/** payroll.disburse.approve + step-up MFA; the approver differs from the requester. */
export const approveDisbursementBatch = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/approve`,
  params: payoutBatchParamsSchema,
  body: approveDisbursementBatchInputSchema,
  response: batchResponse,
});

export const cancelDisbursementBatch = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/cancel`,
  params: payoutBatchParamsSchema,
  body: cancelDisbursementBatchInputSchema,
  response: batchResponse,
});

/**
 * The real answer is a one-time file download (second call: 409
 * PAYOUT_EXPORT_ALREADY_DOWNLOADED). The web client reads it with a raw fetch;
 * this definition exists so mock mode can answer the same path with JSON.
 */
export const exportDisbursementBatch = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/export`,
  params: payoutBatchParamsSchema,
  body: exportDisbursementBatchInputSchema,
  response: z.object({
    data: z.object({
      filename: z.string(),
      contentType: z.string(),
      content: z.string(),
      checksumSha256: z.string(),
    }),
  }),
});

const confirmOutcome = z.object({
  batchStatus: z.enum(PAYOUT_BATCH_STATUSES),
  runPaid: z.boolean(),
  confirmed: z.number().int(),
});

export const confirmDisbursementItems = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/confirm`,
  params: payoutBatchParamsSchema,
  body: confirmManualItemsInputSchema,
  response: z.object({ data: confirmOutcome }),
});

export const resolveDisbursementItems = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/resolve`,
  params: payoutBatchParamsSchema,
  body: resolveManualItemsSchema,
  response: z.object({
    data: z.object({
      batchStatus: z.enum(PAYOUT_BATCH_STATUSES),
      resolved: z.number().int(),
      proposed: z.number().int(),
    }),
  }),
});

/**
 * Funds came back after a paid transfer (payroll.disburse.approve + step-up
 * MFA). Two different non-requesters give the same evidence: the first only
 * proposes (`proposed`), the second moves the item to `returned` (`returned`).
 */
export const returnDisbursementItems = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/return`,
  params: payoutBatchParamsSchema,
  body: returnManualItemsSchema,
  response: z.object({
    data: z.object({
      batchStatus: z.enum(PAYOUT_BATCH_STATUSES),
      returned: z.number().int(),
      proposed: z.number().int(),
    }),
  }),
});

/**
 * A transfer closed as `failed` turned out to have reached the employee after
 * another attempt of the same payslip was paid (payroll.disburse.approve +
 * step-up MFA + password after an enrollment-only stamp). Two different
 * non-requesters give the same evidence: the first only proposes (`proposed`),
 * the second moves each item to `overpaid` and posts the employee receivable
 * once (`recorded`). It never pays anything again.
 */
export const recordOverpaidDisbursementItems = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/overpaid`,
  params: payoutBatchParamsSchema,
  body: recordOverpaidItemsSchema,
  response: z.object({
    data: z.object({
      batchStatus: z.enum(PAYOUT_BATCH_STATUSES),
      stage: z.enum(["proposed", "recorded"]),
      recorded: z.number().int(),
      proposed: z.number().int(),
    }),
  }),
});

/**
 * A transfer closed as `failed` (resolution final, no later successful payment
 * of the same payslip) turned out to have reached the employee (legend-mejr2;
 * payroll.disburse.approve + step-up MFA + password). Two different people,
 * neither the failed-resolution maker nor the batch requester, give the same
 * bank proof: the first only proposes (`proposed`), the second moves each item
 * to `succeeded` and settles the frozen payable once (`corrected`). It never
 * pays anything again.
 */
export const correctFailedDisbursementItems = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/correct-failed`,
  params: payoutBatchParamsSchema,
  body: correctFailedItemsSchema,
  response: z.object({
    data: z.object({
      batchStatus: z.enum(PAYOUT_BATCH_STATUSES),
      stage: z.enum(["proposed", "corrected"]),
      corrected: z.number().int(),
      proposed: z.number().int(),
    }),
  }),
});

/**
 * Takes back an open correction proposal (legend-xatux; payroll.disburse.approve
 * + step-up MFA + password). The proposer or another approver, never the batch
 * requester. The items stay `failed`, nothing is paid, and the proof cannot be
 * used again. `itemIds` is the whole proposal (`groupItemIds`).
 */
export const withdrawFailedCorrection = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/correct-failed/withdraw`,
  params: payoutBatchParamsSchema,
  body: withdrawPayoutProposalSchema,
  response: z.object({
    data: z.object({ withdrawn: z.number().int() }),
  }),
});

/** Same as `withdrawFailedCorrection`, for an open overpaid proposal. */
export const withdrawOverpaidProposal = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/overpaid/withdraw`,
  params: payoutBatchParamsSchema,
  body: withdrawPayoutProposalSchema,
  response: z.object({
    data: z.object({ withdrawn: z.number().int() }),
  }),
});

/**
 * Upload of a resolve/return proof: multipart with one `file` part (JPEG, PNG
 * or PDF, 5 MiB; step-up MFA). The typed client cannot send multipart, so the
 * web reads this path with a raw fetch; the answer is parsed with
 * `payoutEvidenceUploadResponseSchema`. Pass `evidenceKey` to resolve or return.
 */
export const PAYOUT_EVIDENCE_UPLOAD_PATH = `${BASE}/disbursement-batches/:id/evidence`;
export const payoutEvidenceUploadResponseSchema = z.object({
  data: z.object({
    evidenceKey: z.string(),
    contentType: z.enum(PAYOUT_EVIDENCE_CONTENT_TYPES),
    sizeBytes: z.number().int(),
  }),
});

/**
 * Short-lived (60 s) signed link to one stored proof of the batch
 * (payroll.disburse.approve, no step-up). Ask for it when the person clicks;
 * never cache the answer.
 */
export const readPayoutEvidence = defineEndpoint({
  method: "GET",
  path: PAYOUT_EVIDENCE_UPLOAD_PATH,
  params: payoutBatchParamsSchema,
  query: payoutEvidenceReadQuerySchema,
  response: z.object({
    data: z.object({
      evidenceKey: z.string(),
      url: z.string(),
      expiresAt: instant,
    }),
  }),
});

/**
 * First steps of resolve/return waiting for their second person. The second
 * step must send the same `evidenceKey` (409 PAYOUT_RESOLVE_EVIDENCE_MISMATCH /
 * PAYOUT_RETURN_EVIDENCE_MISMATCH otherwise). `outcome` is null for a return.
 */
export const listResolutionProposals = defineEndpoint({
  method: "GET",
  path: `${BASE}/disbursement-batches/:id/resolution-proposals`,
  params: payoutBatchParamsSchema,
  response: z.object({
    data: z.array(
      z.object({
        itemId: z.string(),
        employeeId: z.string(),
        kind: z.enum(["resolve", "return", "correction", "overpaid"]),
        outcome: z.enum(["failed", "not_sent"]).nullable(),
        evidenceKey: z.string().nullable(),
        note: z.string().nullable(),
        proposedBy: z.string(),
        // Display name, only for a user of the same tenant (legend-eszso).
        proposedByName: z.string().nullable(),
        proposedAt: instant,
        // Only for correction and overpaid: all items of the proposal.
        groupItemIds: z.array(z.string()).optional(),
      }),
    ),
  }),
});

export const confirmDisbursementCash = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/confirm-cash`,
  params: payoutBatchParamsSchema,
  body: confirmCashHandoverInputSchema,
  response: z.object({
    data: z.object({
      batchStatus: z.enum(PAYOUT_BATCH_STATUSES),
      runPaid: z.boolean(),
    }),
  }),
});

/** Only the actor of the log gets it; anyone else answers 404. */
export const getPayoutApprovalLog = defineEndpoint({
  method: "GET",
  path: `${BASE}/payout-approval-log/:logId`,
  params: payoutApprovalLogParamsSchema,
  response: z.object({ data: payoutApprovalLogSchema }),
});

/** Freezes the batch of that log; repeating returns the same dispute id. */
export const disownPayoutApproval = defineEndpoint({
  method: "POST",
  path: `${BASE}/payout-approval-log/:logId/disown`,
  params: payoutApprovalLogParamsSchema,
  body: disownPayoutApprovalInputSchema,
  response: z.object({
    data: z.object({ disputeId: z.string(), batchId: z.string() }),
  }),
});

/** Releases every open dispute of the batch; 409 PAYOUT_UNFREEZE_REFUSED. */
export const unfreezeDisbursementBatch = defineEndpoint({
  method: "POST",
  path: `${BASE}/disbursement-batches/:id/unfreeze`,
  params: payoutBatchParamsSchema,
  body: unfreezePayoutBatchInputSchema,
  response: z.object({ data: z.object({ released: z.number().int() }) }),
});
