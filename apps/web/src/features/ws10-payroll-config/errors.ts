// Maps a failed payroll write to catalog text. Domain codes carry the fix
// hint from the contract's error catalog; anything else says the save failed
// without hiding the API's own detail message.
import type { MessageKey } from "@starter/shared/i18n";
import type { PayrollErrorCode } from "@starter/shared/hris/payroll";
import { ApiError } from "@/lib/api/errors";

type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

/** Every payroll error code the configuration screens can receive. */
export const PAYROLL_ERROR_MESSAGE_KEYS = {
  PAYROLL_STATUTORY_TABLE_NOT_FOUND:
    "payrollConfig.errors.PAYROLL_STATUTORY_TABLE_NOT_FOUND",
  PAYROLL_STATUTORY_TABLE_AMBIGUOUS:
    "payrollConfig.errors.PAYROLL_STATUTORY_TABLE_AMBIGUOUS",
  PAYROLL_STATUTORY_TABLE_IMMUTABLE:
    "payrollConfig.errors.PAYROLL_STATUTORY_TABLE_IMMUTABLE",
  PAYROLL_STATUTORY_TABLE_BACKDATED:
    "payrollConfig.errors.PAYROLL_STATUTORY_TABLE_BACKDATED",
  PAYROLL_TER_BRACKET_NOT_FOUND:
    "payrollConfig.errors.PAYROLL_TER_BRACKET_NOT_FOUND",
  PAYROLL_RUN_INVALID_TRANSITION:
    "payrollConfig.errors.PAYROLL_RUN_INVALID_TRANSITION",
  PAYROLL_RUN_SIMULATION_STALE:
    "payrollConfig.errors.PAYROLL_RUN_SIMULATION_STALE",
  PAYROLL_RUN_NOT_APPROVED: "payrollConfig.errors.PAYROLL_RUN_NOT_APPROVED",
  PAYROLL_APPROVER_NOT_DISTINCT:
    "payrollConfig.errors.PAYROLL_APPROVER_NOT_DISTINCT",
  PAYROLL_RUN_FROZEN: "payrollConfig.errors.PAYROLL_RUN_FROZEN",
  PAYROLL_SNAPSHOT_MISMATCH: "payrollConfig.errors.PAYROLL_SNAPSHOT_MISMATCH",
  PAYROLL_LOAN_LIMIT_EXCEEDED:
    "payrollConfig.errors.PAYROLL_LOAN_LIMIT_EXCEEDED",
  PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED:
    "payrollConfig.errors.PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED",
  PAYROLL_INVALID_TRANSITION: "payrollConfig.errors.PAYROLL_INVALID_TRANSITION",
  PAYSLIP_PIN_INVALID: "payrollConfig.errors.PAYSLIP_PIN_INVALID",
  PAYSLIP_PIN_LOCKED: "payrollConfig.errors.PAYSLIP_PIN_LOCKED",
  PAYSLIP_PIN_NOT_SET: "payrollConfig.errors.PAYSLIP_PIN_NOT_SET",
  PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE:
    "payrollConfig.errors.PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE",
  PAYSLIP_PIN_RESET_PROOF_INVALID:
    "payrollConfig.errors.PAYSLIP_PIN_RESET_PROOF_INVALID",
  PAYROLL_BANK_FILE_MISMATCH: "payrollConfig.errors.PAYROLL_BANK_FILE_MISMATCH",
  PAYROLL_PPH21_STATUS_UNSUPPORTED:
    "payrollConfig.errors.PAYROLL_PPH21_STATUS_UNSUPPORTED",
  PAYROLL_PPH21_POLICY_CONFLICT:
    "payrollConfig.errors.PAYROLL_PPH21_POLICY_CONFLICT",
} as const satisfies Record<PayrollErrorCode, MessageKey>;

export function payrollErrorMessageKey(code: string): MessageKey | null {
  return code in PAYROLL_ERROR_MESSAGE_KEYS
    ? PAYROLL_ERROR_MESSAGE_KEYS[code as PayrollErrorCode]
    : null;
}

export function payrollMutationError(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    if (error.code === "IDEMPOTENCY_KEY_REUSED")
      return t("payrollConfig.errors.idempotencyReused");
    if (error.code === "NOT_FOUND") return t("payrollConfig.errors.notFound");
    const key = payrollErrorMessageKey(error.code);
    if (key) return t(key);
    const detail = error.details?.[0]?.message;
    if (detail) return detail;
  }
  return t("payrollConfig.errors.saveFailed");
}

/**
 * True when a list failed because the device has no network, not because the
 * request was refused: the tabs then show the offline state instead of the
 * generic error state (mirrors ws10-payroll-run).
 */
export function isOffline(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.code === "NETWORK_ERROR")
  );
}
