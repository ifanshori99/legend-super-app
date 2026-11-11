// Staff MFA recovery codes: generation, normalization and keyed hashing.
// A code is 10 Crockford base32 symbols (50 bits from the CSPRNG), shown as
// XXXXX-XXXXX. Only the keyed digest is stored (lib/blind-index.ts, bound to
// the user), never the code itself. Codes are written under the active blind
// index version and checked under every version (legend-baxdx); a code cannot be
// re-hashed later, so it needs no stored version and ends with its set.

import { randomInt } from "node:crypto";
import {
  BLIND_INDEX_ACTIVE_VERSION,
  blindIndexAt,
  blindIndexCandidates,
  type BlindIndexVersion,
} from "./blind-index";

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

/** Purpose string that binds a digest to the user. */
function recoveryCodePurpose(userId: string): string {
  return `mfa-recovery-code:${userId}`;
}

/** Keyed digest (HMAC-SHA256 hex) of a normalized code; written under the active version. */
export function recoveryCodeHash(
  userId: string,
  normalized: string,
  version: BlindIndexVersion = BLIND_INDEX_ACTIVE_VERSION,
): string {
  return blindIndexAt(version, normalized, recoveryCodePurpose(userId));
}

/** Digest of a normalized code under every version, for verification across a cutover. */
export function recoveryCodeHashCandidates(
  userId: string,
  normalized: string,
): string[] {
  return blindIndexCandidates(normalized, recoveryCodePurpose(userId)).map(
    (candidate) => candidate.digest,
  );
}
