// Config bundle section codecs for tax_rules, service_charge_rules, zones,
// checklists, facilities and wifi_policies (TEN-09, bead legend-tct8). Same
// interface as the access and accounting codecs: `toTemplate` turns rows into
// tenant-free, key-addressed items, `fromTemplate` turns items into id-less
// drafts or a list of issues. Pure and browser-safe: no DB, no service.
//
// These codecs sit in `platform` (not in their domain folders) because their
// strict item schemas live in `config-items.ts`, and domain folders must not
// import `platform`.
//
// Rows are already key-addressed: the exporter resolves ids to keys (outlet
// id -> `outletKey` = outlet code, zone id -> `zoneKey`, ...) before it calls
// `toTemplate`, because only the exporter can read the tenant. `toTemplate`
// then validates each row with the strict item schema, so a row that still
// carries an id, tenant or other source field THROWS (programmer error)
// instead of leaking into a template. Output is sorted by key.
//
// `fromTemplate` never throws on bad user data: it returns issue strings that
// name the item. Checks that need only this section run always (duplicate
// keys, facility children naming a facility of the section, one tax settings
// item per outlet). References into OTHER sections (`zoneKey`, `roleKey`,
// `taxRuleKey`, `facilityKey` of a Wi-Fi policy) are checked only when the
// caller passes the key set in `ctx`; `decodeConfigBundle` passes it for the
// sections the bundle carries.
//
// Not covered here: loyalty_policy and payroll_settings (money, item schema
// still the loose JSON item) stay unregistered until their domain lands.

import type { ConfigDecodeResult } from "../access/config-codec.ts";
import { z } from "../core/index.ts";
import {
  checklistItemSchema,
  facilityItemSchema,
  serviceChargeItemSchema,
  taxItemSchema,
  wifiPolicyItemSchema,
  zoneItemSchema,
} from "./config-items.ts";

export type TaxRuleConfigItem = z.infer<typeof taxItemSchema>;
export type ServiceChargeRuleConfigItem = z.infer<
  typeof serviceChargeItemSchema
>;
export type ZoneConfigItem = z.infer<typeof zoneItemSchema>;
export type ChecklistConfigItem = z.infer<typeof checklistItemSchema>;
export type FacilityConfigItem = z.infer<typeof facilityItemSchema>;
export type WifiPolicyConfigItem = z.infer<typeof wifiPolicyItemSchema>;

/** Keys of other bundle sections; a reference is checked only when its set is given. */
export type ConfigSectionRefs = {
  zoneKeys?: ReadonlySet<string>;
  roleKeys?: ReadonlySet<string>;
  taxRuleKeys?: ReadonlySet<string>;
  facilityKeys?: ReadonlySet<string>;
};

type Issue = (item: { key: string }, message: string) => void;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sectionCodec<S extends string, I extends { key: string }>(
  section: S,
  itemSchema: z.ZodType<I>,
  check: (
    items: readonly I[],
    refs: ConfigSectionRefs,
    issue: Issue,
  ) => void = () => {},
) {
  return {
    section,
    version: 1 as const,
    itemSchema,

    toTemplate(rows: readonly I[]): I[] {
      const seen = new Set<string>();
      const items = rows.map((row) => {
        const parsed = itemSchema.safeParse(row);
        if (!parsed.success)
          throw new Error(
            `${section} toTemplate: item ${String((row as { key?: unknown } | null)?.key)}: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "item"} ${i.message}`)
              .join("; ")}`,
          );
        if (seen.has(parsed.data.key))
          throw new Error(
            `${section} toTemplate: duplicate key ${parsed.data.key}`,
          );
        seen.add(parsed.data.key);
        return parsed.data;
      });
      return items.sort((a, b) => compareText(a.key, b.key));
    },

    fromTemplate(
      items: readonly I[],
      ctx?: ConfigSectionRefs,
    ): ConfigDecodeResult<I> {
      const issues: string[] = [];
      const issue: Issue = (item, message) =>
        issues.push(`${section} item ${item.key}: ${message}`);
      const drafts: I[] = [];
      const keys = new Set<string>();
      for (const raw of items) {
        const parsed = itemSchema.safeParse(raw);
        if (!parsed.success) {
          issues.push(
            `${section} item ${String((raw as { key?: unknown } | null)?.key)}: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "item"} ${i.message}`)
              .join("; ")}`,
          );
          continue;
        }
        if (keys.has(parsed.data.key)) issue(parsed.data, "duplicate key");
        keys.add(parsed.data.key);
        drafts.push(parsed.data);
      }
      if (issues.length === 0) check(drafts, ctx ?? {}, issue);
      return issues.length > 0 ? { ok: false, issues } : { ok: true, drafts };
    },
  };
}

/** Reports `value` when the caller gave the key set and it lacks the key. */
function refersTo(
  keys: ReadonlySet<string> | undefined,
  value: string | null,
  what: string,
  item: { key: string },
  issue: Issue,
) {
  if (keys && value !== null && !keys.has(value))
    issue(item, `${what} ${value} is not in the bundle`);
}

export const taxRulesConfigCodec = sectionCodec(
  "tax_rules",
  taxItemSchema,
  (items, _refs, issue) => {
    // One settings item per outlet scope (null = tenant default).
    const settings = new Map<string, string>();
    for (const item of items) {
      if (item.kind !== "settings") continue;
      const scope = item.outletKey ?? "";
      const first = settings.get(scope);
      if (first !== undefined)
        issue(
          item,
          `duplicate of ${first} (same tax settings outlet ${item.outletKey ?? "default"})`,
        );
      else settings.set(scope, item.key);
    }
  },
);

export const serviceChargeRulesConfigCodec = sectionCodec(
  "service_charge_rules",
  serviceChargeItemSchema,
  (items, refs, issue) => {
    for (const item of items)
      refersTo(refs.zoneKeys, item.zoneKey, "zoneKey", item, issue);
  },
);

export const zonesConfigCodec = sectionCodec("zones", zoneItemSchema);

export const checklistsConfigCodec = sectionCodec(
  "checklists",
  checklistItemSchema,
  (items, refs, issue) => {
    for (const item of items) {
      refersTo(refs.zoneKeys, item.schedule.zoneKey, "zoneKey", item, issue);
      refersTo(refs.roleKeys, item.roleKey, "roleKey", item, issue);
    }
  },
);

export const facilitiesConfigCodec = sectionCodec(
  "facilities",
  facilityItemSchema,
  (items, refs, issue) => {
    const facilities = new Set<string>();
    const areaFacility = new Map<string, string>();
    for (const item of items) {
      if (item.kind === "facility") facilities.add(item.key);
      else if (item.kind === "area")
        areaFacility.set(item.key, item.facilityKey);
    }
    for (const item of items) {
      if (item.kind === "facility") continue;
      if (!facilities.has(item.facilityKey))
        issue(item, `facilityKey ${item.facilityKey} is not a facility item`);
      if (item.kind === "unit") {
        const areaOf = areaFacility.get(item.areaKey);
        if (areaOf === undefined)
          issue(item, `areaKey ${item.areaKey} is not an area item`);
        else if (areaOf !== item.facilityKey)
          issue(
            item,
            `areaKey ${item.areaKey} belongs to facility ${areaOf}, not ${item.facilityKey}`,
          );
      }
      if (item.kind === "product")
        refersTo(refs.taxRuleKeys, item.taxRuleKey, "taxRuleKey", item, issue);
    }
  },
);

export const wifiPoliciesConfigCodec = sectionCodec(
  "wifi_policies",
  wifiPolicyItemSchema,
  (items, refs, issue) => {
    for (const item of items) {
      refersTo(refs.zoneKeys, item.zoneKey, "zoneKey", item, issue);
      refersTo(refs.facilityKeys, item.facilityKey, "facilityKey", item, issue);
    }
  },
);
