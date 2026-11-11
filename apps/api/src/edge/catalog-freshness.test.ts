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
//        ownerAlarm: boolean,         // stale > 30 min AND cloud reachable
//        cashierWarning: string | null,   // "katalog belum diperbarui sejak HH:MM"
//        salesBlocked: false,         // founder decision: never blocks, no setting
//     }
//
// Assumptions (the brief is silent), each easy to change:
//  - "online but sync failing" = recordFailure with cloudReachable true;
//    "offline" = cloudReachable false (cloud not reachable at all).
//  - Founder decision (coordinator): a stale catalog ALWAYS keeps selling, with
//    a cashier warning and an owner notification after 30 minutes. Sales are
//    never blocked and there is no per-tenant setting, so the API has no
//    sellPolicy option; `salesBlocked` is a constant false.
//  - Age counts from lastSuccessAt of the oldest critical stream; the alarm
//    needs age strictly greater than 30 minutes.
//  - The cashier warning shows whenever a critical stream failed since its last
//    success (offline included, the prices on screen are old either way). Only
//    the OWNER ALARM is suppressed offline.
//  - HH:MM is shown in the configured time zone (tests use Asia/Jakarta, UTC+7).
//  - The owner alarm sink fires once per stale episode, not on every failure.
//  - Streams outside CRITICAL_CATALOG_STREAMS (e.g. "stations") never stale or alarm.
import { describe, expect, it, vi } from "vitest";
import {
  CRITICAL_CATALOG_STREAMS,
  createCatalogFreshness,
} from "./catalog-freshness.ts";

const MIN = 60_000;
const T0 = new Date("2026-11-11T03:05:00.000Z"); // 10:05 in Asia/Jakarta
const [STREAM_A, STREAM_B] = CRITICAL_CATALOG_STREAMS as readonly string[];
const NON_CRITICAL = "stations";

// The age rules below are tested with `failurePersistMs: 0` (a reachable
// failure alarms at once when the age is over 30 minutes). The persistence
// rule (legend-10nex round 2, finding 1) has its own tests that use the default.
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

  it("shows the cashier warning with the last success time, no owner alarm yet at 30 minutes or less", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
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

  it("raises the owner alarm once stale for more than 30 minutes, with stream and reason", () => {
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

  it("a stream that never succeeded and keeps failing online is also stale and alarms after 30 minutes", () => {
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

describe("legend-10nex stale catalog never blocks sales", () => {
  it("keeps selling while stale offline (warning only)", () => {
    const { freshness, advance } = setup();
    freshness.recordSuccess(STREAM_A!);
    freshness.recordSuccess(STREAM_B!);
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
    "%s stale over 30 minutes alarms the owner; its failure shows in the snapshot",
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

  it("a fresh checkpoint gives no alarm for a first failure", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
    freshness.seedLastSuccess(STREAM_A!, T0);
    advance(10 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    expect(freshness.snapshot().ownerAlarm).toBe(false);
    expect(onOwnerAlarm).not.toHaveBeenCalled();
  });

  it("a new edge (no checkpoint) counts from its first failure: no false alarm", () => {
    const { freshness, advance, onOwnerAlarm } = setup();
    // Nothing seeded: first boot of the node.
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    advance(10 * MIN);
    freshness.recordFailure(STREAM_A!, {
      reason: "HTTP 500",
      cloudReachable: true,
    });
    const snap = freshness.snapshot();
    expect(snap.ownerAlarm).toBe(false);
    expect(snap.streams[STREAM_A!]?.lastSuccessAt).toBeNull();
    expect(onOwnerAlarm).not.toHaveBeenCalled();
    advance(21 * MIN);
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
