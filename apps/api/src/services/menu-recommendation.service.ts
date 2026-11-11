// AI-01 menu recommendation (legend-ptd). A recommendation is a suggestion
// only: nothing here changes a price, a discount or an order total. Money rule:
// restrict, never overpay. A candidate is dropped unless its sell price is
// above zero and its cost (HPP per portion, computeLineCostSnapshots: the real
// recipe cost) is known and above zero, and its margin (on the net price when
// prices include tax) reaches the outlet floor. Co-occurrence is
// computed live from order_items, limited to one outlet and the lookback; a
// pair must appear in at least `min_pair_support` distinct orders (k-anonymity)
// and the response never carries any member data. Member history needs
// crm.customer.view and an active member; marginBps needs recipe.cost.view; the
// score is the rank only (n..1), never a raw count.
import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  assertOutletInScope,
  businessDateOf,
  createUlid,
  type OutletId,
  outletIdSchema,
  type ScopedTenantContext,
  userIdSchema,
} from "@starter/shared/core";
import {
  effectiveRuleVersions,
  resolveServiceChargeRule,
  resolveTaxRule,
  resolveTaxSettings,
  TaxError,
} from "@starter/shared/tax";
import type {
  MenuRecommendationItem,
  MenuRecommendationQuery,
  MenuRecommendationResponse,
  MenuRecommendationRules,
  MenuRecommendationRulesUpdate,
} from "@starter/shared/menu";
import { db } from "../db";
import { customerProfiles } from "../db/schema/crm-member";
import {
  menuItemDailyUsage,
  menuItems,
  priceListItems,
  priceLists,
} from "../db/schema/menu";
import {
  menuRecommendationItemRules,
  menuRecommendationRules,
} from "../db/schema/menu-recommendation";
import { outlets } from "../db/schema/platform-org";
import { orderItems, orders } from "../db/schema/qr-order";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { readAvailabilityDecisions } from "./menu-availability";
import { computeLineCostSnapshots } from "./order-cost-snapshot.service";
import { outletBusinessDayClock } from "./outlet-clock";
import { loadTaxConfig } from "./qr-order-pricing";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RulesRow = typeof menuRecommendationRules.$inferSelect;
type ItemRuleRow = typeof menuRecommendationItemRules.$inferSelect;
type OutletClockRow = { timezone: string; businessDayCutoff: string };

const DAY_MS = 86_400_000;
/** Orders that count as demand: sent to the kitchen or completed. */
const COUNTED_ORDER_STATUSES = ["sent", "completed"] as const;
/** Weight of one order of the member's own history next to one pair order. */
const MEMBER_ORDER_WEIGHT = 1;
/** Popular candidates read before the rule filters (they drop some). */
const POPULAR_CANDIDATE_LIMIT = 200;

/** Fields of the rule set that may appear unmasked in the audit log. */
const RULES_AUDIT_SAFE_FIELDS = [
  "outletId",
  "minMarginBps",
  "excludeOutOfStock",
  "maxSuggestions",
  "minPairSupport",
  "lookbackDays",
  "memberHistoryEnabled",
  "enabled",
  "itemRules",
  "menuItemId",
  "blocked",
  "hourFrom",
  "hourTo",
] as const;

const RULE_DEFAULTS = {
  minMarginBps: 2000,
  excludeOutOfStock: true,
  maxSuggestions: 5,
  minPairSupport: 3,
  lookbackDays: 90,
  memberHistoryEnabled: true,
  enabled: true,
} as const;

function rulesFields(row: RulesRow | undefined) {
  return {
    minMarginBps: row?.minMarginBps ?? RULE_DEFAULTS.minMarginBps,
    excludeOutOfStock:
      row?.excludeOutOfStock ?? RULE_DEFAULTS.excludeOutOfStock,
    maxSuggestions: row?.maxSuggestions ?? RULE_DEFAULTS.maxSuggestions,
    minPairSupport: row?.minPairSupport ?? RULE_DEFAULTS.minPairSupport,
    lookbackDays: row?.lookbackDays ?? RULE_DEFAULTS.lookbackDays,
    memberHistoryEnabled:
      row?.memberHistoryEnabled ?? RULE_DEFAULTS.memberHistoryEnabled,
    enabled: row?.enabled ?? RULE_DEFAULTS.enabled,
  };
}

async function loadOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<OutletClockRow> {
  const [row] = await tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletIdSchema.parse(outletId)),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  return row;
}

async function loadRules(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<{ rules: RulesRow | undefined; itemRules: ItemRuleRow[] }> {
  const tenantId = context.tenant.tenantId;
  const outlet = outletIdSchema.parse(outletId);
  const [rules] = await tx
    .select()
    .from(menuRecommendationRules)
    .where(
      and(
        eq(menuRecommendationRules.tenantId, tenantId),
        eq(menuRecommendationRules.outletId, outlet),
      ),
    )
    .limit(1);
  const itemRules = await tx
    .select()
    .from(menuRecommendationItemRules)
    .where(
      and(
        eq(menuRecommendationItemRules.tenantId, tenantId),
        eq(menuRecommendationItemRules.outletId, outlet),
      ),
    )
    .orderBy(asc(menuRecommendationItemRules.menuItemId));
  return { rules, itemRules };
}

function toRulesDto(
  outletId: string,
  rules: RulesRow | undefined,
  itemRules: readonly ItemRuleRow[],
): MenuRecommendationRules {
  return {
    outletId: outletIdSchema.parse(outletId),
    ...rulesFields(rules),
    itemRules: itemRules.map((row) => ({
      menuItemId: row.menuItemId,
      blocked: row.blocked,
      hourFrom: row.hourFrom,
      hourTo: row.hourTo,
    })),
  };
}

/** Rules of one outlet; the documented defaults when nothing is saved. */
export async function getRecommendationRules(
  context: ScopedTenantContext,
  outletId: string,
): Promise<MenuRecommendationRules> {
  assertOutletInScope(context.outletScope, outletId);
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    const { rules, itemRules } = await loadRules(tx, context, outletId);
    return toRulesDto(outletId, rules, itemRules);
  });
}

/**
 * Saves the given fields (others keep their value) and, when `itemRules` is
 * present, replaces the outlet's whole per-item rule set with it.
 */
export async function upsertRecommendationRules(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: string,
  input: MenuRecommendationRulesUpdate,
): Promise<MenuRecommendationRules> {
  assertOutletInScope(context.outletScope, outletId);
  const outlet = outletIdSchema.parse(outletId);
  const actor = userIdSchema.parse(actorUserId);
  const tenantId = context.tenant.tenantId;
  const { itemRules: nextItemRules, ...fields } = input;
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    const previous = await loadRules(tx, context, outletId);
    const before = toRulesDto(outletId, previous.rules, previous.itemRules);
    if (nextItemRules) {
      const wanted = nextItemRules.map((rule) => rule.menuItemId);
      if (new Set(wanted).size !== wanted.length)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "An item may appear only once in itemRules.",
        );
      if (wanted.length > 0) {
        const known = await tx
          .select({ id: menuItems.id })
          .from(menuItems)
          .where(
            and(
              eq(menuItems.tenantId, tenantId),
              inArray(menuItems.id, wanted),
            ),
          );
        if (known.length !== wanted.length)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "itemRules names a menu item that does not exist.",
          );
      }
    }
    const now = new Date();
    const changes: Partial<typeof menuRecommendationRules.$inferInsert> = {};
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const value = fields[key];
      if (value !== undefined) Object.assign(changes, { [key]: value });
    }
    await tx
      .insert(menuRecommendationRules)
      .values({
        id: createUlid(now.getTime()),
        tenantId,
        outletId: outlet,
        ...changes,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          menuRecommendationRules.tenantId,
          menuRecommendationRules.outletId,
        ],
        set: { ...changes, updatedAt: now },
      });
    if (nextItemRules) {
      await tx
        .delete(menuRecommendationItemRules)
        .where(
          and(
            eq(menuRecommendationItemRules.tenantId, tenantId),
            eq(menuRecommendationItemRules.outletId, outlet),
          ),
        );
      if (nextItemRules.length > 0)
        await tx.insert(menuRecommendationItemRules).values(
          nextItemRules.map((rule) => ({
            id: createUlid(now.getTime()),
            tenantId,
            outletId: outlet,
            menuItemId: rule.menuItemId,
            blocked: rule.blocked,
            hourFrom: rule.hourFrom,
            hourTo: rule.hourTo,
            createdAt: now,
            updatedAt: now,
          })),
        );
    }
    const saved = await loadRules(tx, context, outletId);
    const after = toRulesDto(outletId, saved.rules, saved.itemRules);
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: outlet,
        actorType: "user" as const,
        actorId: actor,
        deviceId: null,
        action: "menu_recommendation_rules.updated",
        objectType: "menu_recommendation_rules",
        objectId: outlet,
        reason: null,
        maskedChanges: { before, after },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y" as const,
        createdAt: now.toISOString(),
      },
      RULES_AUDIT_SAFE_FIELDS,
    );
    return after;
  });
}

/** Hour 0-23 of an instant on the outlet's wall clock. */
function localHour(instant: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(instant)
    .find((p) => p.type === "hour");
  return Number(part?.value ?? 0) % 24;
}

/**
 * [from, to) in local hours; may wrap past midnight; both null = all day.
 * from === to is an empty window (never shown): the stricter reading.
 */
function inHourWindow(
  hour: number,
  from: number | null,
  to: number | null,
): boolean {
  if (from === null || to === null) return true;
  if (from < to) return hour >= from && hour < to;
  if (from > to) return hour >= from || hour < to;
  return false;
}

/** Order count per menu item for orders holding an anchor item and the item. */
async function pairCounts(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: OutletId,
  anchors: readonly string[],
  since: Date,
  minSupport: number,
): Promise<Map<string, number>> {
  if (anchors.length === 0) return new Map();
  const tenantId = context.tenant.tenantId;
  const anchorLine = alias(orderItems, "anchor_line");
  const pairLine = alias(orderItems, "pair_line");
  const rows = await tx
    .select({
      menuItemId: pairLine.menuItemId,
      orderCount: countDistinct(pairLine.orderId),
    })
    .from(anchorLine)
    .innerJoin(
      pairLine,
      and(
        eq(pairLine.tenantId, anchorLine.tenantId),
        eq(pairLine.orderId, anchorLine.orderId),
      ),
    )
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, anchorLine.tenantId),
        eq(orders.id, anchorLine.orderId),
      ),
    )
    .where(
      and(
        eq(anchorLine.tenantId, tenantId),
        eq(anchorLine.outletId, outlet),
        eq(pairLine.outletId, outlet),
        eq(orders.outletId, outlet),
        inArray(anchorLine.menuItemId, [...anchors]),
        notInArray(pairLine.menuItemId, [...anchors]),
        ne(anchorLine.status, "voided"),
        ne(pairLine.status, "voided"),
        inArray(orders.status, [...COUNTED_ORDER_STATUSES]),
        gte(orders.placedAt, since),
      ),
    )
    .groupBy(pairLine.menuItemId)
    .having(sql`count(distinct ${pairLine.orderId}) >= ${minSupport}`);
  return new Map(rows.map((row) => [row.menuItemId, Number(row.orderCount)]));
}

/** Order count per menu item of one member's own orders at this outlet. */
async function memberCounts(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: OutletId,
  memberId: string,
  anchors: readonly string[],
  since: Date,
): Promise<Map<string, number>> {
  const tenantId = context.tenant.tenantId;
  // The member must belong to this tenant and be active; anyone else
  // (pending_verification, suspended, closed) is ignored.
  const [member] = await tx
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenantId),
        eq(customerProfiles.id, memberId),
        eq(customerProfiles.membershipStatus, "active"),
      ),
    )
    .limit(1);
  if (!member) return new Map();
  const rows = await tx
    .select({
      menuItemId: orderItems.menuItemId,
      orderCount: countDistinct(orderItems.orderId),
    })
    .from(orderItems)
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, orderItems.tenantId),
        eq(orders.id, orderItems.orderId),
      ),
    )
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.outletId, outlet),
        eq(orders.outletId, outlet),
        eq(orders.customerProfileId, member.id),
        ne(orderItems.status, "voided"),
        inArray(orders.status, [...COUNTED_ORDER_STATUSES]),
        gte(orders.placedAt, since),
        ...(anchors.length > 0
          ? [notInArray(orderItems.menuItemId, [...anchors])]
          : []),
      ),
    )
    .groupBy(orderItems.menuItemId);
  return new Map(rows.map((row) => [row.menuItemId, Number(row.orderCount)]));
}

/**
 * Units sold per menu item in the lookback, best seller first; an item sold
 * fewer than `minSupport` units is not listed (k-anonymity).
 */
async function popularCounts(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: OutletId,
  anchors: readonly string[],
  sinceDate: string,
  minSupport: number,
): Promise<Map<string, number>> {
  const total = sql<number>`sum(${menuItemDailyUsage.quantity})`;
  const rows = await tx
    .select({ menuItemId: menuItemDailyUsage.menuItemId, units: total })
    .from(menuItemDailyUsage)
    .where(
      and(
        eq(menuItemDailyUsage.tenantId, context.tenant.tenantId),
        eq(menuItemDailyUsage.outletId, outlet),
        gte(menuItemDailyUsage.businessDate, sinceDate),
        ...(anchors.length > 0
          ? [notInArray(menuItemDailyUsage.menuItemId, [...anchors])]
          : []),
      ),
    )
    .groupBy(menuItemDailyUsage.menuItemId)
    .having(sql`sum(${menuItemDailyUsage.quantity}) >= ${minSupport}`)
    .orderBy(desc(total), asc(menuItemDailyUsage.menuItemId))
    .limit(POPULAR_CANDIDATE_LIMIT);
  return new Map(rows.map((row) => [row.menuItemId, Number(row.units)]));
}

type Sellable = { name: string; priceIdr: number; marginBps: number };

/**
 * The candidates that pass every rule, with the facts the response shows.
 * Dropped: inactive, blocked, outside the item's hour window, not available
 * now (menu schedule, daily limit, 86; a sold-out item only stays when the
 * outlet does not exclude them), sell price not above zero, HPP unknown or not
 * above zero, margin below the floor. Doubt drops the item.
 */
async function sellableCandidates(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: OutletId,
  outletRow: OutletClockRow,
  candidateIds: readonly string[],
  rules: ReturnType<typeof rulesFields>,
  itemRules: readonly ItemRuleRow[],
  at: Date,
  now: Date,
): Promise<Map<string, Sellable>> {
  const result = new Map<string, Sellable>();
  if (candidateIds.length === 0) return result;
  const tenantId = context.tenant.tenantId;
  const ids = [...candidateIds];
  const items = await tx
    .select({
      id: menuItems.id,
      name: menuItems.name,
      categoryId: menuItems.categoryId,
    })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        inArray(menuItems.id, ids),
        eq(menuItems.isActive, true),
        isNull(menuItems.deletedAt),
      ),
    );
  if (items.length === 0) return result;
  const today = businessDateOf(now, outletBusinessDayClock(outletRow));
  const [list] = await tx
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(
      and(
        eq(priceLists.tenantId, tenantId),
        eq(priceLists.outletId, outlet),
        eq(priceLists.channel, "dine_in"),
        lte(priceLists.effectiveFrom, today),
        isNull(priceLists.deletedAt),
      ),
    )
    .orderBy(desc(priceLists.effectiveFrom), desc(priceLists.id))
    .limit(1);
  if (!list) return result;
  const prices = new Map(
    (
      await tx
        .select({
          itemId: priceListItems.itemId,
          priceIdr: priceListItems.priceIdr,
        })
        .from(priceListItems)
        .where(
          and(
            eq(priceListItems.tenantId, tenantId),
            eq(priceListItems.priceListId, list.id),
            inArray(priceListItems.itemId, ids),
            isNull(priceListItems.variantId),
            isNull(priceListItems.deletedAt),
          ),
        )
    ).map((row) => [row.itemId, Number(row.priceIdr)] as const),
  );
  // HPP of one portion: the real recipe cost, unknown (null) when any part is.
  const costList = await computeLineCostSnapshots(
    tx,
    context,
    outlet,
    items.map((item) => ({
      menuItemId: item.id,
      variantId: null,
      modifierIds: [],
      quantity: 1,
    })),
  );
  const costs = new Map(items.map((item, i) => [item.id, costList[i] ?? null]));
  const availability = await readAvailabilityDecisions(tx, {
    tenantId,
    outletId: outlet,
    itemIds: items.map((item) => item.id),
    at,
    timeZone: outletRow.timezone,
    businessDate: today,
  });
  const taxConfig = await loadTaxConfig(tx, context, outlet);
  const taxRulesInForce = effectiveRuleVersions(
    taxConfig.taxRules,
    outlet,
    today,
  );
  let settingsInclude = false;
  try {
    settingsInclude = resolveTaxSettings(
      taxConfig.settings,
      outlet,
      today,
    ).pricesIncludeTax;
  } catch (error) {
    if (!(error instanceof TaxError)) throw error;
  }
  const serviceRulesInForce = effectiveRuleVersions(
    taxConfig.serviceChargeRules,
    outlet,
    today,
  );
  const anyRuleInclusive = taxRulesInForce.some((r) => r.priceIncludesTax);
  const itemRuleById = new Map(itemRules.map((row) => [row.menuItemId, row]));
  const hour = localHour(at, outletRow.timezone);
  for (const item of items) {
    const rule = itemRuleById.get(item.id);
    if (rule?.blocked) continue;
    if (rule && !inHourWindow(hour, rule.hourFrom, rule.hourTo)) continue;
    // No availability row = no schedule, limit or 86 (legacy items).
    const decision = availability.get(item.id);
    if (
      decision &&
      !decision.sellable &&
      !(
        !rules.excludeOutOfStock &&
        decision.soldOut &&
        decision.withinSchedule &&
        (decision.remaining === null || decision.remaining > 0)
      )
    )
      continue;
    const price = prices.get(item.id);
    if (price === undefined || !(price > 0)) continue;
    const cost = costs.get(item.id);
    if (cost === null || cost === undefined) continue;
    if (!Number.isFinite(cost) || !(cost > 0)) continue;
    // Prices that include tax: the margin is on the net price, rounded down.
    let taxRule: ReturnType<typeof resolveTaxRule> | null = null;
    try {
      taxRule = resolveTaxRule(
        taxRulesInForce,
        {
          outletId: outlet,
          channel: "dine_in",
          zoneId: null,
          regionCode: null,
        },
        {
          itemId: item.id,
          categoryId: item.categoryId,
          itemClass: "food_beverage",
        },
      );
    } catch (error) {
      if (!(error instanceof TaxError)) throw error;
    }
    let base = price;
    // Rule not resolved (ambiguous, none) while any rule in force is
    // tax-inclusive: the margin cannot be trusted, so drop.
    if (!taxRule && anyRuleInclusive) continue;
    if (settingsInclude || taxRule?.priceIncludesTax) {
      // Prices include tax but the rate is unknown: drop (never guess).
      if (!taxRule) continue;
      // The service charge is not outlet revenue: back it out too. An
      // unresolvable service rule (ambiguous) drops the item; none = 0.
      let serviceBp = 0;
      try {
        serviceBp =
          resolveServiceChargeRule(
            serviceRulesInForce,
            {
              outletId: outlet,
              channel: "dine_in",
              zoneId: null,
              regionCode: null,
            },
            "food_beverage",
          )?.rateBp ?? 0;
      } catch (error) {
        if (!(error instanceof TaxError)) throw error;
        continue;
      }
      // Service inside the tax base: the engine's stricter denominator.
      base = taxRule.includeServiceInBase
        ? Number(
            (BigInt(price) * 100_000_000n) /
              (BigInt(10_000 + serviceBp) * BigInt(10_000 + taxRule.rateBp)),
          )
        : Math.floor((price * 10_000) / (10_000 + serviceBp + taxRule.rateBp));
    }
    if (!(base > 0)) continue;
    // Floor: the margin is never rounded up to reach the floor.
    const marginBps = Math.floor(((base - cost) * 10_000) / base);
    if (marginBps < rules.minMarginBps) continue;
    result.set(item.id, {
      name: item.name,
      priceIdr: price,
      marginBps: Math.min(marginBps, 10_000),
    });
  }
  return result;
}

const NONE: MenuRecommendationResponse = { items: [], source: "none" };

/** What the caller may see beyond the plain suggestion (decided by the route). */
export type RecommendationViewer = {
  /** crm.customer.view: the member's own history may shape the list. */
  canViewMemberHistory: boolean;
  /** recipe.cost.view: the margin is shown (else marginBps is null). */
  canViewMargin: boolean;
};

/**
 * Suggestions for an outlet: pair co-occurrence with the anchors plus the
 * member's own history, else the popular items. Every result passes the
 * outlet's rules (see sellableCandidates). At most `max_suggestions`. `score`
 * is the rank only: n for the top suggestion down to 1.
 */
export async function getMenuRecommendations(
  context: ScopedTenantContext,
  input: MenuRecommendationQuery,
  viewer: RecommendationViewer,
): Promise<MenuRecommendationResponse> {
  assertOutletInScope(context.outletScope, input.outletId);
  const outlet = outletIdSchema.parse(input.outletId);
  const anchors = [...new Set(input.anchorItemIds)];
  const now = new Date();
  const at = input.at ? new Date(input.at) : now;
  return withTenant(db, context, async (tx) => {
    const outletRow = await loadOutlet(tx, context, outlet);
    const loaded = await loadRules(tx, context, outlet);
    const rules = rulesFields(loaded.rules);
    if (!rules.enabled) return NONE;
    const since = new Date(now.getTime() - rules.lookbackDays * DAY_MS);

    const pairs = await pairCounts(
      tx,
      context,
      outlet,
      anchors,
      since,
      rules.minPairSupport,
    );
    // Without crm.customer.view the memberId is ignored, silently.
    const member =
      input.memberId &&
      rules.memberHistoryEnabled &&
      viewer.canViewMemberHistory
        ? await memberCounts(
            tx,
            context,
            outlet,
            input.memberId,
            anchors,
            since,
          )
        : new Map<string, number>();

    const rank = async (
      scores: ReadonlyMap<string, number>,
    ): Promise<[string, Sellable][]> => {
      const sellable = await sellableCandidates(
        tx,
        context,
        outlet,
        outletRow,
        [...scores.keys()],
        rules,
        loaded.itemRules,
        at,
        now,
      );
      return [...scores]
        .flatMap(([id, score]) => {
          const facts = sellable.get(id);
          return facts
            ? [[id, score, facts] as [string, number, Sellable]]
            : [];
        })
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, rules.maxSuggestions)
        .map(([id, , facts]) => [id, facts] as [string, Sellable]);
    };

    const toItem = (
      [menuItemId, facts]: [string, Sellable],
      index: number,
      list: readonly unknown[],
      reason: MenuRecommendationItem["reason"],
    ): MenuRecommendationItem => ({
      menuItemId,
      name: facts.name,
      priceIdr: facts.priceIdr as MenuRecommendationItem["priceIdr"],
      marginBps: viewer.canViewMargin ? facts.marginBps : null,
      reason,
      score: list.length - index,
    });

    const combined = new Map<string, number>();
    for (const [id, count] of pairs) combined.set(id, count);
    for (const [id, count] of member)
      combined.set(id, (combined.get(id) ?? 0) + count * MEMBER_ORDER_WEIGHT);
    const ranked = await rank(combined);
    if (ranked.length > 0) {
      const items = ranked.map((entry, index, list) =>
        toItem(
          entry,
          index,
          list,
          pairs.has(entry[0]) ? "pair" : "member_history",
        ),
      );
      return {
        items,
        source: items.some((item) => item.reason === "pair")
          ? "cooccurrence"
          : "member_history",
      };
    }

    const sinceDate = businessDateOf(since, outletBusinessDayClock(outletRow));
    const popular = await rank(
      await popularCounts(
        tx,
        context,
        outlet,
        anchors,
        sinceDate,
        rules.minPairSupport,
      ),
    );
    if (popular.length === 0) return NONE;
    return {
      items: popular.map((entry, index, list) =>
        toItem(entry, index, list, "popular"),
      ),
      source: "popular_fallback",
    };
  });
}
