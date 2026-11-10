// The payer's own proof for one split part (legend-r77pq). The paying client
// makes it, keeps it in sessionStorage per session + part, and sends it on
// `createGuestPayment` and `getSplitClaim`; the server stores only its SHA-256.
// Pure over an injected Storage and random source so Node tests can run it.

const PREFIX = "legend-qr-payer-secret:";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type RandomFill = (bytes: Uint8Array) => Uint8Array;

const SECRET_PATTERN = /^ps_[A-Za-z0-9_-]{43}$/;

/** `ps_` + 32 random bytes as base64url (43 characters, no padding). */
export function newPayerSecret(fill: RandomFill): string {
  const bytes = fill(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `ps_${body}`;
}

const keyOf = (sessionId: string, splitId: string) =>
  `${PREFIX}${sessionId}:${splitId}`;

export function readPayerSecret(
  storage: StorageLike,
  sessionId: string,
  splitId: string,
): string | null {
  const raw = storage.getItem(keyOf(sessionId, splitId));
  return raw !== null && SECRET_PATTERN.test(raw) ? raw : null;
}

/** The stored secret, or a new one saved for next time (retry, claim). */
export function payerSecretFor(
  storage: StorageLike,
  sessionId: string,
  splitId: string,
  fill: RandomFill,
): string {
  const existing = readPayerSecret(storage, sessionId, splitId);
  if (existing !== null) return existing;
  const secret = newPayerSecret(fill);
  storage.setItem(keyOf(sessionId, splitId), secret);
  return secret;
}
