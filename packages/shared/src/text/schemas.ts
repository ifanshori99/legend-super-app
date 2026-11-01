// Text catalog and tenant term dictionary (PRD §3 F4 "Teks & Kamus Istilah",
// §6 `text_overrides`). Every UI string comes from the catalog in
// `@starter/shared/i18n`; a tenant changes only the terms it needs (table,
// station, tier, "Zona WFC", "Shower Room") through `text_overrides` rows,
// without a deploy. The default catalog is Indonesian; `en` rows and the
// fallback chain are already in place for the English menu (PRD F47, P1).

import {
  clientInputSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { isMessageKey } from "../i18n/index.ts";
import type { MessageKey } from "../i18n/index.ts";

/** Locales `text_overrides` may carry. English exists as a target now, so a
 * tenant can pre-fill it; the UI still renders the Indonesian source until an
 * English catalog ships (PRD F47 is P1). */
export const textLocaleSchema = z.enum(["id", "en"]);
export type TextLocale = z.infer<typeof textLocaleSchema>;

export const DEFAULT_TEXT_LOCALE = "id" satisfies TextLocale;

/** Locales every term must be complete in before a release. */
export const REQUIRED_TEXT_LOCALES = [
  "id",
] as const satisfies readonly TextLocale[];

/**
 * A key of the text catalog, e.g. "terms.wfcZone". An override for a key that
 * is not in the catalog is rejected at write time, so a typo can never look
 * like a working override that changes nothing.
 */
export const catalogKeySchema = z.custom<MessageKey>(
  (value) => typeof value === "string" && isMessageKey(value),
  "Unknown text catalog key",
);

const overrideValue = z.string().trim().min(1).max(500);

/**
 * One `text_overrides` row (PRD §6). Unique per (tenant_id, locale, key);
 * clearing an override deletes the row, it never stores an empty string.
 */
export const textOverrideSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  locale: textLocaleSchema,
  key: catalogKeySchema,
  value: overrideValue,
  updatedAt: isoDateTimeSchema,
});
export type TextOverride = z.infer<typeof textOverrideSchema>;

/** Upsert body. The tenant comes from the scoped context, never the client
 * (TEN-02), so `clientInputSchema` rejects a submitted tenantId. */
export const textOverrideInputSchema = clientInputSchema({
  locale: textLocaleSchema.default(DEFAULT_TEXT_LOCALE),
  key: catalogKeySchema,
  value: overrideValue,
});
export type TextOverrideInput = z.infer<typeof textOverrideInputSchema>;

/** A tenant's overrides for one locale, as exported to a config template
 * (TEN-09). Keys are unique within the set. */
export const textOverrideSetSchema = z
  .strictObject({
    locale: textLocaleSchema,
    overrides: z.array(
      z.strictObject({ key: catalogKeySchema, value: overrideValue }),
    ),
  })
  .refine(
    (set) =>
      new Set(set.overrides.map((override) => override.key)).size ===
      set.overrides.length,
    { path: ["overrides"], message: "Duplicate key in override set" },
  );
export type TextOverrideSet = z.infer<typeof textOverrideSetSchema>;

/** Groups the term editor (P1, PRD F52) sorts terms by. */
export const termGroupSchema = z.enum([
  "table",
  "space",
  "facility",
  "station",
  "loyalty_tier",
]);
export type TermGroup = z.infer<typeof termGroupSchema>;

/** A term is a catalog key the tenant may rename; the registry lives in
 * `terms.ts`. */
export const termDefinitionSchema = z
  .strictObject({
    key: catalogKeySchema,
    group: termGroupSchema,
  })
  .refine((term) => term.key.startsWith("terms."), {
    path: ["key"],
    message: "Term keys live under terms.",
  });
export type TermDefinition = z.infer<typeof termDefinitionSchema>;

/** Lookup result: the value shown plus where it came from, so the term editor
 * can mark tenant overrides. */
export const termResolutionSchema = z.strictObject({
  key: catalogKeySchema,
  group: termGroupSchema,
  value: z.string().min(1),
  source: z.enum(["catalog", "tenant"]),
});
export type TermResolution = z.infer<typeof termResolutionSchema>;

/** Cafe Legend mock term dictionary; must parse against the schemas above. */
export const textFixtureSchema = z.strictObject({
  overrides: z.array(textOverrideSchema),
});
export type TextFixture = z.infer<typeof textFixtureSchema>;
