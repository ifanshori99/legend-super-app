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

export function recoveryRefundSplit(input: {
  order: OrderRevenueInput & { depositAppliedIdr: number };
  lineTotalIdr: number;
  /** Already released by other issues of this order. */
  releasedIdr: number;
}): RecoveryRefundSplit {
  const { order, releasedIdr } = input;
  if (order.subtotalIdr <= 0 || input.lineTotalIdr <= 0) return { ...ZERO };
  const split = orderRevenueSplit(order);
  const subtotal = BigInt(order.subtotalIdr);
  // A line never weighs more than the order it belongs to.
  const line = BigInt(Math.min(input.lineTotalIdr, order.subtotalIdr));
  const share = (value: number) => mulDivHalfUp(BigInt(value), line, subtotal);
  let gross = share(split.grossSalesIdr);
  let discount = share(split.discountIdr);
  let service = share(split.serviceChargeIdr);
  let pbjt = share(split.pbjtIdr);
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
