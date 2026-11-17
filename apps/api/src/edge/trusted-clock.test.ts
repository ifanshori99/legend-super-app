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
// expected time (533b: boot wall clock + monotonic time since boot, see the
// "533b" block below; NOT the current wall clock). It never touches `regressed()` (founder Q69 pending), and
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

// 533b P2 (architect round 2): the proof compares the server time with where the
// clock should be if it kept real time since boot: bootWall + monotonic time
// elapsed since boot. It must NOT compare with the current wall clock, because
// a chrony/NTP step (or a hand edit) after boot would then "agree" with a
// server time that the device only adopted, proving nothing about the time spent
// powered off. Expected API is unchanged:
//   clock.proveWithServerTime(serverTime: Date): void
// Rules: proven iff |serverTime - (bootWall + monoElapsedSinceBoot)| <= 5 min
// (inclusive of 4m59s, exclusive of 5m01s) AND serverTime >= boot high water.
// bootWall is the wall clock at createTrustedClock (also for adoptHighWater:
// the clock's own boot, not the adoption time).
describe("533b trusted clock proof uses boot wall plus monotonic elapsed time", () => {
  const MIN5 = 5 * 60_000;
  const api = (clock: unknown) =>
    clock as {
      elapsedTimeUnproven(): boolean;
      regressed(): boolean;
      proveWithServerTime(serverTime: Date): unknown;
    };
  // Offline restart: the date is at the persisted stamp, so time is unproven.
  const unprovenBoot = () => {
    const persisted = new Date(T0.getTime() + HOUR);
    const r = rig(persisted, persisted);
    expect(api(r.clock).elapsedTimeUnproven()).toBe(true);
    return { ...r, persisted };
  };

  it("does not count a wall clock step after boot that the server time merely agrees with", () => {
    const { clock, tick, setWall, persisted } = unprovenBoot();
    tick(2 * 60_000);
    // chrony steps the wall clock three days ahead and the cloud says the same.
    const stepped = new Date(persisted.getTime() + 3 * 24 * HOUR);
    setWall(stepped);
    api(clock).proveWithServerTime(stepped);
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
  });

  it("does not count a small wall clock step either: agreement with the current wall is irrelevant", () => {
    const { clock, tick, setWall, persisted } = unprovenBoot();
    tick(60_000);
    // 10 minutes ahead of where boot wall + elapsed says it should be.
    const stepped = new Date(persisted.getTime() + 60_000 + 10 * 60_000);
    setWall(stepped);
    api(clock).proveWithServerTime(stepped);
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
  });

  it("proves when the server time matches boot wall plus monotonic elapsed, whatever the wall clock shows now", () => {
    const { clock, tick, setWall, persisted } = unprovenBoot();
    tick(30 * 60_000);
    // The date was set back 4 minutes after boot (inside the 5 minute
    // tolerance, so not a regression); real time kept running.
    setWall(new Date(persisted.getTime() + 26 * 60_000));
    api(clock).proveWithServerTime(new Date(persisted.getTime() + 30 * 60_000));
    expect(api(clock).elapsedTimeUnproven()).toBe(false);
  });

  it("measures elapsed time since boot: a server time equal to the boot wall is too old after 10 minutes", () => {
    const { clock, tick, persisted } = unprovenBoot();
    tick(10 * 60_000);
    api(clock).proveWithServerTime(persisted);
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
    api(clock).proveWithServerTime(new Date(persisted.getTime() + 10 * 60_000));
    expect(api(clock).elapsedTimeUnproven()).toBe(false);
  });

  it("applies the 5 minute tolerance around the expected time, on both sides", () => {
    const early = unprovenBoot();
    early.tick(20 * 60_000);
    api(early.clock).proveWithServerTime(
      new Date(early.persisted.getTime() + 20 * 60_000 + MIN5 + 1000),
    );
    expect(api(early.clock).elapsedTimeUnproven()).toBe(true);

    const late = unprovenBoot();
    late.tick(20 * 60_000);
    api(late.clock).proveWithServerTime(
      new Date(late.persisted.getTime() + 20 * 60_000 - MIN5 - 1000),
    );
    expect(api(late.clock).elapsedTimeUnproven()).toBe(true);

    const inside = unprovenBoot();
    inside.tick(20 * 60_000);
    api(inside.clock).proveWithServerTime(
      new Date(inside.persisted.getTime() + 20 * 60_000 - MIN5 + 1000),
    );
    expect(api(inside.clock).elapsedTimeUnproven()).toBe(false);
  });

  it("still requires the server time to be at or after the boot high water", () => {
    // Late-adopted high water 3 minutes ahead of the real time since boot: the
    // server time agrees with boot wall + elapsed (within 5 minutes) but is
    // behind the high water, so it proves nothing about the powered-off time.
    const { clock, tick } = rig();
    tick(HOUR);
    clock.adoptHighWater(new Date(T0.getTime() + HOUR + 3 * 60_000));
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
    api(clock).proveWithServerTime(new Date(T0.getTime() + HOUR));
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
  });

  it("does not let a failed attempt block a later valid proof", () => {
    const { clock, tick, setWall, persisted } = unprovenBoot();
    tick(5 * 60_000);
    const stepped = new Date(persisted.getTime() + 5 * 24 * HOUR);
    setWall(stepped);
    api(clock).proveWithServerTime(stepped);
    expect(api(clock).elapsedTimeUnproven()).toBe(true);
    api(clock).proveWithServerTime(new Date(persisted.getTime() + 5 * 60_000));
    expect(api(clock).elapsedTimeUnproven()).toBe(false);
  });
});

// 533c P1 (founder Q2): a wall clock set back WHILE the process runs must be
// detected, not only at boot. Expected behaviour (from the brief):
//   - wall more than 5 minutes behind (boot wall + monotonic elapsed) => regressed()
//     is true, now()/highWater() never go down, elapsedTimeUnproven() is true
//     (time spent with a wrong clock cannot be proven).
//   - it clears when the wall clock catches up with the trusted time.
//   - drift below 5 minutes and any forward jump never trigger it.
// Assumption: elapsedTimeUnproven() stays true after regressed() clears (only
// proveWithServerTime may clear it); wall-vs-expected is a strict "<" check, so
// the 5 minute boundary itself is not asserted.
describe("533c trusted clock detects a wall clock set back while running", () => {
  const MIN5 = 5 * 60_000;
  const unproven = (clock: unknown) =>
    (clock as { elapsedTimeUnproven(): boolean }).elapsedTimeUnproven();

  it("flags a regression one hour back after 1 s of monotonic time and never lowers now()", () => {
    const { clock, tick, setWall } = rig();
    expect(clock.regressed()).toBe(false);
    tick(1000);
    const before = clock.now().getTime();
    expect(before).toBe(T0.getTime() + 1000);
    setWall(new Date(T0.getTime() - HOUR));
    expect(clock.regressed()).toBe(true);
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(before);
    expect(clock.highWater().getTime()).toBeGreaterThanOrEqual(before);
    tick(1000);
    expect(clock.now().getTime()).toBe(before + 1000);
    expect(clock.regressed()).toBe(true);
  });

  it("detects it on the first read even if now() was never called in between", () => {
    const { clock, tick, setWall } = rig();
    tick(1000);
    setWall(new Date(T0.getTime() - HOUR));
    expect(clock.regressed()).toBe(true);
  });

  // The server time cannot tell a wall step from real time (it compares with
  // boot wall + monotonic), so it must not clear what a live regression set:
  // the owner alarm would vanish as soon as the cloud answers (533c review).
  it("a server time proof does not clear the unproven state a live regression set", () => {
    const { clock, tick, setWall } = rig();
    tick(1000);
    setWall(new Date(T0.getTime() - HOUR));
    (
      clock as unknown as { proveWithServerTime(d: Date): void }
    ).proveWithServerTime(new Date(T0.getTime() + 1000));
    expect(unproven(clock)).toBe(true);
    expect(clock.regressed()).toBe(true);
  });

  it("marks elapsed time as unproven", () => {
    const { clock, tick, setWall } = rig();
    expect(unproven(clock)).toBe(false);
    tick(1000);
    setWall(new Date(T0.getTime() - HOUR));
    expect(unproven(clock)).toBe(true);
  });

  it("clears once the wall clock catches up with the trusted time", () => {
    const { clock, tick, setWall } = rig();
    tick(1000);
    setWall(new Date(T0.getTime() - HOUR));
    expect(clock.regressed()).toBe(true);
    // Still behind the trusted time after 30 real minutes: still held.
    tick(30 * 60_000);
    expect(clock.regressed()).toBe(true);
    // The device date is corrected to the real time (and a little ahead).
    setWall(new Date(clock.now().getTime() + 1000));
    expect(clock.regressed()).toBe(false);
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(
      T0.getTime() + 1000 + 30 * 60_000,
    );
    expect(unproven(clock)).toBe(true);
  });

  it("does not trigger on drift under 5 minutes", () => {
    const { clock, tick, setWall } = rig();
    tick(1000);
    setWall(new Date(T0.getTime() + 1000 - (MIN5 - 1000)));
    expect(clock.regressed()).toBe(false);
    expect(unproven(clock)).toBe(false);
    tick(60_000);
    expect(clock.regressed()).toBe(false);
    expect(unproven(clock)).toBe(false);
  });

  it("does not trigger on a forward jump", () => {
    const { clock, tick, setWall } = rig();
    tick(1000);
    setWall(new Date(T0.getTime() + 30 * HOUR));
    expect(clock.regressed()).toBe(false);
    expect(unproven(clock)).toBe(false);
    expect(clock.now().getTime()).toBe(T0.getTime() + 30 * HOUR);
  });
});

// legend-4sesc: purgeSafeNow() = min(wall now, last cloud server time aged by
// the monotonic clock); null until the cloud was heard since boot. The server
// time is recorded on EVERY proveWithServerTime call, even a refused one.
describe("legend-4sesc purgeSafeNow", () => {
  it("is null until a server time was seen", () => {
    const { clock, tick } = rig();
    expect(clock.purgeSafeNow()).toBeNull();
    tick(HOUR);
    expect(clock.purgeSafeNow()).toBeNull();
  });

  it("ignores a non-finite server time", () => {
    const { clock } = rig();
    clock.proveWithServerTime(new Date(Number.NaN));
    expect(clock.purgeSafeNow()).toBeNull();
  });

  it("follows real time after a server time, aged by the monotonic clock", () => {
    const { clock, tick } = rig();
    clock.proveWithServerTime(T0);
    tick(HOUR);
    expect(clock.purgeSafeNow()).toEqual(new Date(T0.getTime() + HOUR));
  });

  it("is not moved by a wall clock set forward by 2+ years", () => {
    const { clock, tick, setWall } = rig();
    clock.proveWithServerTime(T0);
    tick(HOUR);
    setWall(new Date(T0.getTime() + 2 * 365 * 24 * HOUR));
    // The trusted clock accepts the step; the purge time does not.
    expect(clock.now().getTime()).toBeGreaterThan(
      T0.getTime() + 365 * 24 * HOUR,
    );
    expect(clock.purgeSafeNow()).toEqual(new Date(T0.getTime() + HOUR));
  });

  it("is lowered by a wall clock set back", () => {
    const { clock, tick, setWall } = rig();
    clock.proveWithServerTime(T0);
    tick(HOUR);
    setWall(new Date(T0.getTime() - 24 * HOUR));
    expect(clock.purgeSafeNow()).toEqual(new Date(T0.getTime() - 24 * HOUR));
  });

  it("records the server time even when the proof is refused or already given", () => {
    // Already proven (no persisted stamp): the proof returns early.
    const proven = rig();
    proven.clock.proveWithServerTime(T0);
    proven.tick(HOUR);
    proven.clock.proveWithServerTime(new Date(T0.getTime() + HOUR));
    proven.tick(HOUR);
    expect(proven.clock.purgeSafeNow()).toEqual(
      new Date(T0.getTime() + 2 * HOUR),
    );

    // Refused: server time behind the boot high water.
    const persisted = new Date(T0.getTime() + HOUR);
    const refused = rig(persisted, persisted);
    const behind = new Date(persisted.getTime() - HOUR);
    refused.clock.proveWithServerTime(behind);
    expect(refused.clock.elapsedTimeUnproven()).toBe(true);
    expect(refused.clock.purgeSafeNow()).toEqual(behind);

    // A wall step seen after boot: the proof is blocked for good, the time is not.
    const stepped = rig();
    stepped.tick(1000);
    stepped.setWall(new Date(T0.getTime() - HOUR));
    stepped.clock.proveWithServerTime(T0);
    expect(stepped.clock.purgeSafeNow()).toEqual(new Date(T0.getTime() - HOUR));
  });

  it("keeps the latest server time, not the highest", () => {
    const { clock, tick } = rig();
    clock.proveWithServerTime(new Date(T0.getTime() + HOUR));
    tick(1000);
    clock.proveWithServerTime(T0);
    expect(clock.purgeSafeNow()).toEqual(T0);
  });
});
