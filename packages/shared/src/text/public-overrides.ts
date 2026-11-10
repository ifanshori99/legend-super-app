// Tenant text overrides that may be read without a session (legend-it6p4).
// The web server asks for them on every page render, before anyone signs in,
// so only the tenant term dictionary (`terms.*`) is public. Every other
// catalog key (admin, HRIS, payroll, ...) can carry an override too, but it
// never leaves the authenticated `/api/org/text-overrides` surface.

import { z } from "../core/index.ts";
import { catalogKeySchema, textLocaleSchema } from "./schemas.ts";
import type { TextLocale } from "./schemas.ts";
import { isTermKey } from "./terms.ts";
import type { TermKey } from "./terms.ts";

/** The allowlist: today exactly the term dictionary keys. */
export function isPublicOverrideKey(value: string): value is TermKey {
  return isTermKey(value);
}

/**
 * Body of `GET /api/tenant/text-overrides`: `{ locale: { key: value } }`.
 * Both locales are always present (possibly empty) so the shape is stable.
 * No ids, versions, tenant or author fields.
 */
export const publicTextOverridesSchema = z.strictObject({
  id: z.partialRecord(catalogKeySchema, z.string().min(1).max(500)),
  en: z.partialRecord(catalogKeySchema, z.string().min(1).max(500)),
});
export type PublicTextOverrides = z.infer<typeof publicTextOverridesSchema>;

/** Groups override rows by locale and drops every key outside the allowlist. */
export function toPublicTextOverrides(
  rows: readonly { locale: string; key: string; value: string }[],
): PublicTextOverrides {
  const result: PublicTextOverrides = { id: {}, en: {} };
  for (const row of rows) {
    if (!isPublicOverrideKey(row.key)) continue;
    const locale = textLocaleSchema.safeParse(row.locale);
    if (!locale.success) continue;
    result[locale.data satisfies TextLocale][row.key] = row.value;
  }
  return result;
}
