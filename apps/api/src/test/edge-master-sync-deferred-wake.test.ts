import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import { mintEdgeCredential } from "../edge/credential.ts";
import { startEdgeMasterSyncLoop } from "../edge/master-sync.ts";

const SECOND = 1_000;
const emptyResult = {
  streams: {},
  applied: 0,
  skipped: 0,
  deleted: 0,
  nulledRefs: 0,
  repairedParents: 0,
  pages: 0,
  backlog: false,
};

function config() {
  const credential = mintEdgeCredential({
    tenantId: randomUUID(),
    outletId: randomUUID(),
    edgeNodeId: randomUUID(),
  });
  const parsed = parseEdgeRuntimeConfig({
    EDGE_MODE: "true",
    EDGE_CLOUD_URL: "wss://cloud.example.test/api/edge-link",
    EDGE_NODE_CREDENTIAL: credential.token,
    EDGE_NODE_ROLE: "primary",
  });
  if (!parsed.ok || !parsed.config.edgeMode) throw new Error("invalid config");
  return parsed.config;
}

afterEach(() => vi.useRealTimers());

describe("deferred master data wakes edge sync", () => {
  it("coalesces requests for 30 seconds, runs masters before catalog, preserves periodic fallback, and cancels wake on stop", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      order.push("masters");
      return new Response("{}", { status: 500 });
    });
    const pull = vi.fn(async () => {
      order.push("catalog");
      return emptyResult;
    });
    const loop = startEdgeMasterSyncLoop({
      config: config(),
      intervalMs: 300 * SECOND,
      options: { fetchImpl },
      catalog: { pull },
    });

    loop.requestRun();
    loop.requestRun();
    await vi.advanceTimersByTimeAsync(29 * SECOND);
    expect(order).toEqual([]);
    loop.requestRun();
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(order).toEqual(["masters", "catalog"]);

    await vi.advanceTimersByTimeAsync(270 * SECOND);
    expect(order).toEqual(["masters", "catalog", "masters", "catalog"]);
    loop.requestRun();
    await loop.stop();
    await vi.advanceTimersByTimeAsync(300 * SECOND);
    loop.requestRun();
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(order).toEqual(["masters", "catalog", "masters", "catalog"]);
  });

  it("combines deferred requests while a run is in flight without overlap", async () => {
    vi.useFakeTimers();
    let finishFirst!: () => void;
    const first = new Promise<typeof emptyResult>((resolve) => {
      finishFirst = () => resolve(emptyResult);
    });
    const pull = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(emptyResult);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const loop = startEdgeMasterSyncLoop({
      config: config(),
      intervalMs: 300 * SECOND,
      options: { fetchImpl },
      catalog: { pull },
    });

    loop.requestRun();
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(pull).toHaveBeenCalledTimes(1);
    loop.requestRun();
    loop.requestRun();
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(pull).toHaveBeenCalledTimes(1);
    finishFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(pull).toHaveBeenCalledTimes(2);
    await loop.stop();
  });
});
