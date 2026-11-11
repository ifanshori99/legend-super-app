// Catalog freshness, 24-hour sales hold and owner alarm (bead legend-10nex,
// founder Q57). Unit tests: clocks and alarm sink are injected; nothing touches
// the network or the database. Written from the design contract
// (createCatalogFreshness options `clock`, `trackingStartedAt`, `blockAfterMs`;
// snapshot `salesGate` and derived `salesBlocked`), not from the implementation.
//
// Policy under test:
//  - any critical stream with (trustedNow - lastSuccess) > 24 h blocks sales,
//    even when no failure was recorded (dead loop, restart lost failure state);
//    exactly 24 h is NOT blocked;
//  - a stream that never succeeded counts from `trackingStartedAt`;
//  - offline does not relax the rule;
//  - the wall clock moving backwards (running, or across a restart through the
//    persisted high water) cannot reduce the age;
//  - the owner alarm fires 5 minutes after a reachable-cloud failure with NO
//    extra "older than 30 minutes" condition.
//
// Assumptions (the contract is silent):
//  - `salesBlocked` and `salesGate.stale24h` are both true when the age rule
//    hits (the override is applied elsewhere, in sales-gate.ts).
//  - `salesGate.staleStreams` lists the offending stream names, and
//    `salesGate.staleSince` is the oldest lastSuccess (or trackingStartedAt).
import { describe, expect, it, vi } from "vitest";
import {
  CRITICAL_CATALOG_STREAMS,
  createCatalogFreshness,
} from "./catalog-freshness.ts";
import { createTrustedClock } from "./trusted-clock.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date("2026-11-11T03:05:00.000Z");
const STREAMS = [...CRITICAL_CATALOG_STREAMS] as string[];
const [STREAM_A, STREAM_B] = STREAMS as [string, string];

function setup(options: { trackingStartedAt?: Date } = {}) {
  let clock = T0.getTime();
  const onOwnerAlarm = vi.fn();
  const freshness = createCatalogFreshness({
    clock: { now: () => new Date(clock) },
    timeZone: "Asia/Jakarta",
    onOwnerAlarm,
    ...(options.trackingStartedAt
      ? { trackingStartedAt: options.trackingStartedAt }
      : {}),
  });
  return {
    freshness,
    onOwnerAlarm,
    advance: (ms: number) => {
      clock += ms;
    },
    nowMs: () => clock,
  };
}

const succeedAll = (freshness: ReturnType<typeof setup>["freshness"]) => {
  for (const name of STREAMS) freshness.recordSuccess(name);
};

describe("legend-10nex sales are held after more than 24 hours without a sync", () => {
  it("does not block at exactly 24 hours, blocks one millisecond later", () => {
    const { freshness, advance } = setup();
    succeedAll(freshness);

    advance(DAY);
    let snap = freshness.snapshot();
    expect(snap.salesGate.stale24h).toBe(false);
    expect(snap.salesBlocked).toBe(false);

    advance(1);
    snap = freshness.snapshot();
    expect(snap.salesGate.stale24h).toBe(true);
    expect(snap.salesBlocked).toBe(true);
    expect(snap.salesGate.staleStreams.sort()).toEqual([...STREAMS].sort());
    expect(snap.salesGate.staleSince).toEqual(T0);
  });

  it("does not block at 23h59m even with a recorded failure (the warning stays, sales keep going)", () => {
    const { freshness, advance } = setup();
    succeedAll(freshness);
    advance(DAY - MIN);
    freshness.recordFailure(STREAM_A, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.stale).toBe(true);
    expect(snap.cashierWarning).not.toBeNull();
    expect(snap.salesBlocked).toBe(false);
  });

  it("blocks when only ONE critical stream is older than 24 hours", () => {
    const { freshness, advance } = setup();
    succeedAll(freshness);
    advance(DAY - MIN);
    for (const name of STREAMS)
      if (name !== STREAM_B) freshness.recordSuccess(name);
    advance(2 * MIN); // STREAM_B is now 24h01m old, the rest 2 minutes
    const snap = freshness.snapshot();
    expect(snap.salesBlocked).toBe(true);
    expect(snap.salesGate.staleStreams).toEqual([STREAM_B]);
    expect(snap.salesGate.staleSince).toEqual(T0);
  });

  it("blocks without any recorded failure (a dead sync loop is also caught)", () => {
    const { freshness, advance } = setup();
    succeedAll(freshness);
    advance(DAY + HOUR);
    const snap = freshness.snapshot();
    expect(snap.stale).toBe(false); // nothing failed, nothing was tried
    expect(snap.salesBlocked).toBe(true);
  });

  it("applies offline too: failures with the cloud unreachable still block after 24 hours", () => {
    const { freshness, advance } = setup();
    succeedAll(freshness);
    for (let n = 0; n < 5; n += 1) {
      advance(5 * HOUR);
      freshness.recordFailure(STREAM_A, {
        reason: "fetch failed",
        cloudReachable: false,
      });
    }
    const snap = freshness.snapshot();
    expect(snap.salesBlocked).toBe(true);
    expect(snap.ownerAlarm).toBe(false); // offline cannot reach the owner
  });

  it("ignores failures of non-critical streams for the sales hold", () => {
    const { freshness, advance } = setup();
    succeedAll(freshness);
    advance(2 * HOUR);
    freshness.recordFailure("stations", {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.salesBlocked).toBe(false);
    expect(snap.salesGate.staleStreams).toEqual([]);
  });
});

describe("legend-10nex a successful sync of every critical stream ends the hold", () => {
  it("one fresh stream is not enough, all of them are", () => {
    const { freshness, advance } = setup();
    succeedAll(freshness);
    advance(DAY + HOUR);
    expect(freshness.snapshot().salesBlocked).toBe(true);

    freshness.recordSuccess(STREAM_A);
    expect(freshness.snapshot().salesBlocked).toBe(true);

    for (const name of STREAMS) freshness.recordSuccess(name);
    const snap = freshness.snapshot();
    expect(snap.salesBlocked).toBe(false);
    expect(snap.salesGate.stale24h).toBe(false);
    expect(snap.salesGate.staleStreams).toEqual([]);
    expect(snap.salesGate.staleSince).toBeNull();
  });

  it("the 24 hours restart from the new success", () => {
    const { freshness, advance } = setup();
    succeedAll(freshness);
    advance(DAY + HOUR);
    succeedAll(freshness);
    advance(DAY);
    expect(freshness.snapshot().salesBlocked).toBe(false);
    advance(1);
    expect(freshness.snapshot().salesBlocked).toBe(true);
  });
});

describe("legend-10nex a stream that never succeeded counts from trackingStartedAt", () => {
  it("a new edge is not blocked at once, but is after 24 hours", () => {
    const started = new Date(T0.getTime() - 2 * HOUR);
    const { freshness, advance } = setup({ trackingStartedAt: started });
    // Nothing ever synced: no success, no failure.
    expect(freshness.snapshot().salesBlocked).toBe(false);

    advance(22 * HOUR); // exactly 24h since tracking started
    expect(freshness.snapshot().salesBlocked).toBe(false);
    advance(1);
    const snap = freshness.snapshot();
    expect(snap.salesBlocked).toBe(true);
    expect(snap.salesGate.staleSince).toEqual(started);
    expect(snap.salesGate.staleStreams.sort()).toEqual([...STREAMS].sort());
  });

  it("only the never-synced stream is blamed when the others are fresh", () => {
    const started = new Date(T0.getTime() - 30 * HOUR);
    const { freshness } = setup({ trackingStartedAt: started });
    for (const name of STREAMS)
      if (name !== STREAM_A) freshness.recordSuccess(name);
    const snap = freshness.snapshot();
    expect(snap.salesBlocked).toBe(true);
    expect(snap.salesGate.staleStreams).toEqual([STREAM_A]);
    expect(snap.salesGate.staleSince).toEqual(started);
  });
});

describe("legend-10nex wall clock moved backwards cannot evade the hold", () => {
  function trustedRig(persistedHighWater: Date | null = null, wallAtBoot = T0) {
    let wall = wallAtBoot.getTime();
    let mono = 5_000;
    const trusted = createTrustedClock({
      wall: () => new Date(wall),
      mono: () => mono,
      persistedHighWater,
    });
    const freshness = createCatalogFreshness({
      clock: trusted,
      timeZone: "Asia/Jakarta",
    });
    return {
      freshness,
      trusted,
      tick: (ms: number) => {
        wall += ms;
        mono += ms;
      },
      setWall: (date: Date) => {
        wall = date.getTime();
      },
    };
  }

  it("while running: setting the date back to the last sync does not reset the age", () => {
    const { freshness, tick, setWall } = trustedRig();
    succeedAll(freshness);
    tick(DAY + HOUR);
    expect(freshness.snapshot().salesBlocked).toBe(true);

    // Cashier "fixes" it by moving the date back to just after the last sync.
    setWall(new Date(T0.getTime() + MIN));
    const snap = freshness.snapshot();
    expect(snap.salesBlocked).toBe(true);
    expect(snap.salesGate.staleSince).toEqual(T0);
  });

  it("while running: the age keeps growing from real elapsed time under a frozen-back wall clock", () => {
    const { freshness, tick, setWall } = trustedRig();
    succeedAll(freshness);
    tick(20 * HOUR);
    setWall(T0); // back to the sync moment
    expect(freshness.snapshot().salesBlocked).toBe(false);
    tick(5 * HOUR); // 25 hours of real time, wall says 5 hours
    expect(freshness.snapshot().salesBlocked).toBe(true);
  });

  it("across a restart: the persisted high water keeps the age", () => {
    const first = trustedRig();
    succeedAll(first.freshness);
    first.tick(DAY + HOUR);
    const highWater = first.trusted.highWater();

    // New process; the device date was set back to the time of the last sync.
    // The last successes come back from the stored checkpoints.
    const second = trustedRig(highWater, new Date(T0.getTime() + MIN));
    for (const name of STREAMS) second.freshness.seedLastSuccess(name, T0);
    const snap = second.freshness.snapshot();
    expect(snap.salesBlocked).toBe(true);
    expect(snap.salesGate.staleSince).toEqual(T0);
  });

  it("the wall clock set forward is accepted (blocks earlier, never later)", () => {
    const { freshness, setWall } = trustedRig();
    succeedAll(freshness);
    setWall(new Date(T0.getTime() + DAY + MIN));
    expect(freshness.snapshot().salesBlocked).toBe(true);
  });
});

describe("legend-10nex owner alarm 'segera': 5 minutes after a reachable failure, no 30-minute age", () => {
  const fail = (freshness: ReturnType<typeof setup>["freshness"]) =>
    freshness.recordFailure(STREAM_A, {
      reason: "HTTP_500",
      cloudReachable: true,
    });

  it("alarms once the failure has lasted 5 minutes although the catalog is only 6 minutes old", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
    succeedAll(freshness);
    advance(MIN);
    fail(freshness);
    advance(4 * MIN);
    fail(freshness);
    // 4 minutes of failure: still quiet.
    expect(freshness.snapshot().ownerAlarm).toBe(false);
    expect(onOwnerAlarm).not.toHaveBeenCalled();

    advance(MIN);
    fail(freshness); // 5 minutes of failure, catalog age is 6 minutes
    const snap = freshness.snapshot();
    expect(snap.ownerAlarm).toBe(true);
    expect(snap.alarmStreams.map((entry) => entry.stream)).toEqual([STREAM_A]);
    expect(onOwnerAlarm).toHaveBeenCalledTimes(1);
    expect(onOwnerAlarm).toHaveBeenCalledWith(
      expect.objectContaining({ stream: STREAM_A, reason: "HTTP_500" }),
    );
  });

  it("a single failed tick, recovered on the next one, never alarms", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
    succeedAll(freshness);
    advance(MIN);
    fail(freshness);
    advance(MIN);
    freshness.recordSuccess(STREAM_A);
    advance(10 * MIN);
    expect(freshness.snapshot().ownerAlarm).toBe(false);
    expect(onOwnerAlarm).not.toHaveBeenCalled();
  });

  it("offline failures never alarm, however long", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
    succeedAll(freshness);
    for (let n = 0; n < 6; n += 1) {
      advance(10 * MIN);
      freshness.recordFailure(STREAM_A, {
        reason: "fetch failed",
        cloudReachable: false,
      });
    }
    expect(freshness.snapshot().ownerAlarm).toBe(false);
    expect(onOwnerAlarm).not.toHaveBeenCalled();
  });
});

describe("legend-10nex a last success in the future cannot hide a stale catalog", () => {
  const FUTURE = () => new Date(T0.getTime() + 3 * DAY);

  it("recordSuccess clamps `at` to the trusted now", () => {
    const { freshness, advance } = setup();
    for (const name of STREAMS) freshness.recordSuccess(name, FUTURE());
    const snap = freshness.snapshot();
    expect(snap.streams[STREAM_A]?.lastSuccessAt).toEqual(T0);
    expect(snap.streams[STREAM_A]?.ageMs).toBe(0);

    advance(DAY + MIN);
    const later = freshness.snapshot();
    expect(later.salesBlocked).toBe(true);
    expect(later.salesGate.staleSince).toEqual(T0);
  });

  it("seedLastSuccess clamps a stored future timestamp to the trusted now", () => {
    const { freshness, advance } = setup();
    for (const name of STREAMS) freshness.seedLastSuccess(name, FUTURE());
    const snap = freshness.snapshot();
    expect(snap.streams[STREAM_A]?.lastSuccessAt).toEqual(T0);
    expect(snap.streams[STREAM_A]?.ageMs).toBe(0);

    advance(DAY + MIN);
    expect(freshness.snapshot().salesBlocked).toBe(true);
  });

  it("an age is never negative, whatever was recorded", () => {
    const { freshness } = setup();
    freshness.recordSuccess(STREAM_A, FUTURE());
    freshness.seedLastSuccess(STREAM_B, FUTURE());
    const snap = freshness.snapshot();
    expect(snap.streams[STREAM_A]?.ageMs).toBeGreaterThanOrEqual(0);
    expect(snap.streams[STREAM_B]?.ageMs).toBeGreaterThanOrEqual(0);
  });
});
