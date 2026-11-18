// Sliding-window stores for the MCP per-token rate limit (bead legend-4cjn6).
//
// A fixed window lets a caller spend the budget at the end of one minute and
// again at the start of the next (up to 2x the limit in a short span). These
// stores keep one timestamp per accepted call and count only those inside the
// last `windowMs`, so no span of `windowMs` ever holds more than `limit` calls.
// Same `SharedWindowStore` shape as lib/shared-window-store.ts, so callers swap
// stores without changing the call. Rejected calls are not recorded.
//
// Env-free (the caller passes the URL); `ioredis` loads on first use.

import { randomUUID } from "node:crypto";
import type {
  SharedWindowResult,
  SharedWindowStore,
} from "./shared-window-store";

type Clock = () => number;

/**
 * In-process sliding window. Bounded Map: the least recently used key is
 * evicted first once `capacity` keys are held.
 */
export function createLocalSlidingWindowStore(
  options: { capacity?: number; now?: Clock } = {},
): SharedWindowStore {
  const capacity = options.capacity ?? 5_000;
  const clock = options.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();
  return {
    async take(bucket, key, limit, windowMs): Promise<SharedWindowResult> {
      const now = clock();
      const id = `${bucket}|${key}`;
      const stamps = (hits.get(id) ?? []).filter(
        (stamp) => stamp > now - windowMs,
      );
      hits.delete(id);
      if (stamps.length >= limit) {
        hits.set(id, stamps);
        const oldest = stamps[0] ?? now;
        return {
          allowed: false,
          retryAfterMs: Math.max(1, oldest + windowMs - now),
        };
      }
      if (hits.size >= capacity) {
        const lru = hits.keys().next().value;
        if (lru !== undefined) hits.delete(lru);
      }
      stamps.push(now);
      hits.set(id, stamps);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

// Sorted set of accepted calls (score = ms timestamp). Trim, count, add and the
// expiry in one atomic call, so concurrent instances cannot both take the last
// slot. Returns { allowed (1|0), retryAfterMs }.
const SLIDING_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now - window)
if redis.call("ZCARD", KEYS[1]) < limit then
  redis.call("ZADD", KEYS[1], now, ARGV[4])
  redis.call("PEXPIRE", KEYS[1], window)
  return { 1, 0 }
end
local oldest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
return { 0, tonumber(oldest[2]) + window - now }
`;

type RedisLike = {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type RedisSlidingWindowStoreOptions = {
  /** Test seam; production uses the wall clock. */
  now?: Clock;
  /** Test seam: replaces the lazy `ioredis` connection. */
  client?: RedisLike;
};

/**
 * Redis-backed sliding window, key `rlsw:<bucket>:<key>`. Errors and stalls
 * propagate: the caller decides (the MCP limit fails closed).
 */
export function createRedisSlidingWindowStore(
  url: string,
  options: RedisSlidingWindowStoreOptions = {},
): SharedWindowStore {
  const clock = options.now ?? (() => Date.now());
  let client: Promise<RedisLike> | undefined = options.client
    ? Promise.resolve(options.client)
    : undefined;

  function connect(): Promise<RedisLike> {
    client ??= import("ioredis").then(({ Redis }) => {
      const redis = new Redis(url, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1_000,
        commandTimeout: 200,
      });
      redis.on("error", () => undefined);
      return redis as unknown as RedisLike;
    });
    return client;
  }

  return {
    async take(bucket, key, limit, windowMs) {
      const now = clock();
      const redis = await connect();
      const reply = await redis.eval(
        SLIDING_SCRIPT,
        1,
        `rlsw:${bucket}:${key}`,
        String(now),
        String(windowMs),
        String(limit),
        `${now}:${randomUUID()}`,
      );
      if (!Array.isArray(reply)) throw new Error("unexpected Redis reply");
      const allowed = Number(reply[0]);
      const retryAfterMs = Number(reply[1]);
      if (!Number.isFinite(allowed) || !Number.isFinite(retryAfterMs))
        throw new Error("unexpected Redis reply");
      return allowed === 1
        ? { allowed: true, retryAfterMs: 0 }
        : { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
    },
  };
}
