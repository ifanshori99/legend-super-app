// One idempotency key per user attempt (contracts.md "Typed web client &
// idempotency headers"). The API replays a repeated key, so a retry after a
// timeout must reuse its key; a changed payload is a different request and a
// successful save ends the attempt. Pure so Node tests can cover it.

export type AttemptKeyTracker = {
  keyFor(payload: unknown): string;
  settle(): void;
};

export function createAttemptKeyTracker(
  createKey: () => string = () => crypto.randomUUID(),
): AttemptKeyTracker {
  let attempt: { signature: string; key: string } | null = null;
  return {
    keyFor(payload) {
      const signature = JSON.stringify(payload);
      if (attempt?.signature !== signature)
        attempt = { signature, key: createKey() };
      return attempt.key;
    },
    settle() {
      attempt = null;
    },
  };
}
