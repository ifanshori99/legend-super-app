// legend-94q2l: the money of a failed-item manual refund (ORD-09). Pure: no
// database, no clock. `order-recovery-refund.ts` feeds it the order row, the
// failed line's total, the line totals and money other issues of the order
// already released, and the promo recompute result when the order has a live
// CRM promo.
//
// Default rule (founder Q85, pro rata): the guest paid the line pro rata with
// the order's discount, service charge and PBJT, so the refund is the line's
// share of each component of `orderRevenueSplit`. The share is cumulative
// (legend-h1dyy): with `prior` the line totals other issues already refunded,
// `cumShare(C, x) = round(C * min(x, subtotal) / subtotal)` half up (BigInt, no
// float) and this refund takes `cumShare(C, prior + line) - cumShare(C, prior)`.
// The sum telescopes, so the refund that reaches the subtotal takes exactly
// the rest and all refunds together never exceed C. The order's cash rounding
// is not part of it. `wantedIdr = gross - discount + service + pbjt`.
//
// Promo rule (legend-h1dyy): when the CRM promo port recomputed the order
// without the failed line, its result replaces the pro-rata gross/discount.
// `goodsDueIdr` is the goods money due back on the item-price basis, out of
// `P = subtotal - discount`. Service and PBJT take the cumulative share of the
// goods slice `[before, after)` over P, `before = max(0, P - remainingPaid)`,
// `after = min(P, before + goodsDue)`. Exclusive prices: the net revenue is
// goodsDue and wanted adds service and PBJT. Inclusive prices: wanted is
// goodsDue and the net revenue is goodsDue - service - PBJT. Gross is the
// refunded subtotal on the revenue basis (never below the net revenue) and the
// discount is gross - net. A promo that leaves nothing due refunds nothing.
//
// What the order can still give back is `(total - deposit) - released`; the
// refund is cut to that room and the shortfall is reported, never hidden. A
// cut refund scales discount, service and PBJT by `amount / wanted` and takes
// gross as the rest, so `gross - discount + service + pbjt = amount` still
// holds (the `order.refunded` payload checks it) and no component is negative.
// `goodsIdr` is what the refund pays for the goods on the promo ledger basis
// (exclusive: gross - discount; inclusive: the amount), after the cut.

import {
  orderRevenueSplit,
  type OrderRevenueInput,
  type OrderRevenueSplit,
} from "./order-revenue.ts";

export type RecoveryRefundSplit = {
  wantedIdr: number;
  amountIdr: number;
  shortfallIdr: number;
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
  /**
   * Goods money of the refund on the promo ledger basis (`refunded_paid_idr`,
   * the item price the guest paid): exclusive prices `gross - discount`,
   * inclusive prices the whole amount (the item price already holds the tax).
   */
  goodsIdr: number;
};

const ZERO: RecoveryRefundSplit = {
  wantedIdr: 0,
  amountIdr: 0,
  shortfallIdr: 0,
  grossSalesIdr: 0,
  discountIdr: 0,
  serviceChargeIdr: 0,
  pbjtIdr: 0,
  goodsIdr: 0,
};

/** round(value * numerator / denominator), half up; all operands >= 0. */
function mulDivHalfUp(
  value: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  return (2n * value * numerator + denominator) / (2n * denominator);
}

type Parts = { gross: bigint; discount: bigint; service: bigint; pbjt: bigint };

const big = (value: number) => BigInt(Math.max(0, value));

/**
 * The slice `[from, to)` of a component spread over `base`: cumulative
 * half-up shares, so consecutive slices add up to the component exactly.
 */
function sliceShare(
  component: number,
  from: bigint,
  to: bigint,
  base: bigint,
): bigint {
  if (base <= 0n) return 0n;
  const value = big(component);
  const cum = (x: bigint) =>
    mulDivHalfUp(value, x < base ? (x > 0n ? x : 0n) : base, base);
  return cum(to) - cum(from);
}

/** Founder Q85: the line's cumulative pro-rata share of every component. */
function proRataParts(
  order: OrderRevenueInput,
  split: OrderRevenueSplit,
  lineTotalIdr: number,
  priorLinesIdr: number,
): Parts {
  const subtotal = BigInt(order.subtotalIdr);
  const prior = big(priorLinesIdr);
  const to = prior + BigInt(lineTotalIdr);
  const share = (value: number) => sliceShare(value, prior, to, subtotal);
  return {
    gross: share(split.grossSalesIdr),
    discount: share(split.discountIdr),
    service: share(split.serviceChargeIdr),
    pbjt: share(split.pbjtIdr),
  };
}

/** legend-h1dyy: the refund after the CRM promo was recomputed. */
function promoParts(
  order: OrderRevenueInput,
  split: OrderRevenueSplit,
  promo: RecoveryRefundPromo,
): Parts | null {
  const goodsDue = big(promo.goodsDueIdr);
  if (goodsDue <= 0n) return null;
  const paid = big(order.subtotalIdr - order.discountIdr);
  const before = paid - big(promo.remainingPaidIdr);
  const from = before > 0n ? before : 0n;
  const end = from + goodsDue;
  const to = end < paid ? end : paid;
  let service = sliceShare(split.serviceChargeIdr, from, to, paid);
  let pbjt = sliceShare(split.pbjtIdr, from, to, paid);
  let net: bigint;
  if (order.pricesIncludeTax) {
    net = goodsDue - service - pbjt;
    if (net < 0n) {
      // The taxes of the slice exceed the goods money: take the excess from
      // PBJT first, then from the service charge.
      let excess = -net;
      const fromPbjt = excess < pbjt ? excess : pbjt;
      pbjt -= fromPbjt;
      excess -= fromPbjt;
      service -= excess;
      net = 0n;
    }
  } else {
    net = goodsDue;
  }
  const refunded = big(promo.refundedSubtotalIdr);
  const grossRev = order.pricesIncludeTax
    ? (refunded * big(split.grossSalesIdr)) / BigInt(order.subtotalIdr)
    : refunded;
  const gross = grossRev > net ? grossRev : net;
  return { gross, discount: gross - net, service, pbjt };
}

/** The CRM promo port result for this refund (`recomputeAfterPartialRefund`). */
export type RecoveryRefundPromo = {
  /** Item-price subtotal of the refunded line(s). */
  refundedSubtotalIdr: number;
  /** Goods money due back (`refundDueIdr` of the port). */
  goodsDueIdr: number;
  /** Goods money the order still holds before this refund. */
  remainingPaidIdr: number;
};

export function recoveryRefundSplit(input: {
  order: OrderRevenueInput & { depositAppliedIdr: number };
  lineTotalIdr: number;
  /** Line totals of other issues of this order already refunded (not rejected). */
  priorLinesIdr: number;
  /** Already released by other issues of this order. */
  releasedIdr: number;
  promo?: RecoveryRefundPromo;
}): RecoveryRefundSplit {
  const { order, releasedIdr } = input;
  if (order.subtotalIdr <= 0 || input.lineTotalIdr <= 0) return { ...ZERO };
  const split = orderRevenueSplit(order);
  const parts = input.promo
    ? promoParts(order, split, input.promo)
    : proRataParts(order, split, input.lineTotalIdr, input.priorLinesIdr);
  if (!parts) return { ...ZERO };
  let { gross, discount, service, pbjt } = parts;
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
    goodsIdr: Number(order.pricesIncludeTax ? amount : gross - discount),
  };
}
