// Config bundle section codecs (PRD v1.7 §3 F4 "Konfigurasi sebagai Data",
// TEN-09; bead legend-tct8).
//
// A section codec is owned by the domain that owns the configuration. It is
// a pure, structural object, so domain folders never import `platform`:
//
//   toTemplate(rows, ctx?)   tenant rows (with ids)  -> tenant-free items
//   fromTemplate(items, ctx?) items -> id-less drafts, or a list of issues
//
// Rows reference each other by item `key` inside a bundle; the importer mints
// fresh ids when it inserts drafts. This file is the registry: it validates
// bundle items against each codec's item schema (`configBundleSchema` calls
// `configSectionItemIssues`) and decodes a whole bundle in dependency order
// (`decodeConfigBundle`), because some sections reference others
// (`approval_policies` -> `roles`).
//
// Items are the `kind`-discriminated shape of `configSectionItemSchemas`
// (legend-5cwrq); the codecs still read the old kind-less shape so stored
// templates and old exports import. Item and reference checks run for both.
//
// Registered here: roles, approval_policies, chart_of_accounts, zones,
// tax_rules, service_charge_rules, checklists, facilities, wifi_policies.
// loyalty_policy and payroll_settings (money, loose item schema) stay
// free-form JSON (identifier scan only) until their owning domain registers a
// codec: add it to `CONFIG_SECTION_CODECS`.

import {
  approvalPoliciesConfigCodec,
  rolesConfigCodec,
  type ConfigDecodeResult,
} from "../access/index.ts";
import {
  chartOfAccountsConfigCodec,
  type ChartOfAccountsMappingDraft,
} from "../accounting/index.ts";
import type { ConfigBundle, ConfigSection } from "./config.ts";
import {
  checklistsConfigCodec,
  facilitiesConfigCodec,
  serviceChargeRulesConfigCodec,
  taxRulesConfigCodec,
  wifiPoliciesConfigCodec,
  zonesConfigCodec,
  type ConfigSectionRefs,
} from "./config-section-codecs.ts";

export const CONFIG_SECTION_CODECS = {
  roles: rolesConfigCodec,
  approval_policies: approvalPoliciesConfigCodec,
  chart_of_accounts: chartOfAccountsConfigCodec,
  zones: zonesConfigCodec,
  tax_rules: taxRulesConfigCodec,
  service_charge_rules: serviceChargeRulesConfigCodec,
  checklists: checklistsConfigCodec,
  facilities: facilitiesConfigCodec,
  wifi_policies: wifiPoliciesConfigCodec,
} as const;

export type CodecSection = keyof typeof CONFIG_SECTION_CODECS;
export type ConfigSectionCodec = (typeof CONFIG_SECTION_CODECS)[CodecSection];

/** Codec of a section, `undefined` while its domain has not registered one. */
export function configSectionCodec(
  section: ConfigSection,
): ConfigSectionCodec | undefined {
  return Object.hasOwn(CONFIG_SECTION_CODECS, section)
    ? CONFIG_SECTION_CODECS[section as CodecSection]
    : undefined;
}

type SectionLike = { version: number; items: readonly unknown[] };

export type ConfigItemIssue = {
  /** Path inside the bundle, e.g. ["sections", "roles", "items", 0, "key"]. */
  path: (string | number)[];
  message: string;
};

/** Item-schema problems of one generic section (empty = fine or no codec). */
export function configSectionItemIssues(
  section: ConfigSection,
  value: SectionLike | undefined,
): ConfigItemIssue[] {
  const codec = configSectionCodec(section);
  if (!codec || !value) return [];
  const issues: ConfigItemIssue[] = [];
  if (value.version !== codec.version)
    issues.push({
      path: ["sections", section, "version"],
      message: `expected ${codec.version}, got ${value.version}`,
    });
  value.items.forEach((item, index) => {
    const parsed = codec.itemSchema.safeParse(item);
    if (parsed.success) return;
    for (const issue of parsed.error.issues)
      issues.push({
        path: ["sections", section, "items", index, ...issue.path.map(String)],
        message: issue.message,
      });
  });
  return issues;
}

/** Order codecs are decoded in: a section only references earlier ones. */
const DECODE_ORDER: readonly CodecSection[] = [
  "roles",
  "approval_policies",
  "chart_of_accounts",
  "zones",
  "tax_rules",
  "service_charge_rules",
  "checklists",
  "facilities",
  "wifi_policies",
];

type DraftsOf<C extends { fromTemplate: (...args: never[]) => unknown }> =
  ReturnType<C["fromTemplate"]> extends infer R
    ? R extends { ok: true; drafts: infer D }
      ? D
      : never
    : never;

export type DecodedConfigDrafts = {
  roles?: DraftsOf<typeof rolesConfigCodec>;
  approval_policies?: DraftsOf<typeof approvalPoliciesConfigCodec>;
  chart_of_accounts?: DraftsOf<typeof chartOfAccountsConfigCodec>;
  zones?: DraftsOf<typeof zonesConfigCodec>;
  tax_rules?: DraftsOf<typeof taxRulesConfigCodec>;
  service_charge_rules?: DraftsOf<typeof serviceChargeRulesConfigCodec>;
  checklists?: DraftsOf<typeof checklistsConfigCodec>;
  facilities?: DraftsOf<typeof facilitiesConfigCodec>;
  wifi_policies?: DraftsOf<typeof wifiPoliciesConfigCodec>;
};

export type DecodeConfigBundleOptions = {
  /** Sections to import; default every codec-backed section in the bundle. */
  sections?: readonly ConfigSection[];
  /** Role keys already in the target tenant, for `approval_policies` alone. */
  existingRoleKeys?: ReadonlySet<string>;
};

export type DecodeConfigBundleResult =
  | {
      ok: true;
      drafts: DecodedConfigDrafts;
      /** Wanted sections present in the bundle that have no codec yet; the
       * importer must handle them another way (typed sections) or report them. */
      withoutCodec: ConfigSection[];
      /** Posting-role mappings of the `chart_of_accounts` section (account by
       * code); empty when the bundle carries none. */
      accountMappings: ChartOfAccountsMappingDraft[];
    }
  | { ok: false; issues: { section: ConfigSection; message: string }[] };

/**
 * Turns a parsed bundle into per-section drafts, resolving cross-section
 * references by key. Nothing is written: the importer inserts drafts in
 * `Object.keys(drafts)` order (roles before approval_policies).
 */
export function decodeConfigBundle(
  bundle: ConfigBundle,
  options: DecodeConfigBundleOptions = {},
): DecodeConfigBundleResult {
  const wanted = new Set<ConfigSection>(
    options.sections ?? (Object.keys(bundle.sections) as ConfigSection[]),
  );
  const issues: { section: ConfigSection; message: string }[] = [];
  const drafts: DecodedConfigDrafts = {};
  let accountMappings: ChartOfAccountsMappingDraft[] = [];
  const sections = bundle.sections as Partial<
    Record<ConfigSection, SectionLike>
  >;

  const roleKeys = new Set<string>(options.existingRoleKeys ?? []);
  if (wanted.has("roles"))
    for (const item of (sections.roles?.items ?? []) as { key: string }[])
      roleKeys.add(item.key);

  // Keys of the bundle's own sections, for references between sections. A set
  // exists only when the bundle carries that section (else the target tenant
  // may hold the row, and the importer checks it).
  const keysOf = (
    section: ConfigSection,
    pick: (item: { key: string; kind?: string }) => boolean = () => true,
  ) => {
    const value = sections[section];
    return value
      ? new Set(
          (value.items as { key: string; kind?: string }[])
            .filter(pick)
            .map((item) => item.key),
        )
      : undefined;
  };
  const refs: ConfigSectionRefs = {
    zoneKeys: keysOf("zones"),
    roleKeys: sections.roles ? roleKeys : undefined,
    taxRuleKeys: keysOf("tax_rules", (item) => item.kind === "rule"),
    facilityKeys: keysOf("facilities", (item) => item.kind === "facility"),
  };

  for (const section of DECODE_ORDER) {
    const value = sections[section];
    if (!wanted.has(section) || !value) continue;
    const schemaIssues = configSectionItemIssues(section, value);
    if (schemaIssues.length > 0) {
      for (const issue of schemaIssues)
        issues.push({
          section,
          message: `${issue.path.slice(2).join(".")}: ${issue.message}`,
        });
      continue;
    }
    const items = value.items;
    const accounts =
      section === "chart_of_accounts"
        ? chartOfAccountsConfigCodec.fromTemplate(
            items as Parameters<
              typeof chartOfAccountsConfigCodec.fromTemplate
            >[0],
          )
        : undefined;
    const result: ConfigDecodeResult<unknown> =
      accounts ??
      (section === "approval_policies"
        ? approvalPoliciesConfigCodec.fromTemplate(
            items as Parameters<
              typeof approvalPoliciesConfigCodec.fromTemplate
            >[0],
            { roleKeys },
          )
        : section === "roles"
          ? rolesConfigCodec.fromTemplate(
              items as Parameters<typeof rolesConfigCodec.fromTemplate>[0],
            )
          : // The other codecs share one signature: (items, refs).
            (
              CONFIG_SECTION_CODECS[section] as {
                fromTemplate: (
                  items: never,
                  ctx: ConfigSectionRefs,
                ) => ConfigDecodeResult<unknown>;
              }
            ).fromTemplate(items as never, refs));
    if (result.ok) {
      Object.assign(drafts, { [section]: result.drafts });
      if (accounts?.ok) accountMappings = accounts.mappings;
    } else
      for (const message of result.issues) issues.push({ section, message });
  }
  const withoutCodec = (Object.keys(sections) as ConfigSection[]).filter(
    (section) => wanted.has(section) && !configSectionCodec(section),
  );
  return issues.length === 0
    ? { ok: true, drafts, withoutCodec, accountMappings }
    : { ok: false, issues };
}

/**
 * Reference and uniqueness problems of a bundle that already passed the item
 * schemas (role keys of approval policies, CoA parents, level gaps, ...), so
 * a stored template can always be imported. A bundle without a `roles`
 * section may reference roles of the target tenant: those keys are only
 * checked at import (`decodeConfigBundle` with `existingRoleKeys`).
 */
export function configBundleReferenceIssues(
  bundle: ConfigBundle,
): ConfigItemIssue[] {
  const policies = bundle.sections.approval_policies;
  const existingRoleKeys = bundle.sections.roles
    ? undefined
    : new Set(
        ((policies?.items ?? []) as { approverRoleKey?: string }[]).flatMap(
          (item) => (item.approverRoleKey ? [item.approverRoleKey] : []),
        ),
      );
  const decoded = decodeConfigBundle(bundle, { existingRoleKeys });
  return decoded.ok
    ? []
    : decoded.issues.map((issue) => ({
        path: ["sections", issue.section],
        message: issue.message,
      }));
}
