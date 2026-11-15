// Payroll payout (disbursement) contract: per-legal-entity payout config,
// batches, manual bank confirmation, cash handover. Money is whole rupiah.
// Design: docs/design/payroll-disbursement.md. There is no `doit` channel.
import { z } from "zod";

import { cursorPageQuerySchema } from "../core/pagination.ts";

export const PAYOUT_METHODS = ["duitku", "manual_bank"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PAYOUT_CHANNELS = ["duitku", "manual_bank", "cash"] as const;
export type PayoutChannel = (typeof PAYOUT_CHANNELS)[number];

export const PAYOUT_BANK_FORMATS = [
  "generic_csv",
  "bca",
  "mandiri",
  "bni",
  "bjb",
] as const;
export type PayoutBankFormat = (typeof PAYOUT_BANK_FORMATS)[number];

export const PAYOUT_BATCH_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "sending",
  "exported",
  "completed",
  "partially_failed",
  "halted",
  "cancelled",
] as const;
export type PayoutBatchStatus = (typeof PAYOUT_BATCH_STATUSES)[number];

export const PAYOUT_ITEM_STATUSES = [
  "prepared",
  "blocked",
  "approved",
  "sending",
  "exported",
  "unknown",
  "succeeded",
  "failed",
  "not_sent",
  "cancelled",
  "returned",
  "overpaid",
] as const;
export type PayoutItemStatus = (typeof PAYOUT_ITEM_STATUSES)[number];

export const PAYOUT_EXCLUDED_REASONS = [
  "inquiry_failed",
  "name_mismatch",
  "bank_code_missing",
  "bank_format_unsupported",
  "over_cap",
] as const;
export type PayoutExcludedReason = (typeof PAYOUT_EXCLUDED_REASONS)[number];

/** Per-transfer ceiling a PT may set (whole rupiah). */
export const PAYOUT_MAX_PER_TRANSFER_CEILING_IDR = 100_000_000;
export const PAYOUT_DEFAULT_MAX_PER_TRANSFER_IDR = 50_000_000;
export const PAYOUT_DEFAULT_FEE_PER_TRANSFER_IDR = 5_000;

const idr = z.number().int().safe();
const text = (max: number) => z.string().trim().min(1).max(max);

export const payoutLegalEntityParamsSchema = z.strictObject({
  legalEntityId: z.uuid(),
});
export const payoutRunParamsSchema = z.strictObject({ id: z.uuid() });
export const payoutBatchParamsSchema = z.strictObject({ id: z.uuid() });
/** Params of a payout GL posting inside its batch (finance source record). */
export const payoutPostingParamsSchema = z.strictObject({
  id: z.uuid(),
  postingId: z.uuid(),
});
/**
 * Finance names the GL account a pending/skipped settlement was paid from when
 * the handover could not freeze it (legend-zlcsd). Nothing else is accepted.
 */
export const recordPostingSourceInputSchema = z.strictObject({
  glAccountId: z.uuid(),
  // Asked again when the session's second factor only comes from the first MFA
  // enrollment (legend-658, L5), same as confirm-cash. Never logged.
  password: z.string().min(1).max(128).optional(),
});
/** Page size of the payout recovery list (settlements and fees waiting). */
export const PAYOUT_RECOVERY_LIMIT_MAX = 200;
export const PAYOUT_RECOVERY_LIMIT_DEFAULT = 100;
/** Query of the recovery list: opaque cursor from `next`, page size 1..200. */
export const listPayoutRecoveryQuerySchema = z.strictObject({
  after: z.string().min(1).max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAYOUT_RECOVERY_LIMIT_MAX)
    .optional(),
});
/** Query of the proof read path: the key an upload returned (shape is checked by the API). */
export const payoutEvidenceReadQuerySchema = z.strictObject({
  key: z.string().min(1).max(500),
});

export const payoutMethodSchema = z.enum(PAYOUT_METHODS);
export const payoutChannelSchema = z.enum(PAYOUT_CHANNELS);
export const payoutBankFormatSchema = z.enum(PAYOUT_BANK_FORMATS);

/** SHA-256 hex of the ordered batch items, as shown to the approver. */
export const payoutContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

// The current account password, asked again when the session's second factor
// only comes from the first MFA enrollment (legend-658, L5). Never logged.
const reauthPasswordSchema = z.string().min(1).max(128).optional();

export const upsertPayoutConfigInputSchema = z
  .strictObject({
    password: reauthPasswordSchema,
    method: payoutMethodSchema,
    integrationId: z.uuid().nullable(),
    manualSourceBankAccountId: z.uuid(),
    manualBankFormat: payoutBankFormatSchema.default("generic_csv"),
    maxPerTransferIdr: idr
      .positive()
      .max(PAYOUT_MAX_PER_TRANSFER_CEILING_IDR)
      .default(PAYOUT_DEFAULT_MAX_PER_TRANSFER_IDR),
    dailyCapIdr: idr.positive().nullable().default(null),
    feePerTransferIdr: idr
      .nonnegative()
      .default(PAYOUT_DEFAULT_FEE_PER_TRANSFER_IDR),
    enabled: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.method === "duitku" && value.integrationId === null)
      ctx.addIssue({
        code: "custom",
        path: ["integrationId"],
        message: "integrationId is required for duitku.",
      });
    if (value.method === "manual_bank" && value.integrationId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["integrationId"],
        message: "integrationId must be null for manual_bank.",
      });
  });

export const createDisbursementBatchInputSchema = z.strictObject({
  channel: payoutChannelSchema,
});

// `sourceBankAccountId` is the account the approver saw (legend-3j9yz); the key
// is required, null for a batch that is not manual_bank.
export const approveDisbursementBatchInputSchema = z.strictObject({
  contentHash: payoutContentHashSchema,
  sourceBankAccountId: z.uuid().nullable(),
  password: reauthPasswordSchema,
});

// The export body carries only the re-authentication password (legend-w5yx6).
export const exportDisbursementBatchInputSchema = z.strictObject({
  password: reauthPasswordSchema,
});

export const cancelDisbursementBatchInputSchema = z.strictObject({
  reason: text(500),
});

// Confirm only ever records a success (one non-requester, bank ref required).
// Moving an exported item to failed or not_sent is `resolveManualItems`.
const confirmResultSchema = z.strictObject({
  itemId: z.uuid(),
  result: z.literal("succeeded"),
  bankRef: text(64),
  evidenceKey: text(200).optional(),
});

export const confirmManualItemsInputSchema = z
  .strictObject({
    results: z.array(confirmResultSchema).min(1).max(1000),
    password: reauthPasswordSchema,
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of value.results.entries()) {
      if (seen.has(entry.itemId))
        ctx.addIssue({
          code: "custom",
          path: ["results", index, "itemId"],
          message: "Each item may appear once.",
        });
      seen.add(entry.itemId);
    }
  });

/** Outcomes a manual resolve may propose for an `exported` item. */
export const PAYOUT_RESOLVE_OUTCOMES = ["failed", "not_sent"] as const;
export type PayoutResolveOutcome = (typeof PAYOUT_RESOLVE_OUTCOMES)[number];

// Two different non-requesters must give the same outcome before an exported
// item leaves `exported`; evidence and a note are mandatory on every call.
export const resolveManualItemsSchema = z
  .strictObject({
    itemIds: z.array(z.uuid()).min(1).max(1000),
    outcome: z.enum(PAYOUT_RESOLVE_OUTCOMES),
    evidenceKey: text(200),
    note: text(500),
    password: reauthPasswordSchema,
  })
  .refine((value) => new Set(value.itemIds).size === value.itemIds.length, {
    path: ["itemIds"],
    message: "Each item may appear once.",
  });

// Takes back a step-one resolve proposal (wrong proof, wrong outcome) so a new
// one can be recorded; a finished step two cannot be taken back.
export const withdrawResolutionSchema = z
  .strictObject({
    itemIds: z.array(z.uuid()).min(1).max(1000),
    password: reauthPasswordSchema,
  })
  .refine((value) => new Set(value.itemIds).size === value.itemIds.length, {
    path: ["itemIds"],
    message: "Each item may appear once.",
  });

// Funds came back after a paid transfer: two different non-requesters each
// call this with the same evidence; the second one moves the item to `returned`.
export const returnManualItemsSchema = z
  .strictObject({
    itemIds: z.array(z.uuid()).min(1).max(1000),
    evidenceKey: text(200),
    note: text(500),
    password: reauthPasswordSchema,
  })
  .refine((value) => new Set(value.itemIds).size === value.itemIds.length, {
    path: ["itemIds"],
    message: "Each item may appear once.",
  });

// A transfer reported paid twice after the first attempt was closed as failed
// and a later attempt succeeded (legend-v6gtp). Two different non-requesters
// each call this with the same evidence; the second one records the overpaid
// items (receivable journal). Nothing is paid again by this call.
export const PAYOUT_OVERPAID_ITEMS_MAX = 50;
export const recordOverpaidItemsSchema = z
  .strictObject({
    itemIds: z.array(z.uuid()).min(1).max(PAYOUT_OVERPAID_ITEMS_MAX),
    evidenceKey: text(200),
    note: text(500),
    password: reauthPasswordSchema,
  })
  .refine((value) => new Set(value.itemIds).size === value.itemIds.length, {
    path: ["itemIds"],
    message: "Each item may appear once.",
  });

// A transfer closed as `failed` (resolution final) that never got a later
// successful payment is corrected to `succeeded` once the bank proof shows it
// reached the employee (legend-mejr2). Two different people give the same
// evidence; the second one flips the items and settles the payable once.
// Nothing is paid again by this call. One bank proof proves one transfer, so
// one call corrects exactly one item.
export const PAYOUT_CORRECT_FAILED_ITEMS_MAX = 1;
export const correctFailedItemsSchema = z
  .strictObject({
    itemIds: z.array(z.uuid()).min(1).max(PAYOUT_CORRECT_FAILED_ITEMS_MAX),
    evidenceKey: text(200),
    note: text(500),
    password: reauthPasswordSchema,
  })
  .refine((value) => new Set(value.itemIds).size === value.itemIds.length, {
    path: ["itemIds"],
    message: "Each item may appear once.",
  });

export const confirmCashHandoverInputSchema = z
  .strictObject({
    itemIds: z.array(z.uuid()).min(1).max(1000),
    evidenceKey: text(200).optional(),
    password: reauthPasswordSchema,
  })
  .refine((value) => new Set(value.itemIds).size === value.itemIds.length, {
    path: ["itemIds"],
    message: "Each item may appear once.",
  });

// Closing a stuck proof key (legend-6htrf, 905 card 3). Two different finance
// people with a fresh password step-up: the first proposes with a note, the
// second approves. The key stays bound forever; nothing new is paid over it.
export const PAYOUT_STUCK_PROOF_LIMIT_MAX = 100;
export const PAYOUT_STUCK_PROOF_LIMIT_DEFAULT = 50;
/** Query of the stuck proof list: opaque cursor from `nextCursor`, page size 1..100. */
export const listPayoutStuckProofsQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAYOUT_STUCK_PROOF_LIMIT_MAX)
    .default(PAYOUT_STUCK_PROOF_LIMIT_DEFAULT),
});
export type ListPayoutStuckProofsQuery = z.infer<
  typeof listPayoutStuckProofsQuerySchema
>;
export const proposePayoutProofClosureSchema = z.strictObject({
  evidenceKey: text(500),
  note: text(500),
  password: reauthPasswordSchema,
});
export type ProposePayoutProofClosureInput = z.infer<
  typeof proposePayoutProofClosureSchema
>;
export const approvePayoutProofClosureSchema = z.strictObject({
  password: reauthPasswordSchema,
});
export const payoutProofClosureParamsSchema = z.strictObject({ id: z.uuid() });

// Batch list across runs (legend-396pf): newest first, cursor paged, optional
// legal entity and status filters. Tenant comes from the session.
export const PAYOUT_BATCH_LIST_LIMIT_MAX = 20;
export const listPayoutBatchesQuerySchema = cursorPageQuerySchema.extend({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAYOUT_BATCH_LIST_LIMIT_MAX)
    .default(PAYOUT_BATCH_LIST_LIMIT_MAX),
  legalEntityId: z.uuid().optional(),
  status: z.enum(PAYOUT_BATCH_STATUSES).optional(),
});
export type ListPayoutBatchesQuery = z.infer<
  typeof listPayoutBatchesQuerySchema
>;

// Evidence upload for resolve and return (legend-zoqh1): one multipart `file`
// part. The API sniffs the bytes; the declared type is not trusted.
export const PAYOUT_EVIDENCE_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
export type PayoutEvidenceContentType =
  (typeof PAYOUT_EVIDENCE_CONTENT_TYPES)[number];
export const PAYOUT_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

export type UpsertPayoutConfigInput = z.infer<
  typeof upsertPayoutConfigInputSchema
>;
export type CreateDisbursementBatchInput = z.infer<
  typeof createDisbursementBatchInputSchema
>;
export type ApproveDisbursementBatchInput = z.infer<
  typeof approveDisbursementBatchInputSchema
>;
export type CancelDisbursementBatchInput = z.infer<
  typeof cancelDisbursementBatchInputSchema
>;
export type ConfirmManualItemsInput = z.infer<
  typeof confirmManualItemsInputSchema
>;
export type ResolveManualItemsInput = z.infer<typeof resolveManualItemsSchema>;
export type WithdrawResolutionInput = z.infer<typeof withdrawResolutionSchema>;
export type ReturnManualItemsInput = z.infer<typeof returnManualItemsSchema>;
export type RecordOverpaidItemsInput = z.infer<
  typeof recordOverpaidItemsSchema
>;
export type CorrectFailedItemsInput = z.infer<typeof correctFailedItemsSchema>;
export type ConfirmCashHandoverInput = z.infer<
  typeof confirmCashHandoverInputSchema
>;
export type RecordPostingSourceInput = z.infer<
  typeof recordPostingSourceInputSchema
>;
