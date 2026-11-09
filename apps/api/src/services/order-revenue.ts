// legend-kej3: the revenue split of one `orders` row, the amounts an
// `order.paid` payload carries (POS complete and QR pay-first fire).
//
// `pricesIncludeTax` picks the identity the stored amounts must satisfy:
// - exclusive: subtotal - discount + service + tax + rounding = total, and the
//   gross sales are the subtotal;
// - inclusive (harga nett, legend-zmc2): the subtotal already holds the
//   service charge and tax, so subtotal - discount + rounding = total and the
//   gross sales are subtotal - service - tax.
// Both yield gross - discount + service + tax + rounding = total, the check
// `orderPaidPayloadSchema` runs. A row that fails its identity is never
// guessed into a journal: the split throws (fail closed).

export type OrderRevenueInput = {
  readonly subtotalIdr: number;
  readonly discountIdr: number;
  readonly serviceChargeIdr: number;
  readonly taxIdr: number;
  readonly roundingIdr: number;
  readonly totalIdr: number;
  readonly pricesIncludeTax: boolean;
};

export type OrderRevenueSplit = {
  readonly grossSalesIdr: number;
  readonly discountIdr: number;
  readonly serviceChargeIdr: number;
  readonly pbjtIdr: number;
  readonly roundingIdr: number;
  readonly totalIdr: number;
};

/** The order row's amounts do not satisfy its tax mode's identity. */
export class OrderRevenueMismatch extends Error {
  readonly code = "ORDER_REVENUE_MISMATCH";
}

export function orderRevenueSplit(order: OrderRevenueInput): OrderRevenueSplit {
  const {
    subtotalIdr,
    discountIdr,
    serviceChargeIdr,
    taxIdr,
    roundingIdr,
    totalIdr,
    pricesIncludeTax,
  } = order;
  const expected = pricesIncludeTax
    ? subtotalIdr - discountIdr + roundingIdr
    : subtotalIdr - discountIdr + serviceChargeIdr + taxIdr + roundingIdr;
  if (expected !== totalIdr)
    throw new OrderRevenueMismatch(
      `Order amounts do not add up to the total (${
        pricesIncludeTax ? "inclusive" : "exclusive"
      } prices)`,
    );
  const grossSalesIdr = pricesIncludeTax
    ? subtotalIdr - serviceChargeIdr - taxIdr
    : subtotalIdr;
  if (grossSalesIdr < 0)
    throw new OrderRevenueMismatch("Order gross sales are negative");
  return {
    grossSalesIdr,
    discountIdr,
    serviceChargeIdr,
    pbjtIdr: taxIdr,
    roundingIdr,
    totalIdr,
  };
}
