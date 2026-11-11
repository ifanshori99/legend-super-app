// Shared (Redis-backed) rate-limit window seam (bead legend-bpvf).
//
// Written from the card design, not the implementation. Assumed contract:
//   - `SharedWindowStore.take(bucket, key, limit, windowMs)` resolves
//     `{ allowed, retryAfterMs }`.
//   - `withLocalFallback(shared, localCounterFactory)` returns a store that
//     answers from `shared`, and on a rejection or a stall (> ~200ms) answers
//     from an in-process fixed-window counter instead (fail open per instance,
//     never throws).
//   - The factory builds one local counter per bucket. Assumption: it is called
//     with `(limit, windowMs)` or `({ limit, windowMs })`; the helper below
//     accepts both, so only the counter shape matters (`take(key, now)` returns
//     null when allowed, or the retry delay in ms when limited, like
//     `createFixedWindowCounter`).
// The Redis implementation itself needs a live Redis and is not covered here.

import { describe, expect, it } from "vitest";
import { createFixedWindowCounter } from "../lib/fixed-window-counter";
import {
  withLocalFallback,
  type SharedWindowStore,
} from "../lib/shared-window-store";

function localFactory(...args: unknown[]) {
  const first = args[0];
  const limit =
    typeof first === "object" && first !== null
      ? (first as { limit: number }).limit
      : (first as number);
  const windowMs =
    typeof first === "object" && first !== null
      ? (first as { windowMs: number }).windowMs
      : (args[1] as number);
  return createFixedWindowCounter({ limit, windowMs, capacity: 100 });
}

function fallbackStore(shared: SharedWindowStore): SharedWindowStore {
  return withLocalFallback(shared, localFactory as never);
}

describe("shared window store fallback (legend-bpvf)", () => {
  it("legend-bpvf answers from the shared store while it is healthy", async () => {
    const calls: unknown[][] = [];
    const store = fallbackStore({
      async take(...args) {
        calls.push(args);
        return { allowed: false, retryAfterMs: 4_000 };
      },
    });
    const result = await store.take("ip", "203.0.113.1", 5, 60_000);
    expect(result).toEqual({ allowed: false, retryAfterMs: 4_000 });
    expect(calls).toEqual([["ip", "203.0.113.1", 5, 60_000]]);
  });

  it("legend-bpvf falls back to a local counter when the shared store rejects, never throwing", async () => {
    const store = fallbackStore({
      async take() {
        throw new Error("redis down");
      },
    });
    const take = () => store.take("ip", "203.0.113.2", 2, 60_000);
    expect((await take()).allowed).toBe(true);
    expect((await take()).allowed).toBe(true);
    const limited = await take();
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(limited.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("legend-bpvf keeps fallback counters separate per bucket and key", async () => {
    const store = fallbackStore({
      async take() {
        throw new Error("redis down");
      },
    });
    expect((await store.take("ip", "203.0.113.3", 1, 60_000)).allowed).toBe(
      true,
    );
    expect((await store.take("ip", "203.0.113.3", 1, 60_000)).allowed).toBe(
      false,
    );
    expect((await store.take("ip", "203.0.113.4", 1, 60_000)).allowed).toBe(
      true,
    );
    expect((await store.take("tenant", "203.0.113.3", 1, 60_000)).allowed).toBe(
      true,
    );
  });

  it("legend-bpvf falls back instead of hanging when the shared store stalls", async () => {
    const store = fallbackStore({
      take: () => new Promise(() => undefined),
    });
    const started = Date.now();
    const result = await store.take("ip", "203.0.113.5", 1, 60_000);
    expect(result.allowed).toBe(true);
    // The card caps the wait at 200ms; allow generous slack for a busy machine.
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it("legend-bpvf returns to the shared store once it recovers", async () => {
    let healthy = false;
    const store = fallbackStore({
      async take() {
        if (!healthy) throw new Error("redis down");
        return { allowed: false, retryAfterMs: 7_000 };
      },
    });
    expect((await store.take("ip", "203.0.113.6", 5, 60_000)).allowed).toBe(
      true,
    );
    healthy = true;
    expect(await store.take("ip", "203.0.113.6", 5, 60_000)).toEqual({
      allowed: false,
      retryAfterMs: 7_000,
    });
  });
});
