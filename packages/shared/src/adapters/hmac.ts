// Internal Web Crypto helpers (no Node-only API, so they run in the API, the
// web app and the edge). Not exported from the package entry points; audit/ip.ts
// reuses them. Candidate to move into core in a WS-00 follow-up.

type Subtle = {
  importKey(
    format: "raw",
    key: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: false,
    usages: readonly ("sign" | "verify")[],
  ): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: "HMAC",
    key: unknown,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
};
const runtime = globalThis as unknown as {
  crypto: { subtle: Subtle };
  TextEncoder: new () => { encode(text: string): Uint8Array };
};

export function utf8(text: string): Uint8Array {
  return new runtime.TextEncoder().encode(text);
}
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Strict lowercase/uppercase hex of exactly `length` bytes, else null. */
export function fromHex(hex: string, length: number): Uint8Array | null {
  if (hex.length !== length * 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function importKey(secret: string, usage: "sign" | "verify") {
  return runtime.crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}
export async function hmacSha256(
  secret: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const key = await importKey(secret, "sign");
  return new Uint8Array(await runtime.crypto.subtle.sign("HMAC", key, data));
}
/** Constant-time check (Web Crypto verify) of a 32-byte HMAC-SHA256 tag. */
export async function hmacSha256Verify(
  secret: string,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const key = await importKey(secret, "verify");
  return runtime.crypto.subtle.verify("HMAC", key, signature, data);
}
