// Digest of a facility ticket's door PIN (F6a, legend-iojd1). A PIN has only
// 10^6 values, so a plain hash of it is reversed at once by anyone who reads
// the table. The digest is therefore HMAC-SHA-256 under a key derived from the
// deployment secret (the same material as the table QR keys, qr-token.ts), and
// is bound to the tenant and the ticket.
//
// A digest stored before this (plain SHA-256) is NOT accepted any more: those
// PINs expire with the change. The ticket's QR keeps working (its token is
// random, so its plain digest is safe) and a reprint mints a new PIN.
// Rotating the deployment secret expires the PINs the same way.

import { createHmac, hkdfSync } from "node:crypto";
import { env } from "../config/env.ts";

const KEY_SALT = "legend";
const KEY_CONTEXT = "legend:ticket-door-pin:v1";

let cachedKey: Buffer | undefined;

function digestKey(): Buffer {
  cachedKey ??= Buffer.from(
    hkdfSync(
      "sha256",
      env.DATA_ENCRYPTION_KEY ?? env.BETTER_AUTH_SECRET,
      KEY_SALT,
      KEY_CONTEXT,
      32,
    ),
  );
  return cachedKey;
}

/** HMAC-SHA-256 hex of a door PIN, bound to its tenant and ticket. */
export function ticketPinDigest(
  tenantId: string,
  ticketId: string,
  pin: string,
): string {
  return createHmac("sha256", digestKey())
    .update([tenantId, ticketId, pin].join("\u0000"), "utf8")
    .digest("hex");
}
