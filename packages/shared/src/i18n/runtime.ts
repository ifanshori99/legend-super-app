// Catalog-free half of the text entry point (legend-nmn9j). The web app swaps
// this file in for `@starter/shared/i18n` (apps/web/vite.config.ts) so its
// bundle never holds the whole Indonesian catalog: the translator below works
// on whatever messages the app has loaded (apps/web/src/components/i18n.tsx).
//
// Same names and behavior as index.ts for everything it exports, except the
// catalog values: `messagesId` and `MESSAGE_KEYS` stay in index.ts, and
// `isMessageKey` answers from the loaded messages. Keep the two in step.
// No runtime imports besides ./format.ts and ./area-manifest.ts: tests load
// this file with Node type stripping.

import type {
  MessageKey,
  MessageOverrides,
  Messages,
  Translate,
  TranslateVars,
} from "./index.ts";

export * from "./area-manifest.ts";
export * from "./format.ts";
export type {
  MessageKey,
  MessageOverrides,
  Messages,
  Translate,
  TranslateVars,
};

/** Loaded messages: a tree of namespaces whose leaves are text. */
export type CatalogNode = { readonly [key: string]: string | CatalogNode };

export const DEFAULT_LANGUAGE = "id";

let defaultCatalog: () => CatalogNode = () => ({});

/**
 * Tells `createTranslator()` and `isMessageKey()` where the messages loaded so
 * far live. Called once by the web store; the getter is read on every lookup,
 * so chunks that load later are seen without rebuilding translators.
 */
export function registerDefaultCatalog(source: () => CatalogNode): void {
  defaultCatalog = source;
}

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
 * screen and in tests instead of rendering blank. Without `messages` it reads
 * the registered default catalog at call time.
 */
export function createTranslator(
  messages?: CatalogNode,
  overrides: MessageOverrides = {},
): Translate {
  return (key, vars) =>
    interpolate(
      overrides[key] ?? lookup(messages ?? defaultCatalog(), key) ?? key,
      vars,
    );
}

/**
 * True for a key found in the messages loaded so far. Unlike index.ts it
 * cannot see a chunk that is not loaded; callers use it to pick a fallback
 * for open strings, where the key's own area is already loaded.
 */
export function isMessageKey(value: string): value is MessageKey {
  return lookup(defaultCatalog(), value) !== undefined;
}
