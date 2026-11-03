// Pure rules of the config export/import screen (PRD v1.7 §3 F4 "Konfigurasi
// sebagai Data & Template Tenant", TEN-09). Import is a two-step flow: parse
// and validate the uploaded bundle, show a section-by-section diff against the
// tenant's current export, and only then apply. A bundle that still carries a
// source-tenant identifier or a secret is refused before any preview.
import {
  CONFIG_SECTIONS,
  parseConfigBundle,
  type BundleIdentifierIssue,
  type ConfigBundle,
  type ConfigSection,
} from "@starter/shared/platform";

export type ParsedBundle =
  | { ok: true; bundle: ConfigBundle }
  | {
      ok: false;
      reason: "size" | "empty" | "json" | "schema" | "identifiers";
      schemaIssues: string[];
      identifierIssues: BundleIdentifierIssue[];
    };

/** Parses the text of an uploaded `.json` file into a validated bundle. */
export function parseBundleText(text: string): ParsedBundle {
  if (text.trim() === "")
    return {
      ok: false,
      reason: "empty",
      schemaIssues: [],
      identifierIssues: [],
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "json",
      schemaIssues: [],
      identifierIssues: [],
    };
  }
  const result = parseConfigBundle(raw);
  if (result.ok) return result;
  return {
    ok: false,
    reason: result.schemaIssues.length > 0 ? "schema" : "identifiers",
    schemaIssues: result.schemaIssues,
    identifierIssues: result.identifierIssues,
  };
}

/** Sections a bundle carries, in the contract's display order. */
export function presentSections(bundle: ConfigBundle): ConfigSection[] {
  return CONFIG_SECTIONS.filter(
    (section) => bundle.sections[section] !== undefined,
  );
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function flatten(
  value: unknown,
  prefix: string,
  out: Map<string, string>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    return;
  }
  out.set(prefix, stable(value));
}

/**
 * The comparable "rows" of one section. A generic section compares item by
 * item (the stable `key`); text overrides compare per locale and catalog key;
 * theme and modules compare per setting path.
 */
export function sectionEntries(
  bundle: ConfigBundle,
  section: ConfigSection,
): Map<string, string> {
  const entries = new Map<string, string>();
  const data = bundle.sections[section];
  if (!data) return entries;
  if (section === "text_overrides") {
    const sets = (
      data as {
        sets: { locale: string; overrides: { key: string; value: string }[] }[];
      }
    ).sets;
    for (const set of sets)
      for (const override of set.overrides)
        entries.set(`${set.locale}:${override.key}`, stable(override.value));
    return entries;
  }
  if (section === "theme" || section === "modules") {
    const { version: _version, ...rest } = data as { version: number } & Record<
      string,
      unknown
    >;
    void _version;
    flatten(rest, "", entries);
    return entries;
  }
  const items = (data as { items: { key: string }[] }).items;
  for (const item of items) entries.set(item.key, stable(item));
  return entries;
}

export type SectionStatus = "added" | "changed" | "unchanged";

export type SectionDiff = {
  section: ConfigSection;
  /** `added`: the tenant has nothing in this section yet. */
  status: SectionStatus;
  added: string[];
  changed: string[];
  /** Rows the tenant has now that the bundle does not carry. */
  removed: string[];
  unchanged: number;
};

/**
 * Diff of what applying the bundle would do to the tenant, per section the
 * bundle carries. Applying replaces a section as a whole (contract: sections
 * apply in one transaction), so rows only the tenant has are reported as
 * `removed`.
 */
export function diffBundles(
  current: ConfigBundle,
  incoming: ConfigBundle,
): SectionDiff[] {
  return presentSections(incoming).map((section) => {
    const before = sectionEntries(current, section);
    const after = sectionEntries(incoming, section);
    const hadSection = current.sections[section] !== undefined;
    const added: string[] = [];
    const changed: string[] = [];
    let unchanged = 0;
    for (const [key, value] of after) {
      const old = before.get(key);
      if (old === undefined) added.push(key);
      else if (old !== value) changed.push(key);
      else unchanged += 1;
    }
    const removed = [...before.keys()].filter((key) => !after.has(key));
    const status: SectionStatus = !hadSection
      ? "added"
      : added.length + changed.length + removed.length === 0
        ? "unchanged"
        : "changed";
    return { section, status, added, changed, removed, unchanged };
  });
}

export function diffTotals(diffs: readonly SectionDiff[]): {
  sections: number;
  changedSections: number;
  added: number;
  changed: number;
  removed: number;
} {
  return {
    sections: diffs.length,
    changedSections: diffs.filter((diff) => diff.status !== "unchanged").length,
    added: diffs.reduce((sum, diff) => sum + diff.added.length, 0),
    changed: diffs.reduce((sum, diff) => sum + diff.changed.length, 0),
    removed: diffs.reduce((sum, diff) => sum + diff.removed.length, 0),
  };
}

/** Sections chosen for apply, in contract order (a section toggled off is skipped). */
export function selectedSections(
  diffs: readonly SectionDiff[],
  off: ReadonlySet<ConfigSection>,
): ConfigSection[] {
  return diffs
    .filter((diff) => diff.status !== "unchanged" && !off.has(diff.section))
    .map((diff) => diff.section);
}

/** `konfigurasi-20261103.json` from the export timestamp. */
export function bundleFileName(exportedAt: string): string {
  return `konfigurasi-${exportedAt.slice(0, 10).replaceAll("-", "")}.json`;
}

export function serializeBundle(bundle: ConfigBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
