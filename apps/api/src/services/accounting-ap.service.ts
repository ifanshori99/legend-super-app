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
import { and, eq } from "drizzle-orm";
import { journalEntries } from "../db/schema/accounting.ts";
import { suppliers, supplierInvoices } from "../db/schema/purchasing.ts";
import { HttpError } from "../lib/http-error.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import type { TenantTransaction } from "./accounting-ap-fa-shared.ts";
import {
  recordOpenItemInTransaction,
  settleOpenItemInTransaction,
  type SettlementResult,
} from "./accounting-open-items.service.ts";

const positiveIdr = idrSchema.refine((v) => v > 0, "Amount must be > 0");
const nonnegativeIdr = idrSchema.refine((v) => v >= 0, "Amount must be >= 0");

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
  /**
   * Tax parts of the invoice (legend-v4v7c): DPP = goods + price variance +
   * services, PPN input and PPh 23 withheld, as the journal booked them. Give
   * all three or none; with them the structured `supplier_invoices` row is
   * written and `payableIdr` must equal DPP + PPN - PPh 23.
   */
  dppIdr: nonnegativeIdr.optional(),
  ppnIdr: nonnegativeIdr.optional(),
  pph23Idr: nonnegativeIdr.optional(),
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
  const { dppIdr, ppnIdr, pph23Idr } = input;
  const taxParts = [dppIdr, ppnIdr, pph23Idr];
  if (taxParts.some((part) => part !== undefined)) {
    if (dppIdr === undefined || ppnIdr === undefined || pph23Idr === undefined)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "DPP, PPN and PPh 23 must be given together.",
      );
    if (dppIdr + ppnIdr - pph23Idr !== input.payableIdr)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "The payable must equal DPP plus PPN minus PPh 23.",
      );
  }
  if (dppIdr !== undefined) {
    // The tax record points at the invoice journal the tax reports reconcile
    // against: it must exist for this tenant and legal entity and be a
    // supplier invoice journal.
    if (input.journalEntryId === null)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "A supplier invoice with tax parts needs its journal entry.",
      );
    const [journal] = await tx
      .select({ sourceType: journalEntries.sourceType })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, context.tenant.tenantId),
          eq(journalEntries.legalEntityId, input.legalEntityId),
          eq(journalEntries.id, input.journalEntryId),
        ),
      )
      .limit(1);
    if (journal?.sourceType !== "supplier_invoice")
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "The journal entry must be a supplier invoice journal of this legal entity.",
      );
  }
  const item = await recordOpenItemInTransaction(
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
  if (dppIdr !== undefined && ppnIdr !== undefined && pph23Idr !== undefined) {
    const [supplier] = await tx
      .select({ npwp: suppliers.npwp })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.tenantId, context.tenant.tenantId),
          eq(suppliers.id, input.supplierId),
        ),
      );
    if (!supplier)
      throw new HttpError(422, "VALIDATION_ERROR", "Supplier not found.");
    // A replay of the same command finds its row by id and keeps it, but only
    // when every amount is the same; a second invoice with the same supplier
    // and number hits the unique key and fails.
    const values = {
      id: input.supplierInvoiceId,
      tenantId: context.tenant.tenantId,
      legalEntityId: input.legalEntityId,
      supplierId: input.supplierId,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      dppIdr,
      ppnIdr,
      pph23Idr,
      payableIdr: input.payableIdr,
      journalEntryId: input.journalEntryId,
      npwpSnapshot: supplier.npwp,
    };
    const [written] = await tx
      .insert(supplierInvoices)
      .values(values)
      .onConflictDoNothing({ target: supplierInvoices.id })
      .returning({ id: supplierInvoices.id });
    if (!written) {
      const [stored] = await tx
        .select()
        .from(supplierInvoices)
        .where(
          and(
            eq(supplierInvoices.tenantId, context.tenant.tenantId),
            eq(supplierInvoices.id, input.supplierInvoiceId),
          ),
        );
      if (
        !stored ||
        stored.legalEntityId !== values.legalEntityId ||
        stored.supplierId !== values.supplierId ||
        stored.invoiceNumber !== values.invoiceNumber ||
        stored.invoiceDate !== values.invoiceDate ||
        stored.dppIdr !== dppIdr ||
        stored.ppnIdr !== ppnIdr ||
        stored.pph23Idr !== pph23Idr ||
        stored.payableIdr !== values.payableIdr ||
        stored.journalEntryId !== values.journalEntryId
      )
        throw new HttpError(
          409,
          "CONFLICT",
          "This supplier invoice was already recorded with other amounts or journal entry.",
        );
    }
  }
  return item;
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
