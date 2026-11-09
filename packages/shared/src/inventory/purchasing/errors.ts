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
  /** The supplier payment action is not allowed from its status. */
  "SUPPLIER_PAYMENT_INVALID_TRANSITION",
  /** Approval was attempted before the payment was requested. */
  "SUPPLIER_PAYMENT_NOT_PENDING_APPROVAL",
  /** PRD §3.7: the payment approver must differ from the requester. */
  "SUPPLIER_PAYMENT_SELF_APPROVAL",
  /** A return line exceeds the quantity accepted for that PO line. */
  "PURCHASE_RETURN_EXCEEDS_RECEIPT",
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
