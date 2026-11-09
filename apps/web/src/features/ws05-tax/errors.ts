// Maps a failed tax write to catalog text. Domain codes carry their fix hint;
// anything else says the save failed without hiding the API's detail.
import type { MessageKey } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";
import { taxErrorMessageKey } from "./lib";

type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

export function taxMutationError(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    // The server message for an overlap names the other rule; keep it only
    // when the response carried one (not the client's English fallback).
    if (
      error.code === "TAX_RULE_AMBIGUOUS" &&
      error.message !== `Request failed with status ${error.status}.`
    )
      return error.message;
    const key = taxErrorMessageKey(error.code);
    if (key) return t(key);
    const detail = error.details?.[0]?.message;
    if (detail) return detail;
  }
  return t("tax.errors.saveFailed");
}
