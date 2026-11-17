// Maps the API's error codes to catalog text, so a refusal reads the same
// whether it came from the mock or the API (contracts.md "Error envelope").
import type { MessageKey, Translate } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

const CODE_KEYS: Record<string, MessageKey> = {
  PAYROLL_APPROVER_NOT_DISTINCT: "payrollRun.error.approverNotDistinct",
  PAYROLL_RUN_INVALID_TRANSITION: "payrollRun.error.invalidTransition",
  PAYROLL_RUN_SIMULATION_STALE: "payrollRun.error.simulationStale",
  PAYROLL_RUN_NOT_APPROVED: "payrollRun.error.notApproved",
  PAYROLL_RUN_FROZEN: "payrollRun.error.frozen",
  PAYROLL_BANK_FILE_MISMATCH: "payrollRun.error.bankFileMismatch",
  LEGACY_BANK_EXPORT_DISABLED: "payrollRun.error.legacyBankExport",
  PAYROLL_SNAPSHOT_MISMATCH: "payrollRun.error.snapshot",
  PAYROLL_INVALID_TRANSITION: "payrollRun.error.poolTransition",
  IDEMPOTENCY_KEY_REUSED: "payrollRun.error.idempotency",
  CONFLICT: "payrollRun.error.conflict",
  VALIDATION_ERROR: "payrollRun.error.validation",
  NETWORK_ERROR: "payrollRun.error.offline",
  FORBIDDEN: "payrollRun.error.forbidden",
  PAYROLL_TAX_PERIOD_NOT_LOCKED: "payrollRun.error.taxPeriodNotLocked",
};

/** The refusal in the user's words; an unknown code keeps the API message. */
export function payrollErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    const key = CODE_KEYS[error.code];
    if (key) return t(key);
    if (error.message) return error.message;
  }
  return t("payrollRun.error.generic");
}

/** True when the failure is the network, not the request (offline state). */
export function isOffline(error: unknown): boolean {
  return error instanceof ApiError && error.code === "NETWORK_ERROR";
}
