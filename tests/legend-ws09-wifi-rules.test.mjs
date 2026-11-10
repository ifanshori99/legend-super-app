// WS-09 Wi-Fi rules vs PRD v1.7 §25 "Wi-Fi Tamu & WFC" (lines 860-873) and
// FAC-12 / FAC-13 / FAC-14. Pure helpers in packages/shared/src/facility/wifi.ts,
// no database. Run: node --test tests/legend-ws09-wifi-rules.test.mjs
//
// Assumptions where the PRD is silent:
// - Outlet time zone is Asia/Jakarta (UTC+7); instants below use +07:00.
// - The tier bonus is a daily bonus added on top of the base allowance in both
//   peak and off-peak (PRD: "bonus waktu harian").
// - Peak windows are [start, end): 14:00 is already off-peak.
// - "Sepanjang akhir pekan" means every minute of Saturday and Sunday.
// - Spend steps are cumulative per day: Rp59.999 -> 1 step, Rp60.000 -> 2.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as facility from "../packages/shared/src/facility/index.ts";

const TZ = "Asia/Jakarta";
const [wfcPolicy] = facility.cafeLegendWifiPolicies;

// PRD default peak schedule, built independently of the fixture.
const prdPeakSchedule = [
  { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "11:30", endsAt: "14:00" },
  { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "18:00", endsAt: "21:00" },
  // "24:00" is accepted as a window end only, so the whole day is expressible.
  { daysOfWeek: [0, 6], startsAt: "00:00", endsAt: "24:00" },
];

const policy = {
  freeMinutes: 120,
  peakFreeMinutes: 60,
  spendPerExtraHourIdr: 30_000,
  extraMinutes: 60,
  maxDevices: 2,
  tierBonusMinutes: { gold: 60, platinum: 120 },
};

// 2026-11-09 is a Monday, 2026-11-14 Saturday, 2026-11-15 Sunday.
const at = (day, time) => `2026-11-${day}T${time}:00+07:00`;
const MON = "09";
const FRI = "13";
const SAT = "14";
const SUN = "15";

describe("PRD defaults (Wi-Fi Berbasis Belanja)", () => {
  test("defaults: 2 jam gratis, 1 jam jam ramai, +1 jam per Rp30.000, 2 perangkat", () => {
    const d = facility.WIFI_POLICY_DEFAULTS;
    assert.equal(d.freeMinutes, 120);
    assert.equal(d.peakFreeMinutes, 60);
    assert.equal(d.spendPerExtraHourIdr, 30_000);
    assert.equal(d.extraMinutes, 60);
    assert.equal(d.maxDevices, 2);
  });

  test("fixture WFC policy carries the PRD defaults and Gold/Platinum bonus", () => {
    assert.equal(wfcPolicy.freeMinutes, 120);
    assert.equal(wfcPolicy.peakFreeMinutes, 60);
    assert.equal(wfcPolicy.spendPerExtraHourIdr, 30_000);
    assert.equal(wfcPolicy.extraMinutes, 60);
    assert.equal(wfcPolicy.maxDevices, 2);
    assert.ok(wfcPolicy.tierBonusMinutes.gold > 0);
    assert.ok(wfcPolicy.tierBonusMinutes.platinum > 0);
  });
});

describe("2 jam gratis per hari (FAC-12)", () => {
  test("off-peak guest without spend or tier gets 120 minutes", () => {
    assert.equal(facility.wifiFreeMinutes(policy, { isPeak: false }), 120);
    assert.equal(
      facility.wifiQuotaMinutes(policy, { isPeak: false, sameDaySpendIdr: 0 }),
      120,
    );
  });

  test("unknown or non-premium tier key adds no bonus", () => {
    assert.equal(
      facility.wifiFreeMinutes(policy, { isPeak: false, tierKey: "silver" }),
      120,
    );
  });
});

describe("+1 jam per Rp30.000 belanja (FAC-12)", () => {
  const extra = (spend) => facility.wifiExtraMinutesForSpend(policy, spend);

  test("below the threshold grants nothing", () => {
    assert.equal(extra(0), 0);
    assert.equal(extra(29_999), 0);
  });

  test("each full Rp30.000 grants one hour", () => {
    assert.equal(extra(30_000), 60);
    assert.equal(extra(59_999), 60);
    assert.equal(extra(60_000), 120);
    assert.equal(extra(90_000), 180);
  });

  test("Rp45.000 grants 1 hour (partial step is not rounded up)", () => {
    assert.equal(extra(45_000), 60);
  });

  test("total quota is free minutes plus spend minutes", () => {
    assert.equal(
      facility.wifiQuotaMinutes(policy, {
        isPeak: false,
        sameDaySpendIdr: 90_000,
      }),
      300,
    );
  });

  test("spend steps follow the policy row, not a hardcoded Rp30.000", () => {
    const custom = { spendPerExtraHourIdr: 50_000, extraMinutes: 30 };
    assert.equal(facility.wifiExtraMinutesForSpend(custom, 49_999), 0);
    assert.equal(facility.wifiExtraMinutesForSpend(custom, 100_000), 60);
  });

  test("negative or fractional spend is rejected", () => {
    assert.throws(() => extra(-1), RangeError);
    assert.throws(() => extra(1.5), RangeError);
  });
});

describe("bonus tier Gold dan Platinum", () => {
  test("Gold adds its daily bonus, Platinum at least as much", () => {
    const base = facility.wifiFreeMinutes(policy, { isPeak: false });
    const gold = facility.wifiFreeMinutes(policy, {
      isPeak: false,
      tierKey: "gold",
    });
    const platinum = facility.wifiFreeMinutes(policy, {
      isPeak: false,
      tierKey: "platinum",
    });
    assert.equal(gold, base + 60);
    assert.equal(platinum, base + 120);
    assert.ok(platinum >= gold && gold > base);
  });

  test("bonus stacks with spend minutes in the whole quota", () => {
    assert.equal(
      facility.wifiQuotaMinutes(policy, {
        isPeak: false,
        tierKey: "gold",
        sameDaySpendIdr: 60_000,
      }),
      120 + 60 + 120,
    );
  });

  test("bonus also applies in peak hours (assumption)", () => {
    assert.equal(
      facility.wifiFreeMinutes(policy, { isPeak: true, tierKey: "gold" }),
      60 + 60,
    );
  });
});

describe("jam ramai: 1 jam gratis (FAC-14)", () => {
  test("peak allowance is 60 minutes without tier", () => {
    assert.equal(facility.wifiFreeMinutes(policy, { isPeak: true }), 60);
    assert.equal(
      facility.wifiQuotaMinutes(policy, {
        isPeak: true,
        sameDaySpendIdr: 30_000,
      }),
      120,
    );
  });

  const schedule = { peakSchedule: prdPeakSchedule };
  const peak = (day, time) => facility.isPeakAt(schedule, at(day, time), TZ);

  test("weekday lunch window 11.30-14.00", () => {
    assert.equal(peak(MON, "11:29"), false);
    assert.equal(peak(MON, "11:30"), true);
    assert.equal(peak(MON, "12:45"), true);
    assert.equal(peak(MON, "13:59"), true);
    assert.equal(peak(MON, "14:00"), false);
  });

  test("weekday dinner window 18.00-21.00", () => {
    assert.equal(peak(FRI, "17:59"), false);
    assert.equal(peak(FRI, "18:00"), true);
    assert.equal(peak(FRI, "20:59"), true);
    assert.equal(peak(FRI, "21:00"), false);
  });

  test("weekday off-peak hours are quiet", () => {
    assert.equal(peak(MON, "09:00"), false);
    assert.equal(peak(MON, "15:30"), false);
    assert.equal(peak(MON, "22:00"), false);
  });

  test("whole weekend is peak", () => {
    for (const day of [SAT, SUN]) {
      assert.equal(peak(day, "00:00"), true);
      assert.equal(peak(day, "08:00"), true);
      assert.equal(peak(day, "15:30"), true);
      assert.equal(peak(day, "22:00"), true);
    }
  });

  test("whole weekend is peak, including 23.59", () => {
    const fixtureSchedule = { peakSchedule: wfcPolicy.peakSchedule };
    assert.equal(
      facility.isPeakAt(fixtureSchedule, at(SAT, "23:59"), TZ),
      true,
    );
    assert.equal(
      facility.isPeakAt(fixtureSchedule, at(SUN, "23:59"), TZ),
      true,
    );
  });

  test("24:00 is accepted only as a window end", () => {
    const window = { daysOfWeek: [0], startsAt: "00:00", endsAt: "24:00" };
    assert.equal(facility.peakWindowSchema.safeParse(window).success, true);
    assert.equal(
      facility.peakWindowSchema.safeParse({ ...window, startsAt: "24:00" })
        .success,
      false,
    );
    assert.equal(
      facility.peakWindowSchema.safeParse({ ...window, endsAt: "24:01" })
        .success,
      false,
    );
    assert.equal(
      facility.peakWindowSchema.safeParse({
        ...window,
        startsAt: "23:59",
        endsAt: "24:00",
      }).success,
      true,
    );
  });

  test("fixture WFC schedule matches the PRD on weekdays and weekend daytime", () => {
    const fixtureSchedule = { peakSchedule: wfcPolicy.peakSchedule };
    const peak2 = (day, time) =>
      facility.isPeakAt(fixtureSchedule, at(day, time), TZ);
    assert.equal(peak2(MON, "11:30"), true);
    assert.equal(peak2(MON, "14:00"), false);
    assert.equal(peak2(MON, "18:00"), true);
    assert.equal(peak2(MON, "21:00"), false);
    assert.equal(peak2(SAT, "10:00"), true);
    assert.equal(peak2(SUN, "16:00"), true);
  });

  test("peak is evaluated in the outlet time zone, not UTC", () => {
    // 05:00Z Monday = 12:00 in Jakarta (peak); 12:00Z = 19:00 Jakarta (peak);
    // 08:00Z = 15:00 Jakarta (off-peak) although 08:00 UTC is not in any window.
    assert.equal(facility.isPeakAt(schedule, "2026-11-09T05:00:00Z", TZ), true);
    assert.equal(facility.isPeakAt(schedule, "2026-11-09T12:00:00Z", TZ), true);
    assert.equal(
      facility.isPeakAt(schedule, "2026-11-09T08:00:00Z", TZ),
      false,
    );
  });

  test("admin edit applies on the next call without redeploy (FAC-14)", () => {
    const edited = {
      peakSchedule: [{ daysOfWeek: [1], startsAt: "09:00", endsAt: "10:00" }],
    };
    assert.equal(facility.isPeakAt(edited, at(MON, "09:30"), TZ), true);
    assert.equal(facility.isPeakAt(edited, at(MON, "12:00"), TZ), false);
    assert.equal(facility.isPeakAt(edited, at(SAT, "12:00"), TZ), false);
  });
});

describe("kuota habis: kecepatan dasar, tidak putus (FAC-13)", () => {
  test("under quota is full speed", () => {
    assert.equal(facility.wifiSpeedTier(0, 120), "full");
    assert.equal(facility.wifiSpeedTier(119, 120), "full");
  });

  test("quota spent or exceeded drops to base, never to a disconnected state", () => {
    assert.equal(facility.wifiSpeedTier(120, 120), "base");
    assert.equal(facility.wifiSpeedTier(500, 120), "base");
    assert.equal(facility.wifiSpeedTier(0, 0), "base");
    for (const used of [0, 60, 119, 120, 121, 1000]) {
      assert.ok(["full", "base"].includes(facility.wifiSpeedTier(used, 120)));
    }
  });

  test("remaining minutes never go negative", () => {
    assert.equal(
      facility.wifiRemainingMinutes({ quotaMinutes: 120, usedMinutes: 45 }),
      75,
    );
    assert.equal(
      facility.wifiRemainingMinutes({ quotaMinutes: 120, usedMinutes: 120 }),
      0,
    );
    assert.equal(
      facility.wifiRemainingMinutes({ quotaMinutes: 120, usedMinutes: 300 }),
      0,
    );
  });

  test("buying more spend lifts a throttled guest back to full speed", () => {
    const quota = facility.wifiQuotaMinutes(policy, {
      isPeak: false,
      sameDaySpendIdr: 30_000,
    });
    assert.equal(facility.wifiSpeedTier(120, 120), "base");
    assert.equal(facility.wifiSpeedTier(120, quota), "full");
  });

  test("base speed policy fields exist and base is slower than full", () => {
    assert.ok(wfcPolicy.baseSpeedKbps > 0);
    assert.ok(wfcPolicy.baseSpeedKbps < wfcPolicy.fullSpeedKbps);
  });
});

describe("maksimal 2 perangkat per akun (FAC-12)", () => {
  test("first and second device are allowed", () => {
    assert.doesNotThrow(() => facility.assertWifiDeviceAllowed(0, policy));
    assert.doesNotThrow(() => facility.assertWifiDeviceAllowed(1, policy));
  });

  test("third device is rejected with WIFI_DEVICE_LIMIT", () => {
    assert.throws(
      () => facility.assertWifiDeviceAllowed(2, policy),
      (error) =>
        error instanceof facility.FacilityError &&
        error.code === "WIFI_DEVICE_LIMIT",
    );
  });

  test("an already-connected device can re-authorise at the limit", () => {
    assert.doesNotThrow(() =>
      facility.assertWifiDeviceAllowed(2, policy, {
        deviceAlreadyActive: true,
      }),
    );
  });

  test("the limit follows the policy row", () => {
    assert.doesNotThrow(() =>
      facility.assertWifiDeviceAllowed(2, { maxDevices: 3 }),
    );
    assert.throws(() => facility.assertWifiDeviceAllowed(3, { maxDevices: 3 }));
  });

  test("negative device count is rejected", () => {
    assert.throws(
      () => facility.assertWifiDeviceAllowed(-1, policy),
      RangeError,
    );
  });
});
