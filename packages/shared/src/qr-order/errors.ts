// QR order error codes (docs/plan/contracts.md D-CORE-4: a domain contract
// declares its own UPPER_SNAKE codes next to its schemas). The UI maps `code`
// to catalog text; `message` is the safe Indonesian fallback the API returns.
//
// Every code fails closed: the guest is never charged a price the QR flow
// cannot compute. `QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED` is the explicit refusal
// behind bead legend-49pw: the QR quote adds service charge and tax on top of
// the menu price (owner decision 2026-11-01: menu prices exclude both), so a
// tenant whose published tax rule is price-inclusive would be charged twice
// until the inclusive back-out path lands. The route answers 422 with this
// code instead of guessing (Ord-03).

import { z } from "../core/index.ts";

/** A published tax rule marks menu prices as tax-inclusive (legend-49pw). */
export const QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED =
  "QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED" as const;

/**
 * The outlet runs an edge node and its cloud link is down: the cloud refuses
 * the order (it cannot reach the kitchen) and the guest asks a waiter (WS-02).
 */
export const EDGE_LINK_DOWN = "EDGE_LINK_DOWN" as const;

export const qrOrderErrorHttpStatus = {
  [QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED]: 422,
  [EDGE_LINK_DOWN]: 503,
} as const satisfies Record<string, number>;

export type QrOrderErrorCode = keyof typeof qrOrderErrorHttpStatus;
export const QR_ORDER_ERROR_CODES = Object.keys(
  qrOrderErrorHttpStatus,
) as QrOrderErrorCode[];

export const qrOrderErrorCodeSchema = z.enum(
  QR_ORDER_ERROR_CODES as [QrOrderErrorCode, ...QrOrderErrorCode[]],
);

/** Safe Indonesian fallback messages, one per code. */
export const qrOrderErrorMessages: Record<QrOrderErrorCode, string> = {
  QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED:
    "Pajak harga-termasuk-pajak belum didukung untuk QR order; harga menu QR tidak termasuk pajak dan service charge.",
  EDGE_LINK_DOWN: "Silakan pesan melalui waiter.",
};

/**
 * Guest message when a QR order lands on a business day already closed by
 * Tutup Hari. The API refuses it as a PosError BUSINESS_DAY_ALREADY_CLOSED
 * (409) carrying this text (bead legend-2o1b).
 */
export const QR_OUTLET_CLOSED_MESSAGE =
  "Outlet sudah tutup untuk hari ini. Pesanan belum bisa dibuat, silakan hubungi staf.";
