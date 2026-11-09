// Pure helpers of the order promo wiring (bead legend-souz; PRD v1.7 §3.21;
// ORD-03 server pricing; calc order discount -> service -> tax, legend-559).
// No database: the DB behaviour is in order-promo-db.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import type { PromotionApplicationResult } from "@starter/shared/crm";
import { promoDiscountForTax, toPromoLines } from "../services/order-promo";
import { clampedDiscountOf } from "../services/order-promo-refund";

/** The HttpError status/code a call throws, or null when it does not. */
function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    const { status, code } = error as { status?: number; code?: string };
    return { status, code };
  }
  return null;
}

const result = (totalDiscountIdr: number): PromotionApplicationResult => ({
  evaluations: [],
  totalDiscountIdr: idr(totalDiscountIdr),
});

describe("legend-souz toPromoLines", () => {
  it("[ORD-03] a variant price plus modifiers is the promo unit price; line order is kept", () => {
    const latte = randomUUID();
    const croissant = randomUUID();
    expect(
      toPromoLines([
        {
          menuItemId: latte,
          quantity: 3,
          unitPriceIdr: idr(32_000),
          modifiersTotalIdr: idr(6_000),
        },
        {
          menuItemId: croissant,
          quantity: 1,
          unitPriceIdr: idr(28_000),
          modifiersTotalIdr: idr(0),
        },
      ]),
    ).toEqual([
      {
        menuItemId: latte,
        quantity: 3,
        unitPriceIdr: 38_000,
        lineTotalIdr: 114_000,
      },
      {
        menuItemId: croissant,
        quantity: 1,
        unitPriceIdr: 28_000,
        lineTotalIdr: 28_000,
      },
    ]);
  });

  it("[ORD-03] an empty cart, a bad quantity, a negative or fractional price, or a non-uuid item is refused", () => {
    const line = {
      menuItemId: randomUUID(),
      quantity: 1,
      unitPriceIdr: idr(10_000),
      modifiersTotalIdr: idr(0),
    };
    const refused = { status: 422, code: "VALIDATION_ERROR" };
    expect(refusal(() => toPromoLines([]))).toEqual(refused);
    for (const bad of [
      { ...line, quantity: 0 },
      { ...line, quantity: 1.5 },
      { ...line, unitPriceIdr: -1 as never },
      { ...line, modifiersTotalIdr: 0.5 as never },
      { ...line, menuItemId: "latte" },
    ])
      expect(refusal(() => toPromoLines([bad]))).toEqual(refused);
  });
});

describe("legend-souz promoDiscountForTax", () => {
  it("[ORD-03] no promo step is Rp0; a quote gives its total as the tax engine's orderDiscountIdr", () => {
    expect(promoDiscountForTax(null)).toBe(0);
    expect(
      promoDiscountForTax({
        result: result(12_500),
        totalDiscountIdr: idr(12_500),
      }),
    ).toBe(12_500);
  });

  it("[ORD-03] a quote whose total disagrees with its result fails closed", () => {
    expect(() =>
      promoDiscountForTax({
        result: result(12_500),
        totalDiscountIdr: idr(10_000),
      }),
    ).toThrow();
  });
});

describe("legend-souz clampedDiscountOf (owner Q41 clamp)", () => {
  const adjusted = (withdrawn: number, total: number) => ({
    adjusted: true as const,
    refundedSubtotalIdr: idr(0),
    withdrawnDiscountIdr: idr(withdrawn),
    refundDueIdr: idr(0),
    uncoveredIdr: idr(0),
    totalDiscountIdr: idr(total),
    keptPayableIdr: idr(0),
    remainingPaidIdr: idr(0),
    withdrawn: [],
    keptLineDiscounts: [],
    voucherIds: [],
    facilityRewardIds: [],
  });

  it("[LOY-03] only the part removed by the clamp, never a withdrawal, never negative", () => {
    expect(clampedDiscountOf(20_000, adjusted(0, 15_000))).toBe(5_000);
    expect(clampedDiscountOf(20_000, adjusted(8_000, 12_000))).toBe(0);
    expect(clampedDiscountOf(20_000, adjusted(8_000, 10_000))).toBe(2_000);
    expect(clampedDiscountOf(15_000, adjusted(0, 15_000))).toBe(0);
  });
});
