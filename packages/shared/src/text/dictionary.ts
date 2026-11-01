// Tenant-scoped lookup for the term dictionary. A dictionary is built once per
// request from the tenant's `text_overrides` rows, exposes `term(key)` for UI
// labels, and hands the flat override map to the app's translator
// (`createTranslator`). A row from another tenant fails closed, and a key
// outside the registry never resolves.

import { createTranslator, messagesId } from "../i18n/index.ts";
import type { MessageKey, MessageOverrides, Messages } from "../i18n/index.ts";
import type { TenantId } from "../core/index.ts";
import { DEFAULT_TEXT_LOCALE } from "./schemas.ts";
import type { TextLocale, TextOverride, TermResolution } from "./schemas.ts";
import { TERM_DEFINITIONS, termDefinitionOf } from "./terms.ts";
import type { TermKey } from "./terms.ts";

export type TermDictionaryOptions = {
  /** Tenant the rows were read for; the API takes it from the scoped context. */
  tenantId: TenantId;
  locale?: TextLocale;
  overrides?: readonly TextOverride[];
  /** Catalog for the locale. Defaults to the Indonesian source catalog. */
  messages?: Messages;
};

export type TermDictionary = {
  readonly tenantId: TenantId;
  readonly locale: TextLocale;
  /** Flat overrides for this locale, ready for `createTranslator`. */
  readonly messageOverrides: MessageOverrides;
  /** Resolved label for a term; RangeError outside the registry. */
  term(key: TermKey): string;
  resolve(key: TermKey): TermResolution;
  /** Every registered term, in registry order (term editor, export). */
  entries(): TermResolution[];
};

/**
 * Overrides resolve as: requested locale → default locale (id) → catalog.
 * The default-locale row applies in other locales on purpose: a tenant's own
 * word for a room beats the platform default until it translates it.
 */
export function createTermDictionary(
  options: TermDictionaryOptions,
): TermDictionary {
  const locale = options.locale ?? DEFAULT_TEXT_LOCALE;
  const rowsByLocale = new Map<TextLocale, Map<MessageKey, string>>();
  for (const override of options.overrides ?? []) {
    if (override.tenantId !== options.tenantId)
      throw new TypeError(
        `Text override ${override.id} belongs to another tenant (TEN-02)`,
      );
    let rows = rowsByLocale.get(override.locale);
    if (!rows) {
      rows = new Map();
      rowsByLocale.set(override.locale, rows);
    }
    if (rows.has(override.key))
      throw new RangeError(
        `Duplicate text override for ${override.key} (${override.locale})`,
      );
    rows.set(override.key, override.value);
  }

  const messageOverrides: MessageOverrides = {};
  for (const [key, value] of rowsByLocale.get(DEFAULT_TEXT_LOCALE) ?? [])
    messageOverrides[key] = value;
  if (locale !== DEFAULT_TEXT_LOCALE)
    for (const [key, value] of rowsByLocale.get(locale) ?? [])
      messageOverrides[key] = value;

  const translate = createTranslator(
    options.messages ?? messagesId,
    messageOverrides,
  );

  function resolve(key: TermKey): TermResolution {
    const definition = termDefinitionOf(key);
    return {
      key: definition.key,
      group: definition.group,
      value: translate(definition.key),
      source: Object.hasOwn(messageOverrides, definition.key)
        ? "tenant"
        : "catalog",
    };
  }

  return {
    tenantId: options.tenantId,
    locale,
    messageOverrides,
    term: (key) => resolve(key).value,
    resolve,
    entries: () => TERM_DEFINITIONS.map((term) => resolve(term.key)),
  };
}
