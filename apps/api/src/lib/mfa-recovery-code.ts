// Staff MFA recovery codes: generation, normalization and keyed hashing.
// A code is 10 Crockford base32 symbols (50 bits from the CSPRNG), shown as
// XXXXX-XXXXX. Only the keyed digest is stored (lib/secrets.ts blindIndex bound
// to the user), never the code itself.

import { randomInt } from "node:crypto";
import { blindIndex } from "./secrets";

/** Crockford base32: no I, L, O, U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

/** A fresh code in display form, `XXXXX-XXXXX`. */
export function generateRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1)
    code += ALPHABET[randomInt(ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Strips whitespace and dashes and uppercases, before hashing. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

/** Keyed digest stored for a normalized code (HMAC-SHA256 hex). */
export function recoveryCodeHash(userId: string, normalized: string): string {
  return blindIndex(normalized, `mfa-recovery-code:${userId}`);
}
