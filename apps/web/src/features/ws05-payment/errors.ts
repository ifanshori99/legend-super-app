// Maps payment API failures to catalog text. The API's `code` is the stable
// key; its message is only a fallback and never shown as-is (DESIGN.md: UI
// text comes from the catalog).
import type { MessageKey } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

export function isOfflineError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.code === "NETWORK_ERROR")
  );
}

export function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === "NOT_FOUND")
  );
}

/** 1272 P2-2: the price the payer saw is no longer the price; show the new one. */
export function isFeeChangedError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "FEE_CHANGED";
}

export function paymentErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (isOfflineError(error)) return "payment.offlineHint";
    switch (error.code) {
      case "NOT_FOUND":
        return "payment.linkNotFoundHint";
      case "CONFLICT":
        return "payment.alreadyPaid";
      case "ORDER_CODE_ACTIVE":
      case "SPLIT_CODE_ACTIVE":
      case "QRIS_HOLD_ACTIVE":
        return "payment.codeStillActive";
      case "FUNDS_UNRESOLVED":
        return "payment.fundsUnresolved";
      case "FEE_CHANGED":
        return "payment.redirect.fee.changed";
      case "VALIDATION_ERROR":
        return "payment.methodInvalid";
      case "SERVICE_UNAVAILABLE":
        return "payment.gatewayDownHint";
      default:
        return "payment.actionFailed";
    }
  }
  return "payment.actionFailed";
}
