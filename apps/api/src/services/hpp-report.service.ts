// HPP reports (bead legend-2qq, PRD v1.7 §17): menu cost with gross margin,
// recipe coverage, actual vs theoretical food cost and menu engineering.
//
// - Every read runs inside `withTenant` (RLS scopes the tenant) and the
//   permission is re-checked here against stored role assignments, not only in
//   the route: all four reports are financial and need `recipe.cost.view`
//   (outlet reports on the outlet, coverage on the brand). Deny by default.
// - Costs are never invented: an incomplete recipe has a NULL cost (menu_costs
//   already stores it that way), and a menu item whose sold lines miss a cost
//   snapshot is left out of menu engineering instead of being classified on a
//   partial margin. The food cost report fills the gap from the stock ledger.
// - Money is summed exact and rounded once per total: ledger value at
//   Decimal4 x Decimal4 scale through `scaledCostToIdr`, as the order cost
//   snapshot does. The pure math lives in hpp-math.ts.
// - Orders counted: `completed`, lines not voided, no training orders (same
//   definition as the `cogs` metric source in metric-sources/menu-cogs.ts).
//   A business date follows the outlet clock (day = [cutoff, next cutoff)).

import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { AccessError } from "@starter/shared/access";
import {
  businessDayRange,
  encodeCursor,
  formatDecimal4,
  idr,
  parseDecimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  foodCostComparisonSchema,
  menuCostSchema,
  menuEngineeringRowSchema,
  recipeCoverageRowSchema,
  type foodCostQuerySchema,
  type FoodCostComparison,
  type menuCostQuerySchema,
  type MenuCost,
  type menuEngineeringQuerySchema,
  type MenuEngineeringRow,
  type recipeCoverageQuerySchema,
  type RecipeCoverageRow,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { menuCosts } from "../db/schema/hpp.ts";
import { brands, outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { composeFoodCost, classifyMenuEngineering } from "./hpp-math.ts";
import {
  assertOutlet,
  cursorKeys,
  cursorUuid,
  requireOpsPermission,
  scaledCostToIdr,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";

export type MenuCostQuery = z.infer<typeof menuCostQuerySchema>;
export type FoodCostQuery = z.infer<typeof foodCostQuerySchema>;
export type MenuEngineeringQuery = z.infer<typeof menuEngineeringQuerySchema>;
export type RecipeCoverageQuery = z.infer<typeof recipeCoverageQuerySchema>;

const COST_PERMISSION = "recipe.cost.view" as const;
/** Stands in for NULL variant / modifier ids in sort keys and cursors. */
const NO_ID = "00000000-0000-0000-0000-000000000000";

const isoOf = (value: Date | string): string => new Date(value).toISOString();

// ------------------------------------------------------------ menu costs

function toMenuCost(row: typeof menuCosts.$inferSelect): MenuCost {
  return menuCostSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    menuItemId: row.menuItemId,
    variantId: row.variantId,
    modifierId: row.modifierId,
    recipeId: row.recipeId,
    recipeComplete: row.recipeComplete,
    theoreticalCostIdr: row.theoreticalCostIdr,
    priceIdr: row.priceIdr,
    grossMarginBp: row.grossMarginBp,
    computedAt: row.computedAt.toISOString(),
  });
}

/** GET menu-costs: the precomputed HPP of one outlet, by menu item. */
export async function listMenuCosts(
  context: ScopedTenantContext,
  actorUserId: string,
  query: MenuCostQuery,
): Promise<CursorPage<MenuCost>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      COST_PERMISSION,
      query.outletId,
    );
    const variantKey = sql`coalesce(${menuCosts.variantId}, ${NO_ID}::uuid)::text`;
    const modifierKey = sql`coalesce(${menuCosts.modifierId}, ${NO_ID}::uuid)::text`;
    const filters: SQL[] = [
      eq(menuCosts.tenantId, context.tenant.tenantId),
      eq(menuCosts.outletId, query.outletId),
    ];
    if (query.menuItemId)
      filters.push(eq(menuCosts.menuItemId, query.menuItemId));
    const [itemKey, variantAfter, modifierAfter] = cursorKeys(query.cursor, 3);
    if (
      itemKey !== undefined &&
      variantAfter !== undefined &&
      modifierAfter !== undefined
    )
      filters.push(
        sql`(${menuCosts.menuItemId}::text, ${variantKey}, ${modifierKey}) > (${cursorUuid(itemKey)}::text, ${cursorUuid(variantAfter)}::text, ${cursorUuid(modifierAfter)}::text)`,
      );
    const rows = await tx
      .select()
      .from(menuCosts)
      .where(and(...filters))
      .orderBy(
        asc(sql`${menuCosts.menuItemId}::text`),
        asc(variantKey),
        asc(modifierKey),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toMenuCost),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([
                last.menuItemId,
                last.variantId ?? NO_ID,
                last.modifierId ?? NO_ID,
              ])
            : null,
      },
    };
  });
}

// -------------------------------------------------------- recipe coverage

/**
 * Brands the caller reaches with `recipe.cost.view` (tenant, the brand, or any
 * outlet of the brand, TEN-03). Same rule as the recipe list.
 */
async function reachableBrandIds(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<string[]> {
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    new Date(),
  );
  const brandRows = await tx.select({ id: brands.id }).from(brands);
  const outletRows = await tx
    .select({ id: outlets.id, brandId: outlets.brandId })
    .from(outlets)
    .where(eq(outlets.tenantId, context.tenant.tenantId));
  const tenantWide = snapshot.allows(COST_PERMISSION, { type: "tenant" });
  return brandRows
    .map((brand) => brand.id)
    .filter(
      (brandId) =>
        tenantWide ||
        snapshot.allows(COST_PERMISSION, { type: "brand", id: brandId }) ||
        outletRows.some(
          (outlet) =>
            outlet.brandId === brandId &&
            snapshot.allows(COST_PERMISSION, {
              type: "outlet",
              id: outlet.id,
            }),
        ),
    );
}

type CoverageDbRow = {
  menu_item_id: string;
  variant_id: string | null;
  modifier_id: string | null;
  recipe_id: string | null;
  recipe_active: boolean | null;
  complete_rows: string | number;
  outlet_rows: string | number;
  cost_idr: string | null;
  updated_at: Date | string;
};

function toCoverageRow(
  tenantId: string,
  row: CoverageDbRow,
): RecipeCoverageRow {
  let status: RecipeCoverageRow["status"] = "no_recipe";
  let cost: string | null = null;
  if (row.recipe_id !== null) {
    // Complete only when the recipe is active and EVERY outlet in scope has a
    // complete cost row; an outlet without a row (not computed yet) makes it
    // incomplete, so a menu is never claimed complete on a partial rollout.
    const complete =
      row.recipe_active === true &&
      Number(row.outlet_rows) > 0 &&
      Number(row.complete_rows) === Number(row.outlet_rows) &&
      row.cost_idr !== null;
    status = complete ? "complete" : "incomplete";
    if (complete && row.cost_idr !== null)
      cost = formatDecimal4(parseDecimal4(row.cost_idr));
  }
  return recipeCoverageRowSchema.parse({
    tenantId,
    menuItemId: row.menu_item_id,
    variantId: row.variant_id,
    modifierId: row.modifier_id,
    status,
    recipeId: row.recipe_id,
    theoreticalCostIdr: cost,
    updatedAt: isoOf(row.updated_at),
  });
}

/**
 * GET recipe-coverage: every menu item, variant and modifier (per menu item it
 * is offered on) with whether its HPP can be computed.
 */
export async function listRecipeCoverage(
  context: ScopedTenantContext,
  actorUserId: string,
  query: RecipeCoverageQuery,
): Promise<CursorPage<RecipeCoverageRow>> {
  return withTenant(db, context, async (tx) => {
    const reachable = await reachableBrandIds(tx, context, actorUserId);
    if (
      reachable.length === 0 ||
      (query.brandId && !reachable.includes(query.brandId))
    )
      throw new AccessError("PERMISSION_DENIED");
    const scope = query.brandId ? [query.brandId] : reachable;
    const tenantId = context.tenant.tenantId;
    const brandList = sql.join(
      scope.map((brandId) => sql`${brandId}::uuid`),
      sql`, `,
    );
    const [itemKey, variantAfter, modifierAfter] = cursorKeys(query.cursor, 3);
    const after =
      itemKey !== undefined &&
      variantAfter !== undefined &&
      modifierAfter !== undefined
        ? sql`WHERE (menu_item_key, variant_key, modifier_key) > (${cursorUuid(itemKey)}::text, ${cursorUuid(variantAfter)}::text, ${cursorUuid(modifierAfter)}::text)`
        : sql``;
    const result = await tx.execute<CoverageDbRow>(sql`
      WITH catalogue AS (
        SELECT mi.id AS menu_item_id, NULL::uuid AS variant_id,
               NULL::uuid AS modifier_id, mi.recipe_id, mi.updated_at
          FROM menu_items mi
         WHERE mi.tenant_id = ${tenantId}::uuid
           AND mi.deleted_at IS NULL
           AND mi.brand_id IN (${brandList})
        UNION ALL
        SELECT mi.id, v.id, NULL::uuid, coalesce(v.recipe_id, mi.recipe_id),
               v.updated_at
          FROM item_variants v
          JOIN menu_items mi
            ON mi.tenant_id = v.tenant_id AND mi.id = v.menu_item_id
         WHERE v.tenant_id = ${tenantId}::uuid
           AND v.deleted_at IS NULL
           AND mi.deleted_at IS NULL
           AND mi.brand_id IN (${brandList})
        UNION ALL
        SELECT mi.id, NULL::uuid, m.id, m.recipe_id, m.updated_at
          FROM modifiers m
          JOIN modifier_groups mg
            ON mg.tenant_id = m.tenant_id AND mg.id = m.group_id
           AND mg.deleted_at IS NULL
          JOIN menu_item_modifier_groups g
            ON g.tenant_id = m.tenant_id AND g.group_id = m.group_id
           AND g.deleted_at IS NULL
          JOIN menu_items mi
            ON mi.tenant_id = g.tenant_id AND mi.id = g.menu_item_id
         WHERE m.tenant_id = ${tenantId}::uuid
           AND m.deleted_at IS NULL
           AND mi.deleted_at IS NULL
           AND mi.brand_id IN (${brandList})
      ),
      scope_outlets AS (
        SELECT id FROM outlets
         WHERE tenant_id = ${tenantId}::uuid
           AND brand_id IN (${brandList})
      ),
      cost AS (
        SELECT mc.menu_item_id, mc.variant_id, mc.modifier_id,
               count(*) FILTER (
                 WHERE mc.recipe_complete
                   AND mc.theoretical_cost_idr IS NOT NULL
               ) AS complete_rows,
               max(mc.theoretical_cost_idr) AS cost_idr,
               max(mc.computed_at) AS computed_at
          FROM menu_costs mc
          JOIN scope_outlets so ON so.id = mc.outlet_id
         WHERE mc.tenant_id = ${tenantId}::uuid
         GROUP BY mc.menu_item_id, mc.variant_id, mc.modifier_id
      ),
      joined AS (
        SELECT c.menu_item_id::text AS menu_item_key,
               coalesce(c.variant_id, ${NO_ID}::uuid)::text AS variant_key,
               coalesce(c.modifier_id, ${NO_ID}::uuid)::text AS modifier_key,
               c.menu_item_id, c.variant_id, c.modifier_id, c.recipe_id,
               r.is_active AS recipe_active,
               coalesce(k.complete_rows, 0) AS complete_rows,
               (SELECT count(*) FROM scope_outlets) AS outlet_rows,
               k.cost_idr::text AS cost_idr,
               greatest(c.updated_at, k.computed_at) AS updated_at
          FROM catalogue c
          LEFT JOIN recipes r
            ON r.tenant_id = ${tenantId}::uuid AND r.id = c.recipe_id
          LEFT JOIN cost k
            ON k.menu_item_id = c.menu_item_id
           AND k.variant_id IS NOT DISTINCT FROM c.variant_id
           AND k.modifier_id IS NOT DISTINCT FROM c.modifier_id
      )
      SELECT menu_item_id, variant_id, modifier_id, recipe_id, recipe_active,
             complete_rows, outlet_rows, cost_idr, updated_at
        FROM joined
        ${after}
       ORDER BY menu_item_key, variant_key, modifier_key
       LIMIT ${query.limit + 1}`);
    const rows = result.rows;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => toCoverageRow(tenantId, row)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([
                last.menu_item_id,
                last.variant_id ?? NO_ID,
                last.modifier_id ?? NO_ID,
              ])
            : null,
      },
    };
  });
}

// -------------------------------------------------------------- food cost

/** Shared WHERE of the order lines both order-based reports count. */
function countedLines(
  tenantId: string,
  outletId: string,
  fromDate: string,
  toDate: string,
): SQL {
  return sql`
        FROM order_items oi
        JOIN orders o ON o.tenant_id = oi.tenant_id AND o.id = oi.order_id
        LEFT JOIN pos_orders po
               ON po.tenant_id = o.tenant_id AND po.order_id = o.id
       WHERE o.tenant_id = ${tenantId}::uuid
         AND o.outlet_id = ${outletId}::uuid
         AND o.business_date BETWEEN ${fromDate}::date AND ${toDate}::date
         AND o.status = 'completed'
         AND oi.status <> 'voided'
         AND COALESCE(po.is_training, false) = false`;
}

function assertPeriod(fromDate: string, toDate: string): void {
  if (fromDate > toDate)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "The period must not end before it starts.",
    );
}

/** The outlet's own clock: a business date is [cutoff, next cutoff). */
async function outletClock(tx: Tx, tenantId: string, outletId: string) {
  const [outlet] = await tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  return outletBusinessDayClock(outlet);
}

/**
 * GET food-cost: actual vs theoretical cost of one outlet and period. One row
 * per request (outlet + period), so the page is always the last one.
 *
 * theoretical = SUM(order line cost snapshots); waste, duty meals and count
 * adjustments come from the stock ledger of the period (loss = -quantity x unit
 * cost, so a shortage is positive and a surplus negative). What the sale rows
 * of the ledger consumed beyond (or below) the theoretical cost, net of order
 * returns, joins the adjustment: that is also where lines without a cost
 * snapshot land, so an unknown cost is never silently dropped from the actual.
 */
export async function listFoodCostComparisons(
  context: ScopedTenantContext,
  actorUserId: string,
  query: FoodCostQuery,
): Promise<CursorPage<FoodCostComparison>> {
  assertOutlet(context, query.outletId);
  assertPeriod(query.fromDate, query.toDate);
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      COST_PERMISSION,
      query.outletId,
    );
    const tenantId = context.tenant.tenantId;
    const clock = await outletClock(tx, tenantId, query.outletId);
    const start = businessDayRange(query.fromDate, clock).start;
    const end = businessDayRange(query.toDate, clock).end;

    const theoreticalResult = await tx.execute<{ total: string | null }>(sql`
      SELECT COALESCE(SUM(oi.cost_snapshot_idr), 0)::text AS total
      ${countedLines(tenantId, query.outletId, query.fromDate, query.toDate)}
         AND oi.cost_snapshot_idr IS NOT NULL`);
    const theoreticalIdr = Number(theoreticalResult.rows[0]?.total ?? 0);

    // Exact sums at Decimal4 x Decimal4 scale (integers), rounded once below.
    const ledgerResult = await tx.execute<{ bucket: string; scaled: string }>(
      sql`
      SELECT CASE WHEN movement_type IN ('sale', 'return') THEN 'sale'
                  ELSE movement_type END AS bucket,
             SUM(-(quantity * 10000) * (unit_cost_idr * 10000))::numeric(38, 0)::text
               AS scaled
        FROM stock_ledger
       WHERE tenant_id = ${tenantId}::uuid
         AND outlet_id = ${query.outletId}::uuid
         AND occurred_at >= ${start.toISOString()}::timestamptz
         AND occurred_at < ${end.toISOString()}::timestamptz
         AND (
           movement_type IN ('waste', 'adjustment', 'duty_meal', 'sale')
           OR (movement_type = 'return' AND source_type = 'order')
         )
       GROUP BY 1`,
    );
    const scaledOf = (bucket: string): bigint => {
      const row = ledgerResult.rows.find((entry) => entry.bucket === bucket);
      return row ? BigInt(row.scaled) : 0n;
    };
    const wasteIdr = scaledCostToIdr(scaledOf("waste"));
    const offRecipeUsageIdr = scaledCostToIdr(scaledOf("duty_meal"));
    const saleLedgerIdr = scaledCostToIdr(scaledOf("sale"));
    const adjustmentIdr =
      scaledCostToIdr(scaledOf("adjustment")) +
      (saleLedgerIdr - theoreticalIdr);

    const composed = composeFoodCost({
      theoreticalIdr,
      wasteIdr,
      adjustmentIdr,
      offRecipeUsageIdr,
    });
    const row = foodCostComparisonSchema.parse({
      tenantId,
      outletId: query.outletId,
      fromDate: query.fromDate,
      toDate: query.toDate,
      theoreticalCostIdr: idr(theoreticalIdr),
      actualCostIdr: idr(composed.actualCostIdr),
      varianceIdr: idr(composed.varianceIdr),
      varianceBp: composed.varianceBp,
      wasteIdr: idr(wasteIdr),
      adjustmentIdr: idr(adjustmentIdr),
      offRecipeUsageIdr: idr(offRecipeUsageIdr),
    });
    return { data: [row], meta: { limit: query.limit, nextCursor: null } };
  });
}

// -------------------------------------------------------- menu engineering

/**
 * GET menu-engineering: star / plowhorse / puzzle / dog per menu item sold at
 * one outlet in the period. The cutoffs come from the whole set of classified
 * items, so the page is cut after classifying. An item with any sold line
 * missing a cost snapshot is not classifiable (its margin would be inflated)
 * and is left out; recipe coverage lists it.
 */
export async function listMenuEngineering(
  context: ScopedTenantContext,
  actorUserId: string,
  query: MenuEngineeringQuery,
): Promise<CursorPage<MenuEngineeringRow>> {
  assertOutlet(context, query.outletId);
  assertPeriod(query.fromDate, query.toDate);
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      COST_PERMISSION,
      query.outletId,
    );
    const tenantId = context.tenant.tenantId;
    const [afterItem] = cursorKeys(query.cursor, 1);
    if (afterItem !== undefined) cursorUuid(afterItem);
    const result = await tx.execute<{
      menu_item_id: string;
      units: string;
      margin: string;
      unknown_lines: string;
    }>(sql`
      SELECT oi.menu_item_id::text AS menu_item_id,
             SUM(oi.quantity)::bigint::text AS units,
             COALESCE(SUM(oi.line_total_idr - oi.cost_snapshot_idr), 0)::bigint::text
               AS margin,
             COUNT(*) FILTER (WHERE oi.cost_snapshot_idr IS NULL)::text
               AS unknown_lines
      ${countedLines(tenantId, query.outletId, query.fromDate, query.toDate)}
       GROUP BY oi.menu_item_id`);
    // Sorted here, not in SQL: the cursor compares with the same JS ordering.
    const classifiable = result.rows
      .filter((row) => Number(row.unknown_lines) === 0)
      .map((row) => ({
        menuItemId: row.menu_item_id,
        unitsSold: Number(row.units),
        grossMarginIdr: Number(row.margin),
      }))
      .sort((a, b) =>
        a.menuItemId < b.menuItemId ? -1 : a.menuItemId > b.menuItemId ? 1 : 0,
      );
    const classified = classifyMenuEngineering(classifiable).filter(
      (row) => afterItem === undefined || row.menuItemId > afterItem,
    );
    const page = classified.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) =>
        menuEngineeringRowSchema.parse({
          tenantId,
          outletId: query.outletId,
          menuItemId: row.menuItemId,
          unitsSold: row.unitsSold,
          grossMarginIdr: idr(row.grossMarginIdr),
          classification: row.classification,
        }),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          classified.length > query.limit && last
            ? encodeCursor([last.menuItemId])
            : null,
      },
    };
  });
}
