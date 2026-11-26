// Brief 1270 card W1b: the WFC price floor (decision 28 §2). Pure math: one
// rupiah under the floor is refused, the brief's worked example holds, and
// every rounding goes against the price.
import { describe, expect, it } from "vitest";
import {
  checkWfcProductFloor,
  checkWfcSlotFloor,
  wfcContributionIdr,
  wfcHourlyFloors,
  wfcSlotFloorIdr,
  type WfcFloorSettings,
} from "@starter/shared/wfc";

/** The brief's example: F + L Rp150 jt, S 60, H 420, o 50%, A 60 rb, c 35%, d 1 h. */
const EXAMPLE: WfcFloorSettings = {
  totalSeats: 60,
  openHoursPerMonth: 420,
  fixedCostIdr: 100_000_000,
  targetProfitIdr: 50_000_000,
  targetRevenueIdr: 200_000_000,
  targetOccupancyBp: 5000,
  spendPerPersonIdr: 60_000,
  cogsBp: 3500,
  avgStayMinutes: 60,
} as WfcFloorSettings;

/** Smallest seat fee whose contribution reaches the floor (search, not formula). */
function smallestSeatFee(
  settings: WfcFloorSettings,
  creditIdr: number,
  minutes: { peakMinutes: number; offPeakMinutes: number },
): number {
  let seat = 1;
  while (
    !checkWfcSlotFloor(settings, { seatFeeIdr: seat, creditIdr }, minutes).ok
  )
    seat += 1;
  return seat;
}

describe("WFC price floor", () => {
  it("matches the brief: B1 ±Rp11.905 → 12.000, B2 Rp39.000, off-peak B2 × o", () => {
    expect(wfcHourlyFloors(EXAMPLE)).toEqual({
      peakIdr: 39_000,
      offPeakIdr: 20_000, // max(12.000, 19.500 → 20.000)
    });
    // A long stay makes B1 the floor in both.
    expect(
      wfcHourlyFloors({ ...EXAMPLE, avgStayMinutes: 600 } as WfcFloorSettings),
    ).toEqual({ peakIdr: 12_000, offPeakIdr: 12_000 });
  });

  it("takes R × (1 − c) when it beats F + L", () => {
    // R 300 jt × 65% = 195 jt > 150 jt: 195 jt / 12.600 = 15.476 → 16.000.
    const floors = wfcHourlyFloors({
      ...EXAMPLE,
      targetRevenueIdr: 300_000_000,
      avgStayMinutes: 600,
    } as WfcFloorSettings);
    expect(floors.peakIdr).toBe(16_000);
  });

  it("a full 12-hour peak day pass needs ±Rp468 rb (d = 1 h)", () => {
    expect(
      wfcSlotFloorIdr(EXAMPLE, { peakMinutes: 720, offPeakMinutes: 0 }),
    ).toBe(468_000);
  });

  it("weighs a mixed slot per minute and rounds up", () => {
    expect(
      wfcSlotFloorIdr(EXAMPLE, { peakMinutes: 30, offPeakMinutes: 30 }),
    ).toBe(29_500);
    // One off-peak minute: 20.000 / 60 = 333,3 → 334.
    expect(
      wfcSlotFloorIdr(EXAMPLE, { peakMinutes: 0, offPeakMinutes: 1 }),
    ).toBe(334);
  });

  it("contribution: seat net of tax (down), credit margin (down), gateway (up)", () => {
    // 29.677 × 10.000 / 11.200 = 26.497,3 → 26.497; 20.000 × 65% = 13.000;
    // gateway 1% of 49.677 = 496,77 → 497.
    expect(
      wfcContributionIdr({ seatFeeIdr: 29_677, creditIdr: 20_000 }, EXAMPLE),
    ).toBe(39_000);
  });

  it("one rupiah under the floor is refused, at the floor is accepted", () => {
    const peakHour = { peakMinutes: 60, offPeakMinutes: 0 };
    const offPeakHour = { peakMinutes: 0, offPeakMinutes: 60 };
    expect(smallestSeatFee(EXAMPLE, 20_000, peakHour)).toBe(29_677);
    expect(smallestSeatFee(EXAMPLE, 20_000, offPeakHour)).toBe(8_156);
    const at = checkWfcSlotFloor(
      EXAMPLE,
      { seatFeeIdr: 29_677, creditIdr: 20_000 },
      peakHour,
    );
    expect(at).toEqual({ floorIdr: 39_000, contributionIdr: 39_000, ok: true });
    expect(
      checkWfcSlotFloor(
        EXAMPLE,
        { seatFeeIdr: 29_676, creditIdr: 20_000 },
        peakHour,
      ).ok,
    ).toBe(false);
  });

  it("a product is priced as all peak unless it sells off-peak only", () => {
    const split = { seatFeeIdr: 8_156, creditIdr: 20_000 };
    expect(
      checkWfcProductFloor(EXAMPLE, { ...split, access: "off_peak" }, 60).ok,
    ).toBe(true);
    expect(
      checkWfcProductFloor(EXAMPLE, { ...split, access: "all_day" }, 60).ok,
    ).toBe(false);
  });

  it("refuses broken numbers instead of pricing them", () => {
    for (const bad of [
      { totalSeats: 0 },
      { targetOccupancyBp: 0 },
      { targetOccupancyBp: 10_001 },
      { cogsBp: 10_000 },
      { avgStayMinutes: 0 },
      { fixedCostIdr: 1.5 },
    ])
      expect(
        () => wfcHourlyFloors({ ...EXAMPLE, ...bad } as WfcFloorSettings),
        JSON.stringify(bad),
      ).toThrow(RangeError);
    expect(() =>
      wfcSlotFloorIdr(EXAMPLE, { peakMinutes: 0, offPeakMinutes: 0 }),
    ).toThrow(RangeError);
  });
});
