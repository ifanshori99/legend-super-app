// Unit tests for the edge device-registry puller (bead legend-2lp.7). No DB:
// pull/load/save, clock, timers and random are all injected.
import { describe, expect, it, vi } from "vitest";
import {
  createDeviceRegistryPuller,
  pullWithCursorRecovery,
  type DeviceRegistryPullerDeps,
} from "./device-registry-puller.ts";

const INTERVAL = 60_000;
const STALE_AFTER = 900_000;
const MAX_BACKOFF = 300_000;

type FakeTimer = { fn: () => void; ms: number; cleared: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<DeviceRegistryPullerDeps> = {}) {
  let clock = Date.parse("2026-11-08T10:00:00.000Z");
  const timers: FakeTimer[] = [];
  const pull = vi.fn<DeviceRegistryPullerDeps["pull"]>(async () => ({
    watermark: "w1",
  }));
  const load = vi.fn<DeviceRegistryPullerDeps["load"]>(async () => ({
    watermark: null,
    lastSuccessAt: null,
  }));
  const save = vi.fn<DeviceRegistryPullerDeps["save"]>(async () => undefined);
  const onStaleChange = vi.fn<(stale: boolean) => void>();
  const onError = vi.fn<(error: unknown) => void>();
  const puller = createDeviceRegistryPuller({
    pull,
    load,
    save,
    intervalMs: INTERVAL,
    staleAfterMs: STALE_AFTER,
    maxBackoffMs: MAX_BACKOFF,
    now: () => new Date(clock),
    random: () => 1, // top of the jitter range: delay unchanged
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as FakeTimer).cleared = true;
    },
    onStaleChange,
    onError,
    ...overrides,
  });
  const active = () => timers.filter((timer) => !timer.cleared);
  return {
    puller,
    pull,
    load,
    save,
    onStaleChange,
    onError,
    timers,
    active,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Fires the pending timer and waits for the run it starts. */
    async fire() {
      const pending = active().at(-1);
      if (!pending) throw new Error("no pending timer");
      pending.cleared = true;
      pending.fn();
      await puller.runOnce();
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("createDeviceRegistryPuller", () => {
  it("legend-2lp.7 start() pulls immediately", async () => {
    const t = setup();
    t.puller.start();
    await flush();
    expect(t.pull).toHaveBeenCalledTimes(1);
    expect(t.pull.mock.calls[0]?.[0]).toBeNull();
  });

  it("legend-2lp.7 schedules the next pull at intervalMs after a success", async () => {
    const t = setup();
    t.puller.start();
    await flush();
    expect(t.active()).toHaveLength(1);
    expect(t.active()[0]?.ms).toBe(INTERVAL);
    await t.fire();
    expect(t.pull).toHaveBeenCalledTimes(2);
    expect(t.active().at(-1)?.ms).toBe(INTERVAL);
  });

  it("legend-2lp.7 a throwing onStaleChange does not stop the schedule", async () => {
    const t = setup({
      onStaleChange: () => {
        throw new Error("logger down");
      },
    });
    t.puller.start();
    await flush();
    expect(t.active()).toHaveLength(1);
    await t.fire();
    expect(t.pull).toHaveBeenCalledTimes(2);
    expect(t.active()).toHaveLength(1);
  });

  it("legend-2lp.7 runOnce during an in-flight pull shares that run", async () => {
    const gate = deferred<{ watermark: string | null }>();
    const t = setup({ pull: vi.fn(() => gate.promise) });
    const first = t.puller.runOnce();
    const second = t.puller.runOnce();
    expect(second).toBe(first);
    await flush();
    gate.resolve({ watermark: "w1" });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it("legend-2lp.7 the timer never starts a second concurrent pull", async () => {
    const gate = deferred<{ watermark: string | null }>();
    const pull = vi.fn(() => gate.promise);
    const t = setup({ pull });
    t.puller.start();
    await flush();
    expect(pull).toHaveBeenCalledTimes(1);
    // No timer is armed while a pull runs; even a stray one shares the run.
    expect(t.active()).toHaveLength(0);
    void t.puller.runOnce(); // what a stray timer callback would do
    await flush();
    expect(pull).toHaveBeenCalledTimes(1);
    gate.resolve({ watermark: "w1" });
    await flush();
    expect(t.active()).toHaveLength(1);
    expect(t.active()[0]?.ms).toBe(INTERVAL);
  });

  it("legend-2lp.7 backoff doubles per failure and caps at maxBackoffMs", async () => {
    const t = setup({
      pull: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    t.puller.start();
    await flush();
    const delays = [t.active().at(-1)?.ms];
    for (let i = 0; i < 5; i += 1) {
      await t.fire();
      delays.push(t.active().at(-1)?.ms);
    }
    expect(delays).toEqual([
      60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
    expect(t.puller.getState().consecutiveFailures).toBe(6);
  });

  it("legend-2lp.7 jitters the delay into [delay/2, delay]", async () => {
    const t = setup({
      random: () => 0,
      pull: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    t.puller.start();
    await flush();
    expect(t.active().at(-1)?.ms).toBe(30_000);
    await t.fire();
    expect(t.active().at(-1)?.ms).toBe(60_000);
  });

  it("legend-2lp.7 a success after failures resets backoff to intervalMs", async () => {
    const pull = vi
      .fn<DeviceRegistryPullerDeps["pull"]>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ watermark: "w1" });
    const t = setup({ pull });
    t.puller.start();
    await flush();
    await t.fire();
    await t.fire();
    expect(t.puller.getState().consecutiveFailures).toBe(0);
    expect(t.puller.getState().lastError).toBeNull();
    expect(t.active().at(-1)?.ms).toBe(INTERVAL);
  });

  it("legend-2lp.7 stop() aborts the in-flight fetch, awaits it, and no pull runs after", async () => {
    let seen: AbortSignal | undefined;
    const pull = vi.fn(
      (_since: string | null, signal: AbortSignal) =>
        new Promise<{ watermark: string | null }>((_resolve, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const t = setup({ pull });
    t.puller.start();
    await flush();
    expect(seen?.aborted).toBe(false);
    await t.puller.stop();
    expect(seen?.aborted).toBe(true);
    expect(t.active()).toHaveLength(0);
    expect(t.onError).not.toHaveBeenCalled();
    expect(t.puller.getState().consecutiveFailures).toBe(0);
    expect(await t.puller.runOnce()).toBe(false);
    t.puller.start();
    await t.puller.stop(); // idempotent
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("legend-2lp.7 passes the stored watermark from load() to pull", async () => {
    const t = setup({
      load: vi.fn(async () => ({
        watermark: "stored-w",
        lastSuccessAt: new Date("2026-11-08T09:59:00.000Z"),
      })),
    });
    await t.puller.runOnce();
    expect(t.pull.mock.calls[0]?.[0]).toBe("stored-w");
  });

  it("legend-2lp.7 loads the checkpoint once, retries load if it throws", async () => {
    const load = vi
      .fn<DeviceRegistryPullerDeps["load"]>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue({ watermark: "stored-w", lastSuccessAt: null });
    const t = setup({ load });
    expect(await t.puller.runOnce()).toBe(false);
    expect(t.pull).not.toHaveBeenCalled();
    expect(await t.puller.runOnce()).toBe(true);
    expect(await t.puller.runOnce()).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(t.pull.mock.calls[0]?.[0]).toBe("stored-w");
  });

  it("legend-2lp.7 save() receives the new watermark and the next pull uses it", async () => {
    const pull = vi
      .fn<DeviceRegistryPullerDeps["pull"]>()
      .mockResolvedValueOnce({ watermark: "w1" })
      .mockResolvedValueOnce({ watermark: "w2" });
    const t = setup({ pull });
    await t.puller.runOnce();
    expect(t.save).toHaveBeenCalledWith({
      watermark: "w1",
      succeededAt: new Date("2026-11-08T10:00:00.000Z"),
    });
    await t.puller.runOnce();
    expect(pull.mock.calls[1]?.[0]).toBe("w1");
    expect(t.save.mock.calls[1]?.[0].watermark).toBe("w2");
  });

  it("legend-2lp.7 a failed pull leaves watermark and lastSuccessAt, counts the failure", async () => {
    const pull = vi
      .fn<DeviceRegistryPullerDeps["pull"]>()
      .mockResolvedValueOnce({ watermark: "w1" })
      .mockRejectedValueOnce(
        Object.assign(new Error("secret row data"), { code: "HTTP_503" }),
      )
      .mockResolvedValueOnce({ watermark: "w2" });
    const t = setup({ pull });
    await t.puller.runOnce();
    const before = t.puller.getState();
    t.advance(1000);
    expect(await t.puller.runOnce()).toBe(false);
    const after = t.puller.getState();
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt);
    expect(after.consecutiveFailures).toBe(1);
    expect(after.lastError).toBe("HTTP_503");
    expect(after.lastError).not.toContain("secret");
    expect(after.lastAttemptAt).not.toBe(before.lastAttemptAt);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.onError).toHaveBeenCalledTimes(1);
    await t.puller.runOnce();
    expect(pull.mock.calls[2]?.[0]).toBe("w1");
  });

  it("legend-2lp.7 a failing save() counts as a failure and keeps the old watermark", async () => {
    const save = vi
      .fn<DeviceRegistryPullerDeps["save"]>()
      .mockRejectedValueOnce(
        Object.assign(new Error("x"), { name: "PgError" }),
      );
    const t = setup({ save });
    expect(await t.puller.runOnce()).toBe(false);
    expect(t.puller.getState().lastSuccessAt).toBeNull();
    expect(t.puller.getState().lastError).toBe("PgError");
    await t.puller.runOnce();
    expect(t.pull.mock.calls[1]?.[0]).toBeNull();
  });

  it("legend-2lp.7 stale: true before any success, false after, true after staleAfterMs", async () => {
    const t = setup();
    expect(t.puller.getState().stale).toBe(true);
    await t.puller.runOnce();
    expect(t.puller.getState().stale).toBe(false);
    t.advance(STALE_AFTER);
    expect(t.puller.getState().stale).toBe(false);
    t.advance(1);
    expect(t.puller.getState().stale).toBe(true);
  });

  it("legend-2lp.7 stale starts from the stored checkpoint (survives restarts)", async () => {
    const t = setup({
      load: vi.fn(async () => ({
        watermark: "w0",
        lastSuccessAt: new Date("2026-11-08T09:55:00.000Z"),
      })),
      pull: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await t.puller.runOnce();
    const state = t.puller.getState();
    expect(state.lastSuccessAt).toBe("2026-11-08T09:55:00.000Z");
    expect(state.stale).toBe(false);
    expect(state.consecutiveFailures).toBe(1);
  });

  it("legend-2lp.7 onStaleChange fires on transitions, checked after each run", async () => {
    const pull = vi
      .fn<DeviceRegistryPullerDeps["pull"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ watermark: "w1" })
      .mockResolvedValueOnce({ watermark: "w2" })
      .mockRejectedValue(new Error("offline"));
    const t = setup({ pull });
    await t.puller.runOnce(); // failure, still stale: first report
    expect(t.onStaleChange.mock.calls).toEqual([[true]]);
    await t.puller.runOnce(); // success: recovered
    expect(t.onStaleChange.mock.calls).toEqual([[true], [false]]);
    await t.puller.runOnce(); // success again: no transition
    expect(t.onStaleChange).toHaveBeenCalledTimes(2);
    t.advance(STALE_AFTER + 1);
    await t.puller.runOnce(); // failure past staleAfter: stale again
    expect(t.onStaleChange.mock.calls).toEqual([[true], [false], [true]]);
    await t.puller.runOnce(); // still stale: no duplicate
    expect(t.onStaleChange).toHaveBeenCalledTimes(3);
  });
});

describe("pullWithCursorRecovery", () => {
  const rejected = (error: unknown) =>
    error instanceof Error && error.message === "bad cursor";

  it("legend-2lp.7 a refused stored cursor is retried once from the start", async () => {
    const pull = vi.fn(async (since: string | null) => {
      if (since !== null) throw new Error("bad cursor");
      return "full";
    });
    const onRestart = vi.fn();
    await expect(
      pullWithCursorRecovery(pull, "w1", rejected, onRestart),
    ).resolves.toBe("full");
    expect(pull.mock.calls).toEqual([["w1"], [null]]);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("legend-2lp.7 other errors, and a refusal from the start, are not retried", async () => {
    const down = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(pullWithCursorRecovery(down, "w1", rejected)).rejects.toThrow(
      "down",
    );
    expect(down).toHaveBeenCalledTimes(1);
    const refused = vi.fn(async () => {
      throw new Error("bad cursor");
    });
    await expect(
      pullWithCursorRecovery(refused, null, rejected),
    ).rejects.toThrow("bad cursor");
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe("staleness and the clock", () => {
  it("legend-2lp.7 a last success in the future (clock moved back) is stale", async () => {
    const future = new Date(Date.parse("2026-11-08T11:00:00.000Z"));
    const t = setup({
      load: vi.fn(async () => ({ watermark: "w0", lastSuccessAt: future })),
      pull: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    await t.puller.runOnce();
    expect(t.puller.getState().stale).toBe(true);
  });
});

describe("refused receipt sequences (legend-zsdd)", () => {
  it("legend-zsdd starts at 0 and null", () => {
    const t = setup();
    expect(t.puller.getState()).toMatchObject({
      receiptSequencesRefused: 0,
      receiptSequencesRefusedAt: null,
    });
  });

  it("legend-zsdd a pull that refuses sets the count and the time", async () => {
    const t = setup({
      pull: vi.fn(async () => ({
        watermark: "w1",
        receiptSequencesRefused: 2,
      })),
    });
    await t.puller.runOnce();
    expect(t.puller.getState()).toMatchObject({
      receiptSequencesRefused: 2,
      receiptSequencesRefusedAt: "2026-11-08T10:00:00.000Z",
    });
  });

  it("legend-zsdd a later clean pull zeroes the count and keeps the time", async () => {
    const counts = [1, 0];
    const t = setup({
      pull: vi.fn(async () => ({
        watermark: "w1",
        receiptSequencesRefused: counts.shift(),
      })),
    });
    await t.puller.runOnce();
    t.advance(INTERVAL);
    await t.puller.runOnce();
    expect(t.puller.getState()).toMatchObject({
      receiptSequencesRefused: 0,
      receiptSequencesRefusedAt: "2026-11-08T10:00:00.000Z",
    });
  });

  it("legend-zsdd a failed pull changes neither field", async () => {
    let fail = false;
    const t = setup({
      pull: vi.fn(async () => {
        if (fail) throw new Error("down");
        return { watermark: "w1", receiptSequencesRefused: 3 };
      }),
    });
    await t.puller.runOnce();
    fail = true;
    t.advance(INTERVAL);
    await t.puller.runOnce();
    expect(t.puller.getState()).toMatchObject({
      receiptSequencesRefused: 3,
      receiptSequencesRefusedAt: "2026-11-08T10:00:00.000Z",
    });
  });

  it("legend-zsdd a pull without the count (older pull) counts as 0", async () => {
    const t = setup();
    await t.puller.runOnce();
    expect(t.puller.getState().receiptSequencesRefused).toBe(0);
  });
});
