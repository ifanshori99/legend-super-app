// Redis sliding-window store for the MCP per-token rate limit (bead
// legend-4cjn6). Redis is replaced through the `client` seam by a fake `eval`
// that emulates the Lua script on a sorted set (trim, count < limit => add and
// { 1, 0 }, else { 0, oldest + window - now }), with a fake clock via `now`.
// The Lua text itself is not run here; these cases pin the store's contract:
// never above the limit inside a window, a positive retry delay on refusal, and
// a client error is never turned into an allowed call.

import { describe, expect, it } from "vitest";
import { createRedisSlidingWindowStore } from "../lib/sliding-window-store.ts";

const WINDOW_MS = 60_000;

function fakeRedis() {
  const sets = new Map<string, { score: number; member: string }[]>();
  const evalKeys: string[] = [];
  return {
    evalKeys,
    client: {
      async eval(_script: string, _numKeys: number, ...args: string[]) {
        const [
          key = "",
          nowArg = "",
          windowArg = "",
          limitArg = "",
          member = "",
        ] = args;
        evalKeys.push(key);
        const now = Number(nowArg);
        const window = Number(windowArg);
        const limit = Number(limitArg);
        const set = (sets.get(key) ?? []).filter(
          (entry) => entry.score > now - window,
        );
        if (set.length < limit) {
          set.push({ score: now, member });
          sets.set(key, set);
          return [1, 0];
        }
        sets.set(key, set);
        const oldest = Math.min(...set.map((entry) => entry.score));
        return [0, oldest + window - now];
      },
      on() {
        return undefined;
      },
    },
  };
}

describe("createRedisSlidingWindowStore (fake eval, fake clock)", () => {
  it("never allows more than the limit inside one window", async () => {
    let now = 1_000_000;
    const { client } = fakeRedis();
    const store = createRedisSlidingWindowStore("redis://unused", {
      client,
      now: () => now,
    });
    let allowed = 0;
    for (let i = 0; i < 10; i += 1) {
      const result = await store.take("mcp", "token-a", 3, WINDOW_MS);
      if (result.allowed) allowed += 1;
      now += 1_000;
    }
    expect(allowed).toBe(3);
  });

  it("does not let the budget be spent twice across a window boundary", async () => {
    let now = 5_000_000;
    const { client } = fakeRedis();
    const store = createRedisSlidingWindowStore("redis://unused", {
      client,
      now: () => now,
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await store.take("mcp", "t", 3, WINDOW_MS)).allowed).toBe(true);
    }
    // Just after the first call would fall out of a fixed window, but all
    // three calls are still inside the last 60 s.
    now += WINDOW_MS - 1;
    expect((await store.take("mcp", "t", 3, WINDOW_MS)).allowed).toBe(false);
  });

  it("refuses with a positive retryAfterMs that points at the oldest call leaving", async () => {
    let now = 2_000_000;
    const { client } = fakeRedis();
    const store = createRedisSlidingWindowStore("redis://unused", {
      client,
      now: () => now,
    });
    expect((await store.take("mcp", "t", 1, WINDOW_MS)).allowed).toBe(true);
    now += 10_000;
    const refused = await store.take("mcp", "t", 1, WINDOW_MS);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBe(WINDOW_MS - 10_000);
    // Waiting that long frees the slot; a refused call was not recorded.
    now += refused.retryAfterMs;
    expect((await store.take("mcp", "t", 1, WINDOW_MS)).allowed).toBe(true);
  });

  it("keeps separate counts per bucket and key", async () => {
    const now = 3_000_000;
    const { client, evalKeys } = fakeRedis();
    const store = createRedisSlidingWindowStore("redis://unused", {
      client,
      now: () => now,
    });
    expect((await store.take("mcp", "a", 1, WINDOW_MS)).allowed).toBe(true);
    expect((await store.take("mcp", "a", 1, WINDOW_MS)).allowed).toBe(false);
    expect((await store.take("mcp", "b", 1, WINDOW_MS)).allowed).toBe(true);
    expect(evalKeys).toEqual(["rlsw:mcp:a", "rlsw:mcp:a", "rlsw:mcp:b"]);
  });

  it("propagates a client.eval error instead of returning allowed", async () => {
    const boom = new Error("redis down");
    const store = createRedisSlidingWindowStore("redis://unused", {
      client: {
        async eval() {
          throw boom;
        },
        on() {
          return undefined;
        },
      },
      now: () => 4_000_000,
    });
    await expect(store.take("mcp", "t", 5, WINDOW_MS)).rejects.toBe(boom);
  });

  it("throws on a malformed Redis reply instead of returning allowed", async () => {
    const store = createRedisSlidingWindowStore("redis://unused", {
      client: {
        async eval() {
          return "OK";
        },
        on() {
          return undefined;
        },
      },
      now: () => 4_000_000,
    });
    await expect(store.take("mcp", "t", 5, WINDOW_MS)).rejects.toThrow(
      "unexpected Redis reply",
    );
  });
});
