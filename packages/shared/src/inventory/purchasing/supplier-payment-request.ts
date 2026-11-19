// Payment of one supplier invoice through the approval matrix (bead
// legend-xxqz3; brief docs/briefs/991-akuntansi-kas-supplier.md, part A).
//
// `POST /api/inventory/supplier-invoices/:supplierInvoiceId/payments` asks to
// pay part or all of the outstanding payable; `GET` lists the payments of that
// invoice. The amount is the only money the client names; the payable, the
// outstanding balance, the journal and the approval tier are server-derived.
// Over the matrix limit the payment waits (`pending_approval`) until another
// person than the requester approves it in the approvals inbox; below it the
// payment is `paid` at once. The tenant comes from the domain, never the body.

import {
  businessDateSchema,
  clientInputSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  userIdSchema,
  z,
} from "../../core/index.ts";
import {
  supplierInvoiceIdSchema,
  supplierPaymentIdSchema,
  supplierPaymentStatusSchema,
} from "./schemas.ts";

export const requestSupplierInvoicePaymentInputSchema = clientInputSchema({
  amountIdr: z.number().int().positive(),
  paidOn: businessDateSchema,
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Retries the settlement of a payment whose approval chain is approved but
 * whose posting was refused because GL 1102 was short (legend-5qqb9). The
 * payment, its amount and its approver all come from the stored row.
 */
export const retrySupplierPaymentSettlementInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});

/** What the request answers: the payment and where it stands. */
export const supplierInvoicePaymentRequestResultSchema = z.strictObject({
  id: supplierPaymentIdSchema,
  status: supplierPaymentStatusSchema,
});
export type SupplierInvoicePaymentRequestResult = z.infer<
  typeof supplierInvoicePaymentRequestResultSchema
>;

export const supplierInvoicePaymentSchema = z.strictObject({
  id: supplierPaymentIdSchema,
  supplierInvoiceId: supplierInvoiceIdSchema,
  amountIdr: idrSchema,
  paidOn: businessDateSchema,
  status: supplierPaymentStatusSchema,
  requestedBy: userIdSchema,
  approvedBy: userIdSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  decisionNote: z.string().max(500).nullable(),
  /** Why the payment was declined (same text as `decisionNote`), else null. */
  note: z.string().max(500).nullable(),
  journalEntryId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type SupplierInvoicePayment = z.infer<
  typeof supplierInvoicePaymentSchema
>;

export const supplierInvoicePaymentListSchema = z.strictObject({
  data: z.array(supplierInvoicePaymentSchema),
});
