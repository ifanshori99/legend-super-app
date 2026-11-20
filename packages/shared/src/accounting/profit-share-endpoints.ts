// Profit-share HTTP contracts (defineEndpoint). The WS-07 FE beads
// (legend-ogx3 admin, legend-ik9g shareholder dashboard) build screens and
// mock mode on these; the BE bead (legend-2ljb) implements them. The tenant
// comes from the session (TEN-02): every body schema is strict and carries no
// tenantId. Money in bodies is user input (an adjustment amount), never a
// computed total: the server calculates reserves, shares and tax.
import {
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  createAdjustmentDistributionInputSchema,
  createDistributionRunInputSchema,
  createShareAllocationVersionInputSchema,
  createShareholderDocumentInputSchema,
  createShareholderInputSchema,
  createProfitEntityInputSchema,
  distributionDecisionInputSchema,
  distributionRunSchema,
  distributionRunStatusSchema,
  distributionRunSummarySchema,
  distributionStatementSchema,
  myProfitShareSchema,
  profitEntitySchema,
  recordDistributionPaymentInputSchema,
  shareAllocationVersionSchema,
  shareAllocationVersionStatusSchema,
  shareVersionDecisionInputSchema,
  shareholderDocumentFileSchema,
  shareholderDocumentKindSchema,
  shareholderDocumentSchema,
  shareholderSchema,
  updateProfitEntityInputSchema,
  updateShareAllocationVersionInputSchema,
  updateShareholderInputSchema,
  uploadShareholderDocumentFileMetadataSchema,
  cancelApprovedDistributionInputSchema,
} from "./profit-share.ts";
import {
  distributionLineIdSchema,
  distributionRunIdSchema,
  profitEntityIdSchema,
  shareholderDocumentIdSchema,
  shareholderIdSchema,
} from "./ids.ts";

const BASE = "/api/accounting";
const profitEntityParams = z.strictObject({
  profitEntityId: profitEntityIdSchema,
});
const versionParams = profitEntityParams.extend({
  version: z.coerce.number().int().min(1).max(1_000_000),
});
const runParams = z.strictObject({
  distributionRunId: distributionRunIdSchema,
});
const lineParams = runParams.extend({
  distributionLineId: distributionLineIdSchema,
});
const commandBody = z.strictObject({ idempotencyKey: idempotencyKeySchema });
const list = <T extends z.ZodType>(item: T) =>
  dataResponseSchema(z.array(item));

// ---- Profit entities & policy (§3.37 Entitas Bagi Hasil) ------------------

export const listProfitEntities = defineEndpoint({
  method: "GET",
  path: `${BASE}/profit-entities`,
  response: list(profitEntitySchema),
});
export const createProfitEntity = defineEndpoint({
  method: "POST",
  path: `${BASE}/profit-entities`,
  body: createProfitEntityInputSchema,
  response: dataResponseSchema(profitEntitySchema),
});
export const updateProfitEntity = defineEndpoint({
  method: "PATCH",
  path: `${BASE}/profit-entities/:profitEntityId`,
  params: profitEntityParams,
  body: updateProfitEntityInputSchema,
  response: dataResponseSchema(profitEntitySchema),
});

// ---- Shareholder register (§3.37 Daftar Pemegang Saham) -------------------

export const listShareholders = defineEndpoint({
  method: "GET",
  path: `${BASE}/shareholders`,
  response: list(shareholderSchema),
});
export const createShareholder = defineEndpoint({
  method: "POST",
  path: `${BASE}/shareholders`,
  body: createShareholderInputSchema,
  response: dataResponseSchema(shareholderSchema),
});
export const updateShareholder = defineEndpoint({
  method: "PATCH",
  path: `${BASE}/shareholders/:shareholderId`,
  params: z.strictObject({ shareholderId: shareholderIdSchema }),
  body: updateShareholderInputSchema,
  response: dataResponseSchema(shareholderSchema),
});

// ---- Versioned shares (SH-03) ---------------------------------------------

const shareVersionsPath = `${BASE}/profit-entities/:profitEntityId/share-versions`;
export const listShareAllocationVersions = defineEndpoint({
  method: "GET",
  path: shareVersionsPath,
  params: profitEntityParams,
  query: z.strictObject({
    status: shareAllocationVersionStatusSchema.optional(),
  }),
  response: list(shareAllocationVersionSchema),
});
export const getShareAllocationVersion = defineEndpoint({
  method: "GET",
  path: `${shareVersionsPath}/:version`,
  params: versionParams,
  response: dataResponseSchema(shareAllocationVersionSchema),
});
export const createShareAllocationVersion = defineEndpoint({
  method: "POST",
  path: shareVersionsPath,
  params: profitEntityParams,
  body: createShareAllocationVersionInputSchema,
  response: dataResponseSchema(shareAllocationVersionSchema),
});
/** Draft only; the server refuses a submitted or approved version. */
export const updateShareAllocationVersion = defineEndpoint({
  method: "PATCH",
  path: `${shareVersionsPath}/:version`,
  params: versionParams,
  body: updateShareAllocationVersionInputSchema,
  response: dataResponseSchema(shareAllocationVersionSchema),
});
export const submitShareAllocationVersion = defineEndpoint({
  method: "POST",
  path: `${shareVersionsPath}/:version/submit`,
  params: versionParams,
  body: commandBody,
  response: dataResponseSchema(shareAllocationVersionSchema),
});
export const decideShareAllocationVersion = defineEndpoint({
  method: "POST",
  path: `${shareVersionsPath}/:version/decision`,
  params: versionParams,
  body: shareVersionDecisionInputSchema,
  response: dataResponseSchema(shareAllocationVersionSchema),
});

// ---- Distribution cycle (§3.37 Siklus Distribusi, §4 P) -------------------

const distributionsPath = `${BASE}/profit-entities/:profitEntityId/distributions`;
export const listDistributionRuns = defineEndpoint({
  method: "GET",
  path: distributionsPath,
  params: profitEntityParams,
  query: cursorPageQuerySchema.extend({
    status: distributionRunStatusSchema.optional(),
  }),
  response: cursorPageSchema(distributionRunSummarySchema),
});
/** Calculate + simulate: returns the draft run with per-shareholder lines. */
export const createDistributionRun = defineEndpoint({
  method: "POST",
  path: distributionsPath,
  params: profitEntityParams,
  body: createDistributionRunInputSchema,
  response: dataResponseSchema(distributionRunSchema),
});
export const getDistributionRun = defineEndpoint({
  method: "GET",
  path: `${BASE}/distributions/:distributionRunId`,
  params: runParams,
  response: dataResponseSchema(distributionRunSchema),
});
export const submitDistributionRun = defineEndpoint({
  method: "POST",
  path: `${BASE}/distributions/:distributionRunId/submit`,
  params: runParams,
  body: commandBody,
  response: dataResponseSchema(distributionRunSchema),
});
export const decideDistributionRun = defineEndpoint({
  method: "POST",
  path: `${BASE}/distributions/:distributionRunId/decision`,
  params: runParams,
  body: distributionDecisionInputSchema,
  response: dataResponseSchema(distributionRunSchema),
});
/** SO 1216 F-P1a: withdraw an approved run before any line is paid. */
export const cancelApprovedDistributionRun = defineEndpoint({
  method: "POST",
  path: `${BASE}/distributions/:distributionRunId/cancel-approved`,
  params: runParams,
  body: cancelApprovedDistributionInputSchema,
  response: dataResponseSchema(distributionRunSchema),
});
export const recordDistributionPayment = defineEndpoint({
  method: "POST",
  path: `${BASE}/distributions/:distributionRunId/lines/:distributionLineId/payment`,
  params: lineParams,
  body: recordDistributionPaymentInputSchema,
  response: dataResponseSchema(distributionRunSchema),
});
/** SH-04: the correction path for an approved/paid run. */
export const createAdjustmentDistribution = defineEndpoint({
  method: "POST",
  path: `${BASE}/distributions/:distributionRunId/adjustment`,
  params: runParams,
  body: createAdjustmentDistributionInputSchema,
  response: dataResponseSchema(distributionRunSchema),
});
/** One shareholder's statement; a shareholder may read only their own line (SH-01). */
export const getDistributionStatement = defineEndpoint({
  method: "GET",
  path: `${BASE}/distributions/:distributionRunId/lines/:distributionLineId/statement`,
  params: lineParams,
  response: dataResponseSchema(distributionStatementSchema),
});

// ---- Shareholder documents & self view (F35, SH-01, SH-02) ---------------

export const listShareholderDocuments = defineEndpoint({
  method: "GET",
  path: `${BASE}/shareholder-documents`,
  query: cursorPageQuerySchema.extend({
    profitEntityId: profitEntityIdSchema.optional(),
    kind: shareholderDocumentKindSchema.optional(),
  }),
  response: cursorPageSchema(shareholderDocumentSchema),
});
export const createShareholderDocument = defineEndpoint({
  method: "POST",
  path: `${BASE}/shareholder-documents`,
  body: createShareholderDocumentInputSchema,
  response: dataResponseSchema(shareholderDocumentSchema),
});
export const publishShareholderDocument = defineEndpoint({
  method: "POST",
  path: `${BASE}/shareholder-documents/:shareholderDocumentId/publish`,
  params: z.strictObject({
    shareholderDocumentId: shareholderDocumentIdSchema,
  }),
  body: commandBody,
  response: dataResponseSchema(shareholderDocumentSchema),
});
/** Multipart upload of the PDF (field `file` + `profitEntityId`); manager only. */
export const uploadShareholderDocumentFile = defineEndpoint({
  method: "POST",
  path: `${BASE}/shareholder-documents/files`,
  body: uploadShareholderDocumentFileMetadataSchema,
  response: dataResponseSchema(shareholderDocumentFileSchema),
});
export const shareholderDocumentSignedUrlBodySchema = z.strictObject({});
/** Short-lived download URL (300 s); a shareholder only for a published own document. */
export const createShareholderDocumentSignedUrl = defineEndpoint({
  method: "POST",
  path: `${BASE}/shareholder-documents/:shareholderDocumentId/signed-url`,
  params: z.strictObject({
    shareholderDocumentId: shareholderDocumentIdSchema,
  }),
  body: shareholderDocumentSignedUrlBodySchema,
  response: dataResponseSchema(
    z.strictObject({ url: z.url(), expiresAt: isoDateTimeSchema }),
  ),
});
/** The caller's own share, history, statements and labelled estimates. */
export const getMyProfitShare = defineEndpoint({
  method: "GET",
  path: `${BASE}/my-profit-share`,
  response: dataResponseSchema(myProfitShareSchema),
});

/** Every profit-share endpoint, for registries and route-coverage tests. */
export const profitShareEndpoints = Object.freeze({
  listProfitEntities,
  createProfitEntity,
  updateProfitEntity,
  listShareholders,
  createShareholder,
  updateShareholder,
  listShareAllocationVersions,
  getShareAllocationVersion,
  createShareAllocationVersion,
  updateShareAllocationVersion,
  submitShareAllocationVersion,
  decideShareAllocationVersion,
  listDistributionRuns,
  createDistributionRun,
  getDistributionRun,
  submitDistributionRun,
  decideDistributionRun,
  recordDistributionPayment,
  createAdjustmentDistribution,
  getDistributionStatement,
  listShareholderDocuments,
  createShareholderDocument,
  publishShareholderDocument,
  getMyProfitShare,
});
