// The WFC price floor of brief 1270, decision 28 §2 (card W1b). The one
// function every door uses: saving or switching on a product, the hold (W2) and
// the AI executor (W13). Integer math only (BigInt), so no rounding ever lets a
// price slip under the floor.
//
// Symbols: F fixed cost, L target profit, R target revenue, c cost of goods,
// S seats (all seats of the outlet), H open hours per month, o target occupancy,
// A spend per person, d average stay (hours).
//
//   M = max(F + L, R × (1 − c))
//   B1 = M / (S × H × o)                 B2 = A × (1 − c) / d
//   peak floor / hour = max(B1, B2)      off-peak floor / hour = max(B1, B2 × o)
//   contribution = seat fee net of tax + credit × (1 − c) − gateway fee
//
// Each hourly floor is rounded up to Rp1.000; a slot's floor is the minutes it
// spends in peak and off-peak hours, weighted per minute and rounded up. The
// worst case is assumed: the credit is spent in full and every hour is used.
// The contribution rounds every part against the outlet (seat net and credit
// margin down, gateway fee up).

import type { WfcAccess, WfcBusinessSettings } from "./seat.ts";

/** The settings numbers the floor reads. */
export type WfcFloorSettings = Pick<
  WfcBusinessSettings,
  | "totalSeats"
  | "openHoursPerMonth"
  | "fixedCostIdr"
  | "targetRevenueIdr"
  | "targetProfitIdr"
  | "targetOccupancyBp"
  | "spendPerPersonIdr"
  | "cogsBp"
  | "avgStayMinutes"
>;

/**
 * Tax assumed inside the seat fee until the accountant answers (brief 1270
 * §6 no. 1): 12%, the highest rate in play, so the net seat fee is never
 * overstated.
 */
export const WFC_FLOOR_SEAT_TAX_BP = 1200;
/** Gateway fee assumed on the whole price: 1%, above the QRIS rate. */
export const WFC_FLOOR_GATEWAY_FEE_BP = 100;
/** Hourly floors round up to this step. */
export const WFC_FLOOR_STEP_IDR = 1000;

const BP = 10_000n;

function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

/** num / den rounded up to the floor step. */
function ceilToStep(num: bigint, den: bigint): bigint {
  const step = BigInt(WFC_FLOOR_STEP_IDR);
  return ceilDiv(num, den * step) * step;
}

const bigMax = (a: bigint, b: bigint) => (a > b ? a : b);

function assertPositiveInt(name: string, value: number, min = 1): void {
  if (!Number.isSafeInteger(value) || value < min)
    throw new RangeError(`${name} must be an integer >= ${min}`);
}

function assertSettings(settings: WfcFloorSettings): void {
  assertPositiveInt("totalSeats", settings.totalSeats);
  assertPositiveInt("openHoursPerMonth", settings.openHoursPerMonth);
  assertPositiveInt("fixedCostIdr", settings.fixedCostIdr);
  assertPositiveInt("targetRevenueIdr", settings.targetRevenueIdr);
  assertPositiveInt("targetProfitIdr", settings.targetProfitIdr, 0);
  assertPositiveInt("targetOccupancyBp", settings.targetOccupancyBp);
  assertPositiveInt("spendPerPersonIdr", settings.spendPerPersonIdr);
  assertPositiveInt("cogsBp", settings.cogsBp);
  assertPositiveInt("avgStayMinutes", settings.avgStayMinutes);
  if (settings.targetOccupancyBp > 10_000 || settings.cogsBp >= 10_000)
    throw new RangeError("occupancy <= 100% and cost of goods < 100%");
}

export type WfcHourlyFloors = {
  /** Floor per seat-hour in peak hours (Rp, rounded up to Rp1.000). */
  readonly peakIdr: number;
  /** Floor per seat-hour outside peak hours (Rp, rounded up to Rp1.000). */
  readonly offPeakIdr: number;
};

/** The hourly floors of one settings version. */
export function wfcHourlyFloors(settings: WfcFloorSettings): WfcHourlyFloors {
  assertSettings(settings);
  const fl = BigInt(settings.fixedCostIdr) + BigInt(settings.targetProfitIdr);
  const margin = BP - BigInt(settings.cogsBp);
  const revenueMargin = BigInt(settings.targetRevenueIdr) * margin;
  // M as a fraction mNum / mDen: (F + L) / 1 or R × (BP − c) / BP.
  const [mNum, mDen] =
    fl * BP >= revenueMargin ? [fl, 1n] : [revenueMargin, BP];
  const occupancy = BigInt(settings.targetOccupancyBp);
  const b1 = ceilToStep(
    mNum * BP,
    mDen *
      BigInt(settings.totalSeats) *
      BigInt(settings.openHoursPerMonth) *
      occupancy,
  );
  const stay = BigInt(settings.avgStayMinutes);
  const spendMargin = BigInt(settings.spendPerPersonIdr) * margin * 60n;
  const b2 = ceilToStep(spendMargin, BP * stay);
  const b2OffPeak = ceilToStep(spendMargin * occupancy, BP * stay * BP);
  return {
    peakIdr: Number(bigMax(b1, b2)),
    offPeakIdr: Number(bigMax(b1, b2OffPeak)),
  };
}

/** The floor of one slot: its peak and off-peak minutes, rounded up to Rp1. */
export function wfcSlotFloorIdr(
  settings: WfcFloorSettings,
  minutes: { readonly peakMinutes: number; readonly offPeakMinutes: number },
): number {
  assertPositiveInt("peakMinutes", minutes.peakMinutes, 0);
  assertPositiveInt("offPeakMinutes", minutes.offPeakMinutes, 0);
  if (minutes.peakMinutes + minutes.offPeakMinutes === 0)
    throw new RangeError("a slot lasts at least one minute");
  const floors = wfcHourlyFloors(settings);
  return Number(
    ceilDiv(
      BigInt(floors.peakIdr) * BigInt(minutes.peakMinutes) +
        BigInt(floors.offPeakIdr) * BigInt(minutes.offPeakMinutes),
      60n,
    ),
  );
}

/** What a sold pass leaves the outlet in the worst case (credit spent in full). */
export function wfcContributionIdr(
  split: { readonly seatFeeIdr: number; readonly creditIdr: number },
  settings: Pick<WfcFloorSettings, "cogsBp">,
  rates: {
    readonly seatTaxBp: number;
    readonly gatewayFeeBp: number;
  } = {
    seatTaxBp: WFC_FLOOR_SEAT_TAX_BP,
    gatewayFeeBp: WFC_FLOOR_GATEWAY_FEE_BP,
  },
): number {
  assertPositiveInt("seatFeeIdr", split.seatFeeIdr, 0);
  assertPositiveInt("creditIdr", split.creditIdr, 0);
  assertPositiveInt("seatTaxBp", rates.seatTaxBp, 0);
  assertPositiveInt("gatewayFeeBp", rates.gatewayFeeBp, 0);
  const seat = BigInt(split.seatFeeIdr);
  const credit = BigInt(split.creditIdr);
  const seatNet = (seat * BP) / (BP + BigInt(rates.seatTaxBp));
  const creditMargin = (credit * (BP - BigInt(settings.cogsBp))) / BP;
  const gateway = ceilDiv((seat + credit) * BigInt(rates.gatewayFeeBp), BP);
  return Number(seatNet + creditMargin - gateway);
}

export type WfcFloorCheck = {
  readonly floorIdr: number;
  readonly contributionIdr: number;
  readonly ok: boolean;
};

/** A slot's split against its floor: ok when the contribution reaches it. */
export function checkWfcSlotFloor(
  settings: WfcFloorSettings,
  split: { readonly seatFeeIdr: number; readonly creditIdr: number },
  minutes: { readonly peakMinutes: number; readonly offPeakMinutes: number },
): WfcFloorCheck {
  const floorIdr = wfcSlotFloorIdr(settings, minutes);
  const contributionIdr = wfcContributionIdr(split, settings);
  return { floorIdr, contributionIdr, ok: contributionIdr >= floorIdr };
}

/**
 * A product against its floor before any slot is known: every minute it may be
 * used counts as peak unless the product sells off-peak only. `minutes` is the
 * reservation length, or for a day pass the longest open day of its facility.
 */
export function checkWfcProductFloor(
  settings: WfcFloorSettings,
  product: {
    readonly access: WfcAccess;
    readonly seatFeeIdr: number;
    readonly creditIdr: number;
  },
  minutes: number,
): WfcFloorCheck {
  return checkWfcSlotFloor(
    settings,
    product,
    product.access === "off_peak"
      ? { peakMinutes: 0, offPeakMinutes: minutes }
      : { peakMinutes: minutes, offPeakMinutes: 0 },
  );
}
