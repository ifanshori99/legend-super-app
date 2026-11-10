// Pure attendance rules (WS-10, PRD F25 / HR-02). Unit tests, no database.
//
// Assumptions: late / early leave / overtime are whole minutes (floored) and
// 0 when the employee is on time; null when there is no shift or the matching
// clock event is missing. Geofence edge is inclusive.

import { describe, expect, it } from "vitest";
import {
  computeWorkTiming,
  geofenceDistance,
  haversineMeters,
  qrTokenForWindow,
  qrWindowOf,
  sampleSelected,
  selfieRetentionDue,
  validateQr,
} from "./hris-attendance-logic";

const seed = Buffer.from("0123456789abcdef0123456789abcdef");
const otherSeed = Buffer.from("ffffffffffffffffffffffffffffffff");

describe("haversineMeters", () => {
  it("is zero for the same point", () => {
    expect(
      haversineMeters(
        { latitude: -6.2, longitude: 106.8 },
        { latitude: -6.2, longitude: 106.8 },
      ),
    ).toBe(0);
  });

  it("gives about 111.2 km per degree of latitude", () => {
    const meters = haversineMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 0 },
    );
    expect(meters).toBeGreaterThan(111_000);
    expect(meters).toBeLessThan(111_400);
  });

  it("is symmetric", () => {
    const a = { latitude: -6.2, longitude: 106.8 };
    const b = { latitude: -6.9, longitude: 107.6 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe("geofenceDistance", () => {
  const geofence = { latitude: -6.2, longitude: 106.8, radiusMeters: 100 };

  it("returns null without a geofence", () => {
    expect(geofenceDistance({ latitude: 0, longitude: 0 }, null)).toBeNull();
  });

  it("is inside at the centre", () => {
    expect(
      geofenceDistance({ latitude: -6.2, longitude: 106.8 }, geofence),
    ).toEqual({ distanceMeters: 0, withinRadius: true });
  });

  it("is inside about 50 m away and outside about 500 m away", () => {
    // 1 degree of latitude is ~111195 m, so 0.00045 deg is ~50 m.
    const near = geofenceDistance(
      { latitude: -6.2 + 0.00045, longitude: 106.8 },
      geofence,
    );
    expect(near?.withinRadius).toBe(true);
    expect(near?.distanceMeters).toBeGreaterThan(45);
    expect(near?.distanceMeters).toBeLessThan(55);

    const far = geofenceDistance(
      { latitude: -6.2 + 0.0045, longitude: 106.8 },
      geofence,
    );
    expect(far?.withinRadius).toBe(false);
    expect(Number.isInteger(far?.distanceMeters)).toBe(true);
  });

  it("treats exactly the radius as inside", () => {
    const point = { latitude: -6.2 + 0.0009, longitude: 106.8 };
    const meters = haversineMeters(point, geofence);
    const edge = { ...geofence, radiusMeters: meters };
    expect(geofenceDistance(point, edge)?.withinRadius).toBe(true);
  });
});

describe("rotating QR", () => {
  const t0 = Date.UTC(2026, 10, 10, 8, 0, 0); // start of a 30 s window
  const window = qrWindowOf(t0);

  it("derives windows of 30 seconds", () => {
    expect(qrWindowOf(t0 + 29_999)).toBe(window);
    expect(qrWindowOf(t0 + 30_000)).toBe(window + 1);
  });

  it("is deterministic base64url and differs per window and seed", () => {
    const token = qrTokenForWindow(seed, window);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(qrTokenForWindow(seed, window)).toBe(token);
    expect(qrTokenForWindow(seed, window + 1)).not.toBe(token);
    expect(qrTokenForWindow(otherSeed, window)).not.toBe(token);
  });

  it("accepts the current window", () => {
    expect(validateQr(seed, qrTokenForWindow(seed, window), t0 + 10_000)).toBe(
      true,
    );
  });

  it("accepts the previous window (tolerance of 1)", () => {
    expect(
      validateQr(seed, qrTokenForWindow(seed, window - 1), t0 + 10_000),
    ).toBe(true);
  });

  it("rejects a token two windows old", () => {
    expect(
      validateQr(seed, qrTokenForWindow(seed, window - 2), t0 + 10_000),
    ).toBe(false);
  });

  it("rejects a token from the next window", () => {
    expect(
      validateQr(seed, qrTokenForWindow(seed, window + 1), t0 + 10_000),
    ).toBe(false);
  });

  it("rejects another outlet seed, garbage and empty tokens", () => {
    expect(
      validateQr(otherSeed, qrTokenForWindow(seed, window), t0 + 10_000),
    ).toBe(false);
    expect(validateQr(seed, "garbage", t0)).toBe(false);
    expect(validateQr(seed, "", t0)).toBe(false);
  });
});

describe("computeWorkTiming", () => {
  // 08:00-16:00 WIB (UTC+7) on 2026-11-10 = 01:00-09:00Z.
  const segments = [
    {
      startsAt: "2026-11-10T01:00:00.000Z",
      endsAt: "2026-11-10T09:00:00.000Z",
    },
  ];
  const at = (iso: string) => new Date(iso);

  it("is on time: zero minutes", () => {
    expect(
      computeWorkTiming({
        segments,
        clockInAt: at("2026-11-10T01:00:00.000Z"),
        clockOutAt: at("2026-11-10T09:00:00.000Z"),
        timeZone: "Asia/Jakarta",
      }),
    ).toEqual({
      businessDate: "2026-11-10",
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
    });
  });

  it("counts late minutes, floored to whole minutes", () => {
    const timing = computeWorkTiming({
      segments,
      clockInAt: at("2026-11-10T01:12:59.000Z"),
      timeZone: "Asia/Jakarta",
    });
    expect(timing.lateMinutes).toBe(12);
    expect(timing.earlyLeaveMinutes).toBeNull();
    expect(timing.overtimeMinutes).toBeNull();
  });

  it("clocking in early is not late", () => {
    expect(
      computeWorkTiming({
        segments,
        clockInAt: at("2026-11-10T00:40:00.000Z"),
        timeZone: "Asia/Jakarta",
      }).lateMinutes,
    ).toBe(0);
  });

  it("counts early leave", () => {
    const timing = computeWorkTiming({
      segments,
      clockOutAt: at("2026-11-10T08:30:00.000Z"),
      timeZone: "Asia/Jakarta",
    });
    expect(timing.earlyLeaveMinutes).toBe(30);
    expect(timing.overtimeMinutes).toBe(0);
    expect(timing.lateMinutes).toBeNull();
  });

  it("counts overtime", () => {
    const timing = computeWorkTiming({
      segments,
      clockOutAt: at("2026-11-10T10:15:00.000Z"),
      timeZone: "Asia/Jakarta",
    });
    expect(timing.overtimeMinutes).toBe(75);
    expect(timing.earlyLeaveMinutes).toBe(0);
  });

  it("measures a split shift on its outer edges", () => {
    const split = [
      {
        startsAt: "2026-11-10T05:00:00.000Z",
        endsAt: "2026-11-10T08:00:00.000Z",
      },
      {
        startsAt: "2026-11-10T01:00:00.000Z",
        endsAt: "2026-11-10T03:00:00.000Z",
      },
    ];
    const timing = computeWorkTiming({
      segments: split,
      clockInAt: at("2026-11-10T01:05:00.000Z"),
      clockOutAt: at("2026-11-10T07:50:00.000Z"),
      timeZone: "Asia/Jakarta",
    });
    expect(timing.lateMinutes).toBe(5);
    expect(timing.earlyLeaveMinutes).toBe(10);
  });

  it("uses the outlet zone for the business date of a night shift", () => {
    // 22:00 WIB on 2026-11-10 = 15:00Z, ends 06:00 WIB next day.
    const night = [
      {
        startsAt: "2026-11-10T15:00:00.000Z",
        endsAt: "2026-11-10T23:00:00.000Z",
      },
    ];
    expect(
      computeWorkTiming({ segments: night, timeZone: "Asia/Jakarta" })
        .businessDate,
    ).toBe("2026-11-10");
    // Same instant is already the next calendar day in WIT-ish UTC+9.
    expect(
      computeWorkTiming({ segments: night, timeZone: "Asia/Jayapura" })
        .businessDate,
    ).toBe("2026-11-11");
  });

  it("gives null everywhere without a shift", () => {
    expect(
      computeWorkTiming({
        segments: [],
        clockInAt: at("2026-11-10T01:30:00.000Z"),
        clockOutAt: at("2026-11-10T09:30:00.000Z"),
        timeZone: "Asia/Jakarta",
      }),
    ).toEqual({
      businessDate: null,
      lateMinutes: null,
      earlyLeaveMinutes: null,
      overtimeMinutes: null,
    });
  });
});

describe("selfieRetentionDue", () => {
  const lockedAt = new Date("2026-08-01T00:00:00.000Z");

  it("is false without a closed payroll", () => {
    expect(selfieRetentionDue(null, 90, new Date("2030-01-01"))).toBe(false);
    expect(selfieRetentionDue(undefined, 90, new Date("2030-01-01"))).toBe(
      false,
    );
  });

  it("is false before lockedAt + days", () => {
    expect(
      selfieRetentionDue(lockedAt, 90, new Date("2026-10-29T23:59:59.999Z")),
    ).toBe(false);
  });

  it("is true exactly at lockedAt + days and after", () => {
    expect(
      selfieRetentionDue(lockedAt, 90, new Date("2026-10-30T00:00:00.000Z")),
    ).toBe(true);
    expect(selfieRetentionDue(lockedAt, 90, new Date("2027-01-01"))).toBe(true);
  });

  it("honours a different retention period", () => {
    expect(selfieRetentionDue(lockedAt, 30, new Date("2026-08-31"))).toBe(true);
    expect(selfieRetentionDue(lockedAt, 30, new Date("2026-08-30"))).toBe(
      false,
    );
  });
});

describe("sampleSelected", () => {
  const ids = Array.from(
    { length: 2_000 },
    (_, i) => `01JABCDEF${String(i).padStart(8, "0")}`,
  );

  it("is deterministic", () => {
    for (const id of ids.slice(0, 50))
      expect(sampleSelected(id, 0.3)).toBe(sampleSelected(id, 0.3));
  });

  it("selects none at rate 0 and all at rate 1", () => {
    expect(ids.some((id) => sampleSelected(id, 0))).toBe(false);
    expect(ids.every((id) => sampleSelected(id, 1))).toBe(true);
    expect(sampleSelected(ids[0] ?? "", -0.5)).toBe(false);
  });

  it("is monotonic in rate: a selected log stays selected at a higher rate", () => {
    for (const id of ids)
      if (sampleSelected(id, 0.1)) expect(sampleSelected(id, 0.4)).toBe(true);
  });

  it("selects roughly the requested share", () => {
    const share =
      ids.filter((id) => sampleSelected(id, 0.25)).length / ids.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
  });
});
