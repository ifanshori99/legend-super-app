// EDC transaction events (WS-00 line in events/catalog.ts). Written to the
// outbox in the same database transaction as each ledger status change, so a
// rolled-back ledger write leaves no event (bead legend-apt, EDC-02/03).
//
// - `created`: the write-ahead ledger row was inserted (status `pending`).
// - `approved` / `declined` / `cancelled` / `failed`: the row reached that
//   final status. `settled` stays reserved for bank settlement (EDC-06).
//   Bank settlement of a batch is `edcTransactionSettledEvent`
//   (payment/settlement-events.ts): batch payload, aggregate id =
//   settlementBatchId.
// - `flagged`: the outcome is unknown or a human must reconcile
//   (`needsReconciliation` true, or status `unknown`).
//
// Payloads carry the masked PAN only, never a full PAN or track data. This
// file must not import `./index.ts` (it is re-exported from there), so the
// small enums are repeated and pinned by a test against the index schemas.

import {
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";

/** 13 or more digits, alone or split by dashes: looks like a card number. */
const PAN_LIKE = /\d(?:-*\d){12,}/;
export const edcEventRrnSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,24}$/)
  .refine((value) => !PAN_LIKE.test(value), "RRN looks like a card number");

const payload = z.strictObject({
  transactionId: uuidSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  terminalId: uuidSchema,
  /** Bank / provider key of the terminal (`edcBankSchema`). */
  bank: z.enum(["bca", "mandiri", "bni", "bjb", "bri"]),
  /** The POS reference the sale was made for. */
  reference: z.string().min(1).max(100),
  amountIdr: idrSchema,
  status: z.enum([
    "pending",
    "unknown",
    "approved",
    "declined",
    "cancelled",
    "failed",
  ]),
  trace: z.string().min(1).max(32).nullable(),
  approvalCode: z.string().min(1).max(12).nullable(),
  /** First 6 / last 4 digits at most (`maskedPanSchema`); never a raw PAN. */
  maskedPan: z
    .string()
    .max(23)
    .regex(/^(?:\d{6}|\d{0,4})[*Xx]{2,}\d{4}$/, "masked PAN only")
    .nullable(),
  needsReconciliation: z.boolean(),
  // 1269 E4: what the cloud needs to mirror the edge ledger row. Optional so
  // an event written before E4 still parses; the cloud refuses to mirror one
  // without them (edge/edc-ledger-applier.ts).
  method: z.enum(["card", "qris"]).optional(),
  type: z.enum(["sale", "void", "refund"]).optional(),
  mode: z.enum(["ecr", "standalone"]).optional(),
  /** Bank reference (RRN / slip number); never anything that looks like a
   * card number (13+ digits, also split by dashes). */
  rrn: edcEventRrnSchema.nullable().optional(),
  completedAt: isoDateTimeSchema.nullable().optional(),
});
export type EdcTransactionEventPayload = z.infer<typeof payload>;

function edcEvent<const Name extends string>(name: Name) {
  return defineDomainEvent({ name, payload });
}

export const edcTransactionCreated = edcEvent("edc_transaction.created");
export const edcTransactionApproved = edcEvent("edc_transaction.approved");
export const edcTransactionDeclined = edcEvent("edc_transaction.declined");
export const edcTransactionFailed = edcEvent("edc_transaction.failed");
export const edcTransactionCancelled = edcEvent("edc_transaction.cancelled");
export const edcTransactionFlagged = edcEvent("edc_transaction.flagged");

export const EDC_TRANSACTION_EVENTS = [
  edcTransactionCreated,
  edcTransactionApproved,
  edcTransactionDeclined,
  edcTransactionFailed,
  edcTransactionCancelled,
  edcTransactionFlagged,
] as const;

export type EdcTransactionEventName =
  (typeof EDC_TRANSACTION_EVENTS)[number]["name"];
export const edcTransactionEventPayloadSchema = payload;
