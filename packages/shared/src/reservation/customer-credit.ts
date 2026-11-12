import { z } from "zod";
import {
  idempotencyKeySchema,
  outletIdSchema,
  uuidSchema,
} from "../core/index.ts";

export const reservationCreditParamsSchema = z
  .object({ outletId: outletIdSchema })
  .strict();
export const applyReservationCustomerCreditInputSchema = z
  .object({
    customerProfileId: uuidSchema,
    tableSessionId: uuidSchema,
    amountIdr: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const reservationCustomerCreditKeySchema = idempotencyKeySchema;

export const reservationDepositRemainderSchema = z.strictObject({
  paymentIntentId: uuidSchema,
  method: z.string().min(1),
  amountIdr: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  customerCreditIdr: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  refundableIdr: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(["customer_credit", "manual_refund"]),
});
