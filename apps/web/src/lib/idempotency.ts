// One idempotency key per user attempt (contracts.md "Typed web client &
// idempotency headers"). Keys are minted in the browser, and the edge node may
// serve the app over plain http on a LAN address, where `crypto.randomUUID` is
// undefined because it only exists in secure contexts (bead legend-zrdy).
// `crypto.getRandomValues` has no such restriction, so the key stays a real
// RFC 4122 v4 UUID on any origin instead of throwing on every save.

export type UuidSource = {
  /** Absent in an insecure context, even though `getRandomValues` works. */
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
};

function v4FromRandomValues(source: UuidSource): string {
  const bytes = new Uint8Array(16);
  if (!source.getRandomValues)
    throw new Error("crypto.getRandomValues is unavailable.");
  source.getRandomValues(bytes);
  // Version 4 (random) and the RFC 4122 variant, as randomUUID would set them.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * A fresh idempotency key: `crypto.randomUUID` when the context is secure, an
 * equivalent v4 UUID built from `crypto.getRandomValues` otherwise. The source
 * is injectable so tests can cover both paths.
 */
export function newIdempotencyKey(
  source: UuidSource | undefined = globalThis.crypto,
): string {
  if (typeof source?.randomUUID === "function") {
    try {
      return source.randomUUID();
    } catch {
      // Some profiles expose randomUUID and still refuse it; fall through.
    }
  }
  if (!source) throw new Error("Web Crypto is unavailable.");
  return v4FromRandomValues(source);
}
