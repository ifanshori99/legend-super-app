// Delivery channel error codes, declared next to the schemas
// (docs/plan/contracts.md D-CORE-4). The UI maps `code` to catalog text;
// `message` is the safe Indonesian fallback the API returns.

import { z } from "../core/index.ts";

export const deliveryErrorHttpStatus = {
  /** The platform order id was already imported for this platform (idempotent webhook). */
  DELIVERY_ORDER_DUPLICATE: 409,
  DELIVERY_ORDER_NOT_FOUND: 404,
  /** The requested fulfilment step is outside the delivery order machine. */
  DELIVERY_TRANSITION_INVALID: 409,
  /** The store is closed on that platform, so orders cannot be accepted. */
  DELIVERY_CHANNEL_CLOSED: 409,
  /** A platform line has no menu match and cannot be injected into the KDS. */
  DELIVERY_MAPPING_INCOMPLETE: 422,
  /** Reconciliation was requested for a platform that is not connected. */
  DELIVERY_CHANNEL_UNKNOWN: 404,
  /** The order is not flagged `needs_action` (already synced, resending, or never failed). */
  DELIVERY_SYNC_NOT_PENDING: 409,
  /** The order's lines changed (webhook) after staff looked; nothing was injected. */
  DELIVERY_ORDER_CHANGED: 409,
} as const satisfies Record<string, number>;

export type DeliveryErrorCode = keyof typeof deliveryErrorHttpStatus;
export const DELIVERY_ERROR_CODES = Object.keys(
  deliveryErrorHttpStatus,
) as DeliveryErrorCode[];

export const deliveryErrorCodeSchema = z.enum(
  DELIVERY_ERROR_CODES as [DeliveryErrorCode, ...DeliveryErrorCode[]],
);

/** Safe Indonesian fallback messages, one per code. */
export const deliveryErrorMessages: Record<DeliveryErrorCode, string> = {
  DELIVERY_ORDER_DUPLICATE: "Pesanan platform ini sudah pernah diterima.",
  DELIVERY_ORDER_NOT_FOUND: "Pesanan kanal pengiriman tidak ditemukan.",
  DELIVERY_TRANSITION_INVALID:
    "Status pesanan kanal pengiriman tidak dapat diubah ke tahap tersebut.",
  DELIVERY_CHANNEL_CLOSED:
    "Toko sedang ditutup pada platform ini; pesanan tidak dapat diterima.",
  DELIVERY_MAPPING_INCOMPLETE:
    "Sebagian item pesanan belum terhubung ke menu Cafe Legend.",
  DELIVERY_CHANNEL_UNKNOWN: "Kanal pengiriman ini belum terhubung.",
  DELIVERY_SYNC_NOT_PENDING:
    "Pesanan ini tidak sedang menunggu tindakan sinkronisasi platform.",
  DELIVERY_ORDER_CHANGED:
    "Item pesanan berubah dari platform. Muat ulang pesanan lalu petakan lagi.",
};

/** Domain error for delivery channel rules. */
export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;

  constructor(code: DeliveryErrorCode, message?: string) {
    super(message ?? deliveryErrorMessages[code]);
    this.name = "DeliveryError";
    this.code = code;
  }
}
