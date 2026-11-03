// Pure rules of the term dictionary editor (PRD v1.7 §3 F4 "Teks & Kamus
// Istilah", §6 `text_overrides`). Super Admin only. A tenant renames the terms
// in the registry (`terms.*` catalog keys); clearing a term deletes its row, it
// never stores an empty string (contract). Locale `id` is the source; `en` rows
// are pre-filled ahead of the English catalog (PRD F47, P1).
import type { TenantId } from "@starter/shared/core";
import {
  TERM_DEFINITIONS,
  createTermDictionary,
  type TermGroup,
  type TermKey,
  type TextLocale,
  type TextOverride,
} from "@starter/shared/text";

export const TERM_VALUE_MAX = 500;

const NO_TENANT = "00000000-0000-4000-8000-000000000000";

export type TermRow = {
  key: TermKey;
  group: TermGroup;
  /** What shows when this locale has no row of its own. */
  fallback: string;
  /** This locale's own override, or null. */
  override: { id: string; value: string } | null;
  /** What the tenant's screens show right now. */
  effective: string;
};

/** Registry order, one row per term, for one locale. */
export function buildTermRows(
  overrides: readonly TextOverride[],
  locale: TextLocale,
): TermRow[] {
  // The rows all belong to the signed-in tenant (the API scopes the list); the
  // dictionary only needs one id to compare them against.
  const tenantId = overrides[0]?.tenantId ?? NO_TENANT;
  const withRows = createTermDictionary({
    tenantId: tenantId as TenantId,
    locale,
    overrides: overrides as TextOverride[],
  });
  // Fallback = the answer without this locale's own rows.
  const withoutOwn = createTermDictionary({
    tenantId: tenantId as TenantId,
    locale,
    overrides: overrides.filter((row) => row.locale !== locale),
  });
  return TERM_DEFINITIONS.map((term) => {
    const own = overrides.find(
      (row) => row.locale === locale && row.key === term.key,
    );
    return {
      key: term.key,
      group: term.group,
      fallback: withoutOwn.term(term.key),
      override: own ? { id: own.id, value: own.value } : null,
      effective: withRows.term(term.key),
    };
  });
}

export type TermChange =
  | { action: "set"; key: TermKey; value: string }
  | { action: "clear"; key: TermKey; overrideId: string };

export type TermIssue = "empty" | "tooLong";

export function validateTermValue(value: string): TermIssue | null {
  const trimmed = value.trim();
  if (trimmed === "") return "empty";
  if (trimmed.length > TERM_VALUE_MAX) return "tooLong";
  return null;
}

/**
 * Changes implied by the editor's drafts (key → text typed). A blank draft on a
 * term that has a row clears it; a draft equal to what the row (or the
 * fallback, when there is no row) already shows changes nothing.
 */
export function termChanges(
  rows: readonly TermRow[],
  drafts: Readonly<Record<string, string>>,
): { changes: TermChange[]; invalid: Record<string, TermIssue> } {
  const changes: TermChange[] = [];
  const invalid: Record<string, TermIssue> = {};
  for (const row of rows) {
    const draft = drafts[row.key];
    if (draft === undefined) continue;
    const text = draft.trim();
    if (text === "") {
      if (row.override)
        changes.push({
          action: "clear",
          key: row.key,
          overrideId: row.override.id,
        });
      continue;
    }
    const issue = validateTermValue(text);
    if (issue) {
      invalid[row.key] = issue;
      continue;
    }
    const current = row.override?.value ?? row.fallback;
    if (text !== current)
      changes.push({ action: "set", key: row.key, value: text });
  }
  return { changes, invalid };
}

export function groupTermRows(rows: readonly TermRow[]): {
  group: TermGroup;
  rows: TermRow[];
}[] {
  const order: TermGroup[] = [];
  for (const row of rows) if (!order.includes(row.group)) order.push(row.group);
  return order.map((group) => ({
    group,
    rows: rows.filter((row) => row.group === group),
  }));
}
