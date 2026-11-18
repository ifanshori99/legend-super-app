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
// - applySupplierDebitNoteInTransaction: an invoiced purchase return (debit
//   note) lowers the supplier's open items, in the transaction that posts the
//   return journal.
// - paySupplierInvoiceInTransaction: allocates an approved payment to the
//   invoice under a row lock and posts the `document:supplier_payment` rule
//   (debit accounts_payable / credit bank) in the same transaction.

import {
  assertTrustedScopedContext,
  businessDateSchema,
  idempotencyKeySchema,
  idrSchema,
  outletIdSchema,
  uuidSchema,
  userIdSchema,
  z,
  type BusinessDate,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { legalEntityIdSchema, type OpenItem } from "@starter/shared/accounting";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { accountMappings, journalEntries } from "../db/schema/accounting.ts";
import {
  accountingOpenItems,
  accountingOpenItemSettlements,
} from "../db/schema/accounting-ap-fa.ts";
import { user } from "../db/schema/user.ts";
import {
  purchaseInvoices,
  suppliers,
  supplierInvoices,
} from "../db/schema/purchasing.ts";
import { HttpError } from "../lib/http-error.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import { assertBankCreditCoveredBy1102 } from "./accounting-petty-cash.service.ts";
import {
  auditApFa,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
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
  let npwpSnapshot: string | null = null;
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
    npwpSnapshot = supplier.npwp;
    if (pph23Idr !== undefined && pph23Idr > 0) {
      // A replay keeps the original identity even if the supplier master was
      // subsequently cleared. Legacy missing snapshots require the audited repair.
      const [stored] = await tx
        .select({ npwpSnapshot: supplierInvoices.npwpSnapshot })
        .from(supplierInvoices)
        .where(
          and(
            eq(supplierInvoices.tenantId, context.tenant.tenantId),
            eq(supplierInvoices.id, input.supplierInvoiceId),
          ),
        );
      npwpSnapshot = stored ? stored.npwpSnapshot : supplier.npwp;
      if ((npwpSnapshot ?? "").replace(/\D/g, "").length < 4)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "NPWP supplier wajib diisi sebelum faktur dengan PPh 23 diposting.",
        );
    }
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
      npwpSnapshot,
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
 * Takes the legal entity lock of a payable open item before its row lock (lock
 * order of legend-swn0m: entity, then row). The entity is read unlocked: it
 * never changes after the item is recorded. Reentrant within a transaction.
 * Returns null when the item is not found (the caller reports it under lock).
 */
export async function lockEntityOfPayable(
  tx: TenantTransaction,
  tenantId: string,
  openItemId: string,
): Promise<string | null> {
  const [item] = await tx
    .select({ legalEntityId: accountingOpenItems.legalEntityId })
    .from(accountingOpenItems)
    .where(
      and(
        eq(accountingOpenItems.tenantId, tenantId),
        eq(accountingOpenItems.kind, "payable"),
        eq(accountingOpenItems.id, openItemId),
      ),
    )
    .limit(1);
  if (!item) return null;
  await entityLock(tx, tenantId, item.legalEntityId);
  return item.legalEntityId;
}

/**
 * Supplier payment approved (§3.18 "pembayaran supplier disetujui dan
 * dijurnal otomatis"): allocation + journal in one transaction. A partial
 * payment leaves the rest outstanding; an over-payment is refused (409).
 * ACC-02: a payment dated in a closed period fails PERIOD_CLOSED and nothing
 * is allocated.
 * When the entity's `bank` account is its petty cash account (1102), the
 * credit must be covered by the cash left in 1102, else it is refused with
 * PETTY_CASH_GL_INSUFFICIENT and nothing is allocated (legend-swn0m).
 */
export async function paySupplierInvoiceInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: z.input<typeof paySupplierInvoiceInputSchema>,
  actorId: UserId | null,
  now = new Date(),
): Promise<SettlementResult> {
  const input = paySupplierInvoiceInputSchema.parse(rawInput);
  // Entity lock before the open item row lock taken by the settlement.
  await lockEntityOfPayable(
    tx,
    context.tenant.tenantId,
    input.supplierInvoiceId,
  );
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
      // The rule credits the `bank` role: a mapping to 1102 pays out of
      // petty cash. Under the entity lock taken above.
      const [bank] = await tx
        .select({ accountId: accountMappings.accountId })
        .from(accountMappings)
        .where(
          and(
            eq(accountMappings.tenantId, context.tenant.tenantId),
            eq(accountMappings.legalEntityId, item.legalEntityId),
            eq(accountMappings.role, "bank"),
          ),
        )
        .limit(1);
      if (bank)
        await assertBankCreditCoveredBy1102(
          tx,
          context.tenant.tenantId,
          item.legalEntityId,
          bank.accountId,
          input.amountIdr,
        );
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

export const applySupplierDebitNoteInputSchema = z.strictObject({
  purchaseReturnId: uuidSchema,
  supplierId: uuidSchema,
  legalEntityId: legalEntityIdSchema,
  /** PO of the return: its invoices absorb the debit note first. */
  purchaseOrderId: uuidSchema.nullable(),
  /** Invoiced value + PPN of the return (Dr accounts_payable of its journal). */
  amountIdr: positiveIdr,
  settledOn: businessDateSchema,
  journalEntryId: uuidSchema,
});

/**
 * Supplier debit note (kartu D): the invoiced part of a purchase return, plus
 * its PPN, reduces the supplier's payable open items by exactly `amountIdr`,
 * once. Open items of the supplier in the legal entity are locked, then used
 * in this order: invoices of the return's PO, due date, document date, id.
 * One `debit_note` settlement per item (source = the return, journal = the
 * return journal); idempotent on a per-item key and on the unique index
 * (tenant, kind, item, source). A shortfall (the supplier was already paid,
 * or a payment raced the return) throws 409 `PURCHASE_RETURN_EXCEEDS_PAYABLE`
 * and records nothing: the caller's transaction or savepoint rolls back.
 */
export async function applySupplierDebitNoteInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: z.input<typeof applySupplierDebitNoteInputSchema>,
  actorId: UserId | null,
): Promise<{ settlements: SettlementResult[] }> {
  const input = applySupplierDebitNoteInputSchema.parse(rawInput);
  const tenantId = context.tenant.tenantId;
  // A replay (an item already took this return's debit note) never takes it
  // again: the whole note is recorded together or not at all.
  const [already] = await tx
    .select({ id: accountingOpenItemSettlements.id })
    .from(accountingOpenItemSettlements)
    .where(
      and(
        eq(accountingOpenItemSettlements.tenantId, tenantId),
        eq(accountingOpenItemSettlements.kind, "payable"),
        eq(accountingOpenItemSettlements.method, "debit_note"),
        eq(accountingOpenItemSettlements.sourceId, input.purchaseReturnId),
      ),
    )
    .limit(1);
  if (already) return { settlements: [] };
  const items = await tx
    .select()
    .from(accountingOpenItems)
    .where(
      and(
        eq(accountingOpenItems.tenantId, tenantId),
        eq(accountingOpenItems.kind, "payable"),
        eq(accountingOpenItems.legalEntityId, input.legalEntityId),
        eq(accountingOpenItems.counterpartyType, "supplier"),
        eq(accountingOpenItems.counterpartyId, input.supplierId),
        gt(accountingOpenItems.originalIdr, accountingOpenItems.settledIdr),
      ),
    )
    .orderBy(
      asc(accountingOpenItems.dueOn),
      asc(accountingOpenItems.documentDate),
      asc(accountingOpenItems.id),
    )
    .for("update");
  const ofReturnPo = new Set<string>();
  if (input.purchaseOrderId !== null && items.length > 0) {
    const invoices = await tx
      .select({ id: purchaseInvoices.id })
      .from(purchaseInvoices)
      .where(
        and(
          eq(purchaseInvoices.tenantId, tenantId),
          eq(purchaseInvoices.purchaseOrderId, input.purchaseOrderId),
          inArray(
            purchaseInvoices.id,
            items.map((item) => item.id),
          ),
        ),
      );
    for (const invoice of invoices) ofReturnPo.add(invoice.id);
  }
  // Array sort is stable: ties keep the SQL order above.
  const ordered = [...items].sort(
    (a, b) => Number(ofReturnPo.has(b.id)) - Number(ofReturnPo.has(a.id)),
  );
  const outstanding = ordered.reduce(
    (sum, item) => sum + (item.originalIdr - item.settledIdr),
    0,
  );
  if (outstanding < input.amountIdr)
    throw new HttpError(
      409,
      "PURCHASE_RETURN_EXCEEDS_PAYABLE",
      "The invoiced value of this return exceeds the supplier's outstanding payable.",
    );
  const settlements: SettlementResult[] = [];
  let remaining: number = input.amountIdr;
  for (const item of ordered) {
    if (remaining === 0) break;
    const amountIdr = Math.min(remaining, item.originalIdr - item.settledIdr);
    settlements.push(
      await settleOpenItemInTransaction(
        tx,
        context,
        {
          kind: "payable",
          openItemId: item.id,
          method: "debit_note",
          sourceId: input.purchaseReturnId,
          // Never before the invoice: a settlement cannot predate its document.
          settledOn:
            input.settledOn > item.documentDate
              ? input.settledOn
              : item.documentDate,
          amountIdr,
          reason: null,
          idempotencyKey: `ap-dn:${input.purchaseReturnId}:${item.id}`,
        },
        actorId,
        async () => input.journalEntryId,
      ),
    );
    remaining -= amountIdr;
  }
  return { settlements };
}

const repairSupplierInvoiceNpwpInputSchema = z.strictObject({
  supplierInvoiceId: uuidSchema,
  legalEntityId: legalEntityIdSchema,
  reason: z.string().trim().min(10).max(1000),
});

/**
 * Owner-only legacy repair, called by db/repair-supplier-invoice-npwp.ts.
 * It fills an unreadable/missing tax identity only, never an amount or journal.
 * The app role keeps its UPDATE revocation; no route exposes this port.
 * Caller commits the repair and audit together in one owner transaction.
 */
export async function repairSupplierInvoiceNpwpInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: z.input<typeof repairSupplierInvoiceNpwpInputSchema>,
  actorId: UserId,
): Promise<"corrected" | "unchanged"> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Legacy invoice repair requires tenant scope.",
    );
  const input = repairSupplierInvoiceNpwpInputSchema.parse(rawInput);
  const actor = userIdSchema.parse(actorId);
  const privilege = await tx.execute(sql`
    SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS allowed
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'supplier_invoices'
  `);
  if (privilege.rows[0]?.allowed !== true)
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Legacy invoice repair requires the migration owner.",
    );
  const [operator] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, actor));
  if (!operator)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "The correction actor must be an existing user.",
    );
  await tx.execute(
    sql`SELECT set_config('app.tenant_id', ${context.tenant.tenantId}, true), set_config('app.outlet_ids', '*', true)`,
  );
  const [invoice] = await tx
    .select()
    .from(supplierInvoices)
    .where(
      and(
        eq(supplierInvoices.tenantId, context.tenant.tenantId),
        eq(supplierInvoices.legalEntityId, input.legalEntityId),
        eq(supplierInvoices.id, input.supplierInvoiceId),
      ),
    )
    .for("update");
  if (!invoice)
    throw new HttpError(404, "NOT_FOUND", "Supplier invoice not found.");
  if ((invoice.npwpSnapshot ?? "").replace(/\D/g, "").length >= 4)
    return "unchanged";
  if (invoice.pph23Idr <= 0)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Only an invoice withholding PPh 23 needs a legacy NPWP correction.",
    );
  const [supplier] = await tx
    .select({ npwp: suppliers.npwp })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.tenantId, context.tenant.tenantId),
        eq(suppliers.id, invoice.supplierId),
      ),
    )
    .for("share");
  if ((supplier?.npwp ?? "").replace(/\D/g, "").length < 4)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Lengkapi NPWP supplier sebelum memperbaiki snapshot faktur lama.",
    );
  await tx
    .update(supplierInvoices)
    .set({ npwpSnapshot: supplier!.npwp })
    .where(
      and(
        eq(supplierInvoices.tenantId, context.tenant.tenantId),
        eq(supplierInvoices.id, invoice.id),
      ),
    );
  await auditApFa(tx, context, {
    actorId: actor,
    action: "accounting.supplier_invoice.npwp_corrected",
    objectType: "supplier_invoice",
    objectId: invoice.id,
    reason: input.reason,
    before: { status: "missing" },
    after: { status: "corrected" },
  });
  return "corrected";
}
