// Kartu C item 1 (bead legend-39d.4): the MCP per-token rate limit counts in a
// shared window store (Redis in production), so N API instances share one
// count instead of allowing N times the limit. Same seam as the public limiter
// (bead legend-bpvf, lib/shared-window-store.ts): an async
// `SharedWindowStore.take(bucket, key, limit, windowMs)`. Redis itself is
// replaced by an in-memory fake store shared by "two instances", exactly like
// public-rate-limit.test.ts does.
//
// Seam (from the engineer): `enforceMcpRateLimit(tokenId, limitPerMinute,
// { store })`, exported by services/mcp-server.service.ts. It resolves when the
// call may run and throws AiError("MCP_RATE_LIMITED") when it may not.
//
// DECIDED BEHAVIOR (coordinator): the limit FAILS CLOSED with a shared store. A
// store error or a stall (> ~200 ms) refuses the call with MCP_RATE_LIMITED;
// there is no local fallback, so an outage never loosens the budget.
//
// ASSUMPTIONS (listed in the report):
//  - The store is charged once per call with limit = the token's per-minute
//    budget, windowMs = 60_000, and a key containing the token id.
//  - Without an injected store and without REDIS_URL (tests, dev) the limit
//    stays in process: covered by ai-mcp-acceptance.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SharedWindowStore } from "../lib/shared-window-store.ts";
import { enforceMcpRateLimit } from "../services/mcp-server.service.ts";

const allowed = async (
  token: string,
  limit: number,
  store: SharedWindowStore,
): Promise<boolean> => {
  try {
    await enforceMcpRateLimit(token, limit, { store });
    return true;
  } catch (error) {
    expect(error).toMatchObject({ code: "MCP_RATE_LIMITED" });
    return false;
  }
};

type Take = { bucket: string; key: string; limit: number; windowMs: number };

// One fixed window per bucket/key, shared by whoever holds the same instance:
// stands in for Redis (same shape as public-rate-limit.test.ts).
function fakeSharedStore(now = () => 1_000_000) {
  const counts = new Map<string, number>();
  const calls: Take[] = [];
  const store: SharedWindowStore = {
    async take(bucket, key, limit, windowMs) {
      calls.push({ bucket, key, limit, windowMs });
      const index = Math.floor(now() / windowMs);
      const id = `${bucket}:${key}:${index}`;
      const used = (counts.get(id) ?? 0) + 1;
      counts.set(id, used);
      return used <= limit
        ? { allowed: true, retryAfterMs: 0 }
        : { allowed: false, retryAfterMs: (index + 1) * windowMs - now() };
    },
  };
  return { store, calls };
}

describe("MCP rate limit in a shared store (legend-39d.4)", () => {
  it("legend-39d.4 two instances sharing one store count as one limit", async () => {
    const { store } = fakeSharedStore();
    const token = randomUUID();
    // "Instance one" and "instance two" are two callers of the same store.
    expect(await allowed(token, 2, store)).toBe(true); // instance one
    expect(await allowed(token, 2, store)).toBe(true); // instance two
    // Without the shared window each instance would still have one call left.
    expect(await allowed(token, 2, store)).toBe(false); // instance one
    expect(await allowed(token, 2, store)).toBe(false); // instance two
  });

  it("legend-39d.4 a store that says 'not allowed' refuses with MCP_RATE_LIMITED", async () => {
    const store: SharedWindowStore = {
      async take() {
        return { allowed: false, retryAfterMs: 12_000 };
      },
    };
    await expect(
      enforceMcpRateLimit(randomUUID(), 1000, { store }),
    ).rejects.toMatchObject({ code: "MCP_RATE_LIMITED" });
  });

  it("legend-39d.4 charges the store with the token limit, a 60 s window and a token-specific key", async () => {
    const { store, calls } = fakeSharedStore();
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    await enforceMcpRateLimit(tokenA, 7, { store });
    await enforceMcpRateLimit(tokenB, 7, { store });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ limit: 7, windowMs: 60_000 });
    expect(calls[0]!.key).toContain(tokenA);
    expect(calls[1]!.key).toContain(tokenB);
    expect(calls[0]!.bucket).toBe(calls[1]!.bucket);
    expect(calls[0]!.key).not.toBe(calls[1]!.key);
  });

  it("legend-39d.4 one token hitting its limit does not touch another token", async () => {
    const { store } = fakeSharedStore();
    const busy = randomUUID();
    const calm = randomUUID();
    expect(await allowed(busy, 1, store)).toBe(true);
    expect(await allowed(busy, 1, store)).toBe(false);
    expect(await allowed(calm, 1, store)).toBe(true);
  });

  it("legend-39d.4 FAIL CLOSED: a store error refuses the call, it never lets it through", async () => {
    const store: SharedWindowStore = {
      async take() {
        throw new Error("redis down");
      },
    };
    // Even the very first call, far below any limit, is refused.
    await expect(
      enforceMcpRateLimit(randomUUID(), 1000, { store }),
    ).rejects.toMatchObject({ code: "MCP_RATE_LIMITED" });
  });

  it("legend-39d.4 FAIL CLOSED: a stalled store refuses within the timeout instead of hanging", async () => {
    const store: SharedWindowStore = {
      take: () => new Promise(() => undefined),
    };
    const started = Date.now();
    await expect(
      enforceMcpRateLimit(randomUUID(), 1000, { store }),
    ).rejects.toMatchObject({ code: "MCP_RATE_LIMITED" });
    // The seam caps the wait at ~200 ms; allow slack for a busy machine.
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 15_000);

  it("legend-39d.4 counting resumes in the store once it recovers", async () => {
    let healthy = false;
    const { store: inner } = fakeSharedStore();
    const store: SharedWindowStore = {
      async take(...args) {
        if (!healthy) throw new Error("redis down");
        return inner.take(...args);
      },
    };
    const token = randomUUID();
    expect(await allowed(token, 1, store)).toBe(false); // outage: refused
    healthy = true;
    expect(await allowed(token, 1, store)).toBe(true); // outage calls never counted
    expect(await allowed(token, 1, store)).toBe(false); // now over the limit
  });
});
