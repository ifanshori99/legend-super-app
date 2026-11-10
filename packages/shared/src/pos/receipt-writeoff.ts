// Audited write-off of a lost receipt number (legend-0hzqw). The tenant owner
// marks one number (prefix + ordinal) as permanently lost, with a reason; gap
// checks then count it as present and reports show it as written off.

import {
  z,
  clientInputSchema,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
  uuidSchema,
} from "../core/index.ts";
import {
  RECEIPT_MAX_ORDINAL,
  receiptNumberSchema,
  receiptPrefixSchema,
} from "./receipts.ts";

export const receiptNumberWriteoffInputSchema = clientInputSchema({
  prefix: receiptPrefixSchema,
  sequenceNumber: z.number().int().positive().max(RECEIPT_MAX_ORDINAL),
  reason: z.string().trim().min(10).max(500),
});
export type ReceiptNumberWriteoffInput = z.infer<
  typeof receiptNumberWriteoffInputSchema
>;

export const receiptNumberWriteoffSchema = z.strictObject({
  id: uuidSchema,
  outletId: outletIdSchema,
  prefix: receiptPrefixSchema,
  sequenceNumber: z.number().int().positive().max(RECEIPT_MAX_ORDINAL),
  /** The formatted number, e.g. `P1-000002`. */
  number: receiptNumberSchema,
  reason: z.string().min(10).max(500),
  writtenOffBy: userIdSchema,
  createdAt: isoDateTimeSchema,
});
export type ReceiptNumberWriteoff = z.infer<typeof receiptNumberWriteoffSchema>;
