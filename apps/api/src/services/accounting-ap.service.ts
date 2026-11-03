// Accounts payable (PRD v1.7 §3.19 "Utang & Piutang — Kartu utang supplier
// dengan umur utang"; §3.18 / §4 Alur I "Supplier Invoice → … → Supplier
// Payment dengan approval"; bead legend-hpgo).
//
// WS-06 purchasing records supplier invoices and approves supplier payments
// (contract payables.ts: "Supplier invoices are recorded by WS-06 purchasing
// (`supplier_invoice.recorded`); this contract owns the open-item view").
// These are the in-transaction ports it (or its WS-07 event consumer) calls:
//
// - recordSupplierInvoicePayableInTransaction: the invoice becomes a payable
//   open item. The invoice journal itself posts through the
//   `supplier_invoice.recorded` rule (one business fact posts once); the
//   caller links that entry.
// - paySupplierInvoiceInTransaction: allocates an approved payment to the
//   invoice under a row lock and posts the `document:supplier_payment` rule
//   (debit accounts_payable / credit bank) in the same transaction.

import {
  businessDateSchema,
  idempotencyKeySchema,
  idrSchema,
  outletIdSchema,
  uuidSchema,
  z,
  type BusinessDate,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { legalEntityIdSchema, type OpenItem } from "@starter/shared/accounting";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import type { TenantTransaction } from "./accounting-ap-fa-shared.ts";
import {
  recordOpenItemInTransaction,
  settleOpenItemInTransaction,
  type SettlementResult,
} from "./accounting-open-items.service.ts";

const positiveIdr = idrSchema.refine((v) => v > 0, "Amount must be > 0");

export const recordSupplierInvoicePayableInputSchema = z.strictObject({
  supplierInvoiceId: uuidSchema,
  legalEntityId: legalEntityIdSchema,
  outletId: outletIdSchema.nullable(),
  supplierId: uuidSchema,
  supplierName: z.string().trim().min(1).max(150),
  invoiceNumber: z.string().trim().min(1).max(60),
  invoiceDate: businessDateSchema,
  /** From the supplier's payment terms (§3.18 Supplier "termin pembayaran"). */
  dueOn: businessDateSchema,
  /** `payableIdr` of supplier_invoice.recorded (total − PPh 23 withheld). */
  payableIdr: positiveIdr,
  journalEntryId: uuidSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
});

/** Kartu utang: one supplier invoice = one payable open item. */
export async function recordSupplierInvoicePayableInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: z.input<typeof recordSupplierInvoicePayableInputSchema>,
  actorId: UserId | null,
): Promise<OpenItem> {
  const input = recordSupplierInvoicePayableInputSchema.parse(rawInput);
  return recordOpenItemInTransaction(
    tx,
    context,
    {
      id: input.supplierInvoiceId,
      kind: "payable",
      legalEntityId: input.legalEntityId,
      outletId: input.outletId,
      counterpartyType: "supplier",
      counterpartyId: input.supplierId,
      counterpartyName: input.supplierName,
      documentNumber: input.invoiceNumber,
      documentDate: input.invoiceDate,
      dueOn: input.dueOn,
      originalIdr: input.payableIdr,
      journalEntryId: input.journalEntryId,
      idempotencyKey: input.idempotencyKey,
    },
    actorId,
  );
}

export const paySupplierInvoiceInputSchema = z.strictObject({
  supplierInvoiceId: uuidSchema,
  supplierPaymentId: uuidSchema,
  amountIdr: positiveIdr,
  paidOn: businessDateSchema,
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Supplier payment approved (§3.18 "pembayaran supplier disetujui dan
 * dijurnal otomatis"): allocation + journal in one transaction. A partial
 * payment leaves the rest outstanding; an over-payment is refused (409).
 * ACC-02: a payment dated in a closed period fails PERIOD_CLOSED and nothing
 * is allocated.
 */
export async function paySupplierInvoiceInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: z.input<typeof paySupplierInvoiceInputSchema>,
  actorId: UserId | null,
  now = new Date(),
): Promise<SettlementResult> {
  const input = paySupplierInvoiceInputSchema.parse(rawInput);
  return settleOpenItemInTransaction(
    tx,
    context,
    {
      kind: "payable",
      openItemId: input.supplierInvoiceId,
      method: "payment",
      sourceId: input.supplierPaymentId,
      settledOn: input.paidOn,
      amountIdr: input.amountIdr,
      reason: null,
      idempotencyKey: input.idempotencyKey,
    },
    actorId,
    async (item, settlementId) => {
      const entry = await postJournalFromRuleInTransaction(
        tx,
        context,
        {
          eventName: "document:supplier_payment",
          amounts: { amountIdr: input.amountIdr },
          legalEntityId: item.legalEntityId,
          outletId: item.outletId,
          entryDate: input.paidOn as BusinessDate,
          sourceId: input.supplierPaymentId,
          postedBy: actorId,
          // Server-derived: the command key above already dedupes the request.
          idempotencyKey: `ap-pay:${settlementId}`,
        },
        now,
      );
      return entry.id;
    },
  );
}
