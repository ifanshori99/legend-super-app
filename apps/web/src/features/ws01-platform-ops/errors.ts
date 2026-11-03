// Map the API's stable error codes (contracts.md D-CORE-4, platform/errors.ts)
// to catalog text so every screen explains the same failure the same way.
import type { Translate } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

export function opsErrorMessage(error: unknown, t: Translate): string {
  if (!(error instanceof ApiError)) return t("platformOps.errors.generic");
  switch (error.code) {
    case "MODULE_NOT_IN_PACKAGE":
      return t("platformOps.errors.moduleNotInPackage");
    case "TENANT_NOT_ACTIVE":
      return t("platformOps.errors.tenantNotActive");
    case "FORBIDDEN":
      return t("platformOps.errors.forbidden");
    case "NOT_FOUND":
      return t("platformOps.errors.notFound");
    case "VALIDATION_ERROR":
      return error.details?.[0]?.message ?? t("platformOps.errors.invalid");
    case "NETWORK_ERROR":
      return t("platformOps.errors.offline");
    default:
      return error.message || t("platformOps.errors.generic");
  }
}
