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
  PAYOUT_EXCLUDED_REASONS,
  PAYOUT_ITEM_STATUSES,
  PAYOUT_METHODS,
  approveDisbursementBatchInputSchema,
  cancelDisbursementBatchInputSchema,
  confirmCashHandoverInputSchema,
  confirmManualItemsInputSchema,
  createDisbursementBatchInputSchema,
  payoutBatchParamsSchema,
  payoutLegalEntityParamsSchema,
  payoutRunParamsSchema,
  resolveManualItemsSchema,
  upsertPayoutConfigInputSchema,
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
  nameMatch: z.boolean().nullable(),
  providerRef: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  confirmationRef: z.string().nullable(),
  settledAt: instant.nullable(),
  createdAt: instant,
  updatedAt: instant,
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
  items: z.array(payoutItemSchema),
});

const emptyBody = z.strictObject({});
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
  body: emptyBody,
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
