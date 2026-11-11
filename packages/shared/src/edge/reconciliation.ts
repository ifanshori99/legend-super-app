// Edge up-sync reconciliation (bead legend-kai). The edge reports what it has
// SENT (running ledger per event name, up to a link sequence watermark); the
// cloud compares that with what it has RECEIVED up to the same watermark.
// A mismatch is a report only: nothing is corrected automatically.
//
// Money is integer rupiah. `amountIdr` travels as a decimal string so a total
// above 2^53 stays exact; the services compute with BigInt only.
//
// Permission: `device.registry.manage` on the edge node's outlet.

import {
  z,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
} from "../core/index.ts";

export const edgeReconciliationStatusSchema = z.enum([
  "ok",
  "mismatch",
  "behind",
  "stale",
]);
export type EdgeReconciliationStatus = z.infer<
  typeof edgeReconciliationStatusSchema
>;

/** Largest value the edge ledger's bigint columns hold (2^63 - 1). */
const MAX_BIGINT = 9223372036854775807n;
/** Identity hash sums are kept modulo 2^64. */
const ID_HASH_LIMIT = 18446744073709551616n;

/**
 * Non-negative integer rupiah as a decimal string (no sign, no leading zeros),
 * within the bigint range the ledger can hold (0..9223372036854775807).
 */
export const edgeAmountIdrSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,29})$/, "Jumlah rupiah harus bilangan bulat.")
  .refine((value) => /^\d+$/.test(value) && BigInt(value) <= MAX_BIGINT, {
    message: "Nilai rupiah melebihi batas.",
  });

/**
 * The cloud's own sum of received amounts: digits only, no bigint cap. Each
 * event is capped, but the cloud may hold more events than the edge counted,
 * and such a mismatch must still be recorded rather than refused.
 */
export const cloudAmountIdrSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "Jumlah rupiah harus bilangan bulat.");

/** Sum of event identity hashes as a decimal string in 0..2^64-1. */
export const edgeIdHashSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/, "Hash identitas harus bilangan bulat.")
  .refine((value) => /^\d+$/.test(value) && BigInt(value) < ID_HASH_LIMIT, {
    message: "Hash identitas melebihi batas.",
  });

export const edgeTxnTotalSchema = z.strictObject({
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  amountIdr: edgeAmountIdrSchema,
  idHash: edgeIdHashSchema,
});
export type EdgeTxnTotal = z.infer<typeof edgeTxnTotalSchema>;

export const cloudTxnTotalSchema = z.strictObject({
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  amountIdr: cloudAmountIdrSchema,
  idHash: edgeIdHashSchema,
});

/**
 * The only event names the ledger and the reconciliation count (the order
 * money events). Keep in step with AMOUNT_KEY_BY_EVENT in
 * apps/api/src/services/edge-txn-ledger.service.ts. A strict allowlist also
 * keeps keys like "__proto__" or "toString" out of the totals maps.
 */
export const EDGE_RECONCILED_EVENT_NAMES = [
  "order.submitted",
  "order.paid",
  "order.voided",
  "order.refunded",
] as const;
export const edgeReconciledEventNameSchema = z.enum(
  EDGE_RECONCILED_EVENT_NAMES,
);

export const edgeTxnTotalsSchema = z.partialRecord(
  edgeReconciledEventNameSchema,
  edgeTxnTotalSchema,
);
export type EdgeTxnTotals = z.infer<typeof edgeTxnTotalsSchema>;

export const cloudTxnTotalsSchema = z.partialRecord(
  edgeReconciledEventNameSchema,
  cloudTxnTotalSchema,
);

/**
 * What the edge sends: its sent totals for link sequences in
 * (`fromLinkSeq`, `throughLinkSeq`]. `fromLinkSeq` is the ledger baseline: the
 * sequence the node had reached before the ledger existed (0 for a node whose
 * ledger has counted from its first event). `edgeInstanceId` is the edge's
 * instance id (the epoch): the cloud only judges a digest of its active epoch.
 */
export const edgeTxnDigestSchema = z
  .strictObject({
    edgeNodeId: uuidSchema,
    edgeInstanceId: uuidSchema,
    fromLinkSeq: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    throughLinkSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    totals: edgeTxnTotalsSchema,
  })
  .refine((digest) => digest.fromLinkSeq <= digest.throughLinkSeq, {
    message: "fromLinkSeq must not exceed throughLinkSeq.",
    path: ["fromLinkSeq"],
  });
export type EdgeTxnDigest = z.infer<typeof edgeTxnDigestSchema>;

export const edgeReconciliationParamsSchema = z.strictObject({
  edgeNodeId: uuidSchema,
});

export const edgeReconciliationListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type EdgeReconciliationListQuery = z.infer<
  typeof edgeReconciliationListQuerySchema
>;

export const edgeReconciliationDiffSchema = z.strictObject({
  eventName: edgeReconciledEventNameSchema,
  edgeCount: z.number().int().min(0),
  cloudCount: z.number().int().min(0),
  edgeAmountIdr: edgeAmountIdrSchema,
  cloudAmountIdr: cloudAmountIdrSchema,
  edgeIdHash: edgeIdHashSchema,
  cloudIdHash: edgeIdHashSchema,
});
export type EdgeReconciliationDiff = z.infer<
  typeof edgeReconciliationDiffSchema
>;

export const edgeReconciliationRunSchema = z.strictObject({
  id: z.string(),
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  edgeNodeId: uuidSchema,
  fromLinkSeq: z.number().int().min(0),
  throughLinkSeq: z.number().int().min(0),
  edgeInstanceId: uuidSchema.nullable(),
  status: edgeReconciliationStatusSchema,
  edgeTotals: edgeTxnTotalsSchema,
  cloudTotals: cloudTxnTotalsSchema,
  diffs: z.array(edgeReconciliationDiffSchema),
  checkedAt: isoDateTimeSchema,
  checkedBy: z.string().nullable(),
});
export type EdgeReconciliationRun = z.infer<typeof edgeReconciliationRunSchema>;
