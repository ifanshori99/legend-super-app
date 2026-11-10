// Per-address throttle for the email magic link (legend-k2l follow-up; AUTH-01).
//
// The HTTP limiter (middleware/login-challenge-rate-limit.ts) bounds an IP and a
// browser binding, but not how many mails one mailbox receives: a script
// rotating IPs and cookies could still flood a victim. This limits requests per
// tenant and normalised address.
//
// In memory like the HTTP limiter's store: fixed windows, a capacity cap, a few
// expired keys swept per call. Each API instance holds its own window, so with N
// instances an address may get up to N times the limit. The key is the keyed
// digest of the address (`emailDigest`), never the address.

export const EMAIL_LINK_THROTTLE_LIMIT = 3;
export const EMAIL_LINK_THROTTLE_WINDOW_MS = 15 * 60_000;
const EMAIL_LINK_THROTTLE_CAPACITY = 10_000;

export type EmailLinkSlot = {
  /** False once the address used up its requests in the window. */
  allowed: boolean;
  /** True only for the first refused request of a window (audit it once). */
  firstRefusal: boolean;
};

type Window = { start: number; count: number };
const windows = new Map<string, Window>();

/**
 * Counts one request for `key` (the address digest, per tenant) at `nowMs`.
 * Refused requests count too, but only the first one in a window reports
 * `firstRefusal`, so an anonymous flood writes one audit row per window.
 */
export function takeEmailLinkSlot(key: string, nowMs: number): EmailLinkSlot {
  // Sweep a few expired keys per call so cleanup cost stays bounded.
  let checked = 0;
  for (const [entryKey, entry] of windows) {
    if (nowMs - entry.start >= EMAIL_LINK_THROTTLE_WINDOW_MS)
      windows.delete(entryKey);
    if (++checked === 4) break;
  }
  let entry = windows.get(key);
  if (!entry || nowMs - entry.start >= EMAIL_LINK_THROTTLE_WINDOW_MS) {
    if (!entry && windows.size >= EMAIL_LINK_THROTTLE_CAPACITY) {
      const oldest = windows.keys().next().value;
      if (oldest !== undefined) windows.delete(oldest);
    }
    entry = { start: nowMs, count: 0 };
  }
  entry.count += 1;
  // Move the active key to the end so churn evicts the least recent one.
  windows.delete(key);
  windows.set(key, entry);
  return {
    allowed: entry.count <= EMAIL_LINK_THROTTLE_LIMIT,
    firstRefusal: entry.count === EMAIL_LINK_THROTTLE_LIMIT + 1,
  };
}
