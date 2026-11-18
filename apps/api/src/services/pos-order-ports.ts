// Ports the POS order service (bead legend-kk7) depends on but does not own.
// Each has a fail-safe default and a setter the API bootstrap (lead) or a test
// installs (AGENT_PLAYBOOK §2 "Missing dependency? Do not block").
//
// - Promo (order-promo-port.ts; legend-souz `orderPromoPort`). Default: no
//   promotion applies and an explicit code is refused.
// - Promo partial refund (legend-q1e0). Default: the real order-promo port, so
//   a refund of a promo order is always re-priced; a test injects a failing one.
// - Receipt numbering (POS-06, legend-93a). Default: fail closed. A sale is
//   only `completed` with a receipt number (contract posOrderDetailSchema), so
//   completion is refused until the gapless numbering bead installs its
//   allocator.
// - Cashier shift (POS-03, legend-6c0). Default: no shift (orders carry
//   shiftId null) — attribution only, never a permission.
// - EDC (legend-m0k) and points (loyalty) tenders. Default: refused; only cash
//   and QRIS (WS-05 gateway) settle until those beads land.
// The reservation deposit credit reuses the QR port (`depositCreditFor` in
// qr-order-ports.ts) so one wiring of WS-08 `depositCreditForSession` serves
// both the QR and the POS bill.

import {
  CoreError,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import type { PosReceipt, PosTenderMethod } from "@starter/shared/pos";
import type { OrderPromoPort } from "./order-promo-port.ts";
import type { PromoPartialRefundPort } from "./crm-promo-refund.ts";
import { orderPromoPartialRefundPort } from "./order-promo-refund.ts";
import type { Tx } from "./permission-resolver.ts";
import { noPromotionsPort } from "./qr-order-ports.ts";

// ---- Promo ------------------------------------------------------------------

let promoPort: OrderPromoPort = noPromotionsPort;

export function setPosOrderPromoPort(next: OrderPromoPort | null): void {
  promoPort = next ?? noPromotionsPort;
}

export function posOrderPromoPort(): OrderPromoPort {
  return promoPort;
}

// ---- Promo partial refund -----------------------------------------------------

let promoRefundPort: PromoPartialRefundPort = orderPromoPartialRefundPort;

export function setPosPromoRefundPort(
  next: PromoPartialRefundPort | null,
): void {
  promoRefundPort = next ?? orderPromoPartialRefundPort;
}

export function posPromoRefundPort(): PromoPartialRefundPort {
  return promoRefundPort;
}

// ---- Receipt numbering (POS-06) --------------------------------------------

export type PosReceiptPort = {
  /**
   * Allocates (or returns the already allocated) receipt of a sale inside the
   * caller's order transaction. Idempotent per order.
   */
  issueForSale(
    tx: Tx,
    context: ScopedTenantContext,
    input: {
      orderId: string;
      outletId: string;
      deviceId: string | null;
      at: Date;
    },
  ): Promise<PosReceipt>;
  /** The receipt of an order, if one was issued. */
  findForOrder(
    tx: Tx,
    context: ScopedTenantContext,
    orderId: string,
  ): Promise<PosReceipt | null>;
  /** POS-06: marks the receipt voided; the number stays on record. */
  voidForOrder(
    tx: Tx,
    context: ScopedTenantContext,
    input: {
      orderId: string;
      reason: string;
      voidedBy: UserId;
      at: Date;
    },
  ): Promise<PosReceipt | null>;
};

export const unwiredReceiptPort: PosReceiptPort = {
  async issueForSale() {
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Penomoran struk belum aktif; transaksi belum dapat diselesaikan.",
    );
  },
  async findForOrder() {
    return null;
  },
  async voidForOrder() {
    return null;
  },
};

let receiptPort: PosReceiptPort = unwiredReceiptPort;

export function setPosReceiptPort(next: PosReceiptPort | null): void {
  receiptPort = next ?? unwiredReceiptPort;
}

export function posReceiptPort(): PosReceiptPort {
  return receiptPort;
}

// ---- Cashier shift (POS-03) ------------------------------------------------

export type PosShiftLookup = (
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; deviceId: string | null; cashierId: UserId },
) => Promise<string | null>;

let shiftLookup: PosShiftLookup = async () => null;

export function setPosShiftLookup(next: PosShiftLookup | null): void {
  shiftLookup = next ?? (async () => null);
}

export function posShiftLookup(): PosShiftLookup {
  return shiftLookup;
}

// ---- EDC and points tenders -------------------------------------------------

export type PosExternalTenderInput = {
  orderId: string;
  outletId: string;
  method: PosTenderMethod;
  amountIdr: number;
  reference: string | null;
  edcTransactionId: string | null;
  pointsUsed: number | null;
  cashierId: UserId;
  at: Date;
};

/**
 * Settles an EDC (legend-m0k) or points tender inside the order transaction.
 * Returns the verified reference; throws to refuse.
 */
export type PosExternalTenderPort = (
  tx: Tx,
  context: ScopedTenantContext,
  input: PosExternalTenderInput,
) => Promise<{
  reference: string | null;
  approvedBy: UserId | null;
  /** Points tender (936): what the points cover, at most the remaining balance. */
  amountIdr?: number;
  /** Points tender: the tender id the ledger row already points at. */
  tenderId?: string;
}>;

const refuseExternalTender: PosExternalTenderPort = async (
  _tx,
  _context,
  input,
) => {
  throw new CoreError(
    "SERVICE_UNAVAILABLE",
    input.method === "points"
      ? "Pembayaran dengan poin belum tersedia."
      : "Pembayaran EDC belum tersedia di perangkat ini.",
  );
};

let edcTender: PosExternalTenderPort = refuseExternalTender;
let pointsTender: PosExternalTenderPort = refuseExternalTender;

export function setPosEdcTenderPort(next: PosExternalTenderPort | null): void {
  edcTender = next ?? refuseExternalTender;
}

export function setPosPointsTenderPort(
  next: PosExternalTenderPort | null,
): void {
  pointsTender = next ?? refuseExternalTender;
}

export function posEdcTenderPort(): PosExternalTenderPort {
  return edcTender;
}

export function posPointsTenderPort(): PosExternalTenderPort {
  return pointsTender;
}
