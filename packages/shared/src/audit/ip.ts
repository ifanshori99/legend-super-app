import { hmacSha256, toHex, utf8 } from "../adapters/hmac.ts";

/**
 * `ip_hash` for an audit row: HMAC-SHA256 (hex) of the normalized client IP,
 * keyed with a server secret. A plain SHA-256 of an IP is reversible by
 * enumerating the IPv4 space, so the key is mandatory (at least 16 characters).
 * Rotating the secret breaks correlation with older rows by design.
 */
export async function hashIpForAudit(
  ip: string,
  secret: string,
): Promise<string> {
  if (secret.length < 16)
    throw new TypeError("IP hash secret must be at least 16 characters");
  const normalized = ip.trim().toLowerCase();
  if (!/^[0-9a-f:.]{2,45}$/.test(normalized) || !/[.:]/.test(normalized))
    throw new TypeError("Expected an IPv4 or IPv6 address");
  return toHex(await hmacSha256(secret, utf8(normalized)));
}
