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
]);
export type EdgeReconciliationStatus = z.infer<
  typeof edgeReconciliationStatusSchema
>;

/** Non-negative integer rupiah as a decimal string (no sign, no leading zeros). */
export const edgeAmountIdrSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,29})$/, "Jumlah rupiah harus bilangan bulat.");

export const edgeTxnTotalSchema = z.strictObject({
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  amountIdr: edgeAmountIdrSchema,
});
export type EdgeTxnTotal = z.infer<typeof edgeTxnTotalSchema>;

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

/**
 * What the edge sends: its sent totals for link sequences in
 * (`fromLinkSeq`, `throughLinkSeq`]. `fromLinkSeq` is the ledger baseline: the
 * sequence the node had reached before the ledger existed (0 for a node whose
 * ledger has counted from its first event).
 */
export const edgeTxnDigestSchema = z
  .strictObject({
    edgeNodeId: uuidSchema,
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
  cloudAmountIdr: edgeAmountIdrSchema,
});
export type EdgeReconciliationDiff = z.infer<
  typeof edgeReconciliationDiffSchema
>;

export const edgeReconciliationRunSchema = z.strictObject({
  id: z.string(),
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  edgeNodeId: uuidSchema,
  throughLinkSeq: z.number().int().min(0),
  status: edgeReconciliationStatusSchema,
  edgeTotals: edgeTxnTotalsSchema,
  cloudTotals: edgeTxnTotalsSchema,
  diffs: z.array(edgeReconciliationDiffSchema),
  checkedAt: isoDateTimeSchema,
  checkedBy: z.string().nullable(),
});
export type EdgeReconciliationRun = z.infer<typeof edgeReconciliationRunSchema>;
