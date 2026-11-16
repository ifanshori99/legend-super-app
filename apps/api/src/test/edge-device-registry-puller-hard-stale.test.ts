// legend-2lgu: hard limit on a stale device-registry replica, puller predicate.
// Written from the brief (briefB, "Keputusan desain"), not from the
// implementation. No DB: pull/load/save, clock and timers are injected.
//
// Assumptions (brief ambiguities):
//  - The hard limit reaches the puller as a dependency named `hardStaleAfterMs`
//    (same style as `staleAfterMs`); the runtime feeds it `deviceRegistryMaxStaleMs`.
//  - "Lebih lama dari batas keras" is strict: a last success exactly
//    `hardStaleAfterMs` ago is NOT hard stale; one millisecond more is.
//  - With no success on record (null checkpoint) the age counts from the moment
//    the puller started; the same strict rule applies.
//  - `isHardStale(now)` takes a Date and judges at that instant; `getState()`
//    carries the same answer as `hardStale` at the injected clock.
import { describe, expect, it, vi } from "vitest";
import {
  createDeviceRegistryPuller,
  type DeviceRegistryPullerDeps,
} from "../edge/device-registry-puller.ts";

const INTERVAL = 60_000;
const STALE_AFTER = 900_000;
const MAX_BACKOFF = 300_000;
const HARD = 3_600_000; // 1 hour, the configured minimum
const T0 = Date.parse("2026-11-17T10:00:00.000Z");

type Hard = DeviceRegistryPullerDeps & { hardStaleAfterMs: number };

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(
  options: {
    lastSuccessAt?: Date | null;
    pull?: DeviceRegistryPullerDeps["pull"];
  } = {},
) {
  let clock = T0;
  const pull =
    options.pull ??
    vi.fn<DeviceRegistryPullerDeps["pull"]>(async () => {
      throw new Error("cloud down");
    });
  const deps: Hard = {
    pull,
    load: async () => ({
      watermark: null,
      lastSuccessAt: options.lastSuccessAt ?? null,
    }),
    save: async () => undefined,
    intervalMs: INTERVAL,
    staleAfterMs: STALE_AFTER,
    maxBackoffMs: MAX_BACKOFF,
    hardStaleAfterMs: HARD,
    now: () => new Date(clock),
    random: () => 1,
    setTimer: () => ({}),
    clearTimer: () => undefined,
    onStaleChange: () => undefined,
    onError: () => undefined,
  };
  const puller = createDeviceRegistryPuller(deps) as ReturnType<
    typeof createDeviceRegistryPuller
  > & {
    isHardStale(now: Date): boolean;
    getState(): ReturnType<
      ReturnType<typeof createDeviceRegistryPuller>["getState"]
    > & { hardStale: boolean };
  };
  return {
    puller,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("legend-2lgu puller hardStale predicate", () => {
  it("legend-2lgu never succeeded: not hard stale in the first minute after boot", async () => {
    const t = setup();
    t.puller.start();
    await flush();
    expect(t.puller.getState().lastSuccessAt).toBeNull();
    // The replica is soft stale (no success yet) but not hard stale yet.
    expect(t.puller.getState().stale).toBe(true);
    expect(t.puller.getState().hardStale).toBe(false);
    t.advance(60_000);
    expect(t.puller.getState().hardStale).toBe(false);
    expect(t.puller.isHardStale(new Date(T0 + 60_000))).toBe(false);
  });

  it("legend-2lgu never succeeded: counted from start, hard stale only past the limit", async () => {
    const t = setup();
    t.puller.start();
    await flush();
    t.advance(HARD);
    expect(t.puller.getState().hardStale).toBe(false); // exactly at the limit
    t.advance(1);
    expect(t.puller.getState().hardStale).toBe(true);
    expect(t.puller.isHardStale(new Date(T0 + HARD + 1))).toBe(true);
  });

  it("legend-2lgu last success older than the limit at boot is hard stale at once", async () => {
    const t = setup({
      lastSuccessAt: new Date(T0 - HARD - 1),
    });
    t.puller.start();
    await flush();
    expect(t.puller.getState().hardStale).toBe(true);
  });

  it("legend-2lgu last success exactly at the limit is not hard stale, one ms later is", async () => {
    const t = setup({ lastSuccessAt: new Date(T0 - HARD) });
    t.puller.start();
    await flush();
    expect(t.puller.getState().hardStale).toBe(false);
    t.advance(1);
    expect(t.puller.getState().hardStale).toBe(true);
  });

  it("legend-2lgu a recent last success is not hard stale (but is soft stale past staleAfterMs)", async () => {
    const t = setup({
      lastSuccessAt: new Date(T0 - STALE_AFTER - 1),
    });
    t.puller.start();
    await flush();
    expect(t.puller.getState().stale).toBe(true);
    expect(t.puller.getState().hardStale).toBe(false);
  });

  it("legend-2lgu isHardStale(now) judges at the instant it is given", async () => {
    const t = setup({ lastSuccessAt: new Date(T0) });
    t.puller.start();
    await flush();
    expect(t.puller.isHardStale(new Date(T0 + HARD))).toBe(false);
    expect(t.puller.isHardStale(new Date(T0 + HARD + 1))).toBe(true);
    // The injected clock did not move, so the state still says fresh.
    expect(t.puller.getState().hardStale).toBe(false);
  });

  it("legend-2lgu a successful pull clears hardStale", async () => {
    let ok = false;
    const t = setup({
      lastSuccessAt: new Date(T0 - 2 * HARD),
      pull: vi.fn<DeviceRegistryPullerDeps["pull"]>(async () => {
        if (!ok) throw new Error("cloud down");
        return { watermark: "w1" };
      }),
    });
    t.puller.start();
    await flush();
    expect(t.puller.getState().hardStale).toBe(true);
    ok = true;
    expect(await t.puller.runOnce()).toBe(true);
    expect(t.puller.getState().hardStale).toBe(false);
    expect(t.puller.isHardStale(new Date(T0))).toBe(false);
  });
});
