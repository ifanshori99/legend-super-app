import type { MessageKey } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

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
