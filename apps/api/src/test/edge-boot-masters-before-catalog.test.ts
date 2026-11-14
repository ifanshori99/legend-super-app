// Edge boot order (bead legend-2uqcd, review P2-3): a node bootstrapped before
// the all-tenant brands has no brand rows for other brands' recipes, so the
// first catalog pull would fail on `recipes` (menu_items and item_variants wait
// for recipes) until the periodic master sync. At boot the runtime therefore
// syncs the masters once, best effort, BEFORE it starts the master sync loop
// with its first catalog pull (`startAfterBootMasters`).
//
// The master sync itself is replaced by a controllable fake; its behaviour is
// covered by edge-master-sync.test.ts and edge-recipes-all-tenant.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

const syncEdgeMasters = vi.hoisted(() => vi.fn());
vi.mock("../edge/master-sync.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edge/master-sync.ts")>()),
  syncEdgeMasters,
}));

import {
  startAfterBootMasters,
  syncEdgeMastersBeforeCatalog,
} from "../edge/bootstrap.ts";
import { EdgeMasterSyncError } from "../edge/master-sync.ts";
import { logger } from "../lib/logger.ts";

const config = {
  cloudUrl: "https://cloud.example.test",
  credential: "secret-credential-value",
} as Parameters<typeof startAfterBootMasters>[0]["config"];

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  syncEdgeMasters.mockReset();
  vi.restoreAllMocks();
});

describe("legend-2uqcd boot: masters before the first catalog pull", () => {
  it("starts the catalog loop only after the master sync finished", async () => {
    const order: string[] = [];
    let release!: () => void;
    syncEdgeMasters.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push("masters");
            resolve();
          };
        }),
    );
    const start = vi.fn(() => {
      order.push("catalog");
      return { stop: async () => undefined };
    });
    startAfterBootMasters({ config, syncMasters: true, start });

    // The caller was not blocked and the catalog has not started yet.
    await flush();
    expect(syncEdgeMasters).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();

    release();
    await flush();
    expect(order).toEqual(["masters", "catalog"]);
  });

  it("a failed or offline master sync never stops the boot: the catalog loop still starts and nothing secret is logged", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    for (const failure of [
      new EdgeMasterSyncError("CLOUD_UNREACHABLE"),
      new EdgeMasterSyncError("LOCAL_WRITE"),
      new Error("boom secret-credential-value"),
    ]) {
      syncEdgeMasters.mockRejectedValueOnce(failure);
      const start = vi.fn(() => ({ stop: async () => undefined }));
      startAfterBootMasters({ config, syncMasters: true, start });
      await flush();
      expect(start).toHaveBeenCalledTimes(1);
    }
    expect(JSON.stringify([warn.mock.calls, error.mock.calls])).not.toContain(
      "secret-credential-value",
    );
  });

  it("does not sync the masters again when the node was bootstrapped in this boot", async () => {
    const start = vi.fn(() => ({ stop: async () => undefined }));
    startAfterBootMasters({ config, syncMasters: false, start });
    await flush();
    expect(syncEdgeMasters).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("stop during the master sync aborts it and the loop never starts", async () => {
    let signal: AbortSignal | undefined;
    syncEdgeMasters.mockImplementation(
      (_config: unknown, options: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          signal = options.signal;
          options.signal?.addEventListener("abort", () =>
            reject(new EdgeMasterSyncError("CLOUD_UNREACHABLE")),
          );
        }),
    );
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const start = vi.fn(() => ({ stop: async () => undefined }));
    const handle = startAfterBootMasters({ config, syncMasters: true, start });
    await flush();
    await handle.stop();
    expect(signal?.aborted).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it("stop after the start stops the catalog loop", async () => {
    syncEdgeMasters.mockResolvedValue({});
    const stopLoop = vi.fn(async () => undefined);
    const handle = startAfterBootMasters({
      config,
      syncMasters: true,
      start: () => ({ stop: stopLoop }),
    });
    await flush();
    await handle.stop();
    expect(stopLoop).toHaveBeenCalledTimes(1);
  });

  it("syncEdgeMastersBeforeCatalog bounds the request and reports success or failure without throwing", async () => {
    syncEdgeMasters.mockResolvedValueOnce({});
    expect(await syncEdgeMastersBeforeCatalog(config)).toBe(true);
    expect(syncEdgeMasters.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: 5_000,
    });
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    syncEdgeMasters.mockRejectedValueOnce(
      new EdgeMasterSyncError("CLOUD_UNREACHABLE"),
    );
    expect(await syncEdgeMastersBeforeCatalog(config)).toBe(false);
  });

  it("legend-i8fv3 merge keeps and coalesces deferred wakes while boot masters are pending", async () => {
    let release: () => void = () => undefined;
    syncEdgeMasters.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const requestRun = vi.fn();
    const start = vi.fn(() => ({ requestRun, stop: async () => undefined }));
    const handle: { requestRun?: () => void; stop(): Promise<void> } =
      startAfterBootMasters({ config, syncMasters: true, start });
    try {
      await flush();
      expect(handle.requestRun).toBeTypeOf("function");
      handle.requestRun?.();
      handle.requestRun?.();
      handle.requestRun?.();
      expect(start).not.toHaveBeenCalled();
      expect(requestRun).not.toHaveBeenCalled();
      release();
      await flush();
      expect(start).toHaveBeenCalledTimes(1);
      expect(requestRun).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await handle.stop();
    }
  });

  it("legend-i8fv3 merge forwards deferred wakes after start and ignores them after stop", async () => {
    const requestRun = vi.fn();
    const stop = vi.fn(async () => undefined);
    const handle: { requestRun?: () => void; stop(): Promise<void> } =
      startAfterBootMasters({
        config,
        syncMasters: false,
        start: () => ({ requestRun, stop }),
      });
    try {
      await flush();
      expect(handle.requestRun).toBeTypeOf("function");
      handle.requestRun?.();
      handle.requestRun?.();
      expect(requestRun).toHaveBeenCalledTimes(2);
      await handle.stop();
      handle.requestRun?.();
      expect(requestRun).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop();
    }
  });
});
