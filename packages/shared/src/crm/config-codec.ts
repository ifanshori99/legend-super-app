// TEN-09 / legend-1tzvg: portable loyalty configuration only. Importers must
// supply the target's locked point value and recheck its database lock while
// writing; the codec never transfers ledger, profile, or redemption state.
import { z } from "zod";
import {
  loyaltyProgramSchema,
  loyaltyTierSchema,
  missionObjectSchema,
  missionRuleSchema,
  missionSchema,
  rewardObjectSchema,
  rewardSchema,
  type LoyaltyProgram,
  type LoyaltyTier,
  type Mission,
  type Reward,
} from "./loyalty.ts";

const itemKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/);
const placeholderId = "00000000-0000-4000-8000-000000000001";
// legalEntityId is deliberately omitted (TEN-09: no tenant/PT id in config
// copies; Q80: points are per PT). The schema is strict, so an imported item
// carrying legalEntityId is rejected, and a program decoded from config never
// picks a PT: the entity guard decides it (single-PT tenant) or blocks earn and
// redeem as ambiguous (multi-PT tenant).
const programItemSchema = loyaltyProgramSchema
  .omit({ id: true, tenantId: true, legalEntityId: true, updatedAt: true })
  .extend({ key: itemKeySchema, kind: z.literal("program") });
const tierItemSchema = loyaltyTierSchema
  .omit({ id: true, tenantId: true })
  .extend({ key: itemKeySchema, kind: z.literal("tier") });
const rewardItemSchema = rewardObjectSchema
  .omit({ id: true, tenantId: true, menuItemId: true })
  .extend({
    key: itemKeySchema,
    kind: z.literal("reward"),
    menuItemKey: itemKeySchema.nullable(),
  })
  .superRefine((item, ctx) => {
    const { key, kind, menuItemKey, ...fields } = item;
    void key;
    void kind;
    const parsed = rewardSchema.safeParse({
      ...fields,
      id: placeholderId,
      tenantId: placeholderId,
      menuItemId: menuItemKey === null ? null : placeholderId,
    });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({
          code: "custom",
          path: issue.path.map((part) =>
            part === "menuItemId" ? "menuItemKey" : part,
          ),
          message: issue.message,
        });
  });

const portableMissionRuleSchema = z.discriminatedUnion("kind", [
  missionRuleSchema.options[0],
  missionRuleSchema.options[1]
    .omit({ menuItemIds: true })
    .extend({ menuItemKeys: z.array(itemKeySchema) }),
  missionRuleSchema.options[2],
  missionRuleSchema.options[3],
]);
const missionItemSchema = missionObjectSchema
  .omit({ id: true, tenantId: true, rule: true })
  .extend({
    key: itemKeySchema,
    kind: z.literal("mission"),
    rule: portableMissionRuleSchema,
  })
  .superRefine((item, ctx) => {
    const { key, kind, rule, ...fields } = item;
    void key;
    void kind;
    const parsed = missionSchema.safeParse({
      ...fields,
      id: placeholderId,
      tenantId: placeholderId,
      rule:
        rule.kind === "try_new_item"
          ? {
              kind: rule.kind,
              targetItems: rule.targetItems,
              menuItemIds: rule.menuItemKeys.map(() => placeholderId),
            }
          : rule,
    });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
  });

export const loyaltyPolicyConfigItemSchema = z.discriminatedUnion("kind", [
  programItemSchema,
  tierItemSchema,
  rewardItemSchema,
  missionItemSchema,
]);
export type LoyaltyPolicyConfigItem = z.infer<
  typeof loyaltyPolicyConfigItemSchema
>;
export type LoyaltyPolicyConfigDraft = LoyaltyPolicyConfigItem;
export type LoyaltyPolicyConfigRows = {
  programs?: readonly LoyaltyProgram[];
  tiers?: readonly LoyaltyTier[];
  rewards?: readonly Reward[];
  missions?: readonly Mission[];
};
export type LoyaltyPolicyConfigImportContext = {
  /** Frozen target value once the first ledger row exists; null explicitly
   * confirms the target is unlocked. Never take this decision from a bundle. */
  lockedPointValueIdr: number | null;
  /** Menu keys present in this import or already in the target tenant. */
  menuItemKeys?: ReadonlySet<string>;
};
export type LoyaltyPolicyConfigFromTemplate =
  | { ok: true; drafts: LoyaltyPolicyConfigDraft[] }
  | { ok: false; issues: string[] };

function fromTemplate(
  items: readonly unknown[],
  context: LoyaltyPolicyConfigImportContext,
): LoyaltyPolicyConfigFromTemplate {
  const lockedPointValueIdr = context?.lockedPointValueIdr;
  if (
    lockedPointValueIdr !== null &&
    (!Number.isSafeInteger(lockedPointValueIdr) ||
      typeof lockedPointValueIdr !== "number" ||
      lockedPointValueIdr <= 0)
  )
    return {
      ok: false,
      issues: [
        "Loyalty lockedPointValueIdr must be a positive safe integer or explicit null",
      ],
    };
  const issues: string[] = [];
  const drafts: LoyaltyPolicyConfigDraft[] = [];
  const keys = new Set<string>();
  const ranks = new Set<number>();
  let hasProgram = false;
  for (const raw of items) {
    const parsed = loyaltyPolicyConfigItemSchema.safeParse(raw);
    const label = String((raw as { key?: unknown } | null)?.key);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        issues.push(
          `Loyalty ${label}: ${issue.path.join(".") || "item"} ${issue.message}`,
        );
      continue;
    }
    const item = parsed.data;
    if (keys.has(item.key)) issues.push(`Loyalty ${item.key}: duplicate key`);
    keys.add(item.key);
    if (item.kind === "program") {
      if (hasProgram)
        issues.push(`Loyalty ${item.key}: only one program per tenant`);
      hasProgram = true;
      if (
        lockedPointValueIdr !== null &&
        item.pointValueIdr !== lockedPointValueIdr
      )
        issues.push(
          `Loyalty ${item.key}: pointValueIdr is locked in the target tenant`,
        );
    }
    if (item.kind === "tier") {
      if (ranks.has(item.rank))
        issues.push(`Loyalty ${item.key}: duplicate tier rank ${item.rank}`);
      ranks.add(item.rank);
    }
    const menuKeys =
      item.kind === "reward"
        ? item.menuItemKey === null
          ? []
          : [item.menuItemKey]
        : item.kind === "mission" && item.rule.kind === "try_new_item"
          ? item.rule.menuItemKeys
          : [];
    for (const menuKey of menuKeys)
      if (!context.menuItemKeys?.has(menuKey))
        issues.push(
          `Loyalty ${item.key}: menuItemKey ${menuKey} is not in the target menu`,
        );
    drafts.push(item);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, drafts };
}

function toTemplate(
  rows: LoyaltyPolicyConfigRows,
  context: { menuItemKeyById?: ReadonlyMap<string, string> } = {},
): LoyaltyPolicyConfigItem[] {
  const tenantIds = new Set(
    [
      ...(rows.programs ?? []),
      ...(rows.tiers ?? []),
      ...(rows.rewards ?? []),
      ...(rows.missions ?? []),
    ].map((row) => row.tenantId),
  );
  if (tenantIds.size > 1)
    throw new Error("loyalty_policy needs rows from one tenant");
  const keys = new Set<string>();
  const keyFor = (kind: string, name: string): string => {
    const slug =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 75) || "item";
    const base = `${kind}.${slug}`;
    let key = base;
    let suffix = 2;
    while (keys.has(key)) key = `${base}-${suffix++}`;
    keys.add(key);
    return key;
  };
  const menuKey = (id: string): string => {
    const key = context.menuItemKeyById?.get(id);
    if (key === undefined)
      throw new Error("Loyalty menu item is not in the export menu key map");
    return itemKeySchema.parse(key);
  };
  const items: LoyaltyPolicyConfigItem[] = [];
  for (const row of rows.programs ?? [])
    items.push(
      programItemSchema.parse({
        key: keyFor("program", row.name),
        kind: "program",
        name: row.name,
        earnRate: row.earnRate,
        expiryMonths: row.expiryMonths,
        rollingMonths: row.rollingMonths,
        pointValueIdr: row.pointValueIdr,
        referral: row.referral,
        antiFraud: row.antiFraud,
        isActive: row.isActive,
      }),
    );
  for (const row of rows.tiers ?? [])
    items.push(
      tierItemSchema.parse({
        key: keyFor("tier", row.name),
        kind: "tier",
        name: row.name,
        rank: row.rank,
        thresholdSpendIdr: row.thresholdSpendIdr,
        thresholdVisits: row.thresholdVisits,
        benefits: row.benefits,
        isActive: row.isActive,
      }),
    );
  for (const row of rows.rewards ?? [])
    items.push(
      rewardItemSchema.parse({
        key: keyFor("reward", row.name),
        kind: "reward",
        name: row.name,
        description: row.description,
        type: row.type,
        pointsCost: row.pointsCost,
        stock: row.stock,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        menuItemKey: row.menuItemId === null ? null : menuKey(row.menuItemId),
        voucherValueIdr: row.voucherValueIdr,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        perCustomerLimit: row.perCustomerLimit,
        redemptionValidDays: row.redemptionValidDays,
      }),
    );
  for (const row of rows.missions ?? [])
    items.push(
      missionItemSchema.parse({
        key: keyFor("mission", row.name),
        kind: "mission",
        name: row.name,
        description: row.description,
        type: row.type,
        rule:
          row.rule.kind === "try_new_item"
            ? {
                kind: row.rule.kind,
                targetItems: row.rule.targetItems,
                menuItemKeys: row.rule.menuItemIds.map(menuKey),
              }
            : row.rule,
        reward: row.reward,
        period: row.period,
        isActive: row.isActive,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      }),
    );
  const decoded = fromTemplate(items, {
    lockedPointValueIdr: null,
    menuItemKeys: new Set(context.menuItemKeyById?.values() ?? []),
  });
  if (!decoded.ok) throw new Error(decoded.issues.join("\n"));
  return decoded.drafts;
}

export const loyaltyPolicyConfigCodec = {
  section: "loyalty_policy" as const,
  version: 1 as const,
  itemSchema: loyaltyPolicyConfigItemSchema,
  toTemplate,
  fromTemplate,
};
