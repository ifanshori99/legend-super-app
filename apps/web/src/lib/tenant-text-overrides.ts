import type { MessageOverrides } from "@starter/shared/i18n";
import {
  DEFAULT_TEXT_LOCALE,
  isPublicOverrideKey,
  type PublicTextOverrides,
} from "@starter/shared/text";

/**
 * The overrides of the UI language (Indonesian: the only catalog the UI
 * renders). The allowlist is checked again here, so a key the API should never
 * have sent cannot reach the translator.
 */
export function overridesForLocale(
  overrides: PublicTextOverrides | null,
): MessageOverrides {
  const result: MessageOverrides = {};
  if (!overrides) return result;
  for (const [key, value] of Object.entries(overrides[DEFAULT_TEXT_LOCALE]))
    if (isPublicOverrideKey(key)) result[key] = value;
  return result;
}
