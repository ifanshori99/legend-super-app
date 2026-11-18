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

export type RecoveryChargeRefundSplit = {
  grossSalesIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
};

/**
 * legend-0zfr1: the share of a paid charge that one NEW refund gives back,
 * taken from what is still left of each component (the charge's component
 * less the components of the non-failed refunds that exist), not from a
 * cumulative IDR figure. A failed refund frees its components, so the next
 * refund cannot overshoot a component. A refund that takes all the money left
 * takes the left components exactly; otherwise PBJT = round(Pleft * r / Tleft)
 * half up, service = round(Sleft * (r - PBJT) / (Sleft + Gleft)), gross is the
 * rest. Each component is <= its left amount, the sum is the refund. Throws
 * `RangeError` when the refund passes the money left or the refunded
 * components pass the charge.
 */
export function recoveryChargeRefundSplitFromRemaining(input: {
  charge: {
    grossSalesIdr: number;
    serviceChargeIdr: number;
    pbjtIdr: number;
    amountIdr: number;
  };
  refunded: RecoveryChargeRefundSplit;
  refundIdr: number;
}): RecoveryChargeRefundSplit {
  const { charge, refunded } = input;
  const left = {
    gross: BigInt(charge.grossSalesIdr) - BigInt(refunded.grossSalesIdr),
    service:
      BigInt(charge.serviceChargeIdr) - BigInt(refunded.serviceChargeIdr),
    pbjt: BigInt(charge.pbjtIdr) - BigInt(refunded.pbjtIdr),
  };
  const total = left.gross + left.service + left.pbjt;
  const refund = BigInt(Math.max(0, input.refundIdr));
  if (
    left.gross < 0n ||
    left.service < 0n ||
    left.pbjt < 0n ||
    refund <= 0n ||
    refund > total
  )
    throw new RangeError("Charge refund is outside the paid charge");
  if (refund === total)
    return {
      grossSalesIdr: Number(left.gross),
      serviceChargeIdr: Number(left.service),
      pbjtIdr: Number(left.pbjt),
    };
  const pbjt = mulDivHalfUp(left.pbjt, refund, total);
  const rest = refund - pbjt;
  const base = left.service + left.gross;
  const service = base === 0n ? 0n : mulDivHalfUp(left.service, rest, base);
  const gross = rest - service;
  if (pbjt > left.pbjt || service > left.service || gross > left.gross)
    throw new RangeError("Charge refund is outside the paid charge");
  return {
    grossSalesIdr: Number(gross),
    serviceChargeIdr: Number(service),
    pbjtIdr: Number(pbjt),
  };
}

/**
 * legend-nsvu0: the share of a paid swap-difference charge that one refund
 * gives back. Cumulative: with `priorIdr` already refunded, this refund takes
 * `F(prior + refund) - F(prior)` per component, where F(x) is the split of the
 * first x IDR of the charge: PBJT = round(P * x / T) half up (BigInt, no
 * float); the rest r = x - PBJT splits into service = round(S * r / (S + G))
 * and gross = r - service. Each step of x moves one component by 0 or 1, so
 * every component of F is nondecreasing: no refund takes a negative share, the
 * sum telescopes, and `F(T)` is exactly (G, S, P). The components of one refund
 * add up to its amount. A refund past the charge (`prior + refund > amount`)
 * is the caller's error: throws.
 */
export function recoveryChargeRefundSplit(input: {
  charge: {
    grossSalesIdr: number;
    serviceChargeIdr: number;
    pbjtIdr: number;
    amountIdr: number;
  };
  priorIdr: number;
  refundIdr: number;
}): RecoveryChargeRefundSplit {
  const { charge } = input;
  const total = BigInt(charge.amountIdr);
  const prior = BigInt(Math.max(0, input.priorIdr));
  const refund = BigInt(Math.max(0, input.refundIdr));
  if (
    total <= 0n ||
    refund <= 0n ||
    prior + refund > total ||
    BigInt(charge.grossSalesIdr) +
      BigInt(charge.serviceChargeIdr) +
      BigInt(charge.pbjtIdr) !==
      total
  )
    throw new RangeError("Charge refund is outside the paid charge");
  const at = (x: bigint) => {
    const pbjt = mulDivHalfUp(BigInt(charge.pbjtIdr), x, total);
    const rest = x - pbjt;
    const base = BigInt(charge.serviceChargeIdr) + BigInt(charge.grossSalesIdr);
    const service =
      base === 0n
        ? 0n
        : mulDivHalfUp(BigInt(charge.serviceChargeIdr), rest, base);
    return { gross: rest - service, service, pbjt };
  };
  const from = at(prior);
  const to = at(prior + refund);
  const gross = to.gross - from.gross;
  const service = to.service - from.service;
  const pbjt = to.pbjt - from.pbjt;
  return {
    grossSalesIdr: Number(gross),
    serviceChargeIdr: Number(service),
    pbjtIdr: Number(pbjt),
  };
}
