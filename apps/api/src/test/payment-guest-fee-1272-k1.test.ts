// 1272 K1 (design duitku-fee-passthrough §1-§2, §5): the guest service fee is
// a gross-up of the bill, so the outlet nets at least the bill after the
// gateway's MDR, and the guest pays the smallest such fee. Pure functions only.
import { describe, expect, it } from "vitest";
import {
  feeQuoteAccepted,
  gatewayFeeOf,
  grossUpGuestFee,
  guestFeeFor,
  guestFeeRatesOf,
  type GuestFeeRate,
} from "../services/payment-guest-fee";

/** Independent reference: the first g >= 0 with fee(B+g) <= g, by scanning. */
function scanMinimal(base: number, rate: GuestFeeRate): number {
  for (let g = 0; ; g += 1) if (gatewayFeeOf(base + g, rate) <= g) return g;
}

/** Deterministic pseudo-random sequence (no flaky property test). */
function* lcg(seed: number) {
  let state = seed >>> 0;
  for (;;) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    yield state;
  }
}

describe("gatewayFeeOf", () => {
  it("rounds the percentage up and adds the flat part", () => {
    expect(gatewayFeeOf(10_000, { bps: 0, flatIdr: 4_000 })).toBe(4_000);
    expect(gatewayFeeOf(10_000, { bps: 150, flatIdr: 0 })).toBe(150);
    expect(gatewayFeeOf(10_001, { bps: 150, flatIdr: 0 })).toBe(151);
    expect(gatewayFeeOf(1, { bps: 1, flatIdr: 0 })).toBe(1);
    expect(gatewayFeeOf(0, { bps: 150, flatIdr: 0 })).toBe(0);
  });
});

describe("grossUpGuestFee", () => {
  it.each([
    // [bill, bps, flat, g]
    [10_000, 0, 0, 0],
    [10_000, 0, 4_000, 4_000], // flat only: exactly the flat part
    [10_000, 150, 0, 153], // 1.5% of 10_153 = 152.3 -> 153
    [100_000, 200, 0, 2_041], // 2% of 102_041 = 2_040.82 -> 2_041
    [1, 150, 0, 1], // small bill: the percentage still rounds up to 1
    [1, 0, 0, 0],
    [1, 9_999, 0, 9_999],
    [50_000, 167, 1_000, 1_867],
    [1_000_000_000, 500, 10_000, 52_642_106],
  ])("bill %i at %i bps + Rp%i -> Rp%i", (bill, bps, flatIdr, expected) => {
    const rate = { bps, flatIdr };
    const g = grossUpGuestFee(bill, rate);
    expect(g).toBe(expected);
    expect(g).toBe(scanMinimal(bill, rate));
    // Outlet: the charged amount minus the MDR is at least the bill.
    expect(bill + g - gatewayFeeOf(bill + g, rate)).toBeGreaterThanOrEqual(
      bill,
    );
    // Guest: one rupiah less would leave the outlet short (g is minimal).
    if (g > 0) expect(gatewayFeeOf(bill + g - 1, rate)).toBeGreaterThan(g - 1);
  });

  it("property: bps 0..500, flat 0..10_000, bill 1..10^9 nets the bill and is minimal", () => {
    const random = lcg(1272);
    const next = () => random.next().value as number;
    for (let i = 0; i < 4_000; i += 1) {
      const rate = { bps: next() % 501, flatIdr: next() % 10_001 };
      const bill = 1 + (next() % 1_000_000_000);
      const g = grossUpGuestFee(bill, rate);
      const charged = bill + g;
      expect(charged - gatewayFeeOf(charged, rate)).toBeGreaterThanOrEqual(
        bill,
      );
      expect(gatewayFeeOf(charged, rate)).toBeLessThanOrEqual(g);
      if (g > 0) expect(gatewayFeeOf(charged - 1, rate)).toBeGreaterThan(g - 1);
    }
  });

  it("refuses a bill or rate it cannot gross up", () => {
    expect(() => grossUpGuestFee(0, { bps: 100, flatIdr: 0 })).toThrow(
      RangeError,
    );
    expect(() => grossUpGuestFee(1.5, { bps: 100, flatIdr: 0 })).toThrow(
      RangeError,
    );
    expect(() => grossUpGuestFee(100, { bps: 10_000, flatIdr: 0 })).toThrow(
      RangeError,
    );
    expect(() => grossUpGuestFee(100, { bps: -1, flatIdr: 0 })).toThrow(
      RangeError,
    );
  });
});

describe("guestFeeRatesOf", () => {
  const config = {
    maxFeeBps_va: 0,
    maxFeeFlatIdr_va: 5_000,
    maxFeeBps_ewallet: 300,
    maxFeeBps_card: 300,
    maxFeeFlatIdr_card: 2_500,
    maxFeeBps_qris: 70,
    guestFees: {
      BC: { bps: 0, flatIdr: 4_000 },
      OV: { bps: 167, flatIdr: 0 },
      VC: { bps: 290, flatIdr: 2_000 },
      SP: { bps: 70, flatIdr: 0 },
    },
  };

  it("reads rates within the method cap", () => {
    const rates = guestFeeRatesOf(config);
    expect(rates.get("BC")).toEqual({ bps: 0, flatIdr: 4_000 });
    expect(rates.get("OV")).toEqual({ bps: 167, flatIdr: 0 });
    expect(rates.get("VC")).toEqual({ bps: 290, flatIdr: 2_000 });
  });

  it("never reads a QRIS rate, even a filled one (§5)", () => {
    expect(guestFeeRatesOf(config).has("SP")).toBe(false);
  });

  it("drops a rate above its cap, without a cap, or malformed", () => {
    const rates = guestFeeRatesOf({
      maxFeeBps_va: 0,
      maxFeeFlatIdr_va: 3_000,
      guestFees: {
        BC: { bps: 0, flatIdr: 4_000 }, // above the flat cap
        M2: { bps: 0, flatIdr: 3_000 }, // at the cap: kept
        OV: { bps: 100, flatIdr: 0 }, // e-wallet has no cap
        XX: { bps: 0, flatIdr: 1 }, // unknown code
        B1: { bps: 0, flatIdr: 1, extra: 1 }, // not strict
      },
    });
    expect([...rates.keys()]).toEqual(["M2"]);
    expect(guestFeeRatesOf({}).size).toBe(0);
    expect(guestFeeRatesOf({ guestFees: "nope" }).size).toBe(0);
  });
});

describe("guestFeeFor", () => {
  const rates = new Map<string, GuestFeeRate>([
    ["BC", { bps: 0, flatIdr: 4_000 }],
    ["VC", { bps: 290, flatIdr: 2_000 }],
  ]);
  const base = { baseIdr: 100_000, rates };

  it("is 0 for a method the guest does not pay a fee on", () => {
    expect(
      guestFeeFor({
        ...base,
        method: "va",
        channelCode: "BC",
        feeMethods: [],
      }),
    ).toBe(0);
    expect(
      guestFeeFor({
        ...base,
        method: "qris",
        channelCode: null,
        feeMethods: ["va", "ewallet", "card"],
      }),
    ).toBe(0);
  });

  it("grosses up the channel's rate when the method is on", () => {
    expect(
      guestFeeFor({
        ...base,
        method: "va",
        channelCode: "BC",
        feeMethods: ["va"],
      }),
    ).toBe(4_000);
    expect(
      guestFeeFor({
        ...base,
        method: "card",
        channelCode: "VC",
        feeMethods: ["card"],
      }),
    ).toBe(grossUpGuestFee(100_000, { bps: 290, flatIdr: 2_000 }));
  });

  it("is null (hidden, never a silent 0) for a fee method without a rate", () => {
    expect(
      guestFeeFor({
        ...base,
        method: "va",
        channelCode: "M2",
        feeMethods: ["va"],
      }),
    ).toBeNull();
    expect(
      guestFeeFor({
        ...base,
        method: "ewallet",
        channelCode: null,
        feeMethods: ["ewallet"],
      }),
    ).toBeNull();
    // A channel code of another method's category is not this method's rate.
    expect(
      guestFeeFor({
        ...base,
        method: "ewallet",
        channelCode: "BC",
        feeMethods: ["ewallet"],
      }),
    ).toBeNull();
  });
});

describe("feeQuoteAccepted (§1)", () => {
  it("takes a quote at or up to one rupiah under our fee", () => {
    expect(feeQuoteAccepted(153, 153)).toBe(true);
    expect(feeQuoteAccepted(152, 153)).toBe(true);
    expect(feeQuoteAccepted(151, 153)).toBe(false);
    expect(feeQuoteAccepted(154, 153)).toBe(false);
  });
});
