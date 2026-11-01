// Server-side pricing and split-bill arithmetic for QR orders.
//
// PRD v1.7 ORD-03: "Harga, pajak, service charge, dan total selalu dihitung di
// server; manipulasi di klien ditolak." The client sends a cart (ids and
// quantities); every rupiah amount below is derived from server-resolved
// channel prices, the zone's service charge and the configured tax rules.
//
// ORD-06: "Split bill menghasilkan total bagian yang persis sama dengan total
// tagihan, termasuk pembulatan." All splits use core's largest-remainder
// helpers (allocateIdr / splitIdrEvenly), so parts sum exactly.
//
// Calculation order (matches orders.subtotal/discount/service_charge/tax/
// rounding/total in §6.C and PRD F11):
//   1. line subtotal = (unit price + modifiers) x quantity
//   2. subtotal      = sum of line subtotals
//   3. discount      = promo/voucher lines, allocated across lines
//   4. net           = subtotal - discount
//   5. service       = net x zone service charge rate
//   6. tax           = per tax rule, on its net base (+ its service share when
//                      the rule says service is in the tax base)
//   7. rounding      = cash increment adjustment
//   8. total         = net + service + tax + rounding
// The result is parsed through orderQuoteSchema, so the returned object always
// satisfies the contract's sum invariants.

import {
  addIdr,
  allocateIdr,
  applyBasisPoints,
  idr,
  multiplyIdr,
  roundToIncrement,
  splitIdrEvenly,
  subtractIdr,
  sumIdr,
} from "../core/index.ts";
import type { Idr, RoundingMode } from "../core/index.ts";
import { orderQuoteSchema } from "./schemas.ts";
import type { BillSplitMethod, OrderQuote } from "./schemas.ts";

/** One tax rule the quote applies; WS-05 owns the versioned configuration. */
export type QuoteTaxRule = {
  id: string;
  name: string;
  rateBp: number;
  /** `net`: tax the discounted subtotal. `net_plus_service`: include service. */
  appliesTo: "net" | "net_plus_service";
};

/** Zone + tax configuration snapshot the server uses for one quote. Menu
 * prices are exclusive of tax and service charge (owner decision 2026-11-01);
 * the quote adds both on top, so the guest sees them at checkout. */
export type QuoteConfig = {
  serviceChargeBp: number;
  taxRules: readonly QuoteTaxRule[];
  roundingIncrementIdr: number;
  roundingMode: RoundingMode;
  minimumSpendIdr: Idr;
};

/** A cart line after the server resolved its channel price and modifiers. */
export type QuoteLineInput = {
  cartLineId: string;
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceIdr: Idr;
  modifiersTotalIdr: Idr;
  taxRuleId: string | null;
};

export type QuoteDiscountInput = {
  label: string;
  source: "promo" | "voucher" | "manual";
  amountIdr: Idr;
};

export type BillLine = { orderItemId: string; lineTotalIdr: Idr };

export type SplitAssignment = {
  orderItemIds: readonly string[];
  participantId?: string | null;
  label?: string | null;
};

/** A split part before it is persisted with an id. */
export type BillSplitDraft = {
  method: BillSplitMethod;
  shareIndex: number;
  amountIdr: Idr;
  itemIds: readonly string[];
  participantId: string | null;
  label: string | null;
};

export type SplitBillInput =
  | { method: "equal"; totalIdr: Idr; parts: number }
  | {
      method: "by_person";
      totalIdr: Idr;
      participantIds: readonly string[];
    }
  | {
      method: "by_item";
      totalIdr: Idr;
      lines: readonly BillLine[];
      assignments: readonly SplitAssignment[];
    };

function lineSubtotal(line: QuoteLineInput): Idr {
  if (!Number.isInteger(line.quantity) || line.quantity < 1)
    throw new RangeError(`Invalid line quantity: ${line.quantity}`);
  return multiplyIdr(
    addIdr(line.unitPriceIdr, line.modifiersTotalIdr),
    line.quantity,
  );
}

export function computeQuote(input: {
  sessionId: string;
  cartVersion: number;
  lines: readonly QuoteLineInput[];
  config: QuoteConfig;
  discounts?: readonly QuoteDiscountInput[];
  removedLines?: readonly {
    cartLineId: string;
    menuItemId: string;
    name: string;
    reason: "sold_out";
  }[];
  priceChanges?: readonly {
    cartLineId: string;
    name: string;
    previousUnitPriceIdr: Idr;
    unitPriceIdr: Idr;
  }[];
  servingEstimate?: {
    minMinutes: number;
    maxMinutes: number;
    computedAt: string;
  } | null;
  computedAt: string;
}): OrderQuote {
  const { config } = input;
  const discounts = input.discounts ?? [];
  const subtotals = input.lines.map(lineSubtotal);
  const subtotal = sumIdr(subtotals);

  const discountTotal = sumIdr(discounts.map((line) => line.amountIdr));
  if (discountTotal > subtotal)
    throw new RangeError("A discount cannot exceed the cart subtotal");
  if (discountTotal > 0 && input.lines.length === 0)
    throw new RangeError("A discount needs at least one cart line");

  // Allocate the discount so per-line bases stay exact and each tax rule is
  // computed on what the guest actually pays.
  const lineDiscounts =
    discountTotal === 0
      ? input.lines.map(() => idr(0))
      : allocateIdr(discountTotal, subtotals);
  const netSubtotal = subtractIdr(subtotal, discountTotal);

  const serviceCharge = applyBasisPoints(
    netSubtotal,
    config.serviceChargeBp,
    config.roundingMode,
  );

  const rulesById = new Map(
    config.taxRules.map((rule) => [rule.id, rule] as const),
  );
  for (const line of input.lines)
    if (line.taxRuleId !== null && !rulesById.has(line.taxRuleId))
      throw new RangeError(`Unknown tax rule: ${line.taxRuleId}`);

  const ruleNets = config.taxRules.map((rule) =>
    sumIdr(
      input.lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.taxRuleId === rule.id)
        .map(({ index }) =>
          subtractIdr(subtotals[index], lineDiscounts[index]),
        ),
    ),
  );
  // The service charge enters the tax base proportionally to each rule's net,
  // so the shares still sum to the service charge exactly.
  const serviceShares =
    serviceCharge === 0 || config.taxRules.length === 0
      ? config.taxRules.map(() => idr(0))
      : allocateIdr(serviceCharge, ruleNets);

  const taxLines = config.taxRules.map((rule, index) => {
    const base =
      rule.appliesTo === "net_plus_service"
        ? addIdr(ruleNets[index], serviceShares[index])
        : ruleNets[index];
    return {
      taxRuleId: rule.id,
      name: rule.name,
      rateBp: rule.rateBp,
      baseIdr: base,
      amountIdr: applyBasisPoints(base, rule.rateBp, config.roundingMode),
    };
  });
  const taxTotal = sumIdr(taxLines.map((line) => line.amountIdr));

  const beforeRounding = addIdr(addIdr(netSubtotal, serviceCharge), taxTotal);
  const rounded = roundToIncrement(
    beforeRounding,
    config.roundingIncrementIdr,
    config.roundingMode,
  );

  return orderQuoteSchema.parse({
    sessionId: input.sessionId,
    cartVersion: input.cartVersion,
    lines: input.lines.map((line, index) => ({
      cartLineId: line.cartLineId,
      menuItemId: line.menuItemId,
      name: line.name,
      quantity: line.quantity,
      unitPriceIdr: line.unitPriceIdr,
      modifiersTotalIdr: line.modifiersTotalIdr,
      lineSubtotalIdr: subtotals[index],
      discountIdr: lineDiscounts[index],
      lineTotalIdr: subtractIdr(subtotals[index], lineDiscounts[index]),
      taxRuleId: line.taxRuleId,
    })),
    subtotalIdr: subtotal,
    discountLines: discounts,
    discountIdr: discountTotal,
    serviceCharge: {
      rateBp: config.serviceChargeBp,
      baseIdr: netSubtotal,
      amountIdr: serviceCharge,
    },
    taxLines,
    taxIdr: taxTotal,
    rounding: {
      incrementIdr: config.roundingIncrementIdr,
      mode: config.roundingMode,
      adjustmentIdr: rounded.adjustment,
    },
    totalIdr: rounded.amount,
    removedLines: input.removedLines ?? [],
    priceChanges: input.priceChanges ?? [],
    minimumSpend: {
      requiredIdr: config.minimumSpendIdr,
      shortfallIdr: idr(Math.max(0, config.minimumSpendIdr - netSubtotal)),
    },
    servingEstimate: input.servingEstimate ?? null,
    computedAt: input.computedAt,
  });
}

export function splitBill(input: SplitBillInput): BillSplitDraft[] {
  const total = idr(input.totalIdr);
  if (total < 0) throw new RangeError("A bill total cannot be negative");

  if (input.method === "equal")
    return splitIdrEvenly(total, input.parts).map((amountIdr, shareIndex) => ({
      method: input.method,
      shareIndex,
      amountIdr,
      itemIds: [],
      participantId: null,
      label: null,
    }));

  if (input.method === "by_person") {
    if (input.participantIds.length === 0)
      throw new RangeError("A by-person split needs at least one participant");
    if (new Set(input.participantIds).size !== input.participantIds.length)
      throw new RangeError("Duplicate participant in a by-person split");
    return allocateIdr(
      total,
      input.participantIds.map(() => 1),
    ).map((amountIdr, shareIndex) => ({
      method: input.method,
      shareIndex,
      amountIdr,
      itemIds: [],
      participantId: input.participantIds[shareIndex],
      label: null,
    }));
  }

  const lineTotals = new Map(
    input.lines.map((line) => [line.orderItemId, line.lineTotalIdr] as const),
  );
  const assigned = new Set<string>();
  const weights: Idr[] = [];
  for (const assignment of input.assignments) {
    if (assignment.orderItemIds.length === 0)
      throw new RangeError(
        "A by-item split assignment needs at least one item",
      );
    let weight = idr(0);
    for (const itemId of assignment.orderItemIds) {
      const lineTotal = lineTotals.get(itemId);
      if (lineTotal === undefined)
        throw new RangeError(`Unknown order item in split: ${itemId}`);
      if (assigned.has(itemId))
        throw new RangeError(`Order item assigned twice: ${itemId}`);
      assigned.add(itemId);
      weight = addIdr(weight, lineTotal);
    }
    weights.push(weight);
  }
  if (assigned.size !== input.lines.length)
    throw new RangeError(
      "Every order item must be assigned to exactly one split part",
    );
  return allocateIdr(total, weights).map((amountIdr, shareIndex) => ({
    method: input.method,
    shareIndex,
    amountIdr,
    itemIds: input.assignments[shareIndex].orderItemIds,
    participantId: input.assignments[shareIndex].participantId ?? null,
    label: input.assignments[shareIndex].label ?? null,
  }));
}

/** ORD-06: non-voided parts must sum exactly to the bill total. */
export function assertSplitsSumToTotal(
  splits: readonly { amountIdr: Idr; status?: string }[],
  totalIdr: Idr,
): void {
  const live = splits.filter((split) => split.status !== "voided");
  const sum = sumIdr(live.map((split) => split.amountIdr));
  if (sum !== totalIdr)
    throw new RangeError(
      `ORD-06: split parts sum to ${sum}, the bill total is ${totalIdr}`,
    );
}
