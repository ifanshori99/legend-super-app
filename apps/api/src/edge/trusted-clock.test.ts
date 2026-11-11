// Trusted clock (bead legend-10nex, founder Q57: "jam perangkat mundur tidak
// boleh menghindari batas"). Written from the design contract
// (createTrustedClock in edge/trusted-clock.ts), not from the implementation.
//
//   trustedNow = max(wallNow, anchorWall + (monoNow - anchorMono))
//   anchorWall = max(wallNow at boot, persistedHighWater)
//
// Wall and monotonic clocks are both injected, so nothing here waits.
import { describe, expect, it } from "vitest";
import { createTrustedClock } from "./trusted-clock.ts";

const HOUR = 60 * 60_000;
const T0 = new Date("2026-11-11T03:00:00.000Z");

function rig(persistedHighWater: Date | null = null, wallAtBoot = T0) {
  let wall = wallAtBoot.getTime();
  let mono = 1_000; // arbitrary monotonic origin, unrelated to the wall clock
  const clock = createTrustedClock({
    wall: () => new Date(wall),
    mono: () => mono,
    persistedHighWater,
  });
  return {
    clock,
    // Real time passing: both clocks advance together.
    tick: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    // Somebody edits the device date: only the wall clock jumps.
    setWall: (date: Date) => {
      wall = date.getTime();
    },
  };
}

describe("legend-10nex trusted clock follows real time", () => {
  it("equals the wall clock while nothing is tampered with", () => {
    const { clock, tick } = rig();
    expect(clock.now()).toEqual(T0);
    tick(90 * 60_000);
    expect(clock.now()).toEqual(new Date(T0.getTime() + 90 * 60_000));
  });

  it("accepts a wall clock moved forward (it can only block earlier)", () => {
    const { clock, setWall } = rig();
    setWall(new Date(T0.getTime() + 30 * HOUR));
    expect(clock.now()).toEqual(new Date(T0.getTime() + 30 * HOUR));
  });
});

describe("legend-10nex a wall clock moved backwards cannot evade", () => {
  it("while running: time keeps counting from the monotonic clock", () => {
    const { clock, tick, setWall } = rig();
    tick(10 * HOUR);
    const before = clock.now();
    expect(before.getTime()).toBe(T0.getTime() + 10 * HOUR);

    // The cashier sets the device date back by two days.
    setWall(new Date(T0.getTime() - 48 * HOUR));
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(before.getTime());
    tick(15 * HOUR);
    // 25 h of real time passed since boot, whatever the wall clock says.
    expect(clock.now().getTime()).toBe(T0.getTime() + 25 * HOUR);
  });

  it("never returns a smaller value than it returned before", () => {
    const { clock, tick, setWall } = rig();
    let last = clock.now().getTime();
    const steps: Array<() => void> = [
      () => tick(HOUR),
      () => setWall(new Date(T0.getTime() - 5 * HOUR)),
      () => tick(60_000),
      () => setWall(new Date(T0.getTime() - 1000 * HOUR)),
      () => tick(2 * HOUR),
      () => setWall(new Date(T0.getTime() + 1 * HOUR)),
      () => tick(60_000),
    ];
    for (const step of steps) {
      step();
      const next = clock.now().getTime();
      expect(next).toBeGreaterThanOrEqual(last);
      last = next;
    }
  });

  it("across a restart: the persisted high water keeps the clock from going back", () => {
    const first = rig();
    first.tick(20 * HOUR);
    const persisted = first.clock.highWater();
    expect(persisted.getTime()).toBeGreaterThanOrEqual(
      T0.getTime() + 20 * HOUR,
    );

    // The device restarts and its date is set back to before the first boot.
    const rebooted = rig(persisted, new Date(T0.getTime() - 72 * HOUR));
    expect(rebooted.clock.now().getTime()).toBeGreaterThanOrEqual(
      persisted.getTime(),
    );
    // And it keeps moving forward from there.
    rebooted.tick(5 * HOUR);
    expect(rebooted.clock.now().getTime()).toBeGreaterThanOrEqual(
      persisted.getTime() + 5 * HOUR,
    );
  });

  it("across a restart with a correct wall clock: the wall clock wins when ahead of the high water", () => {
    const rebooted = rig(
      new Date(T0.getTime() - HOUR),
      new Date(T0.getTime() + 2 * HOUR),
    );
    expect(rebooted.clock.now()).toEqual(new Date(T0.getTime() + 2 * HOUR));
  });

  it("a null high water (first boot) just uses the wall clock", () => {
    expect(rig(null).clock.now()).toEqual(T0);
  });
});

describe("legend-10nex high water", () => {
  it("is never behind now() and never goes back", () => {
    const { clock, tick, setWall } = rig();
    tick(3 * HOUR);
    const hw1 = clock.highWater();
    expect(hw1.getTime()).toBeGreaterThanOrEqual(clock.now().getTime());
    setWall(new Date(T0.getTime() - 100 * HOUR));
    expect(clock.highWater().getTime()).toBeGreaterThanOrEqual(hw1.getTime());
    tick(HOUR);
    expect(clock.highWater().getTime()).toBeGreaterThanOrEqual(
      hw1.getTime() + HOUR,
    );
  });
});

// F3 (architect): a persisted high water well ahead of the wall clock means the
// device date was set back across a restart. The clock reports `regressed`.
// Assumption: `regressed` is a boolean property or a no-argument method (both
// are read); it is true when persistedHighWater is more than 5 minutes ahead of
// the wall clock, and clears once the wall clock is no longer behind it.
describe("legend-10nex clock regression is reported", () => {
  const regressedOf = (clock: unknown): boolean => {
    const value = (clock as { regressed: boolean | (() => boolean) }).regressed;
    return typeof value === "function" ? value() : value;
  };

  it("is false on a normal first boot and when the stored high water is behind the wall", () => {
    expect(regressedOf(rig(null).clock)).toBe(false);
    expect(regressedOf(rig(new Date(T0.getTime() - 2 * HOUR)).clock)).toBe(
      false,
    );
  });

  it("is true when the high water is one day ahead of the wall clock", () => {
    const { clock } = rig(new Date(T0.getTime() + 24 * HOUR));
    expect(regressedOf(clock)).toBe(true);
    // Time itself still never goes back.
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(
      T0.getTime() + 24 * HOUR,
    );
  });

  it("tolerates a wall clock less than 5 minutes behind the high water", () => {
    expect(regressedOf(rig(new Date(T0.getTime() + 4 * 60_000)).clock)).toBe(
      false,
    );
  });

  it("flags a wall clock more than 5 minutes behind the high water", () => {
    expect(regressedOf(rig(new Date(T0.getTime() + 6 * 60_000)).clock)).toBe(
      true,
    );
  });

  it("clears after the wall clock catches up with the trusted time", () => {
    const { clock, setWall, tick } = rig(new Date(T0.getTime() + 24 * HOUR));
    tick(HOUR);
    expect(regressedOf(clock)).toBe(true);
    setWall(new Date(clock.now().getTime() + 1000)); // date corrected
    expect(regressedOf(clock)).toBe(false);
  });
});

// Round 2 (legend-10nex): the local database can be down at boot, so the
// persisted high water arrives late through `adoptHighWater`.
// Assumption: adopting behaves like having booted with that high water, except
// that it never lowers anything already returned.
describe("legend-10nex a late-adopted high water", () => {
  const regressedOf = (clock: { regressed(): boolean }) => clock.regressed();

  it("never lowers now() or the high water", () => {
    const { clock, tick } = rig();
    tick(10 * HOUR);
    const before = clock.now().getTime();
    const highBefore = clock.highWater().getTime();
    clock.adoptHighWater(new Date(T0.getTime() - 50 * HOUR));
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(before);
    expect(clock.highWater().getTime()).toBeGreaterThanOrEqual(highBefore);
    expect(regressedOf(clock)).toBe(false);
  });

  it("raises now() when the stored high water is later, and keeps counting from it", () => {
    const { clock, tick } = rig();
    clock.adoptHighWater(new Date(T0.getTime() + 10 * HOUR));
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(
      T0.getTime() + 10 * HOUR,
    );
    expect(clock.highWater().getTime()).toBeGreaterThanOrEqual(
      T0.getTime() + 10 * HOUR,
    );
    const afterAdopt = clock.now().getTime();
    tick(HOUR);
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(afterAdopt + HOUR);
  });

  it("reports regressed when the wall clock is more than 5 minutes behind it", () => {
    const { clock } = rig();
    clock.adoptHighWater(new Date(T0.getTime() + 6 * 60_000));
    expect(regressedOf(clock)).toBe(true);
  });

  it("tolerates a wall clock less than 5 minutes behind it", () => {
    const { clock } = rig();
    clock.adoptHighWater(new Date(T0.getTime() + 4 * 60_000));
    expect(regressedOf(clock)).toBe(false);
  });

  it("clears the regression once the wall clock catches up", () => {
    const { clock, setWall } = rig();
    clock.adoptHighWater(new Date(T0.getTime() + 24 * HOUR));
    expect(regressedOf(clock)).toBe(true);
    setWall(new Date(clock.now().getTime() + 1000));
    expect(regressedOf(clock)).toBe(false);
  });
});

// Codex 520/521: advancing the wall clock must also advance the monotonic
// anchor, otherwise an override can outlive its real-time duration.
describe("521 trusted clock after a forward jump", () => {
  it("expires a four-hour override after four real hours when a 48-hour jump is reverted", () => {
    const { clock, tick, setWall } = rig();
    setWall(new Date(T0.getTime() + 48 * HOUR));
    const grantedAt = clock.now();
    const untilAt = new Date(grantedAt.getTime() + 4 * HOUR);

    setWall(T0);
    tick(4 * HOUR - 1);
    expect(clock.now().getTime()).toBe(untilAt.getTime() - 1);
    tick(1);
    expect(clock.now().getTime()).toBe(untilAt.getTime());
  });

  it("reanchors each later wall-clock increase rather than only the first one", () => {
    const { clock, tick, setWall } = rig();
    setWall(new Date(T0.getTime() + 48 * HOUR));
    clock.now();
    tick(HOUR);
    setWall(new Date(T0.getTime() + 72 * HOUR));
    const raisedAgain = clock.highWater().getTime();
    setWall(T0);
    tick(HOUR);
    expect(clock.now().getTime()).toBe(raisedAgain + HOUR);
  });
});

// The persisted high water only proves a lower bound: at an offline reboot
// with the wall clock reset to that value, powered-off elapsed time is unknown.
describe("521 trusted clock reports unproven offline elapsed time", () => {
  const elapsedTimeUnproven = (clock: unknown) =>
    (clock as { elapsedTimeUnproven(): boolean }).elapsedTimeUnproven();

  it("does not treat a reboot at the persisted high water as proof of elapsed time", () => {
    const beforeShutdown = rig();
    beforeShutdown.tick(HOUR);
    const persisted = beforeShutdown.clock.highWater();
    // The terminal was off for days, then its date was restored to this stamp.
    const rebooted = rig(persisted, persisted);
    expect(elapsedTimeUnproven(rebooted.clock)).toBe(true);
    expect(rebooted.clock.regressed()).toBe(false);
    rebooted.tick(4 * HOUR);
    // A running monotonic clock cannot prove the time spent powered off.
    expect(elapsedTimeUnproven(rebooted.clock)).toBe(true);
  });

  it("does not invent an unproven reboot without a persisted high water", () => {
    expect(elapsedTimeUnproven(rig().clock)).toBe(false);
  });

  it("accepts elapsed time when the boot wall clock is well ahead of high water", () => {
    const rebooted = rig(T0, new Date(T0.getTime() + HOUR));
    expect(elapsedTimeUnproven(rebooted.clock)).toBe(false);
  });

  it("also recognizes missing powered-off time when the high water loads late", () => {
    const { clock, tick } = rig();
    tick(HOUR);
    clock.adoptHighWater(T0);
    expect(elapsedTimeUnproven(clock)).toBe(true);
  });
});

// 533 A2: the cloud's HTTP `Date` header (seen on the link upgrade) can prove
// the device clock after an offline restart. Expected API:
//   clock.proveWithServerTime(serverTime: Date): void   (return value unused here)
// Assumptions: it clears `elapsedTimeUnproven()` only when the server time is at
// or after the boot high water AND within the 5 minute clock tolerance of the
// current wall clock. It never touches `regressed()` (founder Q69 pending), and
// never changes now() or highWater().
describe("533 A2 trusted clock is proven by the cloud's server time", () => {
  const MIN5 = 5 * 60_000;
  const api = (clock: unknown) =>
    clock as {
      elapsedTimeUnproven(): boolean;
      regressed(): boolean;
      proveWithServerTime(serverTime: Date): unknown;
    };
  // A terminal that was off for days and booted with its date at the stamp.
  const unprovenBoot = () => {
    const persisted = new Date(T0.getTime() + HOUR);
    const r = rig(persisted, persisted);
    expect(api(r.clock).elapsedTimeUnproven()).toBe(true);
    return { ...r, persisted };
  };

  it("clears the unproven flag when the server time agrees with the wall clock", () => {
    const { clock, tick, persisted } = unprovenBoot();
    tick(2 * 60_000);
    api(clock).proveWithServerTime(new Date(persisted.getTime() + 2 * 60_000));
    expect(api(clock).elapsedTimeUnproven()).toBe(false);
    // And it stays proven while time passes.
    tick(6 * HOUR);
    expect(api(clock).elapsedTimeUnproven()).toBe(false);
  });

  it("accepts a server time within the 5 minute tolerance of the wall clock", () => {
    const { clock, persisted } = unprovenBoot();
    api(clock).proveWithServerTime(new Date(persisted.getTime() + MIN5 - 1000));
    expect(api(clock).elapsedTimeUnproven()).toBe(false);
  });

  it("does not clear it when the server time is more than 5 minutes from the wall clock", () => {
    const { clock, persisted } = unprovenBoot();
    api(clock).proveWithServerTime(new Date(persisted.getTime() + MIN5 + 1000));
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
  });

  it("does not clear it when the server time is behind the boot high water", () => {
    const { clock, setWall, persisted } = unprovenBoot();
    // A wall clock nudged back by 1 minute agrees with a server time that is
    // still earlier than anything the device saw before shutdown.
    const behind = new Date(persisted.getTime() - 60_000);
    setWall(behind);
    api(clock).proveWithServerTime(behind);
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
  });

  it("ignores an invalid server time", () => {
    const { clock } = unprovenBoot();
    api(clock).proveWithServerTime(new Date(Number.NaN));
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
  });

  it("proves a late-adopted high water too", () => {
    const { clock, tick } = rig();
    tick(HOUR);
    clock.adoptHighWater(T0);
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
    api(clock).proveWithServerTime(new Date(T0.getTime() + HOUR));
    expect(api(clock).elapsedTimeUnproven()).toBe(false);
  });

  it("changes neither now() nor the high water", () => {
    const { clock, tick, persisted } = unprovenBoot();
    tick(60_000);
    const now = clock.now().getTime();
    const high = clock.highWater().getTime();
    api(clock).proveWithServerTime(new Date(persisted.getTime() + 60_000));
    expect(clock.now().getTime()).toBe(now);
    expect(clock.highWater().getTime()).toBe(high);
  });

  it("does not clear a clock regression (A6 stays as is)", () => {
    // The device date was set back a day: the server agrees with the wrong wall
    // clock but is behind the persisted high water.
    const { clock } = rig(new Date(T0.getTime() + 24 * HOUR));
    expect(api(clock).regressed()).toBe(true);
    api(clock).proveWithServerTime(T0);
    expect(api(clock).regressed()).toBe(true);
  });
});
