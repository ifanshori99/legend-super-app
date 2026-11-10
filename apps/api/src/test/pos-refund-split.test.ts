// Revenue split of a re-priced promo refund (bead legend-aef1), pure function.
// The sale books gross without service and tax on an inclusive-price order
// (order-revenue.ts), so the refund's gross must be on the same basis or the
// gross and discount accounts over-reverse (architect review K).
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/pos-refund-split.test.ts" pnpm test

import { describe, expect, it } from "vitest";
import { refundSplit } from "../services/pos-order-corrections.ts";

const order = (over: Record<string, unknown>) =>
  ({
    subtotalIdr: 100_000,
    discountIdr: 20_000,
    serviceChargeIdr: 0,
    taxIdr: 0,
    pricesIncludeTax: false,
    ...over,
  }) as unknown as Parameters<typeof refundSplit>[0];

const sum = (s: ReturnType<typeof refundSplit>) =>
  s.grossSalesIdr - s.discountIdr + s.serviceChargeIdr + s.pbjtIdr;

describe("refundSplit on a re-priced promo order", () => {
  it("exclusive prices: gross is the refunded subtotal, discount the rest (promo withdrawn: 50k / 20k)", () => {
    const split = refundSplit(order({}), 30_000, 50_000);
    expect(split).toMatchObject({ grossSalesIdr: 50_000, discountIdr: 20_000 });
    expect(sum(split)).toBe(30_000);
  });

  it("inclusive prices: the refunded value drops its tax share first (gross 100k, discount 19k, not 110k / 29k)", () => {
    // 2 x 110k with 10% tax inside (20k), promo 20k withdrawn: paid 200k,
    // refunding item A leaves B at 110k, so the payout is 90k.
    const split = refundSplit(
      order({
        subtotalIdr: 220_000,
        taxIdr: 20_000,
        pricesIncludeTax: true,
      }),
      90_000,
      110_000,
    );
    expect(split).toMatchObject({
      grossSalesIdr: 100_000,
      discountIdr: 19_000,
      pbjtIdr: 9_000,
    });
    expect(sum(split)).toBe(90_000);
  });

  it("without a re-priced promo the old pro-rata split stays", () => {
    const split = refundSplit(order({}), 30_000);
    expect(split).toMatchObject({
      grossSalesIdr: 37_500,
      discountIdr: 7_500,
    });
  });
});
