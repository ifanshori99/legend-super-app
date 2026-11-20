// Domain codes for the purchasing contract (bead legend-ejk, PRD v1.7 §3.18
// "Purchasing & Supplier", §4 Alur I, §6.E). The API maps them to HTTP
// responses the same way it maps core codes; the UI maps them to catalog text.
// Codes are UPPER_SNAKE_CASE and stable once shipped
// (docs/plan/contracts.md, D-CORE-4).

import { z } from "../../core/index.ts";

export const PURCHASING_ERROR_CODES = [
  /** The Purchase Request action is not allowed from its status. */
  "PURCHASE_REQUEST_INVALID_TRANSITION",
  /** Approval was attempted before the request was submitted. */
  "PURCHASE_REQUEST_NOT_PENDING_APPROVAL",
  /** PRD §3.7 "Penyetuju selalu berbeda dari pemohon": same requester. */
  "PURCHASE_REQUEST_SELF_APPROVAL",
  /** The Purchase Order action is not allowed from its status. */
  "PURCHASE_ORDER_INVALID_TRANSITION",
  /** Approval was attempted before the PO was submitted. */
  "PURCHASE_ORDER_NOT_PENDING_APPROVAL",
  /** PRD §3.7: the PO approver must differ from the person who created it. */
  "PURCHASE_ORDER_SELF_APPROVAL",
  /** A receipt line points at a PO line of another order or another item. */
  "PURCHASE_ORDER_LINE_MISMATCH",
  /** INV-05: cumulative accepted receipts exceed the ordered quantity. */
  "PURCHASE_ORDER_OVER_RECEIPT",
  /** A payment was requested for an invoice that is not matched yet. */
  "SUPPLIER_INVOICE_NOT_MATCHED",
  /** The invoice has nothing left to pay. */
  "SUPPLIER_INVOICE_NOT_PAYABLE",
  /** A payment amount exceeds the invoice's outstanding payable. */
  "SUPPLIER_INVOICE_OVERPAYMENT",
  /** The supplier already has an invoice with that number (not rejected). */
  "SUPPLIER_INVOICE_DUPLICATE",
  /** Release or reject was asked for an invoice that is not held. */
  "SUPPLIER_INVOICE_NOT_HELD",
  /** The held invoice has an issue finance may not release (quantity, totals). */
  "SUPPLIER_INVOICE_RELEASE_BLOCKED",
  /** The person who recorded the invoice tried to release it. */
  "SUPPLIER_INVOICE_SELF_RELEASE",
  /** Booking a supplier invoice payable is switched off (legend-29vw). */
  "SUPPLIER_INVOICE_POSTING_DISABLED",
  /** The supplier payment action is not allowed from its status. */
  "SUPPLIER_PAYMENT_INVALID_TRANSITION",
  /** Approval was attempted before the payment was requested. */
  "SUPPLIER_PAYMENT_NOT_PENDING_APPROVAL",
  /** PRD §3.7: the payment approver must differ from the requester. */
  "SUPPLIER_PAYMENT_SELF_APPROVAL",
  /** A return line exceeds the quantity accepted for that PO line. */
  "PURCHASE_RETURN_EXCEEDS_RECEIPT",
  /** A return that was invoiced exceeds what is still owed on the invoice. */
  "PURCHASE_RETURN_EXCEEDS_PAYABLE",
  /** The goods receipt behind this invoice or return has no posted receipt journal yet (GRNI, legend-29vw). */
  "GOODS_RECEIPT_NOT_JOURNALED",
  /** PRD §3.18 "Pembelian Sederhana ... batas nominal": over the outlet limit. */
  "PETTY_PURCHASE_LIMIT_EXCEEDED",
  /** The three-way match input does not describe one order (unknown line). */
  "THREE_WAY_MATCH_INVALID_INPUT",
  /** A write needs an active supplier (catalog price, PO on an inactive one). */
  "SUPPLIER_INACTIVE",
  /** Another supplier in the tenant has the same name (case-insensitive). */
  "SUPPLIER_NAME_TAKEN",
  /** Send was asked for a PO that is not approved, sent or partially received. */
  "PURCHASE_ORDER_NOT_SENDABLE",
  /** Replay of a send whose share link is expired, revoked or missing. */
  "PURCHASE_ORDER_SHARE_LINK_UNAVAILABLE",
  /** legend-tomda: a zero-price receipt line was not marked as a supplier bonus. */
  "GOODS_RECEIPT_BONUS_REQUIRED",
  /** legend-tomda: `isBonus` was sent on a receipt line that has a price. */
  "GOODS_RECEIPT_BONUS_PRICED_LINE",
] as const;

export const purchasingErrorCodeSchema = z.enum(PURCHASING_ERROR_CODES);
export type PurchasingErrorCode = z.infer<typeof purchasingErrorCodeSchema>;

/** Thrown by the pure purchasing helpers; services map `code` to a response. */
export class PurchasingError extends Error {
  readonly code: PurchasingErrorCode;

  constructor(code: PurchasingErrorCode, message: string) {
    super(message);
    this.name = "PurchasingError";
    this.code = code;
  }
}

/**
 * HTTP status per purchasing code (docs/plan/contracts.md, "Inventory and
 * purchasing error statuses"). A `Record` over the code union: a new code
 * without a status fails the typecheck.
 */
export const purchasingErrorHttpStatus = {
  PURCHASE_REQUEST_INVALID_TRANSITION: 409,
  PURCHASE_REQUEST_NOT_PENDING_APPROVAL: 409,
  PURCHASE_REQUEST_SELF_APPROVAL: 409,
  PURCHASE_ORDER_INVALID_TRANSITION: 409,
  PURCHASE_ORDER_NOT_PENDING_APPROVAL: 409,
  PURCHASE_ORDER_SELF_APPROVAL: 409,
  PURCHASE_ORDER_LINE_MISMATCH: 422,
  PURCHASE_ORDER_OVER_RECEIPT: 409,
  SUPPLIER_INVOICE_NOT_MATCHED: 409,
  SUPPLIER_INVOICE_NOT_PAYABLE: 409,
  SUPPLIER_INVOICE_OVERPAYMENT: 409,
  SUPPLIER_INVOICE_DUPLICATE: 409,
  SUPPLIER_INVOICE_NOT_HELD: 409,
  SUPPLIER_INVOICE_RELEASE_BLOCKED: 409,
  SUPPLIER_INVOICE_SELF_RELEASE: 403,
  SUPPLIER_INVOICE_POSTING_DISABLED: 409,
  SUPPLIER_PAYMENT_INVALID_TRANSITION: 409,
  SUPPLIER_PAYMENT_NOT_PENDING_APPROVAL: 409,
  SUPPLIER_PAYMENT_SELF_APPROVAL: 409,
  PURCHASE_RETURN_EXCEEDS_RECEIPT: 409,
  PURCHASE_RETURN_EXCEEDS_PAYABLE: 409,
  GOODS_RECEIPT_NOT_JOURNALED: 409,
  PETTY_PURCHASE_LIMIT_EXCEEDED: 409,
  THREE_WAY_MATCH_INVALID_INPUT: 422,
  SUPPLIER_INACTIVE: 409,
  SUPPLIER_NAME_TAKEN: 409,
  PURCHASE_ORDER_NOT_SENDABLE: 409,
  PURCHASE_ORDER_SHARE_LINK_UNAVAILABLE: 409,
  GOODS_RECEIPT_BONUS_REQUIRED: 422,
  GOODS_RECEIPT_BONUS_PRICED_LINE: 422,
} as const satisfies Record<PurchasingErrorCode, number>;

/**
 * Safe Indonesian fallback message per code. Fixed text: the thrown
 * `PurchasingError.message` carries ids and amounts and never reaches a client.
 */
export const purchasingErrorMessages: Record<PurchasingErrorCode, string> = {
  PURCHASE_REQUEST_INVALID_TRANSITION:
    "Aksi ini tidak dapat dilakukan pada status permintaan pembelian saat ini.",
  PURCHASE_REQUEST_NOT_PENDING_APPROVAL:
    "Permintaan pembelian belum diajukan untuk persetujuan.",
  PURCHASE_REQUEST_SELF_APPROVAL:
    "Pemohon tidak dapat menyetujui permintaan pembeliannya sendiri.",
  PURCHASE_ORDER_INVALID_TRANSITION:
    "Aksi ini tidak dapat dilakukan pada status pesanan pembelian saat ini.",
  PURCHASE_ORDER_NOT_PENDING_APPROVAL:
    "Pesanan pembelian belum diajukan untuk persetujuan.",
  PURCHASE_ORDER_SELF_APPROVAL:
    "Pembuat tidak dapat menyetujui pesanan pembeliannya sendiri.",
  PURCHASE_ORDER_LINE_MISMATCH:
    "Baris penerimaan tidak sesuai dengan pesanan pembelian.",
  PURCHASE_ORDER_OVER_RECEIPT:
    "Jumlah penerimaan melebihi jumlah yang dipesan.",
  SUPPLIER_INVOICE_NOT_MATCHED:
    "Faktur pemasok belum lolos pencocokan tiga arah.",
  SUPPLIER_INVOICE_NOT_PAYABLE: "Faktur pemasok tidak memiliki sisa tagihan.",
  SUPPLIER_INVOICE_OVERPAYMENT:
    "Jumlah pembayaran melebihi sisa tagihan faktur.",
  SUPPLIER_INVOICE_DUPLICATE:
    "Pemasok ini sudah memiliki faktur dengan nomor yang sama.",
  SUPPLIER_INVOICE_NOT_HELD: "Faktur pemasok tidak sedang ditahan.",
  SUPPLIER_INVOICE_RELEASE_BLOCKED:
    "Faktur ini tidak dapat dirilis. Minta pemasok mengirim faktur koreksi.",
  SUPPLIER_INVOICE_SELF_RELEASE:
    "Pencatat faktur tidak dapat merilis fakturnya sendiri.",
  SUPPLIER_INVOICE_POSTING_DISABLED:
    "Pencatatan utang faktur pemasok belum diaktifkan.",
  SUPPLIER_PAYMENT_INVALID_TRANSITION:
    "Aksi ini tidak dapat dilakukan pada status pembayaran pemasok saat ini.",
  SUPPLIER_PAYMENT_NOT_PENDING_APPROVAL:
    "Pembayaran pemasok belum diajukan untuk persetujuan.",
  SUPPLIER_PAYMENT_SELF_APPROVAL:
    "Pemohon tidak dapat menyetujui pembayaran pemasoknya sendiri.",
  PURCHASE_RETURN_EXCEEDS_RECEIPT:
    "Jumlah retur melebihi jumlah yang sudah diterima.",
  PURCHASE_RETURN_EXCEEDS_PAYABLE:
    "Nilai retur melebihi sisa utang faktur pemasok.",
  GOODS_RECEIPT_NOT_JOURNALED:
    "Jurnal penerimaan barang belum terposting; faktur/retur belum bisa dibukukan.",
  PETTY_PURCHASE_LIMIT_EXCEEDED:
    "Pembelian sederhana melebihi batas nominal outlet.",
  THREE_WAY_MATCH_INVALID_INPUT:
    "Data pencocokan tiga arah tidak sesuai dengan satu pesanan.",
  SUPPLIER_INACTIVE: "Pemasok tidak aktif.",
  SUPPLIER_NAME_TAKEN: "Pemasok dengan nama itu sudah ada.",
  PURCHASE_ORDER_NOT_SENDABLE:
    "Pesanan pembelian pada status ini tidak dapat dikirim.",
  PURCHASE_ORDER_SHARE_LINK_UNAVAILABLE:
    "Tautan berbagi tidak tersedia. Kirim ulang dengan kunci idempotensi baru.",
  GOODS_RECEIPT_BONUS_REQUIRED:
    "Baris berharga Rp0 harus ditandai bonus supplier, atau perbaiki harga di pesanan.",
  GOODS_RECEIPT_BONUS_PRICED_LINE:
    "Bonus supplier hanya untuk baris berharga Rp0.",
};
