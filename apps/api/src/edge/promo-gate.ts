// Promo and voucher freshness gate on an edge (legend-10nex, CTO decision
// after founder Q57). Promos and vouchers are not part of the critical
// catalog streams: a stale promo must NOT hold sales, it is switched off and
// the sale goes at the normal price. The owner override of the sales hold
// (sales-gate.ts) never opens a stale promo.
//
//   cloud process        promos always on.
//   edge, no provider    off (fail closed: "jangan rugi").
//   edge, provider false off: a promo or voucher stream has no successful
//                        sync within 24 h (or never synced).
//
// A discount that is not applied can only raise the price the guest pays to
// the normal price, never pay anyone more.
import { CoreError, idr } from "@starter/shared/core";
import { env } from "../config/env.ts";
import type {
  OrderPromoPort,
  OrderPromoQuote,
} from "../services/order-promo-port.ts";

export const PROMO_STALE_AFTER_MS = 24 * 60 * 60_000;

export const PROMO_DISABLED_MESSAGE =
  "Promo dan voucher dimatikan: data promo belum diperbarui lebih dari 24 jam. Penjualan memakai harga normal.";

export type PromoFreshnessProvider = () => boolean;

let provider: PromoFreshnessProvider | null = null;
let isEdgeMode: () => boolean = () => env.EDGE_MODE;

export function installPromoFreshnessProvider(
  next: PromoFreshnessProvider | null,
): void {
  provider = next;
}

/** Test seam: override how edge mode is read (null restores `env.EDGE_MODE`). */
export function setPromoGateEdgeModeForTests(fn: (() => boolean) | null): void {
  isEdgeMode = fn ?? (() => env.EDGE_MODE);
}

/** True when promos and vouchers may be applied on this process. */
export function promosEnabled(): boolean {
  if (!isEdgeMode()) return true;
  if (!provider) return false;
  try {
    return provider();
  } catch {
    return false;
  }
}

const NO_DISCOUNT: OrderPromoQuote = {
  result: { evaluations: [], totalDiscountIdr: idr(0) },
  totalDiscountIdr: idr(0),
};

/**
 * Wraps the order promo port. While promos are off: quote and redeem give no
 * discount; an explicit voucher/promo code is refused with a clear message
 * (the sale itself is not held); redeeming a quote that promised a discount
 * is refused as PROMO_CHANGED so a guest never pays a price they did not see.
 * `release` always reaches the engine (it only gives quota back).
 */
export function withPromoFreshness(inner: OrderPromoPort): OrderPromoPort {
  return {
    async quote(tx, ctx, input) {
      if (promosEnabled()) return inner.quote(tx, ctx, input);
      if (input.voucherCode !== null)
        throw new CoreError("VALIDATION_ERROR", PROMO_DISABLED_MESSAGE);
      return NO_DISCOUNT;
    },
    async redeem(tx, ctx, input) {
      if (promosEnabled()) return inner.redeem(tx, ctx, input);
      if (input.voucherCode !== null)
        throw new CoreError("VALIDATION_ERROR", PROMO_DISABLED_MESSAGE);
      if (input.expected && input.expected.totalDiscountIdr > 0)
        throw new CoreError(
          "CONFLICT",
          "Promo berubah sejak harga dihitung. Hitung ulang pesanan.",
        );
      return NO_DISCOUNT;
    },
    release(tx, ctx, input) {
      return inner.release(tx, ctx, input);
    },
  };
}
