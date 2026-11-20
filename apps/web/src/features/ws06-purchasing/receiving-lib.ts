// Pure helpers for the WS-06 receiving, invoice, return and petty-cash screens
// (bead legend-xkk; PRD v1.7 §3 F18, INV-05). No React and no `@/` alias, so a
// Node test can load this file directly (docs/plan/AGENT_PLAYBOOK.md).
//
// The invariants live in the contract and are imported, never reimplemented:
// `acceptedQuantity` (received − rejected enters stock, INV-05),
// `supplierInvoicePaymentStatus`, the status enums and the petty limit helper.
import {
  DEFAULT_BUSINESS_DAY_CUTOFF,
  businessDateOf,
  formatDecimal4,
  idr,
  parseDecimal4,
  sumIdr,
} from "@starter/shared/core";
import type { BusinessDate, Decimal4, Idr } from "@starter/shared/core";
import { formatRupiah } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";
import {
  acceptedQuantity,
  supplierInvoicePaymentStatus,
} from "@starter/shared/inventory";
import type {
  GoodsReceiptLine,
  InventoryItem,
  PettyPurchase,
  PurchaseOrder,
  PurchaseReturnReason,
  StockLocation,
  Supplier,
  SupplierInvoice,
  SupplierInvoiceMatchStatus,
  SupplierInvoicePaymentStatus,
  SupplierPayment,
  SupplierPaymentMethod,
  SupplierPaymentStatus,
  ThreeWayMatchIssue,
  Uom,
} from "@starter/shared/inventory";
import { INVENTORY_TIME_ZONE } from "../ws06-inventory/outlet.ts";
import {
  decimalFromInput,
  formatQuantity,
  quantityFromInput,
} from "../ws06-inventory/lib.ts";

/** The contract caps a cursor list at 100 rows; the screens load one page. */
export const RECEIVING_LIST_LIMIT = 100;

/** Outlet business date (D-CORE-6/owner Q39), not the browser's calendar day. */
export function todayBusinessDate(): BusinessDate {
  return businessDateOf(new Date(), {
    timeZone: INVENTORY_TIME_ZONE,
    cutoff: DEFAULT_BUSINESS_DAY_CUTOFF,
  });
}

const businessDateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-11-01" → "1 Nov 2026", stable on server and browser. */
export function formatBusinessDate(value: BusinessDate | string): string {
  const [year, month, day] = value.split("-").map(Number);
  return businessDateFormatter.format(new Date(Date.UTC(year, month - 1, day)));
}

/** Local date-time for audit fields, in the outlet zone. */
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: INVENTORY_TIME_ZONE,
  }).format(new Date(iso));
}

/**
 * QC-rejected input. Empty means zero (the field is optional), anything else
 * must be a non-negative Decimal4.
 */
export function rejectedQuantityFromInput(value: string): Decimal4 | null {
  if (value.trim() === "") return formatDecimal4(0n);
  const parsed = decimalFromInput(value);
  if (parsed === null) return null;
  return parseDecimal4(parsed) < 0n ? null : parsed;
}

/** Remaining order quantity never goes negative on screen (INV-05). */
export function remainingQuantity(
  ordered: Decimal4,
  accepted: Decimal4,
): Decimal4 {
  const remaining = parseDecimal4(ordered) - parseDecimal4(accepted);
  return formatDecimal4(remaining > 0n ? remaining : 0n);
}

/** Accepted quantity of one receipt line (received − rejected). */
export function acceptedOf(line: GoodsReceiptLine): Decimal4 {
  return acceptedQuantity(line);
}

/** Totals for a receipt's QC summary: quantity received and rejected. */
export function receiptQcTotals(lines: readonly GoodsReceiptLine[]): {
  received: Decimal4;
  rejected: Decimal4;
  hasRejection: boolean;
} {
  let received = 0n;
  let rejected = 0n;
  for (const line of lines) {
    received += parseDecimal4(line.quantityReceived);
    rejected += parseDecimal4(line.quantityRejected);
  }
  return {
    received: formatDecimal4(received),
    rejected: formatDecimal4(rejected),
    hasRejection: rejected > 0n,
  };
}

/** Whole-rupiah form input ("285.000" or "Rp 285.000") → number, or null. */
export function amountFromInput(value: string): number | null {
  const digits = value.replace(/[^\d]/g, "");
  if (digits === "") return null;
  const amount = Number(digits);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

/** Money kept as text for a catalog message placeholder. */
export function formatIdrText(amount: Idr | number): string {
  return formatRupiah(amount);
}

// ---- Label maps (contract code → catalog key) ----------------------------

export const MATCH_STATUS_LABEL: Record<
  SupplierInvoiceMatchStatus,
  MessageKey
> = {
  pending: "inventoryReceiving.status.pending",
  matched: "inventoryReceiving.status.matched",
  discrepancy: "inventoryReceiving.status.discrepancy",
};

// The StatusPill tone set (components/ui/badge.tsx); there is no neutral pill —
// a draft/no-state status reads as information, a cancelled one as danger.
export type Tone = "success" | "warning" | "danger" | "info";

export const MATCH_STATUS_TONE: Record<SupplierInvoiceMatchStatus, Tone> = {
  pending: "warning",
  matched: "success",
  discrepancy: "danger",
};

export const INVOICE_PAYMENT_TONE: Record<SupplierInvoicePaymentStatus, Tone> =
  {
    unpaid: "warning",
    partially_paid: "info",
    paid: "success",
    overdue: "danger",
  };

export const INVOICE_PAYMENT_LABEL: Record<
  SupplierInvoicePaymentStatus,
  MessageKey
> = {
  unpaid: "inventoryReceiving.status.unpaid",
  partially_paid: "inventoryReceiving.status.partially_paid",
  paid: "inventoryReceiving.status.paid",
  overdue: "inventoryReceiving.status.overdue",
};

export const PAYMENT_STATUS_LABEL: Record<SupplierPaymentStatus, MessageKey> = {
  pending_approval: "inventoryReceiving.status.pending_approval",
  approved: "inventoryReceiving.status.approved",
  paid: "inventoryReceiving.status.paid",
  rejected: "inventoryReceiving.status.rejected",
  cancelled: "inventoryReceiving.status.cancelled",
};

export const PAYMENT_STATUS_TONE: Record<SupplierPaymentStatus, Tone> = {
  pending_approval: "warning",
  approved: "info",
  paid: "success",
  rejected: "danger",
  cancelled: "danger",
};

export const PAYMENT_METHOD_LABEL: Record<SupplierPaymentMethod, MessageKey> = {
  bank_transfer: "inventoryReceiving.invoices.method.bank_transfer",
  cash: "inventoryReceiving.invoices.method.cash",
  qris: "inventoryReceiving.invoices.method.qris",
  virtual_account: "inventoryReceiving.invoices.method.virtual_account",
};

export const RETURN_REASON_LABEL: Record<PurchaseReturnReason, MessageKey> = {
  damaged: "inventoryReceiving.returns.reasonOptions.damaged",
  wrong_item: "inventoryReceiving.returns.reasonOptions.wrong_item",
  expired: "inventoryReceiving.returns.reasonOptions.expired",
  quality_reject: "inventoryReceiving.returns.reasonOptions.quality_reject",
  over_delivery: "inventoryReceiving.returns.reasonOptions.over_delivery",
  other: "inventoryReceiving.returns.reasonOptions.other",
};

export const MATCH_ISSUE_LABEL: Record<ThreeWayMatchIssue, MessageKey> = {
  quantity_exceeds_receipt:
    "inventoryReceiving.invoices.issue.quantity_exceeds_receipt",
  price_outside_tolerance:
    "inventoryReceiving.invoices.issue.price_outside_tolerance",
  no_purchase_order_line:
    "inventoryReceiving.invoices.issue.no_purchase_order_line",
  line_total_mismatch: "inventoryReceiving.invoices.issue.line_total_mismatch",
  invoice_total_mismatch:
    "inventoryReceiving.invoices.issue.invoice_total_mismatch",
};

export const PO_STATUS_LABEL = {
  draft: "purchasing.status.draft",
  pending_approval: "purchasing.status.pending_approval",
  approved: "purchasing.status.approved",
  sent: "purchasing.status.sent",
  partially_received: "purchasing.status.partially_received",
  received: "purchasing.status.received",
  closed: "purchasing.status.closed",
  cancelled: "purchasing.status.cancelled",
} as const satisfies Record<string, MessageKey>;

export function poStatusTone(status: keyof typeof PO_STATUS_LABEL): Tone {
  if (status === "cancelled") return "danger";
  if (status === "closed" || status === "received") return "success";
  if (status === "partially_received") return "info";
  if (status === "approved" || status === "sent") return "success";
  if (status === "pending_approval") return "warning";
  return "info";
}

/** Contract domain code → the sentence the user must read (PRD error rule). */
const ERROR_KEYS: Record<string, MessageKey> = {
  PURCHASE_ORDER_OVER_RECEIPT: "inventoryReceiving.errors.overReceipt",
  PURCHASE_ORDER_LINE_MISMATCH: "inventoryReceiving.errors.lineMismatch",
  PURCHASE_RETURN_EXCEEDS_RECEIPT: "inventoryReceiving.errors.returnExceeds",
  PETTY_PURCHASE_LIMIT_EXCEEDED: "inventoryReceiving.errors.pettyLimit",
  PETTY_CASH_FUND_REQUIRED: "inventoryReceiving.errors.pettyFundRequired",
  PETTY_CASH_INSUFFICIENT: "inventoryReceiving.errors.pettyInsufficient",
  SUPPLIER_INVOICE_NOT_MATCHED: "inventoryReceiving.errors.invoiceNotMatched",
  SUPPLIER_INVOICE_NOT_PAYABLE: "inventoryReceiving.errors.invoiceNotPayable",
  SUPPLIER_INVOICE_OVERPAYMENT: "inventoryReceiving.errors.overpayment",
  SUPPLIER_PAYMENT_INVALID_TRANSITION:
    "inventoryReceiving.errors.paymentTransition",
  SUPPLIER_PAYMENT_NOT_PENDING_APPROVAL:
    "inventoryReceiving.errors.paymentTransition",
  SUPPLIER_PAYMENT_SELF_APPROVAL: "inventoryReceiving.errors.paymentTransition",
  GOODS_RECEIPT_BONUS_REQUIRED: "inventoryReceiving.errors.bonusRequired",
  GOODS_RECEIPT_BONUS_PRICED_LINE: "inventoryReceiving.errors.bonusPricedLine",
  VALIDATION_ERROR: "inventoryReceiving.errors.invalid",
  NOT_FOUND: "inventoryReceiving.errors.notFound",
  NETWORK_ERROR: "inventoryReceiving.offline",
};

/** Catalog key for an ApiError code; unknown codes use the generic action text. */
export function receivingErrorKey(code: string | undefined): MessageKey {
  if (code && code in ERROR_KEYS) return ERROR_KEYS[code];
  return "inventoryReceiving.errors.action";
}

/**
 * legend-tomda: a zero-price PO line is a supplier bonus only when the receiver
 * ticks it; the API refuses it otherwise (GOODS_RECEIPT_BONUS_REQUIRED).
 */
export function isZeroPriceLine(line: { unitPriceIdr: string }): boolean {
  return parseDecimal4(line.unitPriceIdr) === 0n;
}

/** The `isBonus` field of one receipt line body: sent only on a ticked zero-price line. */
export function bonusFlagOf(
  line: { unitPriceIdr: string },
  isBonus: boolean,
): { isBonus?: true } {
  return isZeroPriceLine(line) && isBonus ? { isBonus: true } : {};
}

// ---- Joins used by the lists --------------------------------------------

export function supplierNameOf(
  suppliers: readonly Supplier[],
  supplierId: string,
): string {
  return suppliers.find((supplier) => supplier.id === supplierId)?.name ?? "—";
}

export function itemNameOf(
  items: readonly InventoryItem[],
  itemId: string,
): string {
  return items.find((item) => item.id === itemId)?.name ?? "—";
}

export function locationNameOf(
  locations: readonly StockLocation[],
  locationId: string,
): string {
  return locations.find((location) => location.id === locationId)?.name ?? "—";
}

export function uomCodeOf(uoms: readonly Uom[], uomId: string): string {
  return uoms.find((uom) => uom.id === uomId)?.code ?? "—";
}

export function orderNumberOf(
  orders: readonly PurchaseOrder[],
  purchaseOrderId: string,
): string {
  return orders.find((order) => order.id === purchaseOrderId)?.number ?? "—";
}

/** Payment state of an invoice on today's outlet business date. */
export function invoicePaymentStatus(invoice: SupplierInvoice) {
  return supplierInvoicePaymentStatus(invoice, todayBusinessDate());
}

/** Sum of pending or approved payments: money already committed to an invoice. */
export function openPaymentTotal(
  payments: readonly Pick<SupplierPayment, "amountIdr" | "status">[],
): Idr {
  return sumIdr(
    payments
      .filter(
        (payment) =>
          payment.status === "pending_approval" ||
          payment.status === "approved",
      )
      .map((payment) => payment.amountIdr),
  );
}

/** Money that may still be requested without overpaying the invoice. */
export function payableRemaining(
  invoice: Pick<SupplierInvoice, "outstandingIdr">,
  payments: readonly Pick<SupplierPayment, "amountIdr" | "status">[],
): Idr {
  const committed = Number(openPaymentTotal(payments));
  return idr(Math.max(0, Number(invoice.outstandingIdr) - committed));
}

/** Total petty spend recorded for one business date. */
export function pettySpentOn(
  purchases: readonly Pick<PettyPurchase, "amountIdr" | "businessDate">[],
  date: BusinessDate,
): Idr {
  return sumIdr(
    purchases
      .filter((purchase) => purchase.businessDate === date)
      .map((purchase) => purchase.amountIdr),
  );
}

/** Quantity + its purchase unit, e.g. "2 pack". */
export function formatQuantityWithUnit(
  quantity: Decimal4 | string,
  uomCode: string,
): string {
  return `${formatQuantity(quantity)} ${uomCode}`.trim();
}

/** Positive quantity or zero text for the return form. */
export function returnQuantityFromInput(value: string): Decimal4 | null {
  return quantityFromInput(value);
}
