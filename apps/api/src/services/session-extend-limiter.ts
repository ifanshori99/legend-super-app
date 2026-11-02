import { MINUTE_MS } from "@starter/shared/identity";
import { HttpError } from "../lib/http-error";

export const SESSION_EXTEND_RATE_LIMIT = 10;

/** Bounded, process-local windows; eviction may reset an inactive session. */
export function createSessionExtendLimiter(capacity = 10_000) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return {
    size: () => hits.size,
    check(sessionId: string, now: number): void {
      // Check a small number per request, keeping cleanup work bounded.
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
      // Move active sessions to the end so churn evicts the least recent one.
      hits.delete(sessionId);
      hits.set(sessionId, hit);
      if (hit.count > SESSION_EXTEND_RATE_LIMIT)
        throw new HttpError(
          429,
          "RATE_LIMITED",
          "Terlalu banyak permintaan. Coba lagi sebentar.",
        );
    },
  };
}
