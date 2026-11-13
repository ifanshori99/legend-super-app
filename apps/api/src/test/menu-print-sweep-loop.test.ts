// Sweep loop of the printable menu worker (bead legend-iuvq). No database: the
// render service is mocked, only the loop's isolation rules are checked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";

const runDueMenuPrints = vi.hoisted(() => vi.fn());
vi.mock("../services/menu-print.service.ts", () => ({
  createMenuPrintDirtyConsumer: () => async () => {},
  runDueMenuPrints,
}));

import {
  createMenuPrintSweepLoop,
  createMenuPrintSweepLoopIfEnabled,
  shouldStartMenuPrintSweep,
} from "../worker/menu-print.job.ts";

const deps = { storage: {}, scanner: {}, renderer: null } as never;
const ctx = (id: string) =>
  ({ tenant: { tenantId: id } }) as ScopedTenantContext;

describe("menu print sweep loop", () => {
  beforeEach(() => runDueMenuPrints.mockReset());

  it("skips a tenant that cannot resolve and sweeps the others", async () => {
    runDueMenuPrints.mockResolvedValue({ regenerated: ["o1"], failed: [] });
    const onError = vi.fn();
    const loop = createMenuPrintSweepLoop({
      listTenantIds: async () => ["a", "bad", "c"],
      resolveContext: async (id) => {
        if (id === "bad") throw new Error("inactive");
        return ctx(id);
      },
      deps,
      onError,
    });
    const result = await loop.runRound();
    expect(result).toEqual({ regenerated: 2, failed: 0 });
    expect(runDueMenuPrints).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      "Menu print sweep could not resolve a tenant",
      "bad",
    );
  });

  it("keeps sweeping after one tenant's render throws", async () => {
    runDueMenuPrints
      .mockRejectedValueOnce(new Error("db"))
      .mockResolvedValueOnce({ regenerated: ["o1"], failed: ["o2"] });
    const loop = createMenuPrintSweepLoop({
      listTenantIds: async () => ["a", "b"],
      resolveContext: async (id) => ctx(id),
      deps,
    });
    expect(await loop.runRound()).toEqual({ regenerated: 1, failed: 2 });
  });

  it("reports the tenant that threw and each round's counts", async () => {
    runDueMenuPrints
      .mockRejectedValueOnce(new Error("db"))
      .mockResolvedValueOnce({ regenerated: ["o1"], failed: ["o2"] });
    const onError = vi.fn();
    const onRound = vi.fn();
    const loop = createMenuPrintSweepLoop({
      listTenantIds: async () => ["a", "b"],
      resolveContext: async (id) => ctx(id),
      deps,
      onError,
      onRound,
    });
    await loop.runRound();
    expect(onError).toHaveBeenCalledWith(
      "Menu print sweep failed for a tenant",
      "a",
    );
    expect(onRound).toHaveBeenCalledWith({ regenerated: 1, failed: 2 });
  });

  it("stop() mid-round skips the remaining tenants", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    runDueMenuPrints.mockImplementation(async () => {
      await gate;
      return { regenerated: ["o1"], failed: [] };
    });
    const loop = createMenuPrintSweepLoop({
      listTenantIds: async () => ["a", "b", "c"],
      resolveContext: async (id) => ctx(id),
      deps,
    });
    const round = loop.runRound();
    await vi.waitFor(() => expect(runDueMenuPrints).toHaveBeenCalledTimes(1));
    const stopping = loop.stop();
    release();
    await stopping;
    expect(await round).toEqual({ regenerated: 1, failed: 0 });
    expect(runDueMenuPrints).toHaveBeenCalledTimes(1);
    // The predicate reaches the service, which checks it between outlets.
    const shouldStop = runDueMenuPrints.mock.calls[0]![4] as () => boolean;
    expect(shouldStop()).toBe(true);
  });

  it("does not throw when the tenant list fails", async () => {
    const onError = vi.fn();
    const loop = createMenuPrintSweepLoop({
      listTenantIds: async () => {
        throw new Error("registry down");
      },
      resolveContext: async (id) => ctx(id),
      deps,
      onError,
    });
    await expect(loop.runRound()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("Menu print sweep failed");
  });
});

describe("menu print sweep start decision", () => {
  const options = (renderer: unknown) => ({
    listTenantIds: vi.fn(async () => ["a"]),
    resolveContext: async (id: string) => ctx(id),
    deps: { storage: {}, scanner: {}, renderer } as never,
  });

  it("does not start the loop without a renderer", () => {
    const opts = options(null);
    const onDisabled = vi.fn();
    expect(shouldStartMenuPrintSweep(null)).toBe(false);
    expect(createMenuPrintSweepLoopIfEnabled(opts, onDisabled)).toBeNull();
    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(onDisabled).toHaveBeenCalledWith(
      "menu print sweep dinonaktifkan: renderer PDF belum dikonfigurasi",
    );
    expect(opts.listTenantIds).not.toHaveBeenCalled();
  });

  it("creates the loop when a renderer exists", async () => {
    const onDisabled = vi.fn();
    const loop = createMenuPrintSweepLoopIfEnabled(
      options({ render: async () => Buffer.alloc(0) }),
      onDisabled,
    );
    expect(shouldStartMenuPrintSweep({} as never)).toBe(true);
    expect(loop).not.toBeNull();
    expect(onDisabled).not.toHaveBeenCalled();
    await loop!.stop();
  });
});
