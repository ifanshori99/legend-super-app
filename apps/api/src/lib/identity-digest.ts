// Keyed digests for identity material (PRD v1.7 §3 F6, AUTH-01/04;
// docs/plan/contracts.md "Only keyed digests are stored").
//
// Two key families, kept apart on purpose:
//
// - Login material (the 8-symbol code, the browser-binding nonce, the client
//   IP) is HMAC-SHA-256 under a key derived from BETTER_AUTH_SECRET. It never
//   leaves this process, so a stolen database cannot be brute-forced into a
//   live code or binding, and rotating the auth secret invalidates the
//   five-minute leftovers — the outcome we want.
// - Contact values (WhatsApp numbers, emails) use `whatsAppNumberDigest` from
//   the shared identity contract with CONTACT_HASH_SECRET, because other
//   modules (reservations, CRM, waitlist) must produce the same digest for the
//   same number and link rows. That secret falls back to BETTER_AUTH_SECRET
//   until a deployment sets one.
//
// Every digest is 64 lowercase hex characters (`identityDigestSchema`).

import { createHmac, hkdfSync } from "node:crypto";
import { normalizeEmail, whatsAppNumberDigest } from "@starter/shared/identity";
import { env } from "../config/env";
import { clientIpKey } from "./client-ip-key";

/** Domain-separates the login-digest key from Better Auth's own use of the secret. */
const KEY_CONTEXT = "legend:identity-login-digest:v1";
const KEY_SALT = "legend";

let cachedKey: Buffer | undefined;

function digestKey(): Buffer {
  cachedKey ??= Buffer.from(
    hkdfSync("sha256", env.BETTER_AUTH_SECRET, KEY_SALT, KEY_CONTEXT, 32),
  );
  return cachedKey;
}

/**
 * Purposes are constants, never tenant or user data: one HMAC key, one label
 * per use, so a digest can never be replayed against a different purpose.
 */
export type IdentityDigestPurpose =
  | "login-code"
  | "browser-binding"
  // legend-lgfru: the payslip PIN reset browser binding (its own label).
  | "pin-reset-binding"
  | "client-ip"
  | "inbound-request"
  // legend-k2l: the 256-bit email magic-link token (only this digest is stored).
  | "magic-link"
  // legend-wasr7.24: the 8-character EDC bridge pairing code.
  | "edc-pair-code";

/** HMAC-SHA-256 hex of `<purpose>\0<value>`. */
export function identityDigest(
  purpose: IdentityDigestPurpose,
  value: string,
): string {
  return createHmac("sha256", digestKey())
    .update(`${purpose}\u0000${value}`, "utf8")
    .digest("hex");
}

/** The digest of a login code, already normalized by the shared contract. */
export function loginCodeDigest(code: string): string {
  return identityDigest("login-code", code);
}

/**
 * legend-k2l: the digest of an email magic-link token, as stored in
 * `login_challenges.code_hash`. The `magic-link` purpose keeps it apart from a
 * login-code digest even though both sit in the same column.
 */
export function magicLinkTokenDigest(token: string): string {
  return identityDigest("magic-link", token);
}

/** The digest of a browser-binding nonce. */
export function browserBindingDigest(nonce: string): string {
  return identityDigest("browser-binding", nonce);
}

/** The digest of a client IP; an empty IP is never hashed (see callers). */
export function clientIpDigest(ip: string): string {
  // Keyed on the /64 for IPv6 and on the plain address for IPv4 (legend-6jgd2),
  // so AUTH-04's per-IP count cannot be dodged by rotating inside a /64. IPv4
  // digests are unchanged.
  return identityDigest("client-ip", clientIpKey(ip));
}

/** Secret used for contact digests; CONTACT_HASH_SECRET when configured. */
export function contactDigestSecret(): string {
  return env.CONTACT_HASH_SECRET ?? env.BETTER_AUTH_SECRET;
}

/**
 * The canonical digest of a WhatsApp number (the same value reservation and CRM
 * rows store, so a guest's rows link across modules). Throws for a value that
 * is not a number; callers validate first.
 */
export function whatsAppDigest(number: string): Promise<string> {
  return whatsAppNumberDigest(number, contactDigestSecret());
}

/**
 * legend-k2l: the canonical digest of an email address, the value of a
 * `user_identities` row of type `email`. Same key family as `whatsAppDigest`
 * (CONTACT_HASH_SECRET), with an `email` label ahead of the lowercased,
 * trimmed address so it never collides with another contact type. Throws for a
 * value that is not an email; callers validate first.
 */
export async function emailDigest(email: string): Promise<string> {
  const normalized = normalizeEmail(email);
  if (normalized === null) throw new RangeError("Not an email address");
  return createHmac("sha256", contactDigestSecret())
    .update(`email\u0000${normalized}`, "utf8")
    .digest("hex");
}
