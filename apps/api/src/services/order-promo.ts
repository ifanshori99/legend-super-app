// Promo engine wiring for order transactions (bead legend-souz; PRD v1.7
// §3.21 "Promo Engine": "Engine yang sama dipakai POS, QR order, dan website";
// LOY-03; ORD-03). Implements `OrderPromoPort` (order-promo-port.ts) on top of
// the engine ports in crm-promo-engine.ts, so the QR order service (legend-e2x)
// and later POS/website call one adapter:
//
//   quote   — read-only, before checkout: what the bill gets now.
//   redeem  — inside the caller's order transaction, AFTER the order row is
//             inserted or locked FOR UPDATE (engine lock order step 1). Pass
//             the quote the guest accepted as `expected`: a changed outcome
//             (quota/budget taken meanwhile, rule edited) is refused with
//             PROMO_QUOTA_EXHAUSTED / PROMO_BUDGET_EXHAUSTED / PROMO_CHANGED
//             instead of silently charging a different price. Idempotent per
//             order (a retry returns the stored result).
//   release — full void, payment failure or payment expiry; idempotent (a
//             second call returns `released: false`). QR pay-first: redeem at
//             checkout, release when the payment fails or expires.
//
// Calc order (legend-559): discount -> service charge -> tax. The promo total
// is a bill-level discount: feed `promoDiscountForTax(quote)` into
// `calculateTax` as `orderDiscountIdr`; never subtract it after tax.

import {
  promoLineSchema,
  type PromoLine,
  type PromotionApplicationResult,
} from "@starter/shared/crm";
import {
  assertTrustedScopedContext,
  idr,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { HttpError } from "../lib/http-error";
import {
  quotePromotions,
  redeemPromotions,
  releasePromotions,
} from "./crm-promo-engine";
import type {
  OrderPromoInput,
  OrderPromoPort,
  OrderPromoQuote,
} from "./order-promo-port";
import type { Tx } from "./permission-resolver";

/**
 * Release reasons for the QR pay-first flow (PRD §3.10 "alasan baku" covers
 * voids; the void flow passes its own standard reason).
 */
export const ORDER_PROMO_RELEASE_REASONS = {
  paymentFailed: "Pembayaran gagal",
  paymentExpired: "Pembayaran kedaluwarsa",
} as const;

/**
 * One order line after the order service priced it on the server (ORD-03):
 * the channel price of the item or of its chosen variant, plus the server
 * price of the chosen modifiers. Structurally compatible with the QR quote's
 * `QuoteLineInput` and the POS line, so either can be passed directly.
 */
export type PricedOrderLine = {
  readonly menuItemId: string;
  readonly quantity: number;
  /** Absolute server price of the item, or of the chosen variant. */
  readonly unitPriceIdr: Idr;
  /** Per-unit sum of the chosen modifiers' server prices. */
  readonly modifiersTotalIdr: Idr;
};

function invalidLines(): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Periksa baris pesanan.");
}

function isWholeRupiah(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Maps priced order lines to promo engine lines. The promo unit price is the
 * variant/item price plus modifiers, so a percent discount, a bundle or a
 * "buy X get Y" free item works on what the guest actually pays per unit
 * (the same gross the tax engine sees: "unit price x quantity incl.
 * modifiers"). Promotions match on `menuItemId`, so every variant of an item
 * counts toward that item's conditions. Line order is kept: pass the same
 * lines in the same order to quote and redeem (the redeem idempotency
 * fingerprint reads them in order).
 */
export function toPromoLines(lines: readonly PricedOrderLine[]): PromoLine[] {
  if (lines.length === 0) throw invalidLines();
  return lines.map((line) => {
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      !isWholeRupiah(line.unitPriceIdr) ||
      !isWholeRupiah(line.modifiersTotalIdr)
    )
      throw invalidLines();
    const unit = line.unitPriceIdr + line.modifiersTotalIdr;
    const total = unit * line.quantity;
    if (!Number.isSafeInteger(unit) || !Number.isSafeInteger(total))
      throw new HttpError(422, "VALIDATION_ERROR", "Jumlah terlalu besar.");
    const parsed = promoLineSchema.safeParse({
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      unitPriceIdr: unit,
      lineTotalIdr: total,
    });
    if (!parsed.success) throw invalidLines();
    return parsed.data;
  });
}

/**
 * Fail closed on lines that are not plain server-priced lines: strict schema,
 * and `lineTotalIdr === unitPriceIdr x quantity` (the promo engine works on
 * the gross before any discount; a pre-discounted line would discount twice).
 */
function serverPricedLines(lines: readonly PromoLine[]): PromoLine[] {
  if (lines.length === 0) throw invalidLines();
  return lines.map((line) => {
    const parsed = promoLineSchema.safeParse(line);
    if (
      !parsed.success ||
      parsed.data.unitPriceIdr * parsed.data.quantity !==
        parsed.data.lineTotalIdr
    )
      throw invalidLines();
    return parsed.data;
  });
}

function subtotalOf(lines: readonly PromoLine[]): number {
  let total = 0;
  for (const line of lines) total += line.lineTotalIdr;
  return total;
}

function toQuote(
  result: PromotionApplicationResult,
  lines: readonly PromoLine[],
): OrderPromoQuote {
  const total = idr(result.totalDiscountIdr);
  // The engine never discounts more than the bill; re-check before the value
  // reaches the tax engine (its schema refuses it too).
  if (total < 0 || total > subtotalOf(lines))
    throw new Error("Promo discount exceeds the bill");
  return { result, totalDiscountIdr: total };
}

/**
 * The bill-level discount for `calculateTax({ ..., orderDiscountIdr })`
 * (calc order discount -> service -> tax, legend-559). No quote (no promo
 * step, e.g. a channel without promotions) is Rp0.
 */
export function promoDiscountForTax(quote: OrderPromoQuote | null): Idr {
  if (quote === null) return idr(0);
  if (quote.totalDiscountIdr !== quote.result.totalDiscountIdr)
    throw new Error("Promo quote total does not match its result");
  return idr(quote.totalDiscountIdr);
}

function engineInput(input: OrderPromoInput, lines: PromoLine[]) {
  return {
    outletId: input.outletId,
    channel: input.channel,
    lines,
    customer: input.customer,
    voucherCode: input.voucherCode,
    at: input.at,
    ...(input.minSpendSubtotalIdr === undefined
      ? {}
      : { minSpendSubtotalIdr: input.minSpendSubtotalIdr }),
  };
}

export const orderPromoPort: OrderPromoPort = {
  async quote(
    tx: Tx,
    ctx: ScopedTenantContext,
    input: OrderPromoInput,
  ): Promise<OrderPromoQuote> {
    assertTrustedScopedContext(ctx);
    const lines = serverPricedLines(input.lines);
    const result = await quotePromotions(tx, ctx, engineInput(input, lines));
    return toQuote(result, lines);
  },

  async redeem(tx, ctx, input) {
    assertTrustedScopedContext(ctx);
    const lines = serverPricedLines(input.lines);
    const result = await redeemPromotions(tx, ctx, {
      ...engineInput(input, lines),
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      ...(input.expected === undefined ? {} : { expected: input.expected }),
      ...(input.reapplyReleased === true ? { reapplyReleased: true } : {}),
    });
    return toQuote(result, lines);
  },

  async release(tx, ctx, input) {
    assertTrustedScopedContext(ctx);
    const released = await releasePromotions(tx, ctx, {
      orderId: input.orderId,
      reason: input.reason,
      actorUserId: input.actorUserId,
      at: input.at,
    });
    return {
      released: released.released,
      releasedDiscountIdr: idr(released.releasedDiscountIdr),
    };
  },
};
