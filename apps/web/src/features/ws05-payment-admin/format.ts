// Pure display helpers for the payment back office: catalog keys per method,
// status tone and list filters. No React and no `@/` alias, so the root tests
// can import this file with plain Node ESM. Business rules live in the
// contract (@starter/shared/payment/admin); this only shapes what is shown.
import type { MessageKey } from "@starter/shared/i18n";
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import type {
  CashierDefaultMethod,
  EdcTerminalView,
  ReconciliationCaseView,
  RefundStatus,
  RefundView,
  UnallocatedStatus,
  UnallocatedFundView,
} from "@starter/shared/payment/admin";
import type { PaymentMethod } from "@starter/shared/payment";

const METHOD_KEYS: Record<PaymentMethod, MessageKey> = {
  qris: "paymentAdmin.method.qris",
  card: "paymentAdmin.method.card",
  ewallet: "paymentAdmin.method.ewallet",
  va: "paymentAdmin.method.va",
  bank_transfer: "paymentAdmin.method.bank_transfer",
  paylater: "paymentAdmin.method.paylater",
  cash: "paymentAdmin.method.cash",
  edc_card: "paymentAdmin.method.edc_card",
  edc_qris: "paymentAdmin.method.edc_qris",
  points: "paymentAdmin.method.points",
  voucher: "paymentAdmin.method.voucher",
};

export function methodLabelKey(method: PaymentMethod): MessageKey {
  return METHOD_KEYS[method];
}

const CASHIER_METHOD_KEYS: Record<CashierDefaultMethod, MessageKey> = {
  edc_card: "paymentAdmin.method.edc_card",
  edc_qris: "paymentAdmin.method.edc_qris",
  qris_doit: "paymentAdmin.method.qris_doit",
};

export function cashierMethodLabelKey(
  method: CashierDefaultMethod,
): MessageKey {
  return CASHIER_METHOD_KEYS[method];
}

const BANK_KEYS: Record<EdcTerminalView["bankCode"], MessageKey> = {
  bca: "paymentAdmin.bank.bca",
  mandiri: "paymentAdmin.bank.mandiri",
  bni: "paymentAdmin.bank.bni",
  bjb: "paymentAdmin.bank.bjb",
};

export function bankLabelKey(bank: EdcTerminalView["bankCode"]): MessageKey {
  return BANK_KEYS[bank];
}

export function connectionLabelKey(
  connection: EdcTerminalView["connection"],
): MessageKey {
  return connection === "lan"
    ? "paymentAdmin.edc.connectionLan"
    : connection === "usb"
      ? "paymentAdmin.edc.connectionUsb"
      : "paymentAdmin.edc.connectionBluetooth";
}

export type StatusTone = "success" | "warning" | "danger" | "info";

const REFUND_TONES: Record<RefundStatus, StatusTone> = {
  pending: "warning",
  approved: "info",
  completed: "success",
  failed: "danger",
};

export function refundTone(status: RefundStatus): StatusTone {
  return REFUND_TONES[status];
}

const REFUND_LABEL_KEYS: Record<RefundStatus, MessageKey> = {
  pending: "paymentAdmin.refunds.statusPending",
  approved: "paymentAdmin.refunds.statusApproved",
  completed: "paymentAdmin.refunds.statusCompleted",
  failed: "paymentAdmin.refunds.statusFailed",
};

export function refundLabelKey(status: RefundStatus): MessageKey {
  return REFUND_LABEL_KEYS[status];
}

export function unallocatedTone(status: UnallocatedStatus): StatusTone {
  return status === "resolved" ? "success" : "warning";
}

export function unallocatedLabelKey(status: UnallocatedStatus): MessageKey {
  return status === "open"
    ? "paymentAdmin.unallocated.statusOpen"
    : status === "needs_review"
      ? "paymentAdmin.unallocated.statusNeedsReview"
      : "paymentAdmin.unallocated.statusResolved";
}

export function reconciliationTone(
  status: ReconciliationCaseView["status"],
): StatusTone {
  return status === "resolved" || status === "matched" ? "success" : "warning";
}

export function reconciliationLabelKey(
  status: ReconciliationCaseView["status"],
): MessageKey {
  return status === "open"
    ? "paymentAdmin.reconciliation.statusOpen"
    : status === "pending_approval"
      ? "paymentAdmin.reconciliation.statusPending"
      : status === "matched"
        ? "paymentAdmin.reconciliation.statusMatched"
        : "paymentAdmin.reconciliation.statusResolved";
}

/**
 * Approve shows only for a pending refund the server says this viewer may
 * decide (approval matrix, approver ≠ requester — PRD §3 "Matriks Approval").
 */
export function canApproveRefund(refund: RefundView): boolean {
  return refund.status === "pending" && refund.viewerCanApprove;
}

export function filterRefunds(
  rows: readonly RefundView[],
  status: RefundStatus | "all",
): RefundView[] {
  if (status === "all") return [...rows];
  return rows.filter((row) => row.status === status);
}

export function filterUnallocated(
  rows: readonly UnallocatedFundView[],
  status: UnallocatedStatus | "all",
): UnallocatedFundView[] {
  if (status === "all") return [...rows];
  return rows.filter((row) => row.status === status);
}

export function filterReconciliationCases(
  rows: readonly ReconciliationCaseView[],
  filters: {
    status: ReconciliationCaseView["status"] | "all";
    source: ReconciliationCaseView["source"] | "all";
  },
): ReconciliationCaseView[] {
  return rows.filter(
    (row) =>
      (filters.status === "all" || row.status === filters.status) &&
      (filters.source === "all" || row.source === filters.source),
  );
}

/** Newest first, so the work queue reads top-down. */
export function newestFirst<T extends { createdAt: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Fixed outlet zone so the server render and the browser agree (PRD §6). */
const momentFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DEFAULT_TIME_ZONE,
});

export function formatMoment(iso: string): string {
  return momentFormat.format(new Date(iso));
}
