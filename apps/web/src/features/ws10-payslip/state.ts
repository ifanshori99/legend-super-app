// Pure display helpers for the employee payslip, kasbon and reimbursement
// screens (bead legend-23nc; PRD v1.7 §3 F30, F31, HR-01). No React, no DOM:
// status labels/tones, the kasbon approval timeline, input parsing and the PIN
// error mapping live here so the components stay layout-only.
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

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

/** PRD §3 D.30: the employee's payslip PIN is 6 digits. */
export const PAYSLIP_PIN_LENGTH = 6;

/**
 * The mock locks the PIN after three wrong attempts in a row. The catalog text
 * ("Sisa {count} percobaan") is only shown in mock mode; the real API owns its
 * own rate limit (PAYSLIP_PIN_LOCKED) and the screen then shows the locked text.
 */
export const PAYSLIP_PIN_MAX_ATTEMPTS = 3;

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

/** Payroll error code of a failed payslip view, as the screen renders it. */
export function pinErrorKind(
  code: string | undefined,
): "invalid" | "locked" | null {
  if (code === "PAYSLIP_PIN_INVALID") return "invalid";
  if (code === "PAYSLIP_PIN_LOCKED") return "locked";
  return null;
}

/**
 * Whole rupiah from a typed amount. Dots and spaces are grouping, not decimals;
 * anything else (a fraction, a negative sign, letters) is rejected so the form
 * never sends a non-integer Idr.
 */
export function parseAmountInput(raw: string): number | null {
  const digits = raw.replace(/[.\s]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Today's calendar date on the device, YYYY-MM-DD (form default only). */
export function todayBusinessDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `input[type=date]` already enforces this; kept for a parsed request body. */
export function isBusinessDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
