// Pure display helpers for the employee payslip, kasbon and reimbursement
// screens (bead legend-23nc; PRD v1.7 §3 F30, F31, HR-01). No React, no DOM:
// status labels/tones, the kasbon approval timeline and input parsing live
// here so the components stay layout-only. The PIN logic is in pin-state.ts.
//
// The safety rules are not here: `assertLoanWithinPolicy`,
// `assertReimbursementWithinLimit` and the PIN codes belong to
// @starter/shared/hris/payroll and are enforced by the API and the mock.

import type {
  EmployeeLoanStatus,
  PayslipLine,
  PayslipPaymentMethod,
  ReimbursementStatus,
} from "@starter/shared/hris/payroll";
import type { MessageKey } from "@starter/shared/i18n";
import { DEFAULT_TIME_ZONE, localDateOf } from "@starter/shared/core";
import { storagePurposePolicy } from "@starter/shared/storage";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

/**
 * An opened payslip locks itself again after this long on screen (PRD silent;
 * 5 minutes), so a phone left on a counter does not keep salary data open.
 */
export const PAYSLIP_UNLOCK_TTL_MS = 5 * 60_000;

/** Receipt photo: the storage contract's private `receipt` purpose limit. */
export const RECEIPT_PHOTO_MAX_BYTES = storagePurposePolicy.receipt.maxBytes;
export const RECEIPT_PHOTO_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

/** Why a chosen receipt file is refused, or null when it can be used. */
export function receiptPhotoIssue(file: {
  type: string;
  size: number;
}): "type" | "size" | null {
  if (!RECEIPT_PHOTO_TYPES.includes(file.type)) return "type";
  if (file.size <= 0 || file.size > RECEIPT_PHOTO_MAX_BYTES) return "size";
  return null;
}

const LOAN_STATUS_KEYS: Record<EmployeeLoanStatus, MessageKey> = {
  pending: "payslip.status.loan.pending",
  approved: "payslip.status.loan.approved",
  rejected: "payslip.status.loan.rejected",
  cancelled: "payslip.status.loan.cancelled",
  disbursed: "payslip.status.loan.disbursed",
  settled: "payslip.status.loan.settled",
};

const LOAN_STATUS_TONES: Record<EmployeeLoanStatus, StatusTone> = {
  pending: "warning",
  approved: "info",
  rejected: "danger",
  cancelled: "neutral",
  disbursed: "success",
  settled: "success",
};

export function loanStatusKey(status: EmployeeLoanStatus): MessageKey {
  return LOAN_STATUS_KEYS[status];
}

export function loanStatusTone(status: EmployeeLoanStatus): StatusTone {
  return LOAN_STATUS_TONES[status];
}

/** A loan still running at HR: the policy allows one open loan at a time. */
export function isOpenLoan(status: EmployeeLoanStatus): boolean {
  return (
    status === "pending" || status === "approved" || status === "disbursed"
  );
}

const REIMBURSEMENT_STATUS_KEYS: Record<ReimbursementStatus, MessageKey> = {
  submitted: "payslip.status.reimbursement.submitted",
  approved: "payslip.status.reimbursement.approved",
  rejected: "payslip.status.reimbursement.rejected",
  cancelled: "payslip.status.reimbursement.cancelled",
  paid: "payslip.status.reimbursement.paid",
};

const REIMBURSEMENT_STATUS_TONES: Record<ReimbursementStatus, StatusTone> = {
  submitted: "warning",
  approved: "info",
  rejected: "danger",
  cancelled: "neutral",
  paid: "success",
};

export function reimbursementStatusKey(
  status: ReimbursementStatus,
): MessageKey {
  return REIMBURSEMENT_STATUS_KEYS[status];
}

export function reimbursementStatusTone(
  status: ReimbursementStatus,
): StatusTone {
  return REIMBURSEMENT_STATUS_TONES[status];
}

export type TimelineStep = {
  key: MessageKey;
  state: "done" | "current" | "pending";
};

const TIMELINE_KEYS = {
  requested: "payslip.kasbon.timeline.requested",
  pending: "payslip.kasbon.timeline.pending",
  approved: "payslip.kasbon.timeline.approved",
  disbursed: "payslip.kasbon.timeline.disbursed",
  settled: "payslip.kasbon.timeline.settled",
  rejected: "payslip.kasbon.timeline.rejected",
  cancelled: "payslip.kasbon.timeline.cancelled",
} satisfies Record<string, MessageKey>;

/**
 * The kasbon journey for one status (PRD §3 D.31: pengajuan → approval →
 * pencairan → pelunasan lewat payroll). A rejected/cancelled request ends after
 * the decision, so the future steps are not shown.
 */
export function loanTimeline(status: EmployeeLoanStatus): TimelineStep[] {
  const step = (
    key: MessageKey,
    state: TimelineStep["state"],
  ): TimelineStep => ({ key, state });
  switch (status) {
    case "pending":
      return [
        step(TIMELINE_KEYS.requested, "done"),
        step(TIMELINE_KEYS.pending, "current"),
        step(TIMELINE_KEYS.disbursed, "pending"),
        step(TIMELINE_KEYS.settled, "pending"),
      ];
    case "approved":
      return [
        step(TIMELINE_KEYS.requested, "done"),
        step(TIMELINE_KEYS.approved, "done"),
        step(TIMELINE_KEYS.disbursed, "current"),
        step(TIMELINE_KEYS.settled, "pending"),
      ];
    case "disbursed":
      return [
        step(TIMELINE_KEYS.requested, "done"),
        step(TIMELINE_KEYS.approved, "done"),
        step(TIMELINE_KEYS.disbursed, "done"),
        step(TIMELINE_KEYS.settled, "pending"),
      ];
    case "settled":
      return [
        step(TIMELINE_KEYS.requested, "done"),
        step(TIMELINE_KEYS.approved, "done"),
        step(TIMELINE_KEYS.disbursed, "done"),
        step(TIMELINE_KEYS.settled, "done"),
      ];
    case "rejected":
      return [
        step(TIMELINE_KEYS.requested, "done"),
        step(TIMELINE_KEYS.rejected, "current"),
      ];
    case "cancelled":
      return [
        step(TIMELINE_KEYS.requested, "done"),
        step(TIMELINE_KEYS.cancelled, "current"),
      ];
  }
}

const QUANTITY_UNITS: Partial<Record<PayslipLine["category"], MessageKey>> = {
  meal_allowance: "payslip.unit.days",
  overtime: "payslip.unit.hours",
  service_charge: "payslip.unit.points",
};

/** Unit of a payslip line quantity; null when the line has no readable unit. */
export function quantityUnitKey(
  category: PayslipLine["category"],
): MessageKey | null {
  return QUANTITY_UNITS[category] ?? null;
}

const PAYMENT_METHOD_KEYS: Record<PayslipPaymentMethod, MessageKey> = {
  bank_transfer: "payslip.paymentMethod.bank_transfer",
  cash: "payslip.paymentMethod.cash",
};

export function paymentMethodKey(method: PayslipPaymentMethod): MessageKey {
  return PAYMENT_METHOD_KEYS[method];
}

/**
 * Whole rupiah from a typed amount: plain digits ("1500000") or id-ID
 * thousands grouping with dots or spaces ("1.500.000", "1 500 000"). A dot
 * that is not a 3-digit group ("1.5", "1.50") is ambiguous and rejected, as is
 * anything else (a comma decimal, a sign, letters), so the form never sends a
 * non-integer or silently rescaled Idr.
 */
export function parseAmountInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^(\d+|\d{1,3}([. ]\d{3})+)$/.test(trimmed)) return null;
  const digits = trimmed.replace(/[. ]/g, "");
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Today's calendar date in the outlet time zone, YYYY-MM-DD (form default and
 * date picker max). The employee profile carries no outlet zone on this
 * screen yet, so the tenant default (Asia/Jakarta) applies, never the device.
 */
export function todayBusinessDate(
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  return localDateOf(now, timeZone);
}

/** `input[type=date]` already enforces this; kept for a parsed request body. */
export function isBusinessDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
