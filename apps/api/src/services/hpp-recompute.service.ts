// HPP recompute (bead legend-2qq; PRD v1.7 §17 "HPP Menu": theoretical cost
// per item, variant and modifier, refreshed within 5 minutes of an ingredient
// price change). Two halves:
//   1. `enqueueHppRecompute`: called in the SAME transaction that writes
//      `stock_balances.avg_cost_idr`, only when the average actually changed.
//   2. `runHppRecompute`: the worker job claims queued (outlet, item) rows
//      (DELETE ... RETURNING over FOR UPDATE SKIP LOCKED, in a short
//      transaction so no queue lock is held during the recompute), finds the
//      recipes that use those items, then only the menu items / variants /
//      modifiers on those recipes, and rewrites just their `menu_costs` rows in
//      a second transaction. A failed recompute re-enqueues the claimed items;
//      a change that lands while the job runs re-inserts its row. Outlets with
//      no `menu_costs` row at all get a full first fill on the next tick.
//
// Rule "jangan sampai rugi": a cost is never understated. A recipe with an
// inactive or broken tree, no sale location, or any ingredient without a
// balance or with a zero average cost is incomplete: cost and margin NULL,
// never 0. Costs are summed at full Decimal4 x Decimal4 scale and rounded half
// up ONCE per portion (`scaledCostToIdr`), the same helpers as the order line
// snapshot (order-cost-snapshot.service.ts).

import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  businessDateOf,
  divideRounded,
  formatDecimal4,
  parseDecimal4,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { InventoryError } from "@starter/shared/inventory";
import { outletIdSchema } from "../db/columns.ts";
import { db } from "../db/index.ts";
import { hppRecomputeQueue } from "../db/schema/hpp.ts";
import { stockBalances } from "../db/schema/inventory.ts";
import {
  itemVariants,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  priceListItems,
  priceLists,
} from "../db/schema/menu.ts";
import { outlets } from "../db/schema/platform-org.ts";
import {
  modifierRecipeRules,
  outletInventorySettings,
  recipeLines,
  recipes,
} from "../db/schema/recipe.ts";
import { withTenant } from "../db/tenant.ts";
import {
  ROUNDING_MODE,
  SCALE,
  scaledCostToIdr,
  type Tx,
} from "./inventory-ops.shared.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import {
  explodeMenuLinesEach,
  explodeRecipeTree,
  loadRecipeBook,
  MAX_RECIPE_DEPTH,
  toBaseQuantities,
} from "./recipe-bom.service.ts";

/** Rows claimed per transaction by the worker job. */
export const HPP_RECOMPUTE_BATCH_SIZE = 200;
/** Upper bound of batches per call, so one job tick cannot run forever. */
const MAX_BATCHES_PER_RUN = 500;
const UPSERT_CHUNK = 200;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ------------------------------------------------------------------ enqueue

/**
 * Queues the items whose average cost changed at one outlet. Same transaction
 * as the stock balance write. Re-queueing an item only refreshes its
 * `enqueued_at`.
 */
export async function enqueueHppRecompute(
  tx: Tx,
  input: {
    tenantId: TenantId;
    outletId: string;
    itemIds: readonly string[];
  },
): Promise<void> {
  // Sorted: two transactions queueing overlapping items lock rows in the same
  // order, so they cannot deadlock.
  const itemIds = [...new Set(input.itemIds)].sort();
  if (itemIds.length === 0) return;
  const outletId = outletIdSchema.parse(input.outletId);
  for (let start = 0; start < itemIds.length; start += UPSERT_CHUNK) {
    await tx
      .insert(hppRecomputeQueue)
      .values(
        itemIds.slice(start, start + UPSERT_CHUNK).map((itemId) => ({
          tenantId: input.tenantId,
          outletId,
          itemId,
        })),
      )
      .onConflictDoUpdate({
        target: [
          hppRecomputeQueue.tenantId,
          hppRecomputeQueue.outletId,
          hppRecomputeQueue.itemId,
        ],
        set: { enqueuedAt: sql`now()` },
      });
  }
}

// -------------------------------------------------------------------- drain

export type HppRecomputeResult = {
  /** Queue rows claimed and removed. */
  items: number;
  /** `menu_costs` rows written. */
  rows: number;
};

/**
 * Drains the queue of the context's tenant: claims up to `batchSize` rows per
 * short transaction (DELETE ... RETURNING over SKIP LOCKED, so two workers
 * never take the same row and no queue lock outlives the claim), recomputes
 * them in a second transaction, and repeats until the queue is empty, so a
 * large queue finishes in one call. A failed recompute rolls back and
 * re-enqueues its claimed rows for the next tick. Afterwards every outlet
 * without a single `menu_costs` row is rebuilt in full (first fill).
 */
export async function runHppRecompute(
  context: ScopedTenantContext,
  options: { batchSize?: number; now?: Date } = {},
): Promise<HppRecomputeResult> {
  assertTrustedScopedContext(context);
  const batchSize = options.batchSize ?? HPP_RECOMPUTE_BATCH_SIZE;
  const now = options.now ?? new Date();
  const total: HppRecomputeResult = { items: 0, rows: 0 };
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    const done = await processBatch(context, batchSize, now);
    total.items += done.items;
    total.rows += done.rows;
    if (done.items < batchSize) break;
  }
  total.rows += await fillEmptyOutlets(context, now);
  return total;
}

type ClaimedRow = { outletId: string; itemId: string };

async function processBatch(
  context: ScopedTenantContext,
  batchSize: number,
  now: Date,
): Promise<HppRecomputeResult> {
  const tenantId = context.tenant.tenantId;
  const claimed = await withTenant(db, context, (tx) =>
    claimBatch(tx, tenantId, batchSize),
  );
  if (claimed.length === 0) return { items: 0, rows: 0 };

  const byOutlet = new Map<string, string[]>();
  for (const row of claimed) {
    const list = byOutlet.get(row.outletId) ?? [];
    list.push(row.itemId);
    byOutlet.set(row.outletId, list);
  }
  try {
    const rows = await withTenant(db, context, async (tx) => {
      let written = 0;
      for (const [outletId, itemIds] of byOutlet) {
        const recipeIds = await affectedRecipeIds(tx, tenantId, itemIds);
        if (recipeIds.size > 0)
          written += await recomputeMenuCosts(
            tx,
            context,
            outletId,
            recipeIds,
            now,
          );
      }
      return written;
    });
    return { items: claimed.length, rows };
  } catch (error) {
    // The recompute rolled back and the claim already committed: put the rows
    // back so the next tick retries them.
    await withTenant(db, context, async (tx) => {
      for (const outletId of [...byOutlet.keys()].sort())
        await enqueueHppRecompute(tx, {
          tenantId,
          outletId,
          itemIds: byOutlet.get(outletId)!,
        });
    }).catch(() => undefined);
    throw error;
  }
}

async function claimBatch(
  tx: Tx,
  tenantId: TenantId,
  batchSize: number,
): Promise<ClaimedRow[]> {
  const result = await tx.execute(sql`
    DELETE FROM hpp_recompute_queue AS queue
    USING (
      SELECT tenant_id, outlet_id, item_id
      FROM hpp_recompute_queue
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY enqueued_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    ) AS claim
    WHERE queue.tenant_id = claim.tenant_id
      AND queue.outlet_id = claim.outlet_id
      AND queue.item_id = claim.item_id
    RETURNING queue.outlet_id::text AS outlet_id, queue.item_id::text AS item_id
  `);
  return (result.rows as { outlet_id: string; item_id: string }[]).map(
    (row) => ({ outletId: row.outlet_id, itemId: row.item_id }),
  );
}

/**
 * Full rebuild of every outlet of the tenant that has no `menu_costs` row yet
 * but whose brand has menu items (nothing else would ever fill it: the queue
 * only carries changes). Each outlet in its own transaction.
 */
async function fillEmptyOutlets(
  context: ScopedTenantContext,
  now: Date,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const empty = await withTenant(db, context, async (tx) => {
    const result = await tx.execute(sql`
      SELECT o.id::text AS id
      FROM outlets o
      WHERE o.tenant_id = ${tenantId}::uuid
        AND EXISTS (
          SELECT 1 FROM menu_items m
          WHERE m.tenant_id = o.tenant_id AND m.brand_id = o.brand_id
            AND m.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM menu_costs c
          WHERE c.tenant_id = o.tenant_id AND c.outlet_id = o.id
        )
      ORDER BY o.id
    `);
    return (result.rows as { id: string }[]).map((row) => row.id);
  });
  let rows = 0;
  for (const outletId of empty)
    rows += await rebuildMenuCostsForOutlet(context, outletId, now);
  return rows;
}

/**
 * Recipes whose cost can move when the average cost of `itemIds` moves:
 * recipes with the item as a direct line, recipes that draw a semi-finished
 * recipe whose output item it is, then every ancestor through `recipe` lines
 * (bounded by MAX_RECIPE_DEPTH). Over-approximating is safe, it only costs a
 * recompute.
 */
async function affectedRecipeIds(
  tx: Tx,
  tenantId: TenantId,
  itemIds: readonly string[],
): Promise<Set<string>> {
  const parentsOf = async (recipeIds: readonly string[]): Promise<string[]> => {
    if (recipeIds.length === 0) return [];
    const rows = await tx
      .selectDistinct({ recipeId: recipeLines.recipeId })
      .from(recipeLines)
      .where(
        and(
          eq(recipeLines.tenantId, tenantId),
          eq(recipeLines.componentType, "recipe"),
          inArray(recipeLines.componentId, [...recipeIds]),
        ),
      );
    return rows.map((row) => row.recipeId);
  };

  const direct = await tx
    .selectDistinct({ recipeId: recipeLines.recipeId })
    .from(recipeLines)
    .where(
      and(
        eq(recipeLines.tenantId, tenantId),
        eq(recipeLines.componentType, "item"),
        inArray(recipeLines.componentId, [...itemIds]),
      ),
    );
  // A nested recipe with an output item is drawn as that stock item, so its
  // parents depend on the item's average cost, not on the nested lines.
  const producers = await tx
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.tenantId, tenantId),
        inArray(recipes.outputItemId, [...itemIds]),
      ),
    );

  const affected = new Set(direct.map((row) => row.recipeId));
  // A modifier whose rules draw the item (or a recipe) is costed through its
  // own recipe; refresh it too (it turns incomplete while the rules exist).
  const modifierRecipesOf = async (
    componentIds: readonly string[],
  ): Promise<string[]> => {
    if (componentIds.length === 0) return [];
    const rows = await tx
      .selectDistinct({ recipeId: modifiers.recipeId })
      .from(modifierRecipeRules)
      .innerJoin(
        modifiers,
        and(
          eq(modifiers.tenantId, modifierRecipeRules.tenantId),
          eq(modifiers.id, modifierRecipeRules.modifierId),
        ),
      )
      .where(
        and(
          eq(modifierRecipeRules.tenantId, tenantId),
          inArray(modifierRecipeRules.componentId, [...componentIds]),
        ),
      );
    return rows.flatMap((row) => (row.recipeId === null ? [] : [row.recipeId]));
  };
  const viaRules = await modifierRecipesOf(itemIds);
  let frontier = [...affected];
  for (const id of await parentsOf(producers.map((row) => row.id))) {
    if (affected.has(id)) continue;
    affected.add(id);
    frontier.push(id);
  }
  for (
    let depth = 0;
    frontier.length > 0 && depth < MAX_RECIPE_DEPTH;
    depth++
  ) {
    frontier = (await parentsOf(frontier)).filter((id) => !affected.has(id));
    for (const id of frontier) affected.add(id);
  }
  for (const id of await modifierRecipesOf([...affected])) affected.add(id);
  for (const id of viaRules) affected.add(id);
  return affected;
}

// ------------------------------------------------------------------ rebuild

/**
 * Full recompute of one outlet's `menu_costs` (first fill, and when a recipe
 * or a menu link changes). Rows of targets that no longer exist are removed.
 * Runs in its own transaction.
 */
export async function rebuildMenuCostsForOutlet(
  context: ScopedTenantContext,
  outletId: string,
  now: Date = new Date(),
): Promise<number> {
  return withTenant(db, context, (tx) =>
    rebuildMenuCostsForOutletInTransaction(tx, context, outletId, now),
  );
}

export async function rebuildMenuCostsForOutletInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date = new Date(),
): Promise<number> {
  return recomputeMenuCosts(tx, context, outletId, null, now);
}

// ------------------------------------------------------------------ compute

type Target = {
  menuItemId: string;
  variantId: string | null;
  modifierId: string | null;
  recipeId: string | null;
  /** Modifier price; item and variant prices come from the price list. */
  modifierPriceIdr: number | null;
};

type CostOutcome = { ok: true; items: Map<string, string> } | { ok: false };

/**
 * Recomputes `menu_costs` of one outlet. `recipeIds` = only targets whose
 * effective recipe is in the set; `null` = every target (and stale rows go).
 */
async function recomputeMenuCosts(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  recipeIds: ReadonlySet<string> | null,
  now: Date,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const [outlet] = await tx
    .select({
      id: outlets.id,
      brandId: outlets.brandId,
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) return 0;

  const [settings] = await tx
    .select({ saleLocationId: outletInventorySettings.saleLocationId })
    .from(outletInventorySettings)
    .where(
      and(
        eq(outletInventorySettings.tenantId, tenantId),
        eq(outletInventorySettings.outletId, outlet.id),
      ),
    );
  const saleLocationId = settings?.saleLocationId ?? null;

  const targets = await loadTargets(tx, tenantId, outlet.brandId, recipeIds);
  if (targets.length === 0) {
    if (recipeIds === null) await deleteStaleRows(tx, tenantId, outlet.id, now);
    return 0;
  }

  const prices = await loadPrices(tx, tenantId, outlet, now);
  const costs = await computeCosts(tx, context, targets);
  const avgCost = await loadAvgCosts(
    tx,
    tenantId,
    outlet.id,
    saleLocationId,
    [...costs.values()].flatMap((outcome) =>
      outcome.ok ? [...outcome.items.keys()] : [],
    ),
  );

  const rows = new Map<string, MenuCostRow>();
  for (const target of targets) {
    const key = targetKey(target);
    const price =
      target.modifierId !== null
        ? (target.modifierPriceIdr ?? 0)
        : (prices.get(`${target.menuItemId}:${target.variantId ?? ""}`) ?? 0);
    const outcome = costs.get(costKey(target));
    let costIdr: number | null = null;
    if (target.recipeId !== null && outcome?.ok && outcome.items.size > 0) {
      let scaled = 0n;
      let known = true;
      for (const [itemId, quantity] of outcome.items) {
        const unit = avgCost.get(itemId);
        if (unit === undefined || unit <= 0n) {
          known = false;
          break;
        }
        scaled += parseDecimal4(quantity) * unit;
      }
      if (known) costIdr = scaledCostToIdr(scaled);
    }
    rows.set(key, {
      menuItemId: target.menuItemId,
      variantId: target.variantId,
      modifierId: target.modifierId,
      recipeId: target.recipeId,
      complete: costIdr !== null,
      costIdr,
      priceIdr: price,
      marginBp:
        costIdr === null
          ? null
          : price > 0
            ? Number(
                divideRounded(
                  BigInt(price - costIdr) * 10_000n,
                  BigInt(price),
                  ROUNDING_MODE,
                ),
              )
            : 0,
    });
  }
  await upsertRows(tx, tenantId, outlet.id, [...rows.values()], now);
  if (recipeIds === null) await deleteStaleRows(tx, tenantId, outlet.id, now);
  return rows.size;
}

function targetKey(target: Target): string {
  return `${target.menuItemId}:${target.variantId ?? NIL_UUID}:${target.modifierId ?? NIL_UUID}`;
}

/** Cost cache key: modifiers cost the same on every item they are attached to. */
function costKey(target: Target): string {
  return target.modifierId !== null
    ? `m:${target.modifierId}`
    : `i:${target.menuItemId}:${target.variantId ?? ""}`;
}

async function loadTargets(
  tx: Tx,
  tenantId: TenantId,
  brandId: string,
  recipeIds: ReadonlySet<string> | null,
): Promise<Target[]> {
  const items = await tx
    .select({ id: menuItems.id, recipeId: menuItems.recipeId })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        eq(menuItems.brandId, brandId),
        isNull(menuItems.deletedAt),
      ),
    );
  if (items.length === 0) return [];
  const itemIds = items.map((item) => item.id);
  const itemRecipe = new Map(items.map((item) => [item.id, item.recipeId]));
  const variants = await tx
    .select({
      id: itemVariants.id,
      menuItemId: itemVariants.menuItemId,
      recipeId: itemVariants.recipeId,
    })
    .from(itemVariants)
    .where(
      and(
        eq(itemVariants.tenantId, tenantId),
        inArray(itemVariants.menuItemId, itemIds),
        isNull(itemVariants.deletedAt),
      ),
    );
  const modifierRows = await tx
    .select({
      id: modifiers.id,
      recipeId: modifiers.recipeId,
      priceIdr: modifiers.priceIdr,
      menuItemId: menuItemModifierGroups.menuItemId,
    })
    .from(menuItemModifierGroups)
    .innerJoin(
      modifierGroups,
      and(
        eq(modifierGroups.tenantId, menuItemModifierGroups.tenantId),
        eq(modifierGroups.id, menuItemModifierGroups.groupId),
        isNull(modifierGroups.deletedAt),
      ),
    )
    .innerJoin(
      modifiers,
      and(
        eq(modifiers.tenantId, modifierGroups.tenantId),
        eq(modifiers.groupId, modifierGroups.id),
        isNull(modifiers.deletedAt),
      ),
    )
    .where(
      and(
        eq(menuItemModifierGroups.tenantId, tenantId),
        inArray(menuItemModifierGroups.menuItemId, itemIds),
        isNull(menuItemModifierGroups.deletedAt),
      ),
    );

  const all: Target[] = [
    ...items.map((item) => ({
      menuItemId: item.id,
      variantId: null,
      modifierId: null,
      recipeId: item.recipeId,
      modifierPriceIdr: null,
    })),
    ...variants.map((variant) => ({
      menuItemId: variant.menuItemId,
      variantId: variant.id,
      modifierId: null,
      // Same resolution as the stock deduction: variant recipe, else the item's.
      recipeId: variant.recipeId ?? itemRecipe.get(variant.menuItemId) ?? null,
      modifierPriceIdr: null,
    })),
    ...modifierRows.map((modifier) => ({
      menuItemId: modifier.menuItemId,
      variantId: null,
      modifierId: modifier.id,
      recipeId: modifier.recipeId,
      modifierPriceIdr: Number(modifier.priceIdr),
    })),
  ];
  if (recipeIds === null) return all;
  return all.filter(
    (target) => target.recipeId !== null && recipeIds.has(target.recipeId),
  );
}

/** Outlet default price list (dine-in, in force on the outlet business date). */
async function loadPrices(
  tx: Tx,
  tenantId: TenantId,
  outlet: { id: string; timezone: string; businessDayCutoff: string },
  now: Date,
): Promise<Map<string, number>> {
  const today = businessDateOf(now, outletBusinessDayClock(outlet));
  const [list] = await tx
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(
      and(
        eq(priceLists.tenantId, tenantId),
        eq(priceLists.outletId, outlet.id),
        eq(priceLists.channel, "dine_in"),
        lte(priceLists.effectiveFrom, today),
        isNull(priceLists.deletedAt),
      ),
    )
    .orderBy(desc(priceLists.effectiveFrom), desc(priceLists.id))
    .limit(1);
  const prices = new Map<string, number>();
  if (!list) return prices;
  const rows = await tx
    .select({
      itemId: priceListItems.itemId,
      variantId: priceListItems.variantId,
      priceIdr: priceListItems.priceIdr,
    })
    .from(priceListItems)
    .where(
      and(
        eq(priceListItems.tenantId, tenantId),
        eq(priceListItems.priceListId, list.id),
        isNull(priceListItems.deletedAt),
      ),
    );
  for (const row of rows)
    prices.set(`${row.itemId}:${row.variantId ?? ""}`, Number(row.priceIdr));
  return prices;
}

/** Gross base-unit quantity per stock item for one portion of every target. */
async function computeCosts(
  tx: Tx,
  context: ScopedTenantContext,
  targets: readonly Target[],
): Promise<Map<string, CostOutcome>> {
  const result = new Map<string, CostOutcome>();

  const lines = new Map<
    string,
    { menuItemId: string; variantId: string | null }
  >();
  const modifierRecipes = new Map<string, string>();
  for (const target of targets) {
    if (target.recipeId === null) continue;
    if (target.modifierId !== null)
      modifierRecipes.set(target.modifierId, target.recipeId);
    else
      lines.set(costKey(target), {
        menuItemId: target.menuItemId,
        variantId: target.variantId,
      });
  }

  const lineKeys = [...lines.keys()];
  if (lineKeys.length > 0) {
    const outcomes = await explodeMenuLinesEach(
      tx,
      context,
      lineKeys.map((key) => ({
        ...lines.get(key)!,
        modifierIds: [],
        quantity: 1,
      })),
    );
    outcomes.forEach((outcome, index) =>
      result.set(
        lineKeys[index]!,
        outcome.ok ? { ok: true, items: outcome.items } : { ok: false },
      ),
    );
  }

  if (modifierRecipes.size > 0) {
    // A modifier with an add or replace rule changes the base recipe by more
    // than its own recipe: its cost is not known from here, so it is never
    // costed partially (a partial cost would be understated).
    const ruled = new Set(
      (
        await tx
          .selectDistinct({ modifierId: modifierRecipeRules.modifierId })
          .from(modifierRecipeRules)
          .where(
            and(
              eq(modifierRecipeRules.tenantId, context.tenant.tenantId),
              inArray(modifierRecipeRules.modifierId, [
                ...modifierRecipes.keys(),
              ]),
              inArray(modifierRecipeRules.action, ["add", "replace"]),
            ),
          )
      ).map((row) => row.modifierId),
    );
    const book = await loadRecipeBook(tx, context, [
      ...new Set(modifierRecipes.values()),
    ]);
    for (const [modifierId, recipeId] of modifierRecipes) {
      if (ruled.has(modifierId)) {
        result.set(`m:${modifierId}`, { ok: false });
        continue;
      }
      const outcome = explodeRecipeTree(
        book,
        recipeId,
        formatDecimal4(SCALE),
        [],
      );
      if (!outcome.ok) {
        result.set(`m:${modifierId}`, { ok: false });
        continue;
      }
      try {
        result.set(`m:${modifierId}`, {
          ok: true,
          items: await toBaseQuantities(tx, outcome.components),
        });
      } catch (error) {
        if (!(error instanceof InventoryError)) throw error;
        result.set(`m:${modifierId}`, { ok: false });
      }
    }
  }
  return result;
}

async function loadAvgCosts(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  saleLocationId: string | null,
  itemIds: readonly string[],
): Promise<Map<string, bigint>> {
  const avg = new Map<string, bigint>();
  const unique = [...new Set(itemIds)];
  if (saleLocationId === null || unique.length === 0) return avg;
  const rows = await tx
    .select({
      inventoryItemId: stockBalances.inventoryItemId,
      avgCostIdr: stockBalances.avgCostIdr,
    })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.tenantId, tenantId),
        eq(stockBalances.outletId, outletId),
        eq(stockBalances.locationId, saleLocationId),
        inArray(stockBalances.inventoryItemId, unique),
      ),
    );
  for (const row of rows)
    avg.set(row.inventoryItemId, parseDecimal4(row.avgCostIdr));
  return avg;
}

// ------------------------------------------------------------------- writes

type MenuCostRow = {
  menuItemId: string;
  variantId: string | null;
  modifierId: string | null;
  recipeId: string | null;
  complete: boolean;
  costIdr: number | null;
  priceIdr: number;
  marginBp: number | null;
};

/**
 * Upsert on the expression unique index (NULL variant/modifier stand in as the
 * nil uuid), so the conflict target is raw SQL, not a drizzle column list.
 */
async function upsertRows(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  rows: readonly MenuCostRow[],
  computedAt: Date,
): Promise<void> {
  for (let start = 0; start < rows.length; start += UPSERT_CHUNK) {
    const values = rows.slice(start, start + UPSERT_CHUNK).map(
      (row) => sql`(
        ${tenantId}::uuid, ${outletId}::uuid, ${row.menuItemId}::uuid,
        ${row.variantId}::uuid, ${row.modifierId}::uuid, ${row.recipeId}::uuid,
        ${row.complete},
        ${row.costIdr === null ? null : formatDecimal4(BigInt(row.costIdr) * SCALE)}::numeric(14,4),
        ${String(row.priceIdr)}::bigint, ${row.marginBp}::integer,
        ${computedAt.toISOString()}::timestamptz
      )`,
    );
    await tx.execute(sql`
      INSERT INTO menu_costs (
        tenant_id, outlet_id, menu_item_id, variant_id, modifier_id, recipe_id,
        recipe_complete, theoretical_cost_idr, price_idr, gross_margin_bp,
        computed_at
      ) VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (
        tenant_id, outlet_id, menu_item_id,
        coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        coalesce(modifier_id, '00000000-0000-0000-0000-000000000000'::uuid)
      ) DO UPDATE SET
        recipe_id = EXCLUDED.recipe_id,
        recipe_complete = EXCLUDED.recipe_complete,
        theoretical_cost_idr = EXCLUDED.theoretical_cost_idr,
        price_idr = EXCLUDED.price_idr,
        gross_margin_bp = EXCLUDED.gross_margin_bp,
        computed_at = EXCLUDED.computed_at
    `);
  }
}

/** After a full rebuild: rows of targets that were not rewritten are gone. */
async function deleteStaleRows(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  computedAt: Date,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM menu_costs
    WHERE tenant_id = ${tenantId}::uuid AND outlet_id = ${outletId}::uuid
      AND computed_at < ${computedAt.toISOString()}::timestamptz
  `);
}
