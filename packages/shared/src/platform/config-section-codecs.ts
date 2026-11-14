// Config bundle section codec for wifi_policies (TEN-09, bead legend-tct8).
// Same interface as the access and accounting codecs: `toTemplate` turns rows
// into tenant-free, key-addressed items, `fromTemplate` turns items into
// id-less drafts or a list of issues. Pure and browser-safe: no DB, no
// service. The other sections (tax_rules, service_charge_rules, zones,
// checklists, facilities, loyalty_policy) have their codecs in their domain
// folders; wifi_policies sits in `platform` because it has no domain folder
// of its own (`facility` must not import `platform`).
//
// Rows are already key-addressed: the exporter resolves ids to keys (outlet
// id -> `outletKey` = outlet code, zone id -> `zoneKey`, ...) before it calls
// `toTemplate`, because only the exporter can read the tenant. `toTemplate`
// then validates each row with the strict item schema, so a row that still
// carries an id, tenant or other source field THROWS (programmer error)
// instead of leaking into a template. Output is sorted by key.
//
// `fromTemplate` never throws on bad user data: it returns issue strings that
// name the item. Duplicate keys are checked always. References into OTHER
// sections (`zoneKey`, `facilityKey`) are checked only when the caller passes
// the key set in `ctx`; `decodeConfigBundle` passes it for the sections the
// bundle carries.
//
// Payroll settings have their own domain codec in hris/payroll/config-codec.ts.

import type { ConfigDecodeResult } from "../access/config-codec.ts";
import { z } from "../core/index.ts";
import { wifiPolicyItemSchema } from "./config-items.ts";

export type WifiPolicyConfigItem = z.infer<typeof wifiPolicyItemSchema>;

/** Keys of other bundle sections; a reference is checked only when its set is given. */
export type ConfigSectionRefs = {
  zoneKeys?: ReadonlySet<string>;
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
