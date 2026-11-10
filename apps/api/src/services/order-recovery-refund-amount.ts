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
 * Shared by the failed-item refund (`clamp: true`: a line never weighs more
 * than its order) and the dearer-swap charge (`clamp: false`: the difference
 * is not a part of the subtotal). All zero for a non-positive subtotal or base,
 * before the order's identity is checked.
 */
export function lineShareSplit(
  order: OrderRevenueInput,
  baseIdr: number,
  options: { clamp: boolean },
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
  const base = BigInt(
    options.clamp ? Math.min(baseIdr, order.subtotalIdr) : baseIdr,
  );
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
  const shares = lineShareSplit(order, input.lineTotalIdr, { clamp: true });
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
 * legend-i83ls: what the guest owes for a dearer swap. The price difference
 * `differenceIdr` weighs like a line of that value (`lineShareSplit`, no clamp
 * to the subtotal) and brings its share of service charge and PBJT. No order
 * discount and no deposit apply (CTO default, a business decision: the order's
 * discount does not cut the difference), and there is no room to cut to: the
 * guest pays the whole amount. `amount = gross + service + pbjt` holds exactly.
 * A zero result (no subtotal or no difference) is all zero.
 */
export function recoveryChargeSplit(input: {
  order: OrderRevenueInput;
  differenceIdr: number;
}): RecoveryChargeSplit {
  const shares = lineShareSplit(input.order, input.differenceIdr, {
    clamp: false,
  });
  return {
    differenceIdr: Math.max(0, input.differenceIdr),
    grossSalesIdr: shares.grossSalesIdr,
    serviceChargeIdr: shares.serviceChargeIdr,
    pbjtIdr: shares.pbjtIdr,
    amountIdr: shares.grossSalesIdr + shares.serviceChargeIdr + shares.pbjtIdr,
  };
}
