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
// Registered here: roles, approval_policies, chart_of_accounts, tax_rules,
// zones, service_charge_rules, checklists, loyalty_policy, facilities and
// wifi_policies (the one codec that lives in `platform`) and payroll_settings.

import {
  approvalPoliciesConfigCodec,
  rolesConfigCodec,
} from "../access/index.ts";
import {
  chartOfAccountsConfigCodec,
  type ChartOfAccountsMappingDraft,
} from "../accounting/index.ts";
import type { ConfigBundle, ConfigSection } from "./config.ts";
import { taxRulesConfigCodec } from "../tax/config-codec.ts";
import { serviceChargeRulesConfigCodec } from "../tax/service-charge-config-codec.ts";
import { zonesConfigCodec } from "../qr-order/config-codec.ts";
import { checklistsConfigCodec } from "../operations/config-codec.ts";
import { loyaltyPolicyConfigCodec } from "../crm/config-codec.ts";
import { facilitiesConfigCodec } from "../facility/config-codec.ts";
import { payrollSettingsConfigCodec } from "../hris/payroll/config-codec.ts";
import {
  wifiPoliciesConfigCodec,
  type ConfigSectionRefs,
} from "./config-section-codecs.ts";

export const CONFIG_SECTION_CODECS = {
  roles: rolesConfigCodec,
  approval_policies: approvalPoliciesConfigCodec,
  chart_of_accounts: chartOfAccountsConfigCodec,
  tax_rules: taxRulesConfigCodec,
  zones: zonesConfigCodec,
  service_charge_rules: serviceChargeRulesConfigCodec,
  checklists: checklistsConfigCodec,
  loyalty_policy: loyaltyPolicyConfigCodec,
  facilities: facilitiesConfigCodec,
  wifi_policies: wifiPoliciesConfigCodec,
  payroll_settings: payrollSettingsConfigCodec,
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
  "tax_rules",
  "zones",
  "service_charge_rules",
  "checklists",
  "loyalty_policy",
  "facilities",
  "wifi_policies",
  "payroll_settings",
];

type DraftsOf<C extends { fromTemplate: (...args: never[]) => unknown }> =
  ReturnType<C["fromTemplate"]> extends infer R
    ? R extends { ok: true; drafts: infer D }
      ? D
      : never
    : never;

export type DecodedConfigDrafts = {
  [Section in CodecSection]?: DraftsOf<(typeof CONFIG_SECTION_CODECS)[Section]>;
};

export type DecodeConfigBundleOptions = {
  /** Sections to import; default every codec-backed section in the bundle. */
  sections?: readonly ConfigSection[];
  /** Role keys already in the target tenant, for `approval_policies` alone. */
  existingRoleKeys?: ReadonlySet<string>;
  /** Target outlet codes when the importer has resolved them. */
  existingOutletKeys?: ReadonlySet<string>;
  /** Target legal entities resolved by their portable keys. */
  existingLegalEntityKeys?: ReadonlySet<string>;
  /** Target zones for importing dependent sections without a zones section. */
  existingZoneOutletKeyByKey?: ReadonlyMap<string, string>;
  /** Target tax rule owners; null denotes a tenant-wide rule. */
  existingTaxRuleOutletKeyByKey?: ReadonlyMap<string, string | null>;
  /** Target menu keys referenced by loyalty reward/mission configuration. */
  existingMenuItemKeys?: ReadonlySet<string>;
  /** Explicit target lock decision: null before the first ledger entry. */
  lockedPointValueIdr: number | null;
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
  optionsArg?: DecodeConfigBundleOptions,
): DecodeConfigBundleResult {
  const options: Partial<DecodeConfigBundleOptions> = optionsArg ?? {};
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

  const zoneOutletKeyByKey = new Map(options.existingZoneOutletKeyByKey ?? []);
  if (wanted.has("zones"))
    for (const item of (sections.zones?.items ?? []) as {
      key: string;
      outletKey: string;
    }[])
      zoneOutletKeyByKey.set(item.key, item.outletKey);
  const zoneKeys = new Set(zoneOutletKeyByKey.keys());
  const taxRuleOutletKeyByKey = new Map(
    options.existingTaxRuleOutletKeyByKey ?? [],
  );
  if (wanted.has("tax_rules"))
    for (const item of (sections.tax_rules?.items ?? []) as {
      key: string;
      kind: string;
      outletKey: string | null;
    }[])
      if (item.kind === "rule")
        taxRuleOutletKeyByKey.set(item.key, item.outletKey);

  // Keys of the bundle's own sections for the Wi-Fi references. A set exists
  // only when the bundle carries (and imports) that section: otherwise the
  // target tenant may hold the row and the importer checks it.
  const keysOf = (
    section: ConfigSection,
    pick: (item: { key: string; kind?: string }) => boolean = () => true,
  ) => {
    const value = sections[section];
    return wanted.has(section) && value
      ? new Set(
          (value.items as { key: string; kind?: string }[])
            .filter(pick)
            .map((item) => item.key),
        )
      : undefined;
  };
  const wifiRefs: ConfigSectionRefs = {
    zoneKeys: keysOf("zones"),
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
    const result = (() => {
      switch (section) {
        case "approval_policies":
          return approvalPoliciesConfigCodec.fromTemplate(
            value.items as Parameters<
              typeof approvalPoliciesConfigCodec.fromTemplate
            >[0],
            { roleKeys },
          );
        case "roles":
          return rolesConfigCodec.fromTemplate(
            value.items as Parameters<typeof rolesConfigCodec.fromTemplate>[0],
          );
        case "chart_of_accounts":
          return chartOfAccountsConfigCodec.fromTemplate(
            value.items as Parameters<
              typeof chartOfAccountsConfigCodec.fromTemplate
            >[0],
          );
        case "tax_rules": {
          const missingOutlets = options.existingOutletKeys
            ? (value.items as { key: string; outletKey: string | null }[])
                .filter(
                  (item) =>
                    item.outletKey !== null &&
                    !options.existingOutletKeys!.has(item.outletKey),
                )
                .map(
                  (item) =>
                    `Tax item ${item.key}: outletKey ${item.outletKey} is not a known outlet`,
                )
            : [];
          if (missingOutlets.length > 0)
            return { ok: false as const, issues: missingOutlets };
          return taxRulesConfigCodec.fromTemplate(value.items);
        }
        case "zones":
          return zonesConfigCodec.fromTemplate(value.items, {
            outletKeys: options.existingOutletKeys,
          });
        case "service_charge_rules":
          return serviceChargeRulesConfigCodec.fromTemplate(value.items, {
            outletKeys: options.existingOutletKeys,
            zoneKeys,
            zoneOutletKeyByKey,
          });
        case "checklists":
          return checklistsConfigCodec.fromTemplate(value.items, {
            outletKeys: options.existingOutletKeys,
            zoneOutletKeyByKey,
            roleKeys,
          });
        case "loyalty_policy": {
          const lockedPointValueIdr = options.lockedPointValueIdr;
          if (
            value.items.length > 0 &&
            lockedPointValueIdr !== null &&
            (!Number.isSafeInteger(lockedPointValueIdr) ||
              typeof lockedPointValueIdr !== "number" ||
              lockedPointValueIdr <= 0)
          )
            return {
              ok: false as const,
              issues: [
                "An explicit target point-value lock decision is required",
              ],
            };
          return loyaltyPolicyConfigCodec.fromTemplate(value.items, {
            lockedPointValueIdr:
              value.items.length === 0
                ? null
                : (lockedPointValueIdr as number | null),
            menuItemKeys: options.existingMenuItemKeys,
          });
        }
        case "facilities":
          return facilitiesConfigCodec.fromTemplate(value.items, {
            outletKeys: options.existingOutletKeys,
            taxRuleOutletKeyByKey,
          });
        case "payroll_settings":
          return payrollSettingsConfigCodec.fromTemplate(value.items, {
            legalEntityKeys: options.existingLegalEntityKeys,
          });
        case "wifi_policies":
          return wifiPoliciesConfigCodec.fromTemplate(
            value.items as Parameters<
              typeof wifiPoliciesConfigCodec.fromTemplate
            >[0],
            wifiRefs,
          );
      }
    })();
    if (result.ok) {
      Object.assign(drafts, { [section]: result.drafts });
      if ("mappings" in result) accountMappings = result.mappings;
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
 *
 * TEMPLATE VALIDATION ONLY (legend-srfud): this assumes every tax rule that a
 * facility references is tenant-wide and the point value is unlocked. It must
 * never be used as import validation. An importer calls `decodeConfigBundle`
 * with the target's real tax-rule owners (`existingTaxRuleOutletKeyByKey`) and
 * its real point-value lock (`lockedPointValueIdr`); both fail closed when
 * missing.
 */
export function configBundleReferenceIssues(
  bundle: ConfigBundle,
): ConfigItemIssue[] {
  const policies = bundle.sections.approval_policies;
  const checklists = bundle.sections.checklists;
  const existingRoleKeys = bundle.sections.roles
    ? undefined
    : new Set([
        ...((policies?.items ?? []) as { approverRoleKey?: string }[]).flatMap(
          (item) => (item.approverRoleKey ? [item.approverRoleKey] : []),
        ),
        ...((checklists?.items ?? []) as { roleKey?: string | null }[]).flatMap(
          (item) => (item.roleKey ? [item.roleKey] : []),
        ),
      ]);
  // A partial template can reference configuration already in the target.
  // Saving it checks structure; decodeConfigBundle checks the supplied target
  // keys during import. When a referenced section travels, its keys are
  // authoritative and dangling/cross-outlet references are rejected here.
  const existingZoneOutletKeyByKey = bundle.sections.zones
    ? undefined
    : new Map<string, string>();
  if (existingZoneOutletKeyByKey) {
    for (const item of (checklists?.items ?? []) as {
      outletKey: string;
      schedule: { zoneKey: string | null };
    }[])
      if (item.schedule.zoneKey)
        existingZoneOutletKeyByKey.set(item.schedule.zoneKey, item.outletKey);
    for (const item of (bundle.sections.service_charge_rules?.items ?? []) as {
      outletKey: string | null;
      zoneKey: string | null;
    }[])
      if (item.zoneKey && !existingZoneOutletKeyByKey.has(item.zoneKey))
        existingZoneOutletKeyByKey.set(
          item.zoneKey,
          item.outletKey ?? "external",
        );
  }
  const existingTaxRuleOutletKeyByKey = bundle.sections.tax_rules
    ? undefined
    : new Map<string, string | null>(
        (
          (bundle.sections.facilities?.items ?? []) as {
            taxRuleKey?: string | null;
          }[]
        ).flatMap((item): [string, null][] =>
          item.taxRuleKey ? [[item.taxRuleKey, null]] : [],
        ),
      );
  const existingMenuItemKeys = new Set(
    (
      (bundle.sections.loyalty_policy?.items ?? []) as {
        menuItemKey?: string | null;
        rule?: { menuItemKeys?: string[] };
      }[]
    ).flatMap((item) => [
      ...(item.menuItemKey ? [item.menuItemKey] : []),
      ...(item.rule?.menuItemKeys ?? []),
    ]),
  );
  const decoded = decodeConfigBundle(bundle, {
    // Structural template validation has no target ledger. Import decoding
    // requires the caller to supply its real target lock decision.
    lockedPointValueIdr: null,
    existingRoleKeys,
    existingZoneOutletKeyByKey,
    existingTaxRuleOutletKeyByKey,
    existingMenuItemKeys,
  });
  return decoded.ok
    ? []
    : decoded.issues.map((issue) => ({
        path: ["sections", issue.section],
        message: issue.message,
      }));
}
