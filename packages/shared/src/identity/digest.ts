// Keyed digests of identity values (AUTH-01, AUTH-07; contracts.md "Only keyed
// digests are stored"). One function per value type so every module that
// stores a WhatsApp number — identities, reservations, the waitlist, CRM —
// produces the same digest for the same number and can link rows.
import { hmacSha256, toHex, utf8 } from "../adapters/hmac.ts";
import { normalizeWhatsAppNumber } from "./login-code.ts";

const MIN_SECRET_LENGTH = 16;

/**
 * HMAC-SHA-256 (lowercase hex) of a WhatsApp number after
 * `normalizeWhatsAppNumber` ("0812…", "+62 812-…" and "62812…" give the same
 * digest). A bare SHA-256 is never used: ~10^10 Indonesian mobile numbers are
 * enumerable. Throws RangeError for a value that is not a number and
 * TypeError for a secret shorter than 16 characters.
 */
export async function whatsAppNumberDigest(
  input: string,
  secret: string,
): Promise<string> {
  if (secret.length < MIN_SECRET_LENGTH)
    throw new TypeError(
      `Digest secret must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  const digits = normalizeWhatsAppNumber(input);
  if (digits === null) throw new RangeError("Not a WhatsApp number");
  return toHex(await hmacSha256(secret, utf8(digits)));
}
