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
  serviceChargeBp = 0,
): number {
  let seat = 1;
  while (
    !checkWfcSlotFloor(
      settings,
      { seatFeeIdr: seat, creditIdr },
      minutes,
      serviceChargeBp,
    ).ok
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

  it("contribution: seat net of tax (down), credit less cost and tax (up), gateway (up)", () => {
    // 32.105 × 10.000 / 11.200 = 28.665,1 → 28.665; credit 20.000 − cost
    // 7.000 − tax inside ceil(20.000 × 1.200 / 11.200 = 2.142,9) 2.143 =
    // 10.857; gateway 1% of 52.105 = 521,05 → 522.
    expect(
      wfcContributionIdr({ seatFeeIdr: 32_105, creditIdr: 20_000 }, EXAMPLE, {
        serviceChargeBp: 0,
      }),
    ).toBe(39_000);
  });

  it("review K no. 1: the tax and service charge paid out of the credit are deducted", () => {
    // Review example: credit 50 rb, c 35%, 12% inside: ±27.142 left, not 32.500.
    const creditOnly = (serviceChargeBp: number) =>
      wfcContributionIdr({ seatFeeIdr: 0, creditIdr: 50_000 }, EXAMPLE, {
        serviceChargeBp,
      }) +
      // add back the gateway fee to isolate the credit part
      Math.ceil((50_000 * 100) / 10_000);
    expect(creditOnly(0)).toBe(27_142);
    // 5% service charge, tax on top: r = 12% + 5% + 0,6% = 17,6%;
    // 50.000 × 1.760 / 11.760 = 7.482,99 → 7.483.
    expect(creditOnly(500)).toBe(50_000 - 17_500 - 7_483);
  });

  it("one rupiah under the floor is refused, at the floor is accepted", () => {
    const peakHour = { peakMinutes: 60, offPeakMinutes: 0 };
    const offPeakHour = { peakMinutes: 0, offPeakMinutes: 60 };
    expect(smallestSeatFee(EXAMPLE, 20_000, peakHour)).toBe(32_105);
    expect(smallestSeatFee(EXAMPLE, 20_000, offPeakHour)).toBe(10_583);
    expect(smallestSeatFee(EXAMPLE, 20_000, peakHour, 500)).toBe(33_068);
    // A large credit on a small seat fee: the credit's tax still counts.
    expect(smallestSeatFee(EXAMPLE, 60_000, peakHour)).toBe(7_963);
    const at = checkWfcSlotFloor(
      EXAMPLE,
      { seatFeeIdr: 32_105, creditIdr: 20_000 },
      peakHour,
      0,
    );
    expect(at).toEqual({ floorIdr: 39_000, contributionIdr: 39_000, ok: true });
    for (const [seatFeeIdr, creditIdr, serviceChargeBp] of [
      [32_104, 20_000, 0],
      [33_067, 20_000, 500],
      [7_962, 60_000, 0],
    ] as const)
      expect(
        checkWfcSlotFloor(
          EXAMPLE,
          { seatFeeIdr, creditIdr },
          peakHour,
          serviceChargeBp,
        ).ok,
        `${seatFeeIdr}/${creditIdr}/${serviceChargeBp}`,
      ).toBe(false);
  });

  it("a product is priced as all peak unless it sells off-peak only", () => {
    const split = { seatFeeIdr: 10_583, creditIdr: 20_000 };
    expect(
      checkWfcProductFloor(EXAMPLE, { ...split, access: "off_peak" }, 60, 0).ok,
    ).toBe(true);
    expect(
      checkWfcProductFloor(EXAMPLE, { ...split, access: "all_day" }, 60, 0).ok,
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
