// legend-9z1r5 (brief 980): several partial refunds of ONE sale, each rounded
// by allocateIdr, must never add up to more than was paid, per part (goods
// revenue, service charge, PBJT tax) and in total. Money rule "jangan sampai
// rugi": when in doubt, the rule that LIMITS what goes out.
//
// Pure function test (no database), written from the card text, the existing
// refundSplit contract (pos-refund-split.test.ts: parts sum to the refund
// amount; gross - discount + service + pbjt == amount) and the allocateIdr
// contract (largest remainder, parts sum exactly to the amount), not from the
// implementation.
//
// Scenario (found by hand calculation, Rp1 over-reversal): a sale of three
// items of Rp33.333 (goods 99.999) with PBJT 10% (Rp10.000), paid 109.999.
// The customer returns the items one by one and is refunded Rp36.666,
// Rp36.666 and Rp36.667 (sum 109.999 = everything paid). Splitting each refund
// over [goods 99.999, service 0, tax 10.000] with largest remainder gives
//   refund 1: goods 33.333, tax 3.333
//   refund 2: goods 33.333, tax 3.333
//   refund 3: goods 33.334, tax 3.333
// i.e. goods reversed 100.000 > 99.999 sold, tax reversed 9.999 < 10.000
// collected. The total is right, but revenue is over-reversed by Rp1 (and the
// tax liability under-reversed) because every refund is rounded on its own,
// without knowing what earlier refunds already took from each part.
//
// Assumptions:
//  - refundSplit(order, amountIdr) is the single place that divides a refund
//    into goods / service / tax parts; the engineer may change its signature
//    (for example to pass what earlier refunds already took per part). The
//    call is isolated in `splitSequence` below: adapt only that helper, never
//    the asserted rules.
//  - Order shape as in pos-refund-split.test.ts (exclusive prices, no promo
//    re-pricing, no discount): goods part = grossSalesIdr - discountIdr.
//  - Not written because no over-refund reproduces by reasoning:
//    refundAllocation / stillRefundableByMethod (parts of the remaining
//    tender amounts never exceed what is left: ceil(amount * w / sum) <= w
//    when amount <= sum), crm-promo-refund's kept-share rounding (the payout
//    is capped by min(remainingPaid, ...), so the total can not pass paid) and
//    FIFO tender lines (a tender line is capped by the tender balance).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-rounding-cap-980.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import { refundSplit } from "../services/pos-order-corrections.ts";

type Split = ReturnType<typeof refundSplit>;
type SplitOrder = Parameters<typeof refundSplit>[0];

const order = (over: Record<string, unknown>): SplitOrder =>
  ({
    subtotalIdr: 99_999,
    discountIdr: 0,
    serviceChargeIdr: 0,
    taxIdr: 10_000,
    pricesIncludeTax: false,
    ...over,
  }) as unknown as SplitOrder;

const PAID = 109_999;
const REFUNDS = [36_666, 36_666, 36_667];

/** The splits of successive partial refunds of the same sale, oldest first. */
function splitSequence(sale: SplitOrder, amounts: readonly number[]): Split[] {
  // The earlier refunds are passed one by one: the split replays them to know
  // what each part really booked (a part held at 0 is not recomputable from
  // the cumulative total alone).
  return amounts.map((amount, index) =>
    refundSplit(sale, amount, null, amounts.slice(0, index)),
  );
}

const goods = (s: Split) => s.grossSalesIdr - s.discountIdr;
const total = (parts: readonly number[]) =>
  parts.reduce((sum, part) => sum + part, 0);

describe("legend-9z1r5 partial refunds rounded one by one never reverse more than was sold", () => {
  it("980-1 each split sums to its refund amount (control: the single split is exact)", () => {
    const splits = splitSequence(order({}), REFUNDS);
    splits.forEach((split, index) => {
      expect(
        goods(split) + split.serviceChargeIdr + split.pbjtIdr,
        `refund ${index + 1}`,
      ).toBe(REFUNDS[index]);
    });
    expect(total(REFUNDS)).toBe(PAID);
  });

  it("980-2 refunding everything paid in three partials reverses goods 99.999 exactly, never 100.000", () => {
    const splits = splitSequence(order({}), REFUNDS);
    expect(total(splits.map(goods))).toBeLessThanOrEqual(99_999);
  });

  it("980-3 the PBJT reversed over three partials that return everything paid is exactly the Rp10.000 collected, not less", () => {
    const splits = splitSequence(order({}), REFUNDS);
    expect(total(splits.map((s) => s.pbjtIdr))).toBe(10_000);
    expect(total(splits.map(goods))).toBe(99_999);
    expect(total(splits.map((s) => s.serviceChargeIdr))).toBe(0);
  });

  it("980-4 whatever the order of the partials, no part is reversed beyond what the sale holds", () => {
    const orders = [
      [36_667, 36_666, 36_666],
      [36_666, 36_667, 36_666],
    ];
    for (const amounts of orders) {
      const splits = splitSequence(order({}), amounts);
      expect(total(splits.map(goods)), amounts.join(",")).toBeLessThanOrEqual(
        99_999,
      );
      expect(
        total(splits.map((s) => s.pbjtIdr)),
        amounts.join(","),
      ).toBeLessThanOrEqual(10_000);
    }
  });

  it("980-5 a part held at 0 by an earlier refund never exceeds what the sale holds of it (service Rp4.145, not Rp4.146)", () => {
    // goods 82.908, service 4.145, PBJT 8.705 (sum 95.758); the Rp5 refund
    // makes the service part shrink in the cumulative split, so it is held at
    // 0 there and the next refunds must not recompute it from the total.
    const sale = order({
      subtotalIdr: 82_908,
      serviceChargeIdr: 4_145,
      taxIdr: 8_705,
    });
    const amounts = [38_361, 39_316, 5, 18_076];
    const splits = splitSequence(sale, amounts);
    splits.forEach((split, index) => {
      expect(
        goods(split) + split.serviceChargeIdr + split.pbjtIdr,
        `refund ${index + 1}`,
      ).toBe(amounts[index]);
    });
    expect(total(splits.map(goods))).toBeLessThanOrEqual(82_908);
    expect(total(splits.map((s) => s.serviceChargeIdr))).toBeLessThanOrEqual(
      4_145,
    );
    expect(total(splits.map((s) => s.pbjtIdr))).toBeLessThanOrEqual(8_705);
    // Everything paid is refunded: every part is reversed exactly.
    expect(total(amounts)).toBe(95_758);
    expect(total(splits.map(goods))).toBe(82_908);
    expect(total(splits.map((s) => s.serviceChargeIdr))).toBe(4_145);
    expect(total(splits.map((s) => s.pbjtIdr))).toBe(8_705);
  });
});
