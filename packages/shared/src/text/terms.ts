// The tenant term dictionary (PRD §3 F4 "Teks & Kamus Istilah"): the terms a
// tenant may rename without a deploy — table, space/zone ("Zona WFC"),
// facility ("Shower Room"), production station and loyalty tier. Defaults live
// in the text catalog (`terms.*` in i18n/messages/id.ts); this file is the
// registry that decides which catalog keys are terms and how the term editor
// groups them. Values never live here, so the catalog stays the only source.

import { termDefinitionSchema } from "./schemas.ts";
import type { TermDefinition } from "./schemas.ts";

/** Registry order is the order the term editor and `entries()` use. */
export const TERM_DEFINITIONS = [
  { key: "terms.table", group: "table" },
  { key: "terms.zone", group: "space" },
  { key: "terms.wfcZone", group: "space" },
  { key: "terms.facility", group: "facility" },
  { key: "terms.showerRoom", group: "facility" },
  { key: "terms.station", group: "station" },
  { key: "terms.stationBarKopi", group: "station" },
  { key: "terms.stationBarNonkopi", group: "station" },
  { key: "terms.stationDapurPanas", group: "station" },
  { key: "terms.stationDapurDingin", group: "station" },
  { key: "terms.stationPastry", group: "station" },
  { key: "terms.loyaltyTier", group: "loyalty_tier" },
  { key: "terms.tierSilver", group: "loyalty_tier" },
  { key: "terms.tierGold", group: "loyalty_tier" },
  { key: "terms.tierPlatinum", group: "loyalty_tier" },
] as const satisfies readonly TermDefinition[];

/** The registry as plain values, validated at module load. */
export const TERM_CATALOG: readonly TermDefinition[] = TERM_DEFINITIONS.map(
  (term) => termDefinitionSchema.parse(term),
);

export type TermKey = (typeof TERM_DEFINITIONS)[number]["key"];

const termKeys = new Set<string>(TERM_DEFINITIONS.map((term) => term.key));

export function isTermKey(value: string): value is TermKey {
  return termKeys.has(value);
}

/** Throws RangeError for a key outside the registry, so a lookup can never
 * silently fall through to the raw key on screen. */
export function termDefinitionOf(key: string): TermDefinition {
  const definition = TERM_CATALOG.find((term) => term.key === key);
  if (!definition) throw new RangeError(`Not a term dictionary key: ${key}`);
  return definition;
}
