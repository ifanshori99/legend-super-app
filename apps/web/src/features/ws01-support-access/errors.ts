// Stable API error codes to catalog text.
import type { Translate } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

export function supportErrorMessage(error: unknown, t: Translate): string {
  if (!(error instanceof ApiError)) return t("supportAccess.errors.generic");
  switch (error.code) {
    case "SUPPORT_ACCESS_ALREADY_ACTIVE":
      return t("supportAccess.errors.alreadyActive");
    case "REAUTH_REQUIRED":
    case "MFA_INVALID":
    case "MFA_REQUIRED":
      return t("supportAccess.errors.mfa");
    case "FORBIDDEN":
      return t("supportAccess.errors.forbidden");
    case "NOT_FOUND":
      return t("supportAccess.errors.notFound");
    case "NETWORK_ERROR":
      return t("supportAccess.errors.offline");
    case "VALIDATION_ERROR":
      return error.details?.[0]?.message ?? t("supportAccess.errors.generic");
    default:
      return error.message || t("supportAccess.errors.generic");
  }
}
