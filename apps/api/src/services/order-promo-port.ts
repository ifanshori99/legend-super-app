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
import type { Idr } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core/server";
import type { Tx } from "../db/index.ts";

export type OrderPromoInput = {
  readonly outletId: string;
  readonly channel: PromoChannel;
  /** Server-priced lines only. */
  readonly lines: readonly PromoLine[];
  readonly customer: PromoCustomer | null;
  readonly voucherCode: string | null;
  readonly at: Date;
};

export type OrderPromoQuote = {
  readonly result: PromotionApplicationResult;
  /** Feed into calculateTax orderDiscountIdr. */
  readonly totalDiscountIdr: Idr;
};

export interface OrderPromoPort {
  quote(tx: Tx, ctx: ScopedTenantContext, input: OrderPromoInput): Promise<OrderPromoQuote>;
  /** Inside the order transaction, after the order row is locked/inserted. */
  redeem(
    tx: Tx,
    ctx: ScopedTenantContext,
    input: OrderPromoInput & {
      readonly orderId: string;
      readonly actorUserId: string | null;
      readonly expected?: PromotionApplicationResult;
    },
  ): Promise<OrderPromoQuote>;
  /** Full void / payment failure / expiry. Idempotent. */
  release(
    tx: Tx,
    ctx: ScopedTenantContext,
    input: { readonly orderId: string; readonly reason: string; readonly actorUserId: string | null; readonly at: Date },
  ): Promise<{ released: boolean; releasedDiscountIdr: Idr }>;
}
