// Idempotency keys for guest mutations (retries of a tap must not double an
// order, a payment or a waiter call). Created per intent, not per render.
export function idempotencyKey(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`.slice(0, 100);
}
