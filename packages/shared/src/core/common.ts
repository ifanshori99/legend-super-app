// Small envelopes and fields that many contracts share.

import { z } from "zod";

/** Single-resource response: { data: T }. */
export function dataResponseSchema<Item extends z.ZodType>(item: Item) {
  return z.object({ data: item });
}

/**
 * Idempotency key for retried writes (payment intents, edge sync, webhooks):
 * unique per tenant, VARCHAR(100) (PRD §6 payment_intents.idempotency_key).
 * Sent in the `Idempotency-Key` header or the body field `idempotencyKey`.
 */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(100)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "Idempotency keys use letters, digits and . _ : -",
  );
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;
