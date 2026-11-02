import { newIdempotencyKey } from "../../../lib/idempotency.ts";

// Idempotency keys for guest mutations (retries of a tap must not double an
// order, a payment or a waiter call). Created per intent, not per render.
export function idempotencyKey(prefix: string): string {
  return `${prefix}-${newIdempotencyKey()}`.slice(0, 100);
}
