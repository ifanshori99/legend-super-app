// Tax rule overlap detection (bead legend-de3b). Two rules in force tie when
// `resolveTaxRule` cannot choose between them for some order: same level
// (item/category/class) and the same specificity rank. A tie makes the cashier
// fail closed with TAX_RULE_AMBIGUOUS, so publish refuses it. Pure, no I/O.

import type { BusinessDate, OutletId } from "../core/index.ts";
import { TaxError } from "./errors.ts";
import { effectiveRuleVersions, resolveTaxRule } from "./calculate.ts";
import { ITEM_TAX_CLASSES, taxChannelSchema } from "./schemas.ts";
import type { TaxChannel, TaxRule } from "./schemas.ts";

export type TaxRuleTieLevel = "item" | "category" | "itemClass";

export type TaxRuleTie = {
  /** The rule being checked (or the lower id when scanning everything). */
  a: TaxRule;
  b: TaxRule;
  /** null = tenant-wide view. */
  outletId: OutletId | null;
  channel: TaxChannel;
  regionCode: string | null;
  level: TaxRuleTieLevel;
  /** The itemId / categoryId / itemClass that ties. */
  key: string;
  /** First date both rules are in force and tie. */
  effectiveDate: BusinessDate;
};

/** Outlet used to ask `effectiveRuleVersions` for the tenant-wide view: no
 * real outlet, so outlet-scoped rules drop out. */
const TENANT_VIEW_OUTLET = "00000000-0000-4000-8000-000000000000" as OutletId;
/** Item id that matches neither rule, to probe category and class levels.
 * Rules store itemIds without catalog validation, so no fixed id is safe:
 * count up from a base until the id is in neither list (legend-7gwap). */
function probeItemId(taken: ReadonlySet<string>): string {
  for (let n = 0xffff; ; n += 1) {
    const id = `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
    if (!taken.has(id)) return id;
  }
}
const ALL_CHANNELS: readonly TaxChannel[] = taxChannelSchema.options;

/** Indonesian labels for server messages, matching the `tax.channels` and
 * `tax.itemClass` catalog strings. */
const CHANNEL_LABEL_ID: Record<TaxChannel, string> = {
  dine_in: "Dine-in",
  takeaway: "Bawa pulang",
  gofood: "GoFood",
  grabfood: "GrabFood",
  shopeefood: "ShopeeFood",
  reservation: "Reservasi",
};
const ITEM_CLASS_LABEL_ID: Record<(typeof ITEM_TAX_CLASSES)[number], string> = {
  food_beverage: "Makanan & minuman",
  facility: "Layanan fasilitas",
};

/** Indonesian name of an order channel, for messages shown to the owner. */
export function taxChannelLabelId(channel: TaxChannel): string {
  return CHANNEL_LABEL_ID[channel];
}

/** Indonesian name of an item tax class, for messages shown to the owner. */
export function itemTaxClassLabelId(
  itemClass: (typeof ITEM_TAX_CLASSES)[number],
): string {
  return ITEM_CLASS_LABEL_ID[itemClass];
}

/** Indonesian description of what a tie is about; never an id. */
export function taxRuleTieScopeLabelId(
  level: TaxRuleTieLevel,
  key: string,
): string {
  if (level === "item") return "item tertentu";
  if (level === "category") return "kategori tertentu";
  return ITEM_CLASS_LABEL_ID[key as (typeof ITEM_TAX_CLASSES)[number]] ?? key;
}

type Probe = Omit<TaxRuleTie, "a" | "b" | "outletId" | "effectiveDate">;

/** Contexts where `primary` applies, checked against `other`. */
function probeTie(
  primary: TaxRule,
  other: TaxRule,
  outletId: OutletId | null,
): Probe | null {
  const channels =
    primary.channels.length > 0 ? primary.channels : ALL_CHANNELS;
  const regions: (string | null)[] =
    primary.regionCode !== null
      ? [primary.regionCode]
      : other.regionCode !== null
        ? [null, other.regionCode]
        : [null];
  const noItem = probeItemId(
    new Set([...primary.appliesTo.itemIds, ...other.appliesTo.itemIds]),
  );
  const lines: {
    level: TaxRuleTieLevel;
    key: string;
    line: Parameters<typeof resolveTaxRule>[2];
  }[] = [
    ...primary.appliesTo.itemIds.map((key) => ({
      level: "item" as const,
      key,
      line: { itemId: key, categoryId: null, itemClass: ITEM_TAX_CLASSES[0] },
    })),
    ...primary.appliesTo.categoryIds.map((key) => ({
      level: "category" as const,
      key,
      line: {
        itemId: noItem,
        categoryId: key,
        itemClass: ITEM_TAX_CLASSES[0],
      },
    })),
    ...primary.appliesTo.itemClasses.map((key) => ({
      level: "itemClass" as const,
      key,
      line: { itemId: noItem, categoryId: null, itemClass: key },
    })),
  ];
  for (const channel of channels) {
    for (const regionCode of regions) {
      for (const { level, key, line } of lines) {
        try {
          resolveTaxRule(
            [primary, other],
            {
              outletId: outletId ?? TENANT_VIEW_OUTLET,
              channel,
              zoneId: null,
              regionCode,
            },
            line,
          );
        } catch (error) {
          if (error instanceof TaxError && error.code === "TAX_RULE_AMBIGUOUS")
            return { channel, regionCode, level, key };
          throw error;
        }
      }
    }
  }
  return null;
}

/**
 * One tie between exactly these two rules, using `resolveTaxRule([a, b], ...)`
 * and catching TAX_RULE_AMBIGUOUS. Inactive rules, rules out of the outlet
 * view and two versions of one code never tie. `effectiveDate` is left to the
 * caller (it depends on versions in force).
 */
export function taxRuleTie(
  a: TaxRule,
  b: TaxRule,
  outletId: OutletId | null,
): Omit<TaxRuleTie, "effectiveDate"> | null {
  if (!a.isActive || !b.isActive || a.code === b.code) return null;
  for (const rule of [a, b])
    if (rule.outletId !== null && rule.outletId !== outletId) return null;
  const found = probeTie(a, b, outletId) ?? probeTie(b, a, outletId);
  return found ? { a, b, outletId, ...found } : null;
}

/**
 * All pairwise ties among published rules in force, per outlet view, on `from`
 * and on each later effectiveFrom. `onlyRuleId` limits to pairs containing that
 * rule (reported as `a`). One entry per unordered pair: the first date found,
 * tenant-wide view before outlet views.
 */
export function findTaxRuleTies(
  rules: readonly TaxRule[],
  opts: {
    outletIds: readonly (OutletId | null)[];
    from: BusinessDate;
    onlyRuleId?: string;
  },
): TaxRuleTie[] {
  const dates = [
    opts.from,
    ...new Set(
      rules
        .filter((r) => r.status === "published" && r.effectiveFrom > opts.from)
        .map((r) => r.effectiveFrom),
    ),
  ].sort();
  const views = [...new Set(opts.outletIds)].sort(
    (x, y) => Number(y === null) - Number(x === null),
  );
  const seen = new Set<string>();
  const ties: TaxRuleTie[] = [];
  for (const outletId of views) {
    for (const date of dates) {
      const inForce = effectiveRuleVersions(
        rules,
        outletId ?? TENANT_VIEW_OUTLET,
        date,
      ).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      for (let i = 0; i < inForce.length; i += 1) {
        for (let j = i + 1; j < inForce.length; j += 1) {
          let [a, b] = [inForce[i], inForce[j]];
          if (opts.onlyRuleId !== undefined) {
            if (b.id === opts.onlyRuleId) [a, b] = [b, a];
            else if (a.id !== opts.onlyRuleId) continue;
          }
          const pair = `${inForce[i].id}|${inForce[j].id}`;
          if (seen.has(pair)) continue;
          const tie = taxRuleTie(a, b, outletId);
          if (!tie) continue;
          seen.add(pair);
          ties.push({ ...tie, effectiveDate: date });
        }
      }
    }
  }
  return ties;
}
