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
  return {
    size: () => hits.size,
    /**
     * Counts one request. Returns null while the key is inside its limit, or
     * the whole seconds left in the window once it is over.
     */
    take(key: string, now: number): number | null {
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
      if (hit.count <= options.limit) return null;
      return Math.max(
        1,
        Math.ceil((hit.windowStart + options.windowMs - now) / 1000),
      );
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
      return Math.max(
        1,
        Math.ceil((hit.windowStart + options.windowMs - now) / 1000),
      );
    },
  };
}
