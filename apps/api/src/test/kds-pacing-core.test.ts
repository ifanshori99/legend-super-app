// Order pacing + ETA pure core (beads legend-gyc; PRD KDS-05). Unit tests, no
// database. Written from the sub-brief signatures, never from the service.
//
// Assumptions where the brief is silent:
// - `windowStartFor` floors on the epoch (not on local midnight).
// - `medianSeconds` with an even count returns the mean of the two middle
//   samples (samples here are chosen so the mean is an integer).
// - `decidePauses` keeps the input line order and the priority order of
//   channels (first channel dropped).
// - A window start is inclusive, its end is exclusive (same as withinWindows).
import { describe, expect, it } from "vitest";
import {
  FALLBACK_SERVICE_SECONDS,
  LONG_PREP_SECONDS,
  MIN_HISTORY_SAMPLES,
  channelRank,
  decidePauses,
  etaMinutes,
  etaRange,
  medianSeconds,
  pickActiveRule,
  queueAheadPoints,
  serviceSeconds,
  shouldAlert,
  stationDelayMinutes,
  windowStartFor,
  type PacingRule,
} from "../services/kds-pacing-core.ts";

const JAKARTA = "Asia/Jakarta"; // UTC+7, no DST: stable offsets in tests.

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const rule = (overrides: Partial<PacingRule> = {}): PacingRule => ({
  stationId: "station-1",
  windowMinutes: 30,
  capacityPoints: 60,
  nearCapacityBp: 8000,
  schedule: [{ daysOfWeek: ALL_DAYS, start: "00:00", end: "23:59" }],
  channelPriority: ["dine_in", "gofood"],
  ...overrides,
});

// 2026-11-09 is a Monday. Local time is Asia/Jakarta (UTC+7).
const mondayLocal = (hh: number, mm = 0) =>
  new Date(Date.UTC(2026, 10, 9, hh - 7, mm));
// 2026-11-13 is a Friday, 2026-11-14 a Saturday.
const fridayLocal = (hh: number, mm = 0) =>
  new Date(Date.UTC(2026, 10, 13, hh - 7, mm));
const saturdayLocal = (hh: number, mm = 0) =>
  new Date(Date.UTC(2026, 10, 14, hh - 7, mm));

describe("constants", () => {
  it("exposes the fixed pacing thresholds", () => {
    expect(LONG_PREP_SECONDS).toBe(600);
    expect(FALLBACK_SERVICE_SECONDS).toBe(600);
    expect(MIN_HISTORY_SAMPLES).toBe(5);
  });
});

describe("pickActiveRule", () => {
  it("returns null when there are no rules", () => {
    expect(pickActiveRule([], mondayLocal(10), JAKARTA)).toBeNull();
  });

  it("returns null when no rule schedule matches the outlet-local time", () => {
    const lunch = rule({
      schedule: [{ daysOfWeek: [1], start: "11:00", end: "14:00" }],
    });
    expect(pickActiveRule([lunch], mondayLocal(10, 59), JAKARTA)).toBeNull();
    expect(pickActiveRule([lunch], mondayLocal(14, 0), JAKARTA)).toBeNull();
  });

  it("returns null on a weekday the schedule does not list", () => {
    const mondayOnly = rule({
      schedule: [{ daysOfWeek: [1], start: "00:00", end: "23:59" }],
    });
    expect(
      pickActiveRule(
        [mondayOnly],
        new Date(Date.UTC(2026, 10, 10, 3)),
        JAKARTA,
      ),
    ).toBeNull();
  });

  it("matches inclusive of start and exclusive of end", () => {
    const lunch = rule({
      schedule: [{ daysOfWeek: [1], start: "11:00", end: "14:00" }],
    });
    expect(pickActiveRule([lunch], mondayLocal(11, 0), JAKARTA)).toBe(lunch);
    expect(pickActiveRule([lunch], mondayLocal(13, 59), JAKARTA)).toBe(lunch);
    expect(pickActiveRule([lunch], mondayLocal(14, 0), JAKARTA)).toBeNull();
  });

  it("evaluates the schedule in the outlet time zone, not UTC", () => {
    const lunch = rule({
      schedule: [{ daysOfWeek: [1], start: "11:00", end: "14:00" }],
    });
    // 04:30Z is 11:30 in Jakarta but 04:30 in UTC.
    const at = new Date(Date.UTC(2026, 10, 9, 4, 30));
    expect(pickActiveRule([lunch], at, JAKARTA)).toBe(lunch);
    expect(pickActiveRule([lunch], at, "UTC")).toBeNull();
  });

  it("uses the local weekday across the UTC date line", () => {
    const mondayOnly = rule({
      schedule: [{ daysOfWeek: [1], start: "00:00", end: "23:59" }],
    });
    // Sunday 20:00Z is Monday 03:00 in Jakarta.
    const at = new Date(Date.UTC(2026, 10, 8, 20, 0));
    expect(pickActiveRule([mondayOnly], at, JAKARTA)).toBe(mondayOnly);
    expect(pickActiveRule([mondayOnly], at, "UTC")).toBeNull();
  });

  it("matches when any one of several schedule entries matches", () => {
    const twoShifts = rule({
      schedule: [
        { daysOfWeek: [1], start: "07:00", end: "10:00" },
        { daysOfWeek: [1], start: "17:00", end: "21:00" },
      ],
    });
    expect(pickActiveRule([twoShifts], mondayLocal(8), JAKARTA)).toBe(
      twoShifts,
    );
    expect(pickActiveRule([twoShifts], mondayLocal(12), JAKARTA)).toBeNull();
    expect(pickActiveRule([twoShifts], mondayLocal(18), JAKARTA)).toBe(
      twoShifts,
    );
  });

  it("supports an overnight window that belongs to its start day", () => {
    const night = rule({
      schedule: [{ daysOfWeek: [5], start: "22:00", end: "02:00" }],
    });
    expect(pickActiveRule([night], fridayLocal(21, 59), JAKARTA)).toBeNull();
    expect(pickActiveRule([night], fridayLocal(22, 0), JAKARTA)).toBe(night);
    expect(pickActiveRule([night], fridayLocal(23, 30), JAKARTA)).toBe(night);
    // Saturday 01:00 is still inside Friday's window.
    expect(pickActiveRule([night], saturdayLocal(1, 0), JAKARTA)).toBe(night);
    expect(pickActiveRule([night], saturdayLocal(1, 59), JAKARTA)).toBe(night);
    // End is exclusive and Saturday is not a start day.
    expect(pickActiveRule([night], saturdayLocal(2, 0), JAKARTA)).toBeNull();
    expect(pickActiveRule([night], saturdayLocal(23, 0), JAKARTA)).toBeNull();
  });

  it("does not match the tail of an overnight window on the wrong day", () => {
    const night = rule({
      schedule: [{ daysOfWeek: [5], start: "22:00", end: "02:00" }],
    });
    // Monday 01:00 follows a Sunday start, which is not listed.
    expect(pickActiveRule([night], mondayLocal(1, 0), JAKARTA)).toBeNull();
  });

  it("picks the smallest windowMinutes when several rules match", () => {
    const wide = rule({ windowMinutes: 60, capacityPoints: 200 });
    const narrow = rule({ windowMinutes: 15, capacityPoints: 10 });
    const mid = rule({ windowMinutes: 30, capacityPoints: 500 });
    expect(pickActiveRule([wide, narrow, mid], mondayLocal(10), JAKARTA)).toBe(
      narrow,
    );
    expect(pickActiveRule([narrow, mid, wide], mondayLocal(10), JAKARTA)).toBe(
      narrow,
    );
  });

  it("breaks a windowMinutes tie with the highest capacityPoints", () => {
    const small = rule({ windowMinutes: 30, capacityPoints: 40 });
    const big = rule({ windowMinutes: 30, capacityPoints: 90 });
    expect(pickActiveRule([small, big], mondayLocal(10), JAKARTA)).toBe(big);
    expect(pickActiveRule([big, small], mondayLocal(10), JAKARTA)).toBe(big);
  });

  it("ignores a non-matching rule even when it would win on window size", () => {
    const outside = rule({
      windowMinutes: 5,
      schedule: [{ daysOfWeek: [1], start: "20:00", end: "22:00" }],
    });
    const inside = rule({ windowMinutes: 60 });
    expect(pickActiveRule([outside, inside], mondayLocal(10), JAKARTA)).toBe(
      inside,
    );
  });
});

describe("windowStartFor", () => {
  it("floors to the start of the window", () => {
    const at = new Date("2026-11-09T03:07:30.250Z");
    expect(windowStartFor(at, 15).toISOString()).toBe(
      "2026-11-09T03:00:00.000Z",
    );
    expect(windowStartFor(at, 30).toISOString()).toBe(
      "2026-11-09T03:00:00.000Z",
    );
    expect(windowStartFor(at, 60).toISOString()).toBe(
      "2026-11-09T03:00:00.000Z",
    );
    expect(
      windowStartFor(new Date("2026-11-09T03:20:00.000Z"), 15).toISOString(),
    ).toBe("2026-11-09T03:15:00.000Z");
  });

  it("returns the same instant when already on a window boundary", () => {
    const at = new Date("2026-11-09T03:30:00.000Z");
    expect(windowStartFor(at, 30).getTime()).toBe(at.getTime());
  });

  it("changes the window at the exact next boundary", () => {
    const justBefore = new Date("2026-11-09T03:29:59.999Z");
    const boundary = new Date("2026-11-09T03:30:00.000Z");
    expect(windowStartFor(justBefore, 30).toISOString()).toBe(
      "2026-11-09T03:00:00.000Z",
    );
    expect(windowStartFor(boundary, 30).toISOString()).toBe(
      "2026-11-09T03:30:00.000Z",
    );
  });

  it("floors to an epoch multiple of windowMinutes, not to the hour", () => {
    const windowMs = 45 * 60_000;
    const at = new Date("2026-11-09T03:07:30.000Z");
    const start = windowStartFor(at, 45);
    expect(start.getTime() % windowMs).toBe(0);
    expect(start.getTime()).toBe(
      Math.floor(at.getTime() / windowMs) * windowMs,
    );
    expect(start.getTime()).toBeLessThanOrEqual(at.getTime());
    expect(at.getTime() - start.getTime()).toBeLessThan(windowMs);
  });

  it("does not mutate its input", () => {
    const at = new Date("2026-11-09T03:07:30.000Z");
    const before = at.getTime();
    windowStartFor(at, 15);
    expect(at.getTime()).toBe(before);
  });
});

describe("channelRank", () => {
  it("is the index in the priority list", () => {
    const priority = ["dine_in", "gofood", "grabfood"];
    expect(channelRank("dine_in", priority)).toBe(0);
    expect(channelRank("gofood", priority)).toBe(1);
    expect(channelRank("grabfood", priority)).toBe(2);
  });

  it("ranks an unlisted channel last (rank = list length)", () => {
    expect(channelRank("shopeefood", ["dine_in", "gofood"])).toBe(2);
  });

  it("ranks every channel 0 for an empty list", () => {
    expect(channelRank("dine_in", [])).toBe(0);
  });
});

describe("queueAheadPoints", () => {
  const priority = ["dine_in", "gofood"];

  it("makes a lower-priority channel wait behind its own and higher channels", () => {
    const queue = [
      { channel: "dine_in", points: 5 },
      { channel: "gofood", points: 3 },
    ];
    expect(queueAheadPoints(queue, "gofood", priority)).toBe(8);
  });

  it("makes the top channel wait only behind itself", () => {
    const queue = [
      { channel: "dine_in", points: 5 },
      { channel: "gofood", points: 3 },
    ];
    expect(queueAheadPoints(queue, "dine_in", priority)).toBe(5);
  });

  it("sums several queue entries of the same channel", () => {
    const queue = [
      { channel: "dine_in", points: 2 },
      { channel: "dine_in", points: 4 },
      { channel: "gofood", points: 1 },
      { channel: "gofood", points: 6 },
    ];
    expect(queueAheadPoints(queue, "dine_in", priority)).toBe(6);
    expect(queueAheadPoints(queue, "gofood", priority)).toBe(13);
  });

  it("does not count lower-priority or unlisted queue items for a listed channel", () => {
    const queue = [
      { channel: "dine_in", points: 5 },
      { channel: "gofood", points: 3 },
      { channel: "shopeefood", points: 9 },
    ];
    expect(queueAheadPoints(queue, "gofood", priority)).toBe(8);
    expect(queueAheadPoints(queue, "dine_in", priority)).toBe(5);
  });

  it("treats unlisted channels as one last rank that waits behind everything", () => {
    const queue = [
      { channel: "dine_in", points: 5 },
      { channel: "gofood", points: 3 },
      { channel: "shopeefood", points: 4 },
      { channel: "grabfood", points: 2 },
    ];
    // Unlisted channels share the last rank: they wait behind all queue items.
    expect(queueAheadPoints(queue, "shopeefood", priority)).toBe(14);
    expect(queueAheadPoints(queue, "grabfood", priority)).toBe(14);
  });

  it("is 0 for an empty queue", () => {
    expect(queueAheadPoints([], "gofood", priority)).toBe(0);
    expect(queueAheadPoints([], "dine_in", priority)).toBe(0);
  });

  it("is 0 when only lower-priority channels are queued for the top channel", () => {
    expect(
      queueAheadPoints([{ channel: "gofood", points: 7 }], "dine_in", priority),
    ).toBe(0);
  });

  it("counts the whole queue for every channel when the priority list is empty", () => {
    const queue = [
      { channel: "dine_in", points: 5 },
      { channel: "gofood", points: 3 },
    ];
    expect(queueAheadPoints(queue, "dine_in", [])).toBe(8);
    expect(queueAheadPoints(queue, "gofood", [])).toBe(8);
  });
});

describe("stationDelayMinutes", () => {
  it("is 0 when nothing is ahead", () => {
    expect(
      stationDelayMinutes({
        aheadPoints: 0,
        capacityPoints: 60,
        windowMinutes: 30,
      }),
    ).toBe(0);
  });

  it("is ceil(ahead / throughput) with throughput = capacity / window per minute", () => {
    // 60 points per 30 minutes = 2 points per minute.
    const base = { capacityPoints: 60, windowMinutes: 30 };
    expect(stationDelayMinutes({ ...base, aheadPoints: 1 })).toBe(1);
    expect(stationDelayMinutes({ ...base, aheadPoints: 2 })).toBe(1);
    expect(stationDelayMinutes({ ...base, aheadPoints: 3 })).toBe(2);
    expect(stationDelayMinutes({ ...base, aheadPoints: 60 })).toBe(30);
    expect(stationDelayMinutes({ ...base, aheadPoints: 61 })).toBe(31);
  });

  it("handles a throughput below one point per minute", () => {
    // 10 points per 60 minutes = 1/6 point per minute.
    const base = { capacityPoints: 10, windowMinutes: 60 };
    expect(stationDelayMinutes({ ...base, aheadPoints: 1 })).toBe(6);
    expect(stationDelayMinutes({ ...base, aheadPoints: 5 })).toBe(30);
  });

  it("is not off by one on exact multiples with a fractional throughput", () => {
    // 10 points per 3 minutes: 10 ahead clears in exactly 3 minutes.
    expect(
      stationDelayMinutes({
        aheadPoints: 10,
        capacityPoints: 10,
        windowMinutes: 3,
      }),
    ).toBe(3);
    expect(
      stationDelayMinutes({
        aheadPoints: 7,
        capacityPoints: 7,
        windowMinutes: 3,
      }),
    ).toBe(3);
  });

  it("grows with the queue", () => {
    const base = { capacityPoints: 40, windowMinutes: 20 };
    const small = stationDelayMinutes({ ...base, aheadPoints: 10 });
    const large = stationDelayMinutes({ ...base, aheadPoints: 30 });
    expect(small).toBe(5);
    expect(large).toBe(15);
    expect(large).toBeGreaterThan(small);
  });
});

describe("medianSeconds", () => {
  it("returns null with fewer than the minimum samples", () => {
    expect(medianSeconds([])).toBeNull();
    expect(medianSeconds([100])).toBeNull();
    expect(medianSeconds([100, 200, 300, 400])).toBeNull();
  });

  it("returns a number from exactly the minimum samples", () => {
    expect(medianSeconds([10, 20, 30, 40, 50])).toBe(30);
  });

  it("sorts before taking the middle", () => {
    expect(medianSeconds([50, 10, 30, 20, 40])).toBe(30);
    expect(medianSeconds([900, 60, 120, 90, 100, 80, 70])).toBe(90);
  });

  it("averages the two middle samples for an even count", () => {
    expect(medianSeconds([10, 20, 30, 40, 50, 70])).toBe(35);
  });

  it("is not pulled by an outlier", () => {
    expect(medianSeconds([100, 100, 100, 100, 99_999])).toBe(100);
  });

  it("does not mutate its input", () => {
    const samples = [50, 10, 30, 20, 40];
    medianSeconds(samples);
    expect(samples).toEqual([50, 10, 30, 20, 40]);
  });
});

describe("serviceSeconds", () => {
  it("falls back to 600 when there is no history and no prep time", () => {
    expect(
      serviceSeconds({
        historyMedianSeconds: null,
        longestLinePrepSeconds: null,
      }),
    ).toBe(FALLBACK_SERVICE_SECONDS);
  });

  it("uses history alone when no line prep time is known", () => {
    expect(
      serviceSeconds({
        historyMedianSeconds: 300,
        longestLinePrepSeconds: null,
      }),
    ).toBe(300);
  });

  it("uses the longest line prep alone when there is no history", () => {
    expect(
      serviceSeconds({
        historyMedianSeconds: null,
        longestLinePrepSeconds: 420,
      }),
    ).toBe(420);
  });

  it("takes the larger of history and longest line prep", () => {
    expect(
      serviceSeconds({
        historyMedianSeconds: 300,
        longestLinePrepSeconds: 900,
      }),
    ).toBe(900);
    expect(
      serviceSeconds({
        historyMedianSeconds: 1200,
        longestLinePrepSeconds: 600,
      }),
    ).toBe(1200);
  });

  it("does not apply the fallback when a known value is below 600", () => {
    expect(
      serviceSeconds({
        historyMedianSeconds: 120,
        longestLinePrepSeconds: 240,
      }),
    ).toBe(240);
  });
});

describe("etaMinutes", () => {
  it("is the service time in minutes when nothing is queued", () => {
    expect(etaMinutes({ delayMinutes: 0, serviceSeconds: 600 })).toBe(10);
  });

  it("adds the queue delay to the service time", () => {
    expect(etaMinutes({ delayMinutes: 2, serviceSeconds: 600 })).toBe(12);
  });

  it("rounds a partial minute up", () => {
    expect(etaMinutes({ delayMinutes: 2, serviceSeconds: 601 })).toBe(13);
    expect(etaMinutes({ delayMinutes: 3, serviceSeconds: 30 })).toBe(4);
    expect(etaMinutes({ delayMinutes: 0, serviceSeconds: 1 })).toBe(1);
  });

  it("does not round up an exact number of minutes", () => {
    expect(etaMinutes({ delayMinutes: 5, serviceSeconds: 300 })).toBe(10);
  });

  it("grows with the delay", () => {
    const low = etaMinutes({ delayMinutes: 1, serviceSeconds: 600 });
    const high = etaMinutes({ delayMinutes: 10, serviceSeconds: 600 });
    expect(high).toBeGreaterThan(low);
  });
});

describe("etaRange", () => {
  it("keeps the ETA as the minimum", () => {
    expect(etaRange(10).minMinutes).toBe(10);
    expect(etaRange(37).minMinutes).toBe(37);
  });

  it("adds at least 2 minutes for a short ETA", () => {
    expect(etaRange(4)).toEqual({ minMinutes: 4, maxMinutes: 6 });
    expect(etaRange(8)).toEqual({ minMinutes: 8, maxMinutes: 10 });
  });

  it("adds 25 percent rounded up once that exceeds 2 minutes", () => {
    expect(etaRange(9)).toEqual({ minMinutes: 9, maxMinutes: 12 });
    expect(etaRange(10)).toEqual({ minMinutes: 10, maxMinutes: 13 });
    expect(etaRange(20)).toEqual({ minMinutes: 20, maxMinutes: 25 });
    expect(etaRange(21)).toEqual({ minMinutes: 21, maxMinutes: 27 });
  });

  it("always has maxMinutes above minMinutes", () => {
    for (const eta of [1, 2, 5, 12, 30, 60, 120]) {
      const range = etaRange(eta);
      expect(range.maxMinutes).toBeGreaterThan(range.minMinutes);
    }
  });
});

describe("decidePauses", () => {
  const priority = ["dine_in", "gofood", "grabfood"];
  const lines = [
    { menuItemId: "rendang", variantId: null, prepSeconds: 900 },
    { menuItemId: "nasi", variantId: null, prepSeconds: 599 },
    { menuItemId: "soto", variantId: "large", prepSeconds: 600 },
    { menuItemId: "teh", variantId: null, prepSeconds: 60 },
  ];

  it("pauses nothing while the station is available", () => {
    expect(
      decidePauses({ level: "available", channelPriority: priority, lines }),
    ).toEqual([]);
  });

  it("pauses nothing while the station is only near capacity", () => {
    expect(
      decidePauses({
        level: "near_capacity",
        channelPriority: priority,
        lines,
      }),
    ).toEqual([]);
  });

  it("at capacity pauses long-prep lines for every channel except the top one", () => {
    expect(
      decidePauses({ level: "at_capacity", channelPriority: priority, lines }),
    ).toEqual([
      {
        menuItemId: "rendang",
        variantId: null,
        channels: ["gofood", "grabfood"],
      },
      {
        menuItemId: "soto",
        variantId: "large",
        channels: ["gofood", "grabfood"],
      },
    ]);
  });

  it("treats prepSeconds equal to LONG_PREP_SECONDS as long and one below as short", () => {
    const result = decidePauses({
      level: "at_capacity",
      channelPriority: priority,
      lines: [
        {
          menuItemId: "at-limit",
          variantId: null,
          prepSeconds: LONG_PREP_SECONDS,
        },
        {
          menuItemId: "below",
          variantId: null,
          prepSeconds: LONG_PREP_SECONDS - 1,
        },
      ],
    });
    expect(result.map((entry) => entry.menuItemId)).toEqual(["at-limit"]);
  });

  it("never lists the top-priority channel in a pause", () => {
    const result = decidePauses({
      level: "at_capacity",
      channelPriority: priority,
      lines,
    });
    for (const entry of result) expect(entry.channels).not.toContain("dine_in");
  });

  it("pauses only the second channel for a two-channel priority list", () => {
    expect(
      decidePauses({
        level: "at_capacity",
        channelPriority: ["dine_in", "gofood"],
        lines: [{ menuItemId: "rendang", variantId: null, prepSeconds: 900 }],
      }),
    ).toEqual([
      { menuItemId: "rendang", variantId: null, channels: ["gofood"] },
    ]);
  });

  it("pauses nothing for a single-channel priority list", () => {
    expect(
      decidePauses({
        level: "at_capacity",
        channelPriority: ["dine_in"],
        lines,
      }),
    ).toEqual([]);
  });

  it("pauses nothing for an empty priority list", () => {
    expect(
      decidePauses({ level: "at_capacity", channelPriority: [], lines }),
    ).toEqual([]);
  });

  it("pauses nothing when no line is long-prep", () => {
    expect(
      decidePauses({
        level: "at_capacity",
        channelPriority: priority,
        lines: [
          { menuItemId: "teh", variantId: null, prepSeconds: 60 },
          { menuItemId: "nasi", variantId: null, prepSeconds: 599 },
        ],
      }),
    ).toEqual([]);
  });

  it("pauses nothing for a station without lines", () => {
    expect(
      decidePauses({
        level: "at_capacity",
        channelPriority: priority,
        lines: [],
      }),
    ).toEqual([]);
  });

  it("keeps the variant id of an exact-variant line", () => {
    const [entry] = decidePauses({
      level: "at_capacity",
      channelPriority: priority,
      lines: [{ menuItemId: "soto", variantId: "jumbo", prepSeconds: 1200 }],
    });
    expect(entry).toEqual({
      menuItemId: "soto",
      variantId: "jumbo",
      channels: ["gofood", "grabfood"],
    });
  });

  it("does not mutate the input lines or priority", () => {
    const snapshotLines = structuredClone(lines);
    const snapshotPriority = [...priority];
    decidePauses({ level: "at_capacity", channelPriority: priority, lines });
    expect(lines).toEqual(snapshotLines);
    expect(priority).toEqual(snapshotPriority);
  });
});

describe("shouldAlert", () => {
  it("treats a missing previous level as available", () => {
    expect(shouldAlert(null, "available")).toBe(false);
    expect(shouldAlert(null, "near_capacity")).toBe(true);
    expect(shouldAlert(null, "at_capacity")).toBe(true);
  });

  it("alerts when the level gets worse", () => {
    expect(shouldAlert("available", "near_capacity")).toBe(true);
    expect(shouldAlert("available", "at_capacity")).toBe(true);
    expect(shouldAlert("near_capacity", "at_capacity")).toBe(true);
  });

  it("does not alert when the level stays the same", () => {
    expect(shouldAlert("available", "available")).toBe(false);
    expect(shouldAlert("near_capacity", "near_capacity")).toBe(false);
    expect(shouldAlert("at_capacity", "at_capacity")).toBe(false);
  });

  it("does not alert on release (the level improves)", () => {
    expect(shouldAlert("near_capacity", "available")).toBe(false);
    expect(shouldAlert("at_capacity", "near_capacity")).toBe(false);
    expect(shouldAlert("at_capacity", "available")).toBe(false);
  });
});
