// Wi-Fi quota rules, pure level (bead legend-kmd3, PRD v1.7 §3 F25,
// FAC-12/FAC-13/FAC-14): spend modes, tier bonus, peak windows, daily cap.
// Run with: pnpm test (root node:test suite, no database needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import * as facility from "../packages/shared/src/facility/index.ts";

const base = facility.cafeLegendFacilityFixtures.wifiPolicies[0];
const perDay = { ...base, spendMode: "per_day_multiple" };
const perOrder = { ...base, spendMode: "per_order" };

test("legend-kmd3 FAC-12 spendMode: Rp20k + Rp20k earns an hour per day but nothing per order", () => {
  const nets = [20_000, 20_000];
  assert.equal(facility.wifiExtraMinutesForOrders(perDay, nets), 60);
  assert.equal(facility.wifiExtraMinutesForOrders(perOrder, nets), 0);
  // A missing mode reads as per_day_multiple.
  assert.equal(facility.wifiExtraMinutesForOrders(base, nets), 60);
});

test("legend-kmd3 FAC-12 spendMode: Rp45k in one order earns an hour in both modes", () => {
  assert.equal(facility.wifiExtraMinutesForOrders(perDay, [45_000]), 60);
  assert.equal(facility.wifiExtraMinutesForOrders(perOrder, [45_000]), 60);
});

test("legend-kmd3 FAC-12 spendMode: per_order sums each order, per_day_multiple floors the whole day", () => {
  assert.equal(
    facility.wifiExtraMinutesForOrders(perOrder, [30_000, 59_000, 10_000]),
    120,
  );
  assert.equal(
    facility.wifiExtraMinutesForOrders(perDay, [30_000, 59_000, 10_000]),
    180,
  );
  assert.equal(facility.wifiExtraMinutesForOrders(perDay, []), 0);
});

test("legend-kmd3 FAC-12 a refund that leaves a negative net counts as zero", () => {
  assert.equal(
    facility.wifiExtraMinutesForOrders(perDay, [-5_000, 30_000]),
    60,
  );
  assert.equal(
    facility.wifiExtraMinutesForOrders(perOrder, [-5_000, 30_000]),
    60,
  );
});

test("legend-kmd3 FAC-12 quota adds free minutes, tier bonus and spend per mode", () => {
  const off = { isPeak: false, orderNetSpendIdr: [20_000, 20_000] };
  assert.equal(facility.wifiQuotaMinutesForOrders(perDay, off), 180);
  assert.equal(facility.wifiQuotaMinutesForOrders(perOrder, off), 120);
  assert.equal(
    facility.wifiQuotaMinutesForOrders(perDay, {
      isPeak: true,
      orderNetSpendIdr: [20_000, 20_000],
    }),
    120,
  );
});

test("legend-kmd3 FAC-12 tier bonus: Gold +60, Platinum +120, unknown or no tier +0", () => {
  const input = { isPeak: false, orderNetSpendIdr: [] };
  assert.equal(
    facility.wifiQuotaMinutesForOrders(perDay, { ...input, tierKey: "gold" }),
    180,
  );
  assert.equal(
    facility.wifiQuotaMinutesForOrders(perDay, {
      ...input,
      tierKey: "platinum",
    }),
    240,
  );
  assert.equal(
    facility.wifiQuotaMinutesForOrders(perDay, { ...input, tierKey: "silver" }),
    120,
  );
  assert.equal(facility.wifiQuotaMinutesForOrders(perDay, input), 120);
  // Bonus stacks on the peak allowance and on spend.
  assert.equal(
    facility.wifiQuotaMinutesForOrders(perOrder, {
      isPeak: true,
      tierKey: "platinum",
      orderNetSpendIdr: [30_000],
    }),
    60 + 120 + 60,
  );
});

test("legend-kmd3 FAC-14 peak windows: weekdays 11.30-14.00 and 18.00-21.00, whole weekend", () => {
  const peak = (iso) => facility.isPeakAt(base, iso, "Asia/Jakarta");
  // Monday 2026-11-02, Jakarta is UTC+7.
  assert.equal(peak("2026-11-02T03:00:00.000Z"), false); // 10:00
  assert.equal(peak("2026-11-02T04:30:00.000Z"), true); // 11:30 start inclusive
  assert.equal(peak("2026-11-02T05:00:00.000Z"), true); // 12:00
  assert.equal(peak("2026-11-02T07:00:00.000Z"), false); // 14:00 end exclusive
  assert.equal(peak("2026-11-02T11:00:00.000Z"), true); // 18:00
  assert.equal(peak("2026-11-02T14:00:00.000Z"), false); // 21:00 end exclusive
  // Sunday 2026-11-01 and Saturday 2026-11-07 are peak all day.
  assert.equal(peak("2026-11-01T03:00:00.000Z"), true);
  assert.equal(peak("2026-11-07T03:00:00.000Z"), true); // Saturday 10:00
  assert.equal(peak("2026-11-07T17:00:00.000Z"), true); // Sunday 00:00
});

test("legend-kmd3 FAC-14 the peak window changes the free allowance in the quota", () => {
  const at = (iso) =>
    facility.wifiQuotaMinutesForOrders(base, {
      isPeak: facility.isPeakAt(base, iso, "Asia/Jakarta"),
      orderNetSpendIdr: [],
    });
  assert.equal(at("2026-11-02T03:00:00.000Z"), 120);
  assert.equal(at("2026-11-02T05:00:00.000Z"), 60);
  assert.equal(at("2026-11-01T03:00:00.000Z"), 60);
});

test("legend-kmd3 FAC-12 the daily quota never exceeds 1440 minutes in either mode", () => {
  assert.equal(facility.WIFI_MAX_DAILY_MINUTES, 1440);
  for (const policy of [perDay, perOrder]) {
    assert.equal(
      facility.wifiQuotaMinutesForOrders(policy, {
        isPeak: false,
        tierKey: "platinum",
        orderNetSpendIdr: [1_000_000],
      }),
      1440,
    );
  }
  // Just below the cap stays exact: 120 free + 22 hours of spend = 1440.
  assert.equal(
    facility.wifiQuotaMinutesForOrders(perDay, {
      isPeak: false,
      orderNetSpendIdr: [22 * 30_000],
    }),
    1440,
  );
  assert.equal(
    facility.wifiQuotaMinutesForOrders(perDay, {
      isPeak: false,
      orderNetSpendIdr: [21 * 30_000],
    }),
    1380,
  );
});

test("legend-kmd3 FAC-13 an exhausted quota throttles to base and never reads as cut", () => {
  assert.equal(facility.wifiSpeedTier(119, 120), "full");
  assert.equal(facility.wifiSpeedTier(120, 120), "base");
  assert.equal(facility.wifiSpeedTier(500, 120), "base");
  assert.equal(
    facility.wifiRemainingMinutes({ quotaMinutes: 120, usedMinutes: 500 }),
    0,
  );
});

test("legend-kmd3 FAC-12 wifiPolicySchema accepts both spend modes and an absent one, rejects others", () => {
  facility.wifiPolicySchema.parse(perDay);
  facility.wifiPolicySchema.parse(perOrder);
  facility.wifiPolicySchema.parse(base);
  assert.throws(() =>
    facility.wifiPolicySchema.parse({ ...base, spendMode: "weekly" }),
  );
});
