import type { Translate } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

export function deviceErrorMessage(error: unknown, t: Translate): string {
  if (!(error instanceof ApiError)) return t("deviceRegistry.errors.generic");
  switch (error.code) {
    case "FORBIDDEN":
      return t("deviceRegistry.errors.forbidden");
    case "NOT_FOUND":
      return t("deviceRegistry.errors.notFound");
    case "CONFLICT":
      return t("deviceRegistry.errors.conflict");
    case "NETWORK_ERROR":
      return t("deviceRegistry.errors.offline");
    default:
      return t("deviceRegistry.errors.generic");
  }
}
