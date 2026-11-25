// Catalog freshness per critical stream (bead legend-10nex, brief
// docs/briefs/ecf-482.md card 1). Unit tests: clock and alarm sink are
// injected, nothing touches the network or the database.
// Written from the brief, not from the implementation. The module does not
// exist yet: names below are GUESSES, listed in docs/briefs/ecf-482-tests.md.
//
// Guessed API (new file ./catalog-freshness.ts):
//   CRITICAL_CATALOG_STREAMS: readonly string[]   (price + product status streams)
//   createCatalogFreshness({ now, timeZone?, staleAlarmAfterMs?, onOwnerAlarm? })
//     .recordSuccess(stream)
//     .recordFailure(stream, { reason, cloudReachable })
//     .snapshot() -> {
//        streams: Record<stream, { lastSuccessAt: Date | null, ageMs: number | null,
//                                  failureReason: string | null }>,
//        stale: boolean,              // a critical stream failed since its last success
//        ownerAlarm: boolean,         // reachable-cloud failure lasting 5 min (no age condition)
//        cashierWarning: string | null,   // "katalog belum diperbarui sejak HH:MM"
//        salesBlocked: boolean,       // founder Q57: true once a critical stream is >24 h
//     }                               // without a successful sync (see catalog-freshness-block.test.ts)
//
// Assumptions (the brief is silent), each easy to change:
//  - "online but sync failing" = recordFailure with cloudReachable true;
//    "offline" = cloudReachable false (cloud not reachable at all).
//  - Founder Q57 (replaces the earlier "never blocks" decision): a stale
//    catalog keeps selling with a cashier warning and an owner alarm as soon as
//    a reachable-cloud failure lasts 5 minutes (no 30-minute age condition any
//    more); only after MORE than 24 hours without a successful sync of a
//    critical stream are sales held (`salesBlocked`, covered in
//    catalog-freshness-block.test.ts). There is no per-tenant setting.
//  - Age counts from lastSuccessAt of the oldest critical stream.
//  - The cashier warning shows whenever a critical stream failed since its last
//    success (offline included, the prices on screen are old either way). Only
//    the OWNER ALARM is suppressed offline.
//  - HH:MM is shown in the configured time zone (tests use Asia/Jakarta, UTC+7).
//  - The owner alarm sink fires once per stale episode, not on every failure.
//  - Streams outside CRITICAL_CATALOG_STREAMS (e.g. "stations") never stale or alarm.
import { describe, expect, it, vi } from "vitest";
import { CATALOG_TAX_STREAMS } from "@starter/shared/edge";
import {
  CRITICAL_CATALOG_STREAMS,
  catalogStaleForHeartbeat,
  createCatalogFreshness,
} from "./catalog-freshness.ts";

const MIN = 60_000;
const T0 = new Date("2026-11-11T03:05:00.000Z"); // 10:05 in Asia/Jakarta
const [STREAM_A, STREAM_B] = CRITICAL_CATALOG_STREAMS as readonly string[];
const NON_CRITICAL = "stations";

// Most tests below use `failurePersistMs: 0` (a reachable failure alarms at
// once). The persistence rule (a failure must last 5 minutes) has its own tests
// that use the default.
function setup(options: { defaultPersistence?: boolean } = {}) {
  let clock = T0.getTime();
  const onOwnerAlarm = vi.fn();
  const freshness = createCatalogFreshness({
    now: () => new Date(clock),
    timeZone: "Asia/Jakarta",
    onOwnerAlarm,
    ...(options.defaultPersistence ? {} : { failurePersistMs: 0 }),
  });
  return {
    freshness,
    onOwnerAlarm,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("legend-10nex critical streams", () => {
  it("has at least two critical streams (price and product status)", () => {
    expect(CRITICAL_CATALOG_STREAMS.length).toBeGreaterThanOrEqual(2);
    expect(STREAM_A).toBeTruthy();
    expect(STREAM_B).toBeTruthy();
  });
});

describe("legend-10nex prolonged sync failure while online", () => {
  it("is fresh and quiet while everything succeeds", () => {
    const { freshness, advance } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    advance(5 * MIN);
    const snap = freshness.snapshot();
    expect(snap.stale).toBe(false);
    expect(snap.ownerAlarm).toBe(false);
    expect(snap.cashierWarning).toBeNull();
    expect(snap.streams[STREAM_A!]?.lastSuccessAt).toEqual(T0);
    expect(snap.streams[STREAM_A!]?.ageMs).toBe(5 * MIN);
  });

  it("records lastSuccessAt, age and the failure reason per stream", () => {
    const { freshness, advance } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    advance(10 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500 dari cloud",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.streams[STREAM_A!]).toMatchObject({
      lastSuccessAt: T0,
      ageMs: 10 * MIN,
      failureReason: "HTTP 500 dari cloud",
    });
    expect(snap.streams[STREAM_B!]?.failureReason).toBeNull();
  });

  it("shows the cashier warning with the last success time, no owner alarm on the first failed tick", () => {
    const { freshness, advance, onOwnerAlarm } = setup({
      defaultPersistence: true,
    });
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    advance(30 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.stale).toBe(true);
    expect(snap.cashierWarning).toBe("katalog belum diperbarui sejak 10:05");
    expect(snap.ownerAlarm).toBe(false);
    expect(onOwnerAlarm).not.toHaveBeenCalled();
  });

  it("raises the owner alarm once the failure persists, with stream and reason", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    advance(30 * MIN + 1000);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    expect(freshness.snapshot().ownerAlarm).toBe(true);
    expect(onOwnerAlarm).toHaveBeenCalledTimes(1);
    expect(onOwnerAlarm).toHaveBeenCalledWith(
      expect.objectContaining({ stream: STREAM_A, reason: "HTTP 500" }),
    );
    // Later failures of the same episode do not page the owner again.
    advance(5 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    expect(onOwnerAlarm).toHaveBeenCalledTimes(1);
  });

  it("a stream that never succeeded and keeps failing online is also stale and alarms", () => {
    const { freshness, advance } = setup();
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    advance(31 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.stale).toBe(true);
    expect(snap.ownerAlarm).toBe(true);
    expect(snap.streams[STREAM_A!]?.lastSuccessAt).toBeNull();
  });

  it("ignores failures of non-critical streams", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    advance(2 * 60 * MIN);
    freshness.recordFailure(NON_CRITICAL, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.stale).toBe(false);
    expect(snap.ownerAlarm).toBe(false);
    expect(snap.cashierWarning).toBeNull();
    expect(onOwnerAlarm).not.toHaveBeenCalled();
  });
});

describe("legend-10nex pure offline gives no false alarm", () => {
  it("warns the cashier but never alarms the owner while the cloud is unreachable", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    for (let n = 0; n < 8; n += 1) {
      advance(15 * MIN); // two hours offline in total
      freshness.recordFailure(STREAM_A!, {
        reason: "fetch failed",
        cloudReachable: false,
      });
      freshness.recordFailure(STREAM_B!, {
        reason: "fetch failed",
        cloudReachable: false,
      });
    }
    const snap = freshness.snapshot();
    expect(snap.ownerAlarm).toBe(false);
    expect(onOwnerAlarm).not.toHaveBeenCalled();
    expect(snap.cashierWarning).toBe("katalog belum diperbarui sejak 10:05");
  });
});

describe("legend-10nex recovery", () => {
  it("clears warning, alarm and failure reason after every critical stream succeeds again", () => {
    const { freshness, advance } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    advance(45 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    freshness.recordFailure(STREAM_B!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    expect(freshness.snapshot().ownerAlarm).toBe(true);

    freshness.recordSuccess(STREAM_A!);
    // One stream still failing: still stale, still alarming.
    let snap = freshness.snapshot();
    expect(snap.stale).toBe(true);
    expect(snap.ownerAlarm).toBe(true);

    freshness.recordSuccess(STREAM_B!);
    snap = freshness.snapshot();
    expect(snap.stale).toBe(false);
    expect(snap.ownerAlarm).toBe(false);
    expect(snap.cashierWarning).toBeNull();
    expect(snap.streams[STREAM_A!]?.failureReason).toBeNull();
    expect(snap.streams[STREAM_B!]?.failureReason).toBeNull();
    expect(snap.streams[STREAM_A!]?.ageMs).toBe(0);
  });

  it("a new stale episode after recovery alarms the owner again", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    advance(31 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    advance(31 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 503",
      cloudReachable: true,
    });
    expect(onOwnerAlarm).toHaveBeenCalledTimes(2);
  });
});

describe("legend-10nex a stale catalog keeps selling until 24 hours (founder Q57)", () => {
  it("keeps selling while stale offline for 3 hours (warning only)", () => {
    const { freshness, advance } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    for (const name of CATALOG_TAX_STREAMS) freshness.recordSuccess(name);
    advance(3 * 60 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "fetch failed",
      cloudReachable: false,
    });
    const snap = freshness.snapshot();
    expect(snap.stale).toBe(true);
    expect(snap.salesBlocked).toBe(false);
    expect(snap.cashierWarning).not.toBeNull();
  });

  it("keeps selling while stale online with the owner alarm raised", () => {
    const { freshness, advance } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
    for (const name of CATALOG_TAX_STREAMS) freshness.recordSuccess(name);
    advance(5 * 60 * MIN);
    freshness.recordFailure(STREAM_B!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.ownerAlarm).toBe(true);
    expect(snap.salesBlocked).toBe(false);
    expect(snap.cashierWarning).not.toBeNull();
  });

  it("holds sales once a critical stream is over 24 hours old, offline or online", () => {
    const { freshness, advance } = setup();
    for (const name of CRITICAL_CATALOG_STREAMS) freshness.recordSuccess(name);
    advance(24 * 60 * MIN + 1);
    freshness.recordFailure(STREAM_A!, {
      reason: "fetch failed",
      cloudReachable: false,
    });
    expect(freshness.snapshot().salesBlocked).toBe(true);
  });

  it("has no sell policy setting", () => {
    const { freshness } = setup();
    expect(freshness.snapshot()).not.toHaveProperty("sellPolicy");
  });
});

describe("legend-10nex variant and modifier prices are critical", () => {
  it("tracks item_variants and modifiers next to prices and product status", () => {
    expect(CRITICAL_CATALOG_STREAMS).toEqual(
      expect.arrayContaining([
        "price_lists",
        "menu_items",
        "item_variants",
        "modifiers",
      ]),
    );
  });

  it.each(["item_variants", "modifiers"])(
    "%s failing for a while alarms the owner; its failure shows in the snapshot",
    (stream) => {
      const { freshness, advance, onOwnerAlarm } = setup();
      for (const name of CRITICAL_CATALOG_STREAMS)
        freshness.recordSuccess(name);
      advance(30 * MIN + 1000);
      freshness.recordFailure(stream, {
        reason: "HTTP 500",
        cloudReachable: true,
      });
      const snap = freshness.snapshot();
      expect(snap.streams[stream]?.failureReason).toBe("HTTP 500");
      expect(snap.cashierWarning).toBe("katalog belum diperbarui sejak 10:05");
      expect(snap.alarmStreams.map((entry) => entry.stream)).toEqual([stream]);
      expect(onOwnerAlarm).toHaveBeenCalledTimes(1);
    },
  );

  it("is not fresh again until item_variants and modifiers succeed too", () => {
    const { freshness, advance } = setup();
    for (const name of CRITICAL_CATALOG_STREAMS) freshness.recordSuccess(name);
    advance(5 * MIN);
    for (const name of ["item_variants", "modifiers"])
      freshness.recordFailure(name, {
        reason: "HTTP 500",
        cloudReachable: true,
      });
    freshness.recordSuccess("price_lists");
    freshness.recordSuccess("menu_items");
    freshness.recordSuccess("item_variants");
    expect(freshness.snapshot().stale).toBe(true);
    freshness.recordSuccess("modifiers");
    expect(freshness.snapshot().stale).toBe(false);
  });
});

describe("legend-10nex restart keeps the last success from the checkpoint", () => {
  const OLD = new Date(T0.getTime() - 3 * 60 * MIN); // 07:05 Jakarta

  it("a stale catalog stays stale across a restart: alarm counts from the checkpoint", () => {
    const { freshness, onOwnerAlarm } = setup();
    for (const name of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(name, OLD);
    // Nothing failed yet: the seed alone says nothing is stale.
    expect(freshness.snapshot().stale).toBe(false);
    expect(freshness.snapshot().streams[STREAM_A!]?.ageMs).toBe(180 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.cashierWarning).toBe("katalog belum diperbarui sejak 07:05");
    expect(snap.ownerAlarm).toBe(true);
    expect(snap.alarmStreams[0]?.staleSince).toEqual(OLD);
    expect(onOwnerAlarm).toHaveBeenCalledTimes(1);
  });

  it("an offline restart warns the cashier but never alarms", () => {
    const { freshness, onOwnerAlarm } = setup();
    for (const name of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(name, OLD);
    freshness.recordFailure(STREAM_A!, {
      reason: "NETWORK",
      cloudReachable: false,
    });
    const snap = freshness.snapshot();
    expect(snap.cashierWarning).toBe("katalog belum diperbarui sejak 07:05");
    expect(snap.ownerAlarm).toBe(false);
    expect(onOwnerAlarm).not.toHaveBeenCalled();
  });

  it("a fresh checkpoint gives no alarm for a first failed tick", () => {
    const { freshness, advance, onOwnerAlarm } = setup({
      defaultPersistence: true,
    });
    freshness.seedLastSuccess(STREAM_A!, T0);
    advance(10 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    expect(freshness.snapshot().ownerAlarm).toBe(false);
    expect(onOwnerAlarm).not.toHaveBeenCalled();
  });

  it("a new edge (no checkpoint) alarms only after its failure lasted 5 minutes", () => {
    const { freshness, advance, onOwnerAlarm } = setup({
      defaultPersistence: true,
    });
    // Nothing seeded: first boot of the node.
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    advance(4 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.ownerAlarm).toBe(false);
    expect(snap.streams[STREAM_A!]?.lastSuccessAt).toBeNull();
    expect(onOwnerAlarm).not.toHaveBeenCalled();
    advance(MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    expect(freshness.snapshot().ownerAlarm).toBe(true);
  });

  it("never moves a newer success back, and ignores non-critical streams", () => {
    const { freshness } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.seedLastSuccess(STREAM_A!, OLD);
    expect(freshness.snapshot().streams[STREAM_A!]?.lastSuccessAt).toEqual(T0);
    freshness.seedLastSuccess(NON_CRITICAL, OLD);
    expect(freshness.snapshot().streams).not.toHaveProperty(NON_CRITICAL);
  });

  it("a seed that arrives after a first failure still dates the episode from the checkpoint", () => {
    const { freshness } = setup();
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    freshness.seedLastSuccess(STREAM_A!, OLD);
    const snap = freshness.snapshot();
    expect(snap.cashierWarning).toBe("katalog belum diperbarui sejak 07:05");
    expect(snap.ownerAlarm).toBe(true);
  });

  it("recovers after a restart once a pull succeeds", () => {
    const { freshness } = setup();
    for (const name of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(name, OLD);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    freshness.recordSuccess(STREAM_A!);
    const snap = freshness.snapshot();
    expect(snap.stale).toBe(false);
    expect(snap.ownerAlarm).toBe(false);
  });
});

describe("legend-10nex an alarm needs a failure that lasts, not one failed tick", () => {
  const OLD = new Date(T0.getTime() - 8 * 60 * MIN); // last night's checkpoint
  const fail = (freshness: ReturnType<typeof setup>["freshness"]) =>
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP_500",
      cloudReachable: true,
    });

  it("restart after a night and one failed tick: no alarm, the cashier still sees the warning", () => {
    const { freshness, onOwnerAlarm } = setup({ defaultPersistence: true });
    for (const name of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(name, OLD);
    fail(freshness);
    const snap = freshness.snapshot();
    expect(snap.stale).toBe(true);
    expect(snap.cashierWarning).toBe("katalog belum diperbarui sejak 02:05");
    expect(snap.ownerAlarm).toBe(false);
    expect(snap.alarmStreams).toEqual([]);
    expect(onOwnerAlarm).not.toHaveBeenCalled();
  });

  it("the next tick recovers: still no alarm and the warning clears", () => {
    const { freshness, advance, onOwnerAlarm } = setup({
      defaultPersistence: true,
    });
    for (const name of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(name, OLD);
    fail(freshness);
    advance(MIN);
    freshness.recordSuccess(STREAM_A!);
    expect(freshness.snapshot().stale).toBe(false);
    expect(onOwnerAlarm).not.toHaveBeenCalled();
  });

  it("a failure that lasts 5 minutes alarms (once, with the checkpoint as start)", () => {
    const { freshness, advance, onOwnerAlarm } = setup({
      defaultPersistence: true,
    });
    for (const name of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(name, OLD);
    fail(freshness);
    advance(4 * MIN);
    fail(freshness);
    expect(freshness.snapshot().ownerAlarm).toBe(false);
    advance(MIN);
    fail(freshness);
    const snap = freshness.snapshot();
    expect(snap.ownerAlarm).toBe(true);
    expect(snap.alarmStreams[0]?.staleSince).toEqual(OLD);
    expect(onOwnerAlarm).toHaveBeenCalledTimes(1);
  });

  it("offline time does not count as a lasting failure once the cloud answers again", () => {
    const { freshness, advance } = setup({ defaultPersistence: true });
    for (const name of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(name, OLD);
    for (let n = 0; n < 6; n += 1) {
      freshness.recordFailure(STREAM_A!, {
        reason: "NETWORK",
        cloudReachable: false,
      });
      advance(MIN);
    }
    fail(freshness); // first tick with the cloud reachable again
    expect(freshness.snapshot().ownerAlarm).toBe(false);
    advance(5 * MIN);
    fail(freshness);
    expect(freshness.snapshot().ownerAlarm).toBe(true);
  });
});

describe("legend-10nex recordSuccess uses the time the page was stored", () => {
  it("521 stamps a successful sync with trusted time after the wall clock goes back", () => {
    const trustedAt = new Date(T0.getTime() + 48 * 60 * MIN);
    const freshness = createCatalogFreshness({
      clock: { now: () => trustedAt },
      now: () => T0,
    });

    // The successful pull's wall timestamp is behind the trusted high water.
    // It is a fresh sync, so this must not immediately re-age it by two days.
    for (const stream of CRITICAL_CATALOG_STREAMS)
      freshness.recordSuccess(stream, T0);

    const snapshot = freshness.snapshot();
    for (const stream of CRITICAL_CATALOG_STREAMS)
      expect(snapshot.streams[stream]).toMatchObject({
        lastSuccessAt: trustedAt,
        ageMs: 0,
      });
    expect(snapshot.salesBlocked).toBe(false);
  });

  it("dates the last success from `at`, so staleSince matches the checkpoint after a restart", () => {
    const { freshness, advance } = setup();
    const stored = new Date(T0.getTime() - 2 * MIN);
    freshness.recordSuccess(STREAM_A!, stored);
    expect(freshness.snapshot().streams[STREAM_A!]?.lastSuccessAt).toEqual(
      stored,
    );
    advance(40 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP_500",
      cloudReachable: true,
    });
    expect(freshness.snapshot().alarmStreams[0]?.staleSince).toEqual(stored);
  });
});

describe("521 Q62 elapsed time cannot be proven after an offline restart", () => {
  function unprovenTracker(initiallyUnproven = true) {
    let at = T0.getTime();
    let unproven = initiallyUnproven;
    const onOwnerAlarm = vi.fn();
    const freshness = createCatalogFreshness({
      clock: {
        now: () => new Date(at),
        elapsedTimeUnproven: () => unproven,
      },
      onOwnerAlarm,
    });
    return {
      freshness,
      onOwnerAlarm,
      advance: (ms: number) => {
        at += ms;
      },
      markUnproven: () => {
        unproven = true;
      },
    };
  }

  it("warns and queues an owner alarm immediately, then blocks sales once the saved success is over 24 hours old even though elapsed time is unproven", () => {
    const { freshness, onOwnerAlarm, advance } = unprovenTracker();
    for (const stream of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(stream, T0);

    const snapshot = freshness.snapshot();
    expect(snapshot.stale).toBe(true);
    expect(snapshot.ownerAlarm).toBe(true);
    expect(snapshot.cashierWarning).toContain("waktu");
    expect(snapshot.salesBlocked).toBe(false);
    expect(catalogStaleForHeartbeat(snapshot)).toEqual(
      CRITICAL_CATALOG_STREAMS.map((stream) => ({
        stream,
        staleSince: T0.toISOString(),
        reason: "CLOCK_ELAPSED_UNPROVEN",
      })),
    );
    expect(onOwnerAlarm).toHaveBeenCalledTimes(1);

    advance(48 * 60 * MIN);
    freshness.recordFailure("price_lists", {
      reason: "NETWORK",
      cloudReachable: false,
    });
    // 533 A1 (money rule): the age counts from the live trusted clock, not from
    // a boot-time lower bound, so the outlet never sells on prices that are
    // really older than 24 hours.
    expect(freshness.snapshot().salesGate.stale24h).toBe(true);
    expect(freshness.snapshot().salesBlocked).toBe(true);
    expect(freshness.snapshot().ownerAlarm).toBe(true);
    expect(onOwnerAlarm).toHaveBeenCalledTimes(1);
  });

  it("533 A1 keeps counting after an offline restart: a catalog 20 hours stale at boot blocks sales 5 hours later", () => {
    const { freshness, advance } = unprovenTracker();
    // The saved checkpoint was 20 hours old when the terminal restarted offline.
    const savedSuccess = new Date(T0.getTime() - 20 * 60 * MIN);
    for (const stream of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(stream, savedSuccess);
    expect(freshness.snapshot().salesBlocked).toBe(false);

    advance(4 * 60 * MIN); // exactly 24 hours since the saved success
    expect(freshness.snapshot().salesGate.stale24h).toBe(false);
    expect(freshness.snapshot().salesBlocked).toBe(false);

    advance(60 * MIN); // 25 hours, clock still unproven, still offline
    freshness.recordFailure("price_lists", {
      reason: "NETWORK",
      cloudReachable: false,
    });
    const snapshot = freshness.snapshot();
    expect(snapshot.salesGate.stale24h).toBe(true);
    expect(snapshot.salesBlocked).toBe(true);
    expect(snapshot.salesGate.staleStreams).toContain("price_lists");

    // A live sync recovers the streams and lifts the block.
    for (const stream of CRITICAL_CATALOG_STREAMS)
      freshness.recordSuccess(stream);
    expect(freshness.snapshot().salesBlocked).toBe(false);
  });

  it("a checkpoint seed cannot prove elapsed time, but a live sync recovers each critical stream", () => {
    const { freshness } = unprovenTracker();
    for (const stream of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(stream, T0);
    freshness.recordSuccess("price_lists");
    expect(
      freshness.snapshot().alarmStreams.map((entry) => entry.stream),
    ).not.toContain("price_lists");
    expect(freshness.snapshot().stale).toBe(true);
    for (const stream of CRITICAL_CATALOG_STREAMS)
      freshness.recordSuccess(stream);
    expect(freshness.snapshot()).toMatchObject({
      stale: false,
      ownerAlarm: false,
      cashierWarning: null,
    });
    // The boot clock flag remains latched; recovered streams stay recovered.
    expect(freshness.snapshot().stale).toBe(false);
  });

  it("adopts uncertainty when the database high water arrives after provisional boot", () => {
    const { freshness, markUnproven, onOwnerAlarm } = unprovenTracker(false);
    for (const stream of CRITICAL_CATALOG_STREAMS)
      freshness.recordSuccess(stream);
    expect(freshness.snapshot().stale).toBe(false);
    markUnproven();
    freshness.adoptTrackingStartedAt(T0);
    expect(freshness.snapshot().stale).toBe(true);
    expect(freshness.snapshot().ownerAlarm).toBe(true);
    expect(onOwnerAlarm).toHaveBeenCalledTimes(1);
  });

  it("still blocks proven catalog data once it is older than 24 hours after a live recovery", () => {
    const { freshness, advance } = unprovenTracker();
    for (const stream of CRITICAL_CATALOG_STREAMS)
      freshness.recordSuccess(stream);
    advance(24 * 60 * MIN + 1);
    expect(freshness.snapshot().salesGate.stale24h).toBe(true);
  });

  it("preserves a proven 24-hour block when a saved success was already old at the persisted high water", () => {
    const alreadyOld = new Date(T0.getTime() - 48 * 60 * MIN);
    // Only the added downtime is unknown. The two days between the saved
    // success and the persisted high water were already observed before boot.
    const restarted = createCatalogFreshness({
      clock: { now: () => T0, elapsedTimeUnproven: () => true },
    });
    for (const stream of CRITICAL_CATALOG_STREAMS)
      restarted.seedLastSuccess(
        stream,
        stream === "price_lists" ? alreadyOld : T0,
      );
    expect(restarted.snapshot().salesGate).toMatchObject({
      stale24h: true,
      staleSince: alreadyOld,
      staleStreams: ["price_lists"],
    });
    expect(restarted.snapshot().salesBlocked).toBe(true);
  });

  it("keeps the queued uncertainty alarm identity stable when saved checkpoints load after boot", () => {
    const onOwnerAlarm = vi.fn();
    const freshness = createCatalogFreshness({
      clock: { now: () => T0, elapsedTimeUnproven: () => true },
      trackingStartedAt: new Date(T0.getTime() - 48 * 60 * MIN),
      onOwnerAlarm,
    });
    const queued = onOwnerAlarm.mock.calls[0]![0].streams.map(
      (entry: { stream: string; staleSince: Date; reason: string }) => ({
        stream: entry.stream,
        staleSince: entry.staleSince.toISOString(),
        reason: entry.reason,
      }),
    );
    for (const stream of CRITICAL_CATALOG_STREAMS)
      freshness.seedLastSuccess(stream, new Date(T0.getTime() - 60 * MIN));
    expect(catalogStaleForHeartbeat(freshness.snapshot())).toEqual(queued);
    expect(onOwnerAlarm).toHaveBeenCalledTimes(1);
  });

  it("queues distinct uncertainty alarms for two boots separated by live recovery even with the same saved tracking start", () => {
    const trackingStartedAt = new Date(T0.getTime() - 48 * 60 * MIN);
    const bootAndRecover = (bootAt: Date, checkpointAt: Date) => {
      let current = bootAt.getTime();
      const queued: ReturnType<typeof catalogStaleForHeartbeat>[] = [];
      const freshness = createCatalogFreshness({
        clock: {
          now: () => new Date(current),
          elapsedTimeUnproven: () => true,
        },
        trackingStartedAt,
        onOwnerAlarm: (alarm) => {
          queued.push(
            alarm.streams.map((entry) => ({
              stream: entry.stream,
              staleSince: entry.staleSince.toISOString(),
              reason: entry.reason,
            })),
          );
        },
      });
      expect(queued).toHaveLength(1);
      const bootAlarm = queued[0]!;
      for (const stream of CRITICAL_CATALOG_STREAMS)
        freshness.seedLastSuccess(stream, checkpointAt);
      expect(catalogStaleForHeartbeat(freshness.snapshot())).toEqual(bootAlarm);

      current += 30 * MIN;
      for (const stream of CRITICAL_CATALOG_STREAMS)
        freshness.recordFailure(stream, {
          reason: "NETWORK",
          cloudReachable: false,
        });
      expect(catalogStaleForHeartbeat(freshness.snapshot())).toEqual(bootAlarm);
      expect(queued).toHaveLength(1);

      // Internet returns and each stream succeeds before the next shutdown.
      for (const stream of CRITICAL_CATALOG_STREAMS)
        freshness.recordSuccess(stream);
      expect(freshness.snapshot().stale).toBe(false);
      expect(catalogStaleForHeartbeat(freshness.snapshot())).toEqual([]);
      expect(queued).toHaveLength(1);
      return { bootAlarm, lastSuccessAt: new Date(current) };
    };

    const first = bootAndRecover(T0, new Date(T0.getTime() - MIN));
    const nextBootAt = new Date(T0.getTime() + 6 * 60 * MIN);
    const second = bootAndRecover(nextBootAt, first.lastSuccessAt);

    expect(first.bootAlarm).toEqual(
      CRITICAL_CATALOG_STREAMS.map((stream) => ({
        stream,
        staleSince: T0.toISOString(),
        reason: "CLOCK_ELAPSED_UNPROVEN",
      })),
    );
    expect(second.bootAlarm).toEqual(
      CRITICAL_CATALOG_STREAMS.map((stream) => ({
        stream,
        staleSince: nextBootAt.toISOString(),
        reason: "CLOCK_ELAPSED_UNPROVEN",
      })),
    );
    const firstIds = first.bootAlarm.map(
      (entry) => `${entry.stream}:${entry.staleSince}:${entry.reason}`,
    );
    const secondIds = second.bootAlarm.map(
      (entry) => `${entry.stream}:${entry.staleSince}:${entry.reason}`,
    );
    for (const id of secondIds) expect(firstIds).not.toContain(id);
  });
});

// Round 2 (legend-10nex): the tracking start is persisted in the local
// database, which can be down at boot. `adoptTrackingStartedAt` applies it late.
// Assumption: a stream that never succeeded counts from the tracking start, so
// the 24 hour hold (`salesGate.stale24h`) shows whether the adopted date took.
describe("legend-10nex adoptTrackingStartedAt (late load of the stored start)", () => {
  const HOUR = 60 * MIN;
  const rigAdopt = () => {
    let clock = T0.getTime();
    const freshness = createCatalogFreshness({
      now: () => new Date(clock),
      timeZone: "Asia/Jakarta",
    });
    return {
      freshness,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };

  it("moves the start earlier, so a never-synced edge is held sooner", () => {
    const { freshness, advance } = rigAdopt();
    freshness.adoptTrackingStartedAt(new Date(T0.getTime() - 20 * HOUR));
    advance(4 * HOUR); // 24 h since the adopted start
    expect(freshness.snapshot().salesGate.stale24h).toBe(false);
    advance(1);
    expect(freshness.snapshot().salesGate.stale24h).toBe(true);
  });

  it("never moves the start later", () => {
    const { freshness, advance } = rigAdopt();
    freshness.adoptTrackingStartedAt(new Date(T0.getTime() + 10 * HOUR));
    advance(24 * HOUR + 1);
    // Still counted from the boot time T0, not from the later date.
    expect(freshness.snapshot().salesGate.stale24h).toBe(true);
  });

  it("an adopted start does not affect a stream that has synced", () => {
    const { freshness, advance } = rigAdopt();
    for (const name of CRITICAL_CATALOG_STREAMS as readonly string[])
      freshness.recordSuccess(name);
    freshness.adoptTrackingStartedAt(new Date(T0.getTime() - 100 * HOUR));
    advance(HOUR);
    expect(freshness.snapshot().salesGate.stale24h).toBe(false);
  });
});
