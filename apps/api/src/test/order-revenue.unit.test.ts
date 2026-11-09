// legend-kej3: unit test of the pure revenue split of an `orders` row, the
// amounts every `order.paid` payload carries (docs/design/auto-journals.md).
//
// Assumptions (the design fixes the identities, the shapes are from the brief):
// - `orderRevenueSplit(row)` takes {subtotalIdr, discountIdr, serviceChargeIdr,
//   taxIdr, roundingIdr, totalIdr, pricesIncludeTax} and returns
//   {grossSalesIdr, discountIdr, serviceChargeIdr, pbjtIdr, roundingIdr, totalIdr}.
// - A row that fails the identity of its tax mode throws an error named
//   `OrderRevenueMismatch` (fail closed); the test checks the class name so it
//   does not depend on how the class is exported.

import { describe, expect, it } from "vitest";
import { orderRevenueSplit } from "../services/order-revenue.ts";

type Row = Parameters<typeof orderRevenueSplit>[0];

const base: Row = {
  subtotalIdr: 0,
  discountIdr: 0,
  serviceChargeIdr: 0,
  taxIdr: 0,
  roundingIdr: 0,
  totalIdr: 0,
  pricesIncludeTax: false,
};

function mismatchOf(row: Row): string | null {
  try {
    orderRevenueSplit(row);
    return null;
  } catch (error) {
    return error instanceof Error ? error.constructor.name : String(error);
  }
}

describe("legend-kej3 orderRevenueSplit", () => {
  it("ORD-REV-01 exclusive prices: gross sales are the subtotal and the parts add up to the total", () => {
    const row: Row = {
      ...base,
      subtotalIdr: 100_000,
      discountIdr: 10_000,
      serviceChargeIdr: 5_000,
      taxIdr: 9_500,
      roundingIdr: 500,
      totalIdr: 105_000,
    };
    expect(orderRevenueSplit(row)).toEqual({
      grossSalesIdr: 100_000,
      discountIdr: 10_000,
      serviceChargeIdr: 5_000,
      pbjtIdr: 9_500,
      roundingIdr: 500,
      totalIdr: 105_000,
    });
  });

  it("ORD-REV-02 inclusive prices (harga nett): gross sales are the subtotal less the service charge and tax it already holds", () => {
    const row: Row = {
      ...base,
      pricesIncludeTax: true,
      subtotalIdr: 110_000,
      discountIdr: 10_000,
      serviceChargeIdr: 5_000,
      taxIdr: 9_000,
      roundingIdr: 0,
      totalIdr: 100_000,
    };
    const split = orderRevenueSplit(row);
    expect(split).toEqual({
      grossSalesIdr: 96_000,
      discountIdr: 10_000,
      serviceChargeIdr: 5_000,
      pbjtIdr: 9_000,
      roundingIdr: 0,
      totalIdr: 100_000,
    });
    // The identity the order.paid payload schema checks.
    expect(
      split.grossSalesIdr -
        split.discountIdr +
        split.serviceChargeIdr +
        split.pbjtIdr +
        split.roundingIdr,
    ).toBe(split.totalIdr);
  });

  it("ORD-REV-03 negative rounding is kept as is on both modes", () => {
    expect(
      orderRevenueSplit({
        ...base,
        subtotalIdr: 10_000,
        taxIdr: 1_000,
        roundingIdr: -100,
        totalIdr: 10_900,
      }),
    ).toMatchObject({ grossSalesIdr: 10_000, roundingIdr: -100 });
    expect(
      orderRevenueSplit({
        ...base,
        pricesIncludeTax: true,
        subtotalIdr: 11_000,
        taxIdr: 1_000,
        roundingIdr: -100,
        totalIdr: 10_900,
      }),
    ).toMatchObject({ grossSalesIdr: 10_000, roundingIdr: -100 });
  });

  it("ORD-REV-04 a full comp (discount equals gross) splits to a zero total", () => {
    expect(
      orderRevenueSplit({
        ...base,
        subtotalIdr: 100_000,
        discountIdr: 100_000,
      }),
    ).toEqual({
      grossSalesIdr: 100_000,
      discountIdr: 100_000,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      roundingIdr: 0,
      totalIdr: 0,
    });
  });

  it("ORD-REV-05 an exclusive row that does not add up throws OrderRevenueMismatch", () => {
    expect(
      mismatchOf({
        ...base,
        subtotalIdr: 100_000,
        taxIdr: 10_000,
        totalIdr: 100_000,
      }),
    ).toBe("OrderRevenueMismatch");
  });

  it("ORD-REV-06 an inclusive row that does not add up throws OrderRevenueMismatch", () => {
    expect(
      mismatchOf({
        ...base,
        pricesIncludeTax: true,
        subtotalIdr: 110_000,
        taxIdr: 10_000,
        // Exclusive arithmetic (subtotal + tax) must not pass an inclusive row.
        totalIdr: 120_000,
      }),
    ).toBe("OrderRevenueMismatch");
  });

  it("ORD-REV-07 the identity follows the flag: an inclusive-shaped row fails as exclusive", () => {
    const row: Row = {
      ...base,
      subtotalIdr: 110_000,
      taxIdr: 10_000,
      totalIdr: 110_000,
    };
    expect(mismatchOf(row)).toBe("OrderRevenueMismatch");
    expect(mismatchOf({ ...row, pricesIncludeTax: true })).toBeNull();
  });
});
