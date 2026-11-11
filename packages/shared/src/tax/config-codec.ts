// TEN-09 (legend-j568k): portable tax configuration. Published tenant-wide
// rules export as the latest version of each code; importing produces drafts,
// so publication still goes through the domain's ordinary validation.
// Legacy API bundles include settings in this section and omit effectiveFrom.
// Dates absent from those bundles stay absent for the importer to resolve.
import { businessDateSchema, z } from "../core/index.ts";
import {
  itemTaxClassSchema,
  regionCodeSchema,
  ruleCodeSchema,
  settingsFields,
  taxRuleFields,
} from "./schemas.ts";
import type { TaxRule } from "./schemas.ts";

const itemKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/);
const scopeFields = {
  key: itemKeySchema,
  outletKey: itemKeySchema.nullable(),
  effectiveFrom: businessDateSchema.optional(),
};
const ruleItemSchema = z.strictObject({
  ...scopeFields,
  ...taxRuleFields,
  kind: z.literal("rule"),
  code: ruleCodeSchema,
  regionCode: regionCodeSchema.nullable(),
  appliesTo: z.strictObject({
    itemClasses: z
      .array(itemTaxClassSchema)
      .min(1)
      .max(itemTaxClassSchema.options.length),
  }),
});
const settingsItemSchema = z.strictObject({
  ...scopeFields,
  ...settingsFields,
  kind: z.literal("settings"),
});

export const taxRulesConfigItemSchema = z.discriminatedUnion("kind", [
  ruleItemSchema,
  settingsItemSchema,
]);
export type TaxRuleConfigItem = z.infer<typeof ruleItemSchema>;
export type TaxSettingsConfigItem = z.infer<typeof settingsItemSchema>;
export type TaxRulesConfigItem = z.infer<typeof taxRulesConfigItemSchema>;

/** Source identifiers and publication authority never travel in drafts. */
export type TaxRuleConfigDraft = Omit<TaxRuleConfigItem, "appliesTo"> & {
  appliesTo: TaxRule["appliesTo"];
  status: "draft";
  version: 1;
};
export type TaxSettingsConfigDraft = TaxSettingsConfigItem & {
  status: "draft";
  version: 1;
};
export type TaxRulesConfigDraft = TaxRuleConfigDraft | TaxSettingsConfigDraft;
export type TaxRulesFromTemplate =
  { ok: true; drafts: TaxRulesConfigDraft[] } | { ok: false; issues: string[] };

function compareKeys(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function toTemplate(rows: readonly TaxRule[]): TaxRuleConfigItem[] {
  if (new Set(rows.map((row) => row.tenantId)).size > 1)
    throw new Error("tax_rules toTemplate requires one tenant");

  const latestByCode = new Map<string, TaxRule>();
  const seenVersions = new Set<string>();
  for (const row of rows) {
    if (row.outletId !== null || row.status !== "published") continue;
    const versionKey = `${row.code}:${row.version}`;
    if (seenVersions.has(versionKey))
      throw new Error(`Tax rule ${row.code}: duplicate published version`);
    seenVersions.add(versionKey);
    const previous = latestByCode.get(row.code);
    if (!previous || row.version > previous.version)
      latestByCode.set(row.code, row);
  }

  return [...latestByCode.values()]
    .map((row) => {
      // Dropping item/category targets could change precedence and charge a
      // different tax. Require class-only rules instead of silently widening.
      if (
        row.appliesTo.categoryIds.length > 0 ||
        row.appliesTo.itemIds.length > 0
      )
        throw new Error(`Tax rule ${row.code}: menu targets are not portable`);
      return ruleItemSchema.parse({
        key: `tenant.${row.code.toLowerCase()}`,
        kind: "rule",
        outletKey: null,
        code: row.code,
        name: row.name,
        taxType: row.taxType,
        rateBp: row.rateBp,
        regionCode: row.regionCode,
        channels: row.channels,
        appliesTo: { itemClasses: row.appliesTo.itemClasses },
        priceIncludesTax: row.priceIncludesTax,
        includeServiceInBase: row.includeServiceInBase,
        isActive: row.isActive,
        effectiveFrom: row.effectiveFrom,
      });
    })
    .sort(compareKeys);
}

function fromTemplate(items: readonly unknown[]): TaxRulesFromTemplate {
  const issues: string[] = [];
  const drafts: TaxRulesConfigDraft[] = [];
  const keys = new Set<string>();
  const identities = new Set<string>();
  for (const raw of items) {
    const parsed = taxRulesConfigItemSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        issues.push(`Tax config ${issue.path.join(".")}: ${issue.message}`);
      continue;
    }
    const item = parsed.data;
    const identity = JSON.stringify([
      item.kind,
      item.outletKey,
      item.kind === "rule" ? item.code : null,
    ]);
    if (keys.has(item.key) || identities.has(identity)) {
      issues.push(`Tax config ${item.key}: duplicate key or rule identity`);
      continue;
    }
    keys.add(item.key);
    identities.add(identity);
    if (item.kind === "rule")
      drafts.push({
        ...item,
        appliesTo: {
          itemClasses: item.appliesTo.itemClasses,
          categoryIds: [],
          itemIds: [],
        },
        status: "draft",
        version: 1,
      });
    else drafts.push({ ...item, status: "draft", version: 1 });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, drafts };
}

export const taxRulesConfigCodec = {
  section: "tax_rules",
  version: 1,
  itemSchema: taxRulesConfigItemSchema,
  toTemplate,
  fromTemplate,
} as const;
