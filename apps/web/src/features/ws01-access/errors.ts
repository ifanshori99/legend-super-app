// Map the API's stable error codes (contracts.md D-CORE-4) to catalog text so
// every screen explains the same failure the same way.
import type { Translate } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

export function accessErrorMessage(error: unknown, t: Translate): string {
  if (!(error instanceof ApiError)) return t("access.errors.generic");
  switch (error.code) {
    case "REAUTH_REQUIRED":
      return t("access.errors.reauthRequired");
    case "SELF_ELEVATION_FORBIDDEN":
      return t("access.errors.selfElevation");
    case "ROLE_NOT_ASSIGNABLE":
      return t("access.errors.roleNotAssignable");
    case "ROLE_SCOPE_NOT_ALLOWED":
      return t("access.errors.roleScopeNotAllowed");
    case "PERMISSION_NOT_IN_CATALOG":
      return t("access.errors.permissionNotInCatalog");
    case "APPROVER_IS_REQUESTER":
      return t("access.errors.approverIsRequester");
    case "FORBIDDEN":
      return t("access.errors.forbid");
    case "NOT_FOUND":
      return t("access.errors.notFound");
    case "CONFLICT":
      return t("access.errors.conflict");
    case "VALIDATION_ERROR":
      return error.details?.[0]?.message ?? t("access.errors.invalid");
    case "NETWORK_ERROR":
      return t("access.errors.offline");
    default:
      return error.message || t("access.errors.generic");
  }
}
