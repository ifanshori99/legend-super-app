// RFC 6238 TOTP (SHA-1, 30-second step, 6 digits) for staff second factors
// (PRD v1.7 §3 F6 "Staf — Login Web": TOTP or passkey; §6 B mfa_factors).
//
// Pure functions over `node:crypto`; the service owns storage, sealing and
// attempt limits. Secrets are 160 random bits encoded as unpadded RFC 4648
// base32, which is what authenticator apps expect in the otpauth URI.
//
// A code is accepted inside a ±1 step window (clock skew between the phone and
// the server) but only once: the caller passes the last accepted step and gets
// null for any code whose step it already consumed.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;
/** ±1 step: 30 s of skew in each direction. */
export const TOTP_WINDOW_STEPS = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new RangeError("Not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, base32 (32 characters, matches TOTP_SECRET_PATTERN). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** The RFC 6238 time step (counter) for an instant. */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP value for one counter (RFC 4226), zero-padded to six digits. */
export function totpCode(secretBase32: string, step: number): string {
  if (!Number.isSafeInteger(step) || step < 0)
    throw new RangeError("A TOTP step is a non-negative integer");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secretBase32))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * The step a six-digit code belongs to, or null. `lastUsedStep` makes each code
 * single-use: a step at or below it no longer verifies. Constant-time compare
 * so a wrong code leaks no timing information.
 */
export function verifyTotpCode(input: {
  readonly secretBase32: string;
  readonly code: string;
  readonly now: Date;
  readonly lastUsedStep?: number | null;
  readonly windowSteps?: number;
}): number | null {
  if (!/^\d{6}$/.test(input.code)) return null;
  const window = input.windowSteps ?? TOTP_WINDOW_STEPS;
  const current = totpStep(input.now);
  const given = Buffer.from(input.code, "utf8");
  for (let step = current + window; step >= current - window; step--) {
    if (step < 0) continue;
    if (input.lastUsedStep != null && step <= input.lastUsedStep) continue;
    const expected = Buffer.from(totpCode(input.secretBase32, step), "utf8");
    if (expected.length === given.length && timingSafeEqual(expected, given))
      return step;
  }
  return null;
}

/** What an authenticator app scans at enrollment. Shown once, never stored. */
export function totpOtpauthUri(input: {
  readonly secretBase32: string;
  readonly accountName: string;
  readonly issuer: string;
}): string {
  const label = `${input.issuer}:${input.accountName}`;
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
