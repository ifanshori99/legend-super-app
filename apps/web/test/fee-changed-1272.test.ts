// 1272 fee second opinion P2-2: the total the payer saw travels with the create
// call, and a price that changed since (409 FEE_CHANGED) is recognised.
import { describe, expect, it } from "vitest";
import { feeChanged } from "../src/features/ws03-qr-order/lib/pay-failure.ts";
import { shownChargedIdr } from "../src/features/ws05-payment/shown-price.ts";

const methods = [
  { method: "qris", guestFeeIdr: 0, totalIdr: 100_000, channels: [] },
  {
    method: "va",
    guestFeeIdr: null,
    totalIdr: null,
    channels: [
      { code: "BC", guestFeeIdr: 4_000, totalIdr: 104_000 },
      { code: "I1", guestFeeIdr: 0, totalIdr: 100_000 },
    ],
  },
  { method: "card", guestFeeIdr: 3_000, totalIdr: 103_000, channels: [] },
];

describe("1272 P2-2 the total the payer saw", () => {
  it("is sent for a channel or method with a fee, never for one without", () => {
    expect(shownChargedIdr(methods, "va", "BC")).toBe(104_000);
    expect(shownChargedIdr(methods, "card", null)).toBe(103_000);
    expect(shownChargedIdr(methods, "va", "I1")).toBeUndefined();
    expect(shownChargedIdr(methods, "qris", null)).toBeUndefined();
    expect(shownChargedIdr(methods, "ewallet", "OV")).toBeUndefined();
  });

  it("recognises FEE_CHANGED and nothing else", () => {
    expect(feeChanged({ status: 409, code: "FEE_CHANGED" })).toBe(true);
    expect(feeChanged({ status: 409, code: "CONFLICT" })).toBe(false);
    expect(feeChanged(null)).toBe(false);
  });
});
