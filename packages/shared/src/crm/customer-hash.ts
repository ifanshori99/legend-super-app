// Customer WhatsApp hash (legend-o9fc). One keyed digest links a guest across
// modules: a reservation `contactHash` (`hashGuestContact`) equals
// `customer_profiles.whatsapp_hash` for the same number.
//
// The digest is HMAC-SHA-256 (lowercase hex, 64 chars) of the normalized
// number, NOT a bare SHA-256. The server computes it with
// `whatsAppDigest(number)` in `apps/api/src/lib/identity-digest.ts` (secret:
// CONTACT_HASH_SECRET, else BETTER_AUTH_SECRET). Clients never compute or
// receive it. The helper below runs the same shared function, so any caller
// that holds the secret gets the identical value.
import { z } from "../core/index.ts";
import { whatsAppNumberDigest } from "../identity/index.ts";

/** HMAC-SHA-256 hex digest of a normalized WhatsApp number. */
export const customerWhatsappHashSchema = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    "Expected a lowercase HMAC-SHA-256 hex digest of the WhatsApp number",
  );

/**
 * `customer_profiles.whatsapp_hash` for a number: exactly
 * `identity.whatsAppNumberDigest`, the same value as the reservation
 * `hashGuestContact`. Throws RangeError for a value that is not a number and
 * TypeError for a secret shorter than 16 characters.
 */
export async function hashCustomerWhatsapp(
  phone: string,
  secret: string,
): Promise<string> {
  return whatsAppNumberDigest(phone, secret);
}
