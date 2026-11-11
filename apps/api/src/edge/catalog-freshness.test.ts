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

function setup() {
  let clock = T0.getTime();
  const onOwnerAlarm = vi.fn();
  const freshness = createCatalogFreshness({
    now: () => new Date(clock),
    timeZone: "Asia/Jakarta",
    onOwnerAlarm,
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
