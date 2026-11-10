// legend-94q2l: the money of a failed-item manual refund (ORD-09). Pure: no
// database, no clock. `order-recovery-refund.ts` feeds it the order row, the
// failed line's total and what other issues of the order already released.
//
// The guest paid the line pro rata with the order's discount, service charge
// and PBJT, so the refund is the line's share of each component:
// `s = lineTotalIdr / subtotalIdr`, every component of `orderRevenueSplit`
// times `s`, rounded half up (BigInt, no float). The order's cash rounding is
// not part of it. `wantedIdr = gross - discount + service + pbjt`.
//
// What the order can still give back is `(total - deposit) - released`; the
// refund is cut to that room and the shortfall is reported, never hidden. A
// cut refund scales discount, service and PBJT by `amount / wanted` and takes
// gross as the rest, so `gross - discount + service + pbjt = amount` still
// holds (the `order.refunded` payload checks it) and no component is negative.

import { orderRevenueSplit, type OrderRevenueInput } from "./order-revenue.ts";

export type RecoveryRefundSplit = {
  wantedIdr: number;
  amountIdr: number;
  shortfallIdr: number;
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
};

const ZERO: RecoveryRefundSplit = {
  wantedIdr: 0,
  amountIdr: 0,
  shortfallIdr: 0,
  grossSalesIdr: 0,
  discountIdr: 0,
  serviceChargeIdr: 0,
  pbjtIdr: 0,
};

/** round(value * numerator / denominator), half up; all operands >= 0. */
function mulDivHalfUp(
  value: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  return (2n * value * numerator + denominator) / (2n * denominator);
}

export type LineShareSplit = {
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
};

/**
 * The share of the order's gross, discount, service and PBJT that `baseIdr`
 * weighs: `s = baseIdr / subtotalIdr`, each component rounded half up (BigInt).
 * Used by the failed-item refund: a line never weighs more than its order, so
 * the base is cut to the subtotal. All zero for a non-positive subtotal or
 * base, before the order's identity is checked.
 */
export function lineShareSplit(
  order: OrderRevenueInput,
  baseIdr: number,
): LineShareSplit {
  if (order.subtotalIdr <= 0 || baseIdr <= 0)
    return {
      grossSalesIdr: 0,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
    };
  const split = orderRevenueSplit(order);
  const subtotal = BigInt(order.subtotalIdr);
  const base = BigInt(Math.min(baseIdr, order.subtotalIdr));
  const share = (value: number) =>
    Number(mulDivHalfUp(BigInt(value), base, subtotal));
  return {
    grossSalesIdr: share(split.grossSalesIdr),
    discountIdr: share(split.discountIdr),
    serviceChargeIdr: share(split.serviceChargeIdr),
    pbjtIdr: share(split.pbjtIdr),
  };
}

export function recoveryRefundSplit(input: {
  order: OrderRevenueInput & { depositAppliedIdr: number };
  lineTotalIdr: number;
  /** Already released by other issues of this order. */
  releasedIdr: number;
}): RecoveryRefundSplit {
  const { order, releasedIdr } = input;
  if (order.subtotalIdr <= 0 || input.lineTotalIdr <= 0) return { ...ZERO };
  const shares = lineShareSplit(order, input.lineTotalIdr);
  let gross = BigInt(shares.grossSalesIdr);
  let discount = BigInt(shares.discountIdr);
  let service = BigInt(shares.serviceChargeIdr);
  let pbjt = BigInt(shares.pbjtIdr);
  const wanted = gross - discount + service + pbjt;
  if (wanted <= 0n) return { ...ZERO };

  const room = BigInt(
    Math.max(0, order.totalIdr - order.depositAppliedIdr - releasedIdr),
  );
  const amount = wanted < room ? wanted : room;
  if (amount < wanted) {
    discount = mulDivHalfUp(discount, amount, wanted);
    service = mulDivHalfUp(service, amount, wanted);
    pbjt = mulDivHalfUp(pbjt, amount, wanted);
    gross = amount + discount - service - pbjt;
    if (gross < 0n) {
      // Rounding pushed the taxes past what the amount carries: take the
      // excess from PBJT first, then from the service charge.
      let excess = -gross;
      const fromPbjt = excess < pbjt ? excess : pbjt;
      pbjt -= fromPbjt;
      excess -= fromPbjt;
      service -= excess;
      gross = 0n;
    }
  }
  return {
    wantedIdr: Number(wanted),
    amountIdr: Number(amount),
    shortfallIdr: Number(wanted - amount),
    grossSalesIdr: Number(gross),
    discountIdr: Number(discount),
    serviceChargeIdr: Number(service),
    pbjtIdr: Number(pbjt),
  };
}

export type RecoveryChargeSplit = {
  differenceIdr: number;
  grossSalesIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
  /** gross + service + pbjt: what the guest pays. */
  amountIdr: number;
};

/**
 * legend-i83ls: what the guest owes for a dearer swap. The order's service
 * charge and PBJT are computed on `base = subtotal - discount`, so their
 * effective rates are `service / base` and `pbjt / base`. The price difference
 * `differenceIdr` (D) pays those rates in full: `service = D * service / base`,
 * `pbjt = D * pbjt / base`, half up (BigInt). A full discount (`base <= 0`)
 * leaves both at zero. No deposit applies (CTO default, a business decision:
 * the order's discount does not cut D) and there is no room to cut to.
 *
 * Exclusive prices: gross = D, amount = D + service + pbjt. Inclusive prices
 * (`pricesIncludeTax`): D already holds the taxes, amount = D and
 * gross = D - service - pbjt; a negative gross (rounding) is taken from PBJT
 * first, then from the service charge, like `recoveryRefundSplit`.
 * `amount = gross + service + pbjt` holds exactly. No subtotal or no
 * difference is all zero (the order's identity is checked only when D > 0).
 */
export function recoveryChargeSplit(input: {
  order: OrderRevenueInput;
  differenceIdr: number;
}): RecoveryChargeSplit {
  const { order } = input;
  const difference = Math.max(0, input.differenceIdr);
  const zero = {
    differenceIdr: difference,
    grossSalesIdr: 0,
    serviceChargeIdr: 0,
    pbjtIdr: 0,
    amountIdr: 0,
  };
  if (order.subtotalIdr <= 0 || difference <= 0) return zero;
  const split = orderRevenueSplit(order);
  const base = BigInt(order.subtotalIdr - order.discountIdr);
  const diff = BigInt(difference);
  let service = 0n;
  let pbjt = 0n;
  if (base > 0n) {
    service = mulDivHalfUp(BigInt(split.serviceChargeIdr), diff, base);
    pbjt = mulDivHalfUp(BigInt(split.pbjtIdr), diff, base);
  }
  let gross: bigint;
  let amount: bigint;
  if (order.pricesIncludeTax) {
    amount = diff;
    gross = diff - service - pbjt;
    if (gross < 0n) {
      let excess = -gross;
      const fromPbjt = excess < pbjt ? excess : pbjt;
      pbjt -= fromPbjt;
      excess -= fromPbjt;
      service -= excess;
      gross = 0n;
    }
  } else {
    gross = diff;
    amount = diff + service + pbjt;
  }
  return {
    differenceIdr: difference,
    grossSalesIdr: Number(gross),
    serviceChargeIdr: Number(service),
    pbjtIdr: Number(pbjt),
    amountIdr: Number(amount),
  };
}
