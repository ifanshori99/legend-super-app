// TEN-09: tenant-free service-charge configuration. The caller selects the
// published version to export; version/publication metadata and row ids never
// leave the tenant. Missing references fail closed rather than becoming null
// (which would broaden a zone-specific service charge).
import { z } from "zod";
import { businessDateSchema } from "../core/index.ts";
import {
  ruleCodeSchema,
  serviceChargeRuleFields,
  type ServiceChargeRule,
} from "./schemas.ts";

const itemKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/);

const serviceChargeRuleConfigItemSchema = z.strictObject({
  key: itemKeySchema,
  outletKey: itemKeySchema.nullable(),
  code: ruleCodeSchema,
  name: serviceChargeRuleFields.name,
  rateBp: serviceChargeRuleFields.rateBp,
  zoneKey: itemKeySchema.nullable(),
  orderTypes: serviceChargeRuleFields.orderTypes,
  itemClasses: serviceChargeRuleFields.itemClasses,
  isActive: serviceChargeRuleFields.isActive,
  // Server exports predating this codec omitted the effective date. Do not
  // invent one: the importer chooses the target's safe effective date.
  effectiveFrom: businessDateSchema.optional(),
});

export type ServiceChargeRuleConfigItem = z.infer<
  typeof serviceChargeRuleConfigItemSchema
>;
export type ServiceChargeRuleConfigDraft = ServiceChargeRuleConfigItem;

type ServiceChargeExportRow = Pick<
  ServiceChargeRule,
  | "outletId"
  | "code"
  | "name"
  | "rateBp"
  | "zoneId"
  | "orderTypes"
  | "itemClasses"
  | "isActive"
  | "effectiveFrom"
>;

export type ServiceChargeConfigExportContext = {
  outletKeyById: ReadonlyMap<string, string>;
  zoneKeyById: ReadonlyMap<string, string>;
  zoneOutletKeyByKey?: ReadonlyMap<string, string>;
};

export type ServiceChargeConfigImportContext = {
  outletKeys?: ReadonlySet<string>;
  zoneKeys?: ReadonlySet<string>;
  zoneOutletKeyByKey?: ReadonlyMap<string, string>;
};

type DecodeResult =
  | { ok: true; drafts: ServiceChargeRuleConfigDraft[] }
  | { ok: false; issues: string[] };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Keep the server's taxRuleConfigKey convention (tenant/code or outlet/code),
// including normalization when a supplied outlet key contains punctuation.
function configKey(...parts: string[]): string {
  const slug = parts
    .map((part) =>
      part
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join(".");
  return (/^[a-z0-9]/.test(slug) ? slug : `k${slug}`).slice(0, 100) || "k";
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  for (let suffix = 2; used.has(key); suffix++) {
    const ending = `-${suffix}`;
    key = `${base.slice(0, 100 - ending.length)}${ending}`;
  }
  used.add(key);
  return key;
}

function referenceIssues(
  item: ServiceChargeRuleConfigItem,
  ctx: ServiceChargeConfigImportContext,
): string[] {
  const issues: string[] = [];
  const label = `service_charge_rules item ${item.key}`;
  if (
    item.outletKey !== null &&
    ctx.outletKeys !== undefined &&
    !ctx.outletKeys.has(item.outletKey)
  )
    issues.push(`${label}: outletKey ${item.outletKey} is not a known outlet`);
  if (item.zoneKey !== null) {
    if (ctx.zoneKeys !== undefined && !ctx.zoneKeys.has(item.zoneKey))
      issues.push(`${label}: zoneKey ${item.zoneKey} is not a known zone`);
    if (ctx.zoneOutletKeyByKey !== undefined) {
      const zoneOutletKey = ctx.zoneOutletKeyByKey.get(item.zoneKey);
      if (zoneOutletKey === undefined)
        issues.push(`${label}: zoneKey ${item.zoneKey} has no known outlet`);
      else if (item.outletKey !== null && zoneOutletKey !== item.outletKey)
        issues.push(
          `${label}: zoneKey ${item.zoneKey} belongs to another outlet`,
        );
    }
  }
  return issues;
}

export const serviceChargeRulesConfigCodec = {
  section: "service_charge_rules" as const,
  version: 1 as const,
  itemSchema: serviceChargeRuleConfigItemSchema,

  toTemplate(
    rows: readonly ServiceChargeExportRow[],
    ctx: ServiceChargeConfigExportContext,
  ): ServiceChargeRuleConfigItem[] {
    const resolved = rows.map((row) => {
      const outletKey =
        row.outletId === null ? null : ctx.outletKeyById.get(row.outletId);
      if (outletKey === undefined)
        throw new Error(`service_charge_rules ${row.code}: missing outlet key`);
      const zoneKey =
        row.zoneId === null ? null : ctx.zoneKeyById.get(row.zoneId);
      if (zoneKey === undefined)
        throw new Error(`service_charge_rules ${row.code}: missing zone key`);
      return { row, outletKey, zoneKey };
    });
    resolved.sort(
      (a, b) =>
        compareText(a.outletKey ?? "tenant", b.outletKey ?? "tenant") ||
        compareText(a.row.code, b.row.code),
    );
    const used = new Set<string>();
    const items = resolved.map(({ row, outletKey, zoneKey }) =>
      serviceChargeRuleConfigItemSchema.parse({
        key: uniqueKey(configKey(outletKey ?? "tenant", row.code), used),
        outletKey,
        code: row.code,
        name: row.name,
        rateBp: row.rateBp,
        zoneKey,
        orderTypes: [...row.orderTypes],
        itemClasses: [...row.itemClasses],
        isActive: row.isActive,
        effectiveFrom: row.effectiveFrom,
      }),
    );
    const result = this.fromTemplate(items, {
      zoneKeys: new Set(ctx.zoneKeyById.values()),
      outletKeys: new Set(ctx.outletKeyById.values()),
      zoneOutletKeyByKey: ctx.zoneOutletKeyByKey,
    });
    if (!result.ok) throw new Error(result.issues.join("; "));
    return items;
  },

  fromTemplate(
    items: readonly unknown[],
    ctx: ServiceChargeConfigImportContext = {},
  ): DecodeResult {
    const issues: string[] = [];
    const drafts: ServiceChargeRuleConfigDraft[] = [];
    const keys = new Set<string>();
    const naturalKeys = new Set<string>();
    for (const raw of items) {
      const parsed = serviceChargeRuleConfigItemSchema.safeParse(raw);
      if (!parsed.success) {
        const key = (raw as { key?: unknown } | null)?.key;
        issues.push(
          `service_charge_rules item ${String(key)}: ${parsed.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "item"} ${issue.message}`,
            )
            .join("; ")}`,
        );
        continue;
      }
      const item = parsed.data;
      if (keys.has(item.key))
        issues.push(`service_charge_rules item ${item.key}: duplicate key`);
      keys.add(item.key);
      // The existing importer addresses one rule by outlet and code. Multiple
      // versions must be selected before export, never silently overwritten.
      const naturalKey = JSON.stringify([item.outletKey, item.code]);
      if (naturalKeys.has(naturalKey))
        issues.push(
          `service_charge_rules item ${item.key}: duplicate outlet and code`,
        );
      naturalKeys.add(naturalKey);
      issues.push(...referenceIssues(item, ctx));
      drafts.push(item);
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, drafts };
  },
};
