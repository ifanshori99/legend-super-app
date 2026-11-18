// Accounts receivable (PRD v1.7 §3.19 "Utang & Piutang — … serta piutang
// untuk event dan corporate account"; bead legend-hpgo). Contract:
// payables.ts (open items, counterparty types `corporate_account` and
// `event_customer`).
//
// The AR documents (event invoices, corporate-account billing) belong to the
// modules that issue them; these in-transaction ports record their open
// items and settlements. The contract has no posting rule for AR invoices,
// receipts or bad-debt write-offs, so this module never invents one: the
// source posts its journal (sale / manual) and links it here. A receipt or
// write-off must link a journal of the same legal entity, so no AR balance
// moves without a balanced ledger entry (fail closed). Write-offs are audited
// with their reason.

import {
  businessDateSchema,
  idempotencyKeySchema,
  idrSchema,
  outletIdSchema,
  uuidSchema,
  z,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { legalEntityIdSchema, type OpenItem } from "@starter/shared/accounting";
import { HttpError } from "../lib/http-error.ts";
import type { TenantTransaction } from "./accounting-ap-fa-shared.ts";
import {
  recordOpenItemInTransaction,
  settleOpenItemInTransaction,
  type SettlementResult,
} from "./accounting-open-items.service.ts";

const positiveIdr = idrSchema.refine((v) => v > 0, "Amount must be > 0");

export const recordReceivableInputSchema = z.strictObject({
  invoiceId: uuidSchema,
  legalEntityId: legalEntityIdSchema,
  outletId: outletIdSchema.nullable(),
  customerType: z.enum(["corporate_account", "event_customer"]),
  customerId: uuidSchema,
  customerName: z.string().trim().min(1).max(150),
  invoiceNumber: z.string().trim().min(1).max(60),
  invoiceDate: businessDateSchema,
  dueOn: businessDateSchema,
  amountIdr: positiveIdr,
  journalEntryId: uuidSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
});

/** Kartu piutang: one AR invoice = one receivable open item. */
export async function recordReceivableInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: z.input<typeof recordReceivableInputSchema>,
  actorId: UserId | null,
): Promise<OpenItem> {
  const input = recordReceivableInputSchema.parse(rawInput);
  return recordOpenItemInTransaction(
    tx,
    context,
    {
      id: input.invoiceId,
      kind: "receivable",
      legalEntityId: input.legalEntityId,
      outletId: input.outletId,
      counterpartyType: input.customerType,
      counterpartyId: input.customerId,
      counterpartyName: input.customerName,
      documentNumber: input.invoiceNumber,
      documentDate: input.invoiceDate,
      dueOn: input.dueOn,
      originalIdr: input.amountIdr,
      journalEntryId: input.journalEntryId,
      idempotencyKey: input.idempotencyKey,
    },
    actorId,
  );
}

export const settleReceivableInputSchema = z
  .strictObject({
    invoiceId: uuidSchema,
    method: z.enum(["payment", "write_off"]),
    /** Receipt id for a payment; null for a write-off. */
    receiptId: uuidSchema.nullable(),
    settledOn: businessDateSchema,
    amountIdr: positiveIdr,
    /** The balanced journal the caller posted for this receipt / write-off. */
    journalEntryId: uuidSchema,
    reason: z.string().trim().min(1).max(200).nullable(),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((input, ctx) => {
    if (input.method === "write_off" && input.reason === null)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A write-off needs a reason",
      });
  });

/**
 * Receipt or write-off against a receivable, allocated under the open item's
 * row lock (no over-allocation). The linked journal must exist in the same
 * legal entity. An employee receivable (PPh 21 raised by payroll) is never
 * settled here: only the payroll deduction settles it (payroll-pph21-
 * receivable-open-items.service.ts), otherwise the employee is billed twice.
 */
export async function settleReceivableInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: z.input<typeof settleReceivableInputSchema>,
  actorId: UserId | null,
): Promise<SettlementResult> {
  const input = settleReceivableInputSchema.parse(rawInput);
  return settleOpenItemInTransaction(
    tx,
    context,
    {
      kind: "receivable",
      openItemId: input.invoiceId,
      method: input.method,
      sourceId: input.receiptId,
      settledOn: input.settledOn,
      amountIdr: input.amountIdr,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    },
    actorId,
    async (item) => {
      if (item.counterpartyType === "employee")
        throw new HttpError(
          409,
          "PAYROLL_EMPLOYEE_RECEIVABLE_NOT_SETTLEABLE",
          "An employee PPh 21 receivable can only be settled by a payroll deduction.",
        );
      return input.journalEntryId;
    },
  );
}
