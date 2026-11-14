// Maps the API's stable error codes to catalog text so every settings screen
// explains the same failure the same way. Never echoes `error.message` for
// integration saves: a server message could quote a request field.
import type { Translate } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

export function isOfflineError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "NETWORK_ERROR";
}

export function settingsErrorMessage(error: unknown, t: Translate): string {
  if (!(error instanceof ApiError)) return t("tenantSettings.errors.generic");
  switch (error.code) {
    case "THEME_CONTRAST_FAILED":
      return t("tenantSettings.errors.themeContrast");
    case "INTEGRATION_PROVIDER_NOT_AVAILABLE":
      return t("tenantSettings.errors.providerNotAvailable");
    case "CONFIG_BUNDLE_INVALID":
      return t("tenantSettings.errors.bundleInvalid");
    case "INVALID_TRANSITION":
      return t("tenantSettings.errors.invalidTransition");
    case "FORBIDDEN":
      return t("tenantSettings.errors.forbidden");
    case "NOT_FOUND":
      return t("tenantSettings.errors.notFound");
    case "CONFLICT":
      return t("tenantSettings.errors.conflict");
    case "WHATSAPP_NUMBER_TAKEN":
      return t("tenantSettings.errors.whatsappNumberTaken");
    case "VALIDATION_ERROR":
      return t("tenantSettings.errors.invalid");
    case "NETWORK_ERROR":
      return t("tenantSettings.errors.offline");
    default:
      return t("tenantSettings.errors.generic");
  }
}
