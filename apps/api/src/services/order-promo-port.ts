/**
 * Port between the QR/POS/website order services and the promo engine wiring
 * (beads legend-e2x consumes, legend-souz implements in order-promo.ts).
 * PRD §3.21, LOY-03, ORD-03. Calc order stays discount -> service -> tax.
 */
import type {
  PromoChannel,
  PromoCustomer,
  PromoLine,
  PromotionApplicationResult,
} from "@starter/shared/crm";
import type { Idr, OutletId, ScopedTenantContext } from "@starter/shared/core";
import type { Tx } from "./permission-resolver";

export type OrderPromoInput = {
  readonly outletId: OutletId;
  readonly channel: PromoChannel;
  /** Server-priced lines only. */
  readonly lines: readonly PromoLine[];
  readonly customer: PromoCustomer | null;
  readonly voucherCode: string | null;
  readonly at: Date;
  /**
   * Pre-promo bill before tax and service charge: the `min_spend` basis
   * (owner Q53). Only an outlet whose prices include tax fills it; absent
   * means the lines' total is already that value.
   */
  readonly minSpendSubtotalIdr?: Idr;
};

export type OrderPromoQuote = {
  readonly result: PromotionApplicationResult;
  /** Feed into calculateTax orderDiscountIdr. */
  readonly totalDiscountIdr: Idr;
};

export interface OrderPromoPort {
  quote(
    tx: Tx,
    ctx: ScopedTenantContext,
    input: OrderPromoInput,
  ): Promise<OrderPromoQuote>;
  /** Inside the order transaction, after the order row is locked/inserted. */
  redeem(
    tx: Tx,
    ctx: ScopedTenantContext,
    input: OrderPromoInput & {
      readonly orderId: string;
      readonly actorUserId: string | null;
      readonly expected?: PromotionApplicationResult;
      /** POS cashier swap: reuse the released application row (legend-1059). */
      readonly reapplyReleased?: boolean;
    },
  ): Promise<OrderPromoQuote>;
  /** Full void / payment failure / expiry. Idempotent. */
  release(
    tx: Tx,
    ctx: ScopedTenantContext,
    input: {
      readonly orderId: string;
      readonly reason: string;
      readonly actorUserId: string | null;
      readonly at: Date;
    },
  ): Promise<{ released: boolean; releasedDiscountIdr: Idr }>;
}
