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

export const EDGE_PROMO_CODE_ONLINE_MESSAGE =
  "Kode promo dan voucher harus dipakai melalui kasir cloud yang online agar tidak digunakan dua kali.";

export type PromoFreshnessProvider = () => boolean;

let provider: PromoFreshnessProvider | null = null;
let isEdgeMode: () => boolean = () => env.EDGE_MODE;
let clockProvider: (() => Date) | null = null;
const pendingStreams = new Map<string, number>();
let pullGeneration = 0;

/** Shared by the gate and the engine so every edge checkout follows one rule. */
export function isPromoEdgeMode(): boolean {
  return isEdgeMode();
}

export function installPromoClockProvider(next: (() => Date) | null): void {
  clockProvider = next;
}

/** Runtime supplies its trusted clock; cloud evaluation keeps the caller's time. */
export function promoEvaluationAt(fallback: Date): Date {
  return isEdgeMode() && clockProvider ? clockProvider() : fallback;
}

/** A replicated code is not a reservation against the authoritative cloud row. */
export function assertEdgePromoCodeAllowed(code: string | null): void {
  if (isEdgeMode() && code !== null)
    throw new CoreError("VALIDATION_ERROR", EDGE_PROMO_CODE_ONLINE_MESSAGE);
}

/** Partial catalog pages must not make a discount usable before terminal sync. */
export function markPromoCatalogStreamPending(stream: string): number {
  if (stream !== "catalog:promotions" && stream !== "catalog:vouchers")
    return 0;
  const generation = ++pullGeneration;
  pendingStreams.set(stream, generation);
  return generation;
}

export function completePromoCatalogStream(
  stream: string,
  generation: number,
): void {
  if (pendingStreams.get(stream) === generation) pendingStreams.delete(stream);
}

export function installPromoFreshnessProvider(
  next: PromoFreshnessProvider | null,
): void {
  provider = next;
  if (next === null) pendingStreams.clear();
}

/** Test seam: override how edge mode is read (null restores `env.EDGE_MODE`). */
export function setPromoGateEdgeModeForTests(fn: (() => boolean) | null): void {
  isEdgeMode = fn ?? (() => env.EDGE_MODE);
}

/** True when promos and vouchers may be applied on this process. */
export function promosEnabled(): boolean {
  if (!isEdgeMode()) return true;
  if (pendingStreams.size > 0) return false;
  if (!provider) return false;
  try {
    return provider();
  } catch {
    return false;
  }
}

/** One gate for order adapters and callers that reach the engine directly. */
export function promoRequestEnabled(
  voucherCode: string | null,
  expectedDiscountIdr = 0,
): boolean {
  if (promosEnabled()) {
    assertEdgePromoCodeAllowed(voucherCode);
    return true;
  }
  if (voucherCode !== null)
    throw new CoreError("VALIDATION_ERROR", PROMO_DISABLED_MESSAGE);
  if (expectedDiscountIdr > 0)
    throw new CoreError(
      "CONFLICT",
      "Promo berubah sejak harga dihitung. Hitung ulang pesanan.",
    );
  return false;
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
 * Fresh edge catalogs permit automatic rules; typed codes require cloud
 * checkout because the local database cannot reserve a cloud voucher.
 * `release` always reaches the engine (it only gives quota back).
 */
export function withPromoFreshness(inner: OrderPromoPort): OrderPromoPort {
  return {
    async quote(tx, ctx, input) {
      if (!promoRequestEnabled(input.voucherCode)) return NO_DISCOUNT;
      return inner.quote(tx, ctx, input);
    },
    async redeem(tx, ctx, input) {
      if (
        !promoRequestEnabled(
          input.voucherCode,
          input.expected?.totalDiscountIdr,
        )
      )
        return NO_DISCOUNT;
      return inner.redeem(tx, ctx, input);
    },
    release(tx, ctx, input) {
      return inner.release(tx, ctx, input);
    },
  };
}
