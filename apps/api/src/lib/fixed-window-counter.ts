// Fixed-window request counter shared by the public rate limits
// (middleware/public-rate-limit.ts, legend-wd4b) and the edge link / edge sync
// limits (legend-wg5t). No env or database import, so env-free modules such
// as edge/link-server.ts can use it.

type Window = { windowStart: number; count: number };

/**
 * Fixed-window counter with the shape of services/session-extend-limiter.ts:
 * a bounded Map, the least recently used key evicted first, and a few expired
 * keys swept per call so cleanup cost does not grow with the map.
 */
export function createFixedWindowCounter(options: {
  limit: number;
  windowMs: number;
  capacity: number;
}) {
  const hits = new Map<string, Window>();
  const secondsLeft = (hit: Window, now: number) =>
    Math.max(1, Math.ceil((hit.windowStart + options.windowMs - now) / 1000));
  // Counts one request and returns the window it landed in.
  function count(key: string, now: number): Window {
    // Check a small number per request, keeping cleanup work bounded.
    let checked = 0;
    for (const [entryKey, hit] of hits) {
      if (now - hit.windowStart >= options.windowMs) hits.delete(entryKey);
      if (++checked === 4) break;
    }
    let hit = hits.get(key);
    if (!hit || now - hit.windowStart >= options.windowMs) {
      if (!hit && hits.size >= options.capacity) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      hit = { windowStart: now, count: 0 };
    }
    hit.count += 1;
    // Move the active key to the end so churn evicts the least recent one.
    hits.delete(key);
    hits.set(key, hit);
    return hit;
  }
  return {
    size: () => hits.size,
    /**
     * Counts one request. Returns null while the key is inside its limit, or
     * the whole seconds left in the window once it is over.
     */
    take(key: string, now: number): number | null {
      const hit = count(key, now);
      return hit.count <= options.limit ? null : secondsLeft(hit, now);
    },
    /**
     * Counts one request like `take`, but the caller can hand the slot back
     * (legend-12ku): reserve before an await, `release` when the outcome turns
     * out not to count (e.g. a successful login). `release` undoes that one
     * count only while the same window object is still current, and only once,
     * so it cannot erase a count of a later window.
     */
    reserve(
      key: string,
      now: number,
    ): { retryAfter: number | null; release(): void } {
      const hit = count(key, now);
      let released = false;
      return {
        retryAfter: hit.count <= options.limit ? null : secondsLeft(hit, now),
        release() {
          if (released) return;
          released = true;
          if (hits.get(key) === hit && hit.count > 0) hit.count -= 1;
        },
      };
    },
    /**
     * Counts nothing. Returns null while the next `take` would still be inside
     * the limit, or the whole seconds left in the window once the key has used
     * it up (e.g. failed attempts, legend-x3lv).
     */
    peek(key: string, now: number): number | null {
      const hit = hits.get(key);
      if (!hit || now - hit.windowStart >= options.windowMs) return null;
      if (hit.count < options.limit) return null;
      return secondsLeft(hit, now);
    },
  };
}
