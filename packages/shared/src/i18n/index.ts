// Text catalog entry point. Components never contain UI text; they call
// t("namespace.key", { var }) with a key from the catalog. Tenants may
// override any key (PRD §7 "Katalog teks ... dengan override per tenant").

import { id } from "./messages/id.ts";

export { id as messagesId };
export * from "./format.ts";

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };

/** Shape every locale must follow (keys from the Indonesian source). */
export type Messages = Widen<typeof id>;

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every valid catalog key, e.g. "common.save" or "orderStatus.ready". */
export type MessageKey = Leaves<typeof id>;

/** The same keys at runtime, for schemas and contract tests (never UI text). */
export const MESSAGE_KEYS: readonly MessageKey[] = (() => {
  const keys: string[] = [];
  (function walk(node: unknown, prefix: string): void {
    if (typeof node === "string") {
      keys.push(prefix.slice(0, -1));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node))
      walk(value, `${prefix}${key}.`);
  })(id, "");
  return keys as MessageKey[];
})();

/** True for a key of the catalog; used to reject typo'd tenant overrides. */
export function isMessageKey(value: string): value is MessageKey {
  return (MESSAGE_KEYS as readonly string[]).includes(value);
}

/** Flat tenant overrides, e.g. { "nav.customer.menu": "Daftar Menu" }. */
export type MessageOverrides = Partial<Record<MessageKey, string>>;

export type TranslateVars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: TranslateVars) => string;

function lookup(messages: unknown, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Builds t(). A missing key returns the key itself, so a gap is visible on
 * screen and in tests instead of rendering blank.
 */
export function createTranslator(
  messages: Messages = id,
  overrides: MessageOverrides = {},
): Translate {
  return (key, vars) =>
    interpolate(overrides[key] ?? lookup(messages, key) ?? key, vars);
}

export const DEFAULT_LANGUAGE = "id";
