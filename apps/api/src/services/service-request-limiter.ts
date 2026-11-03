// Per-session rate limit for guest service requests (PRD §3 F10 "Panggil
// Waiter"; ORD-07). Same shape as session-extend-limiter.ts: a bounded,
// process-local fixed window; the oldest key is evicted first.

import { MINUTE_MS } from "@starter/shared/identity";
import { HttpError } from "../lib/http-error";

/** Guest attempts (create or dedupe-hit) per table session per minute. */
export const SERVICE_REQUEST_RATE_LIMIT = 10;

export function createServiceRequestLimiter(
  limit = SERVICE_REQUEST_RATE_LIMIT,
  capacity = 10_000,
) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return {
    size: () => hits.size,
    check(sessionId: string, now: number): void {
      let checked = 0;
      for (const [key, hit] of hits) {
        if (now - hit.windowStart >= MINUTE_MS) hits.delete(key);
        if (++checked === 4) break;
      }
      let hit = hits.get(sessionId);
      if (!hit || now - hit.windowStart >= MINUTE_MS) {
        if (!hit && hits.size >= capacity) {
          const oldest = hits.keys().next().value;
          if (oldest !== undefined) hits.delete(oldest);
        }
        hit = { windowStart: now, count: 0 };
      }
      hit.count += 1;
      hits.delete(sessionId);
      hits.set(sessionId, hit);
      if (hit.count > limit)
        throw new HttpError(
          429,
          "RATE_LIMITED",
          "Terlalu banyak permintaan. Coba lagi sebentar.",
        );
    },
  };
}

export const serviceRequestLimiter = createServiceRequestLimiter();
