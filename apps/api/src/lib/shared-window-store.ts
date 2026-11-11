// Shared fixed-window store for the public rate limits (bead legend-bpvf).
//
// The in-process counter (lib/fixed-window-counter.ts) gives each API instance
// its own window, so N instances allow N times the limit. With REDIS_URL set,
// the limits count in one Redis window shared by every instance; without it
// nothing here is loaded and the limits stay in process, as before.
//
// Env-free on purpose (the caller passes the URL), and `ioredis` is imported
// dynamically on first use, so a single-VM deploy never loads it.
//
// Redis is an optimisation, never a dependency: `withLocalFallback` answers
// from the instance's own counter when Redis errors or stalls (fail open per
// instance), so a Redis outage can never turn into a 5xx.

import type { createFixedWindowCounter } from "./fixed-window-counter";

export type SharedWindowResult = { allowed: boolean; retryAfterMs: number };

export type SharedWindowStore = {
  /** Counts one request for `key` in `bucket`'s current fixed window. */
  take(
    bucket: string,
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<SharedWindowResult>;
};

type LocalCounter = Pick<ReturnType<typeof createFixedWindowCounter>, "take">;

/** The longest a request waits on the shared store before the local fallback. */
export const SHARED_STORE_TIMEOUT_MS = 200;

export type LocalFallbackOptions = {
  timeoutMs?: number;
  /** Clock for the local counters; production uses the wall clock. */
  now?: () => number;
  /** Called with the store error each time the fallback answers. */
  onError?: (error: unknown) => void;
};

/**
 * In-process store: one fixed-window counter per bucket (and limit/window),
 * built by `localCounterFactory`. The no-Redis path and the fallback below.
 */
export function createLocalWindowStore(
  localCounterFactory: (limit: number, windowMs: number) => LocalCounter,
  now: () => number = Date.now,
): SharedWindowStore {
  const counters = new Map<string, LocalCounter>();
  return {
    async take(bucket, key, limit, windowMs) {
      const id = `${bucket}|${limit}|${windowMs}`;
      let counter = counters.get(id);
      if (!counter) {
        counter = localCounterFactory(limit, windowMs);
        counters.set(id, counter);
      }
      const retrySeconds = counter.take(key, now());
      return retrySeconds === null
        ? { allowed: true, retryAfterMs: 0 }
        : { allowed: false, retryAfterMs: retrySeconds * 1000 };
    },
  };
}

/**
 * Answers from `shared`; on a rejection or a stall longer than the timeout it
 * answers from an in-process counter instead. Never throws.
 */
export function withLocalFallback(
  shared: SharedWindowStore,
  localCounterFactory: (limit: number, windowMs: number) => LocalCounter,
  options: LocalFallbackOptions = {},
): SharedWindowStore {
  const timeoutMs = options.timeoutMs ?? SHARED_STORE_TIMEOUT_MS;
  const local = createLocalWindowStore(localCounterFactory, options.now);

  return {
    async take(bucket, key, limit, windowMs) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("shared window store timed out")),
            timeoutMs,
          );
          timer.unref?.();
        });
        return await Promise.race([
          shared.take(bucket, key, limit, windowMs),
          timeout,
        ]);
      } catch (error) {
        try {
          options.onError?.(error);
        } catch {
          // A failing logger must not fail the request.
        }
        return local.take(bucket, key, limit, windowMs);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// INCR and the expiry in one atomic call, so a crash between them cannot leave
// a counter that never expires. Returns { count, ttl in ms }.
const TAKE_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return { count, redis.call("PTTL", KEYS[1]) }
`;

type RedisLike = {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type RedisWindowStoreOptions = {
  /** Test seam; production uses the wall clock. */
  now?: () => number;
  /** Test seam: replaces the lazy `ioredis` connection. */
  client?: RedisLike;
};

/**
 * Redis-backed fixed windows. Key `rl:<bucket>:<key>:<windowIndex>`, so each
 * window is its own counter that Redis expires on its own. The connection is
 * opened on first use (dynamic import) and fails fast while Redis is down
 * instead of queueing commands.
 */
export function createRedisWindowStore(
  url: string,
  options: RedisWindowStoreOptions = {},
): SharedWindowStore {
  const clock = options.now ?? Date.now;
  let client: Promise<RedisLike> | undefined = options.client
    ? Promise.resolve(options.client)
    : undefined;

  function connect(): Promise<RedisLike> {
    client ??= import("ioredis").then(({ Redis }) => {
      const redis = new Redis(url, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1_000,
        // A hung (half-open) connection must not leave commands queued per
        // request: fail the command at the same budget the fallback waits.
        commandTimeout: 200,
      });
      // Without a listener ioredis would throw on connection errors; the
      // fallback in withLocalFallback already handles failed commands.
      redis.on("error", () => undefined);
      return redis as unknown as RedisLike;
    });
    return client;
  }

  return {
    async take(bucket, key, limit, windowMs) {
      const now = clock();
      const index = Math.floor(now / windowMs);
      const redis = await connect();
      const reply = await redis.eval(
        TAKE_SCRIPT,
        1,
        `rl:${bucket}:${key}:${index}`,
        String(windowMs),
      );
      if (!Array.isArray(reply)) throw new Error("unexpected Redis reply");
      const count = Number(reply[0]);
      if (!Number.isFinite(count)) throw new Error("unexpected Redis reply");
      if (count <= limit) return { allowed: true, retryAfterMs: 0 };
      const untilWindowEnd = (index + 1) * windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(1, untilWindowEnd) };
    },
  };
}
