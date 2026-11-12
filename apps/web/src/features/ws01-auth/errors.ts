import type { MessageKey } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";
import { classifyRecoveryError } from "./recovery-state";

/**
 * Wrong code, rate limit and offline are the only failures a second factor can
 * produce that the user can act on; everything else gets the same retry hint.
 * Every message says how to fix it (PRD: error selalu disertai petunjuk).
 */
export function secondFactorErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.code === "NETWORK_ERROR") return "staffAuth.verify.offlineHint";
    if (error.status === 429) return "staffAuth.verify.rateLimited";
  }
  return "staffAuth.verify.invalidCode";
}

/** Enrollment failures are about setup, not about a typed code. */
export function enrollmentErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError && error.code === "NETWORK_ERROR")
    return "staffAuth.errors.offlineHint";
  return "staffAuth.enroll.errorGeneric";
}

/** Typing a backup code at the login challenge. */
export function recoveryLoginErrorKey(error: unknown): MessageKey {
  switch (classifyRecoveryError(error)) {
    case "network":
      return "staffAuth.recoveryLogin.offline";
    case "rate_limited":
      return "staffAuth.recoveryLogin.rateLimited";
    case "session_ended":
      return "staffAuth.recoveryLogin.sessionEnded";
    case "invalid":
      return "staffAuth.recoveryLogin.invalid";
    default:
      return "staffAuth.recoveryLogin.unknown";
  }
}

/** Generating or regenerating the set. */
export function recoveryGenerateErrorKey(error: unknown): MessageKey {
  switch (classifyRecoveryError(error)) {
    case "network":
      return "staffAuth.recovery.offline";
    case "mfa_required":
      return "staffAuth.recovery.mfaRequired";
    case "no_factor":
      return "staffAuth.recovery.noFactor";
    case "session_ended":
      return "staffAuth.recovery.sessionEnded";
    default:
      return "staffAuth.recovery.unknown";
  }
}
