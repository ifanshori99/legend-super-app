// Production batches of semi-finished goods (PRD v1.7 §3 F17 "Produksi Batch":
// "Perintah produksi, pemakaian bahan, hasil produksi, sisa, dan biaya per
// batch untuk bahan semi-finished"; §6 E `production_orders`; INV-02; bead
// legend-ugo).
//
// State machine: the contract's `transitionProductionOrder`
// (draft -> in_progress -> completed, cancel from draft/in_progress).
// Completing a batch, in one tenant transaction:
//   1. draws every recipe component for the PLANNED quantity (lines scaled by
//      planned / yield, converted to base units, grossed up by the line prep
//      loss, owner Q19) from the production location, FEFO, as
//      `production_out` rows at the location moving-average cost;
//   2. puts the ACTUAL output away as one `production_in` row at
//      cost / actualQty, so the yield difference ("sisa") moves the unit
//      cost instead of disappearing;
//   3. stores `costIdr` (whole rupiah, rounded once) on the order.
// No negative-stock bypass: a missing component rejects the completion (409)
// and nothing is posted. Recipes come from the recipe source port
// (legend-db6); until it is wired every production write fails closed (404).

import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import {
  divideRounded,
  encodeCursor,
  formatDecimal4,
  idr,
  parseDecimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  productionOrderSchema,
  transitionProductionOrder,
  type createProductionOrderInputSchema,
  type ProductionOrder,
  type productionOrderQuerySchema,
  type transitionProductionOrderInputSchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { inventoryItems, stockLocations } from "../db/schema/inventory.ts";
import { productionOrders } from "../db/schema/inventory-ops.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { consumeStockFefo } from "./inventory-expiry.service.ts";
import {
  assertOutlet,
  claimIdempotency,
  completeIdempotency,
  cursorInstant,
  cursorKeys,
  cursorUuid,
  inventoryRecipeSource,
  lockLocations,
  outletTarget,
  recipeConsumptionPlan,
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  ROUNDING_MODE,
  scaledCostToIdr,
  translateInventoryError,
  type CursorPage,
  type RecipeForStock,
  type Tx,
} from "./inventory-ops.shared.ts";
import { evaluateParAlertsInTransaction } from "./inventory-par-alerts.service.ts";
import { recordStockMovementInTransaction } from "./inventory.service.ts";

/**
 * The contract input, plus an optional production location. The contract has
 * no `locationId` yet (proposed in the bead report); service callers (the
 * WS-14 prep list, legend-sdet) and a future contract field pass it here.
 */
export type CreateProductionOrderInput = z.infer<
  typeof createProductionOrderInputSchema
> & { locationId?: string };
export type TransitionProductionOrderInput = z.infer<
  typeof transitionProductionOrderInputSchema
>;
export type ProductionOrderQuery = z.infer<typeof productionOrderQuerySchema>;

/**
 * Production is recipe work done by the kitchen (PRD §17); the catalog has no
 * production code, so writes need `recipe.manage` (kitchen lead, GM, owner).
 * See the bead report: a dedicated `inventory.production.record` is proposed.
 */
export const PRODUCTION_WRITE_PERMISSION = "recipe.manage" as const;
const PRODUCTION_AUDIT_FIELDS = [
  "recipeId",
  "plannedQty",
  "actualQty",
  "status",
  "costIdr",
  "completedAt",
] as const;

type OrderRow = typeof productionOrders.$inferSelect;

function toOrder(row: OrderRow): ProductionOrder {
  return productionOrderSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    recipeId: row.recipeId,
    plannedQty: row.plannedQty,
    actualQty: row.actualQty,
    status: row.status,
    costIdr: row.costIdr,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

/** Batch cost is financial data (HPP): masked without a cost-view code. */
function masked(order: ProductionOrder, withCost: boolean): ProductionOrder {
  return withCost || order.costIdr === null
    ? order
    : { ...order, costIdr: idr(0) };
}

function canViewProductionCost(
  snapshot: Awaited<ReturnType<typeof requireOpsPermission>>,
  outletId: string,
): boolean {
  const target = outletTarget(outletId);
  return (
    snapshot.allows("inventory.cost.view", target) ||
    snapshot.allows("recipe.cost.view", target)
  );
}

/** A production batch makes a semi-finished item: the recipe needs an output. */
async function requireProductionRecipe(
  tx: Tx,
  context: ScopedTenantContext,
  recipeId: string,
): Promise<RecipeForStock & { outputItemId: string }> {
  const recipe = await inventoryRecipeSource().loadRecipe(
    tx,
    context,
    recipeId,
  );
  if (!recipe)
    throw new HttpError(404, "RECIPE_NOT_FOUND", "Recipe not found.");
  if (!recipe.outputItemId)
    throw new HttpError(
      422,
      "RECIPE_OUTPUT_MISSING",
      "Only a semi-finished recipe (with an output item) can be produced.",
    );
  return recipe as RecipeForStock & { outputItemId: string };
}

/**
 * The production location. An explicit `locationId` must be an active
 * location of the outlet. Without one (the contract input has no location
 * yet) the batch is made in the outlet's single active `kitchen` location;
 * zero or several is a 422 instead of a guess (decision in the bead report;
 * PRD §17 is silent).
 */
async function productionLocation(
  tx: Tx,
  outletId: string,
  locationId: string | undefined,
): Promise<string> {
  if (locationId !== undefined) {
    const [row] = await tx
      .select({ id: stockLocations.id, isActive: stockLocations.isActive })
      .from(stockLocations)
      .where(
        and(
          eq(stockLocations.id, locationId),
          eq(stockLocations.outletId, outletId),
        ),
      );
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Stock location not found.");
    if (!row.isActive)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "The production location is inactive.",
      );
    return row.id;
  }
  const rows = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.outletId, outletId),
        eq(stockLocations.type, "kitchen"),
        eq(stockLocations.isActive, true),
      ),
    )
    .limit(2);
  if (rows.length !== 1)
    throw new HttpError(
      422,
      "PRODUCTION_LOCATION_UNRESOLVED",
      "The outlet needs exactly one active kitchen location for production.",
    );
  return rows[0]!.id;
}

/** POST production order: a `draft` batch. Nothing moves until completion. */
export async function createProductionOrder(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateProductionOrderInput,
): Promise<ProductionOrder> {
  assertOutlet(context, input.outletId);
  const operation = "production.create";
  const claim = {
    operation,
    key: input.idempotencyKey,
    outletId: input.outletId,
    fingerprint: requestFingerprint(operation, actorUserId, {
      outletId: input.outletId,
      recipeId: input.recipeId,
      plannedQty: formatDecimal4(parseDecimal4(input.plannedQty)),
      locationId: input.locationId ?? null,
    }),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      const snapshot = await requireOpsPermission(
        tx,
        context,
        actorUserId,
        PRODUCTION_WRITE_PERMISSION,
        input.outletId,
      );
      const withCost = canViewProductionCost(snapshot, input.outletId);
      const replay = await claimIdempotency(tx, context, claim);
      if (replay)
        return masked(productionOrderSchema.parse(replay.replay), withCost);

      const recipe = await requireProductionRecipe(tx, context, input.recipeId);
      if (!recipe.isActive)
        throw new HttpError(422, "VALIDATION_ERROR", "The recipe is inactive.");
      const [output] = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(eq(inventoryItems.id, recipe.outputItemId));
      if (!output)
        throw new HttpError(
          422,
          "RECIPE_COMPONENT_MISSING",
          "The recipe's output item does not exist.",
        );
      const locationId = await productionLocation(
        tx,
        input.outletId,
        input.locationId,
      );
      const [row] = await tx
        .insert(productionOrders)
        .values({
          id: randomUUID(),
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          locationId,
          recipeId: input.recipeId,
          outputItemId: recipe.outputItemId,
          plannedQty: input.plannedQty,
          status: "draft",
          createdBy: actorUserId,
          // Millisecond precision, like the cursor that pages over it.
          createdAt: new Date(),
        })
        .returning();
      const order = toOrder(row!);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: order.outletId,
        action: "inventory.production_created",
        objectType: "production_order",
        objectId: order.id,
        before: null,
        after: order,
        safeFields: PRODUCTION_AUDIT_FIELDS,
      });
      await completeIdempotency(tx, context, claim, order);
      return masked(order, withCost);
    });
  } catch (error) {
    throw translateInventoryError(error);
  }
}

/**
 * POST production order transition. The order row is locked first (lock
 * order: document -> location advisory locks -> balance rows), so two
 * completions of one batch cannot both post. The permission is re-checked
 * against the order's own outlet (TEN-03): the route only knows the id.
 */
export async function transitionProductionOrderStatus(
  context: ScopedTenantContext,
  actorUserId: string,
  productionOrderId: string,
  input: TransitionProductionOrderInput,
): Promise<ProductionOrder> {
  const operation = `production.transition:${productionOrderId}`;
  try {
    return await withTenant(db, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(productionOrders)
        .where(eq(productionOrders.id, productionOrderId))
        .for("update");
      // RLS hides another tenant's or an out-of-scope outlet's order: 404.
      if (!current)
        throw new HttpError(404, "NOT_FOUND", "Production order not found.");
      assertOutlet(context, current.outletId);
      const snapshot = await requireOpsPermission(
        tx,
        context,
        actorUserId,
        PRODUCTION_WRITE_PERMISSION,
        current.outletId,
      );
      const withCost = canViewProductionCost(snapshot, current.outletId);
      const claim = {
        operation,
        key: input.idempotencyKey,
        outletId: current.outletId,
        fingerprint: requestFingerprint(operation, actorUserId, {
          action: input.action,
          actualQty:
            input.actualQty === undefined
              ? null
              : formatDecimal4(parseDecimal4(input.actualQty)),
        }),
      };
      const replay = await claimIdempotency(tx, context, claim);
      if (replay)
        return masked(productionOrderSchema.parse(replay.replay), withCost);

      const before = toOrder(current);
      const next = transitionProductionOrder(current.status, input.action);
      const now = new Date();
      let patch: Partial<typeof productionOrders.$inferInsert> = {
        status: next,
        updatedAt: now,
      };
      if (next === "in_progress") patch.startedAt = now;
      if (next === "cancelled") patch.cancelledAt = now;
      if (next === "completed") {
        if (input.actualQty === undefined)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Completing a batch needs its actual output.",
          );
        patch = {
          ...patch,
          ...(await postProduction(tx, context, actorUserId, current, {
            actualQty: input.actualQty,
          })),
          completedAt: now,
        };
      }
      const [row] = await tx
        .update(productionOrders)
        .set(patch)
        .where(eq(productionOrders.id, current.id))
        .returning();
      const order = toOrder(row!);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: order.outletId,
        action: `inventory.production_${input.action === "start" ? "started" : input.action === "complete" ? "completed" : "cancelled"}`,
        objectType: "production_order",
        objectId: order.id,
        before,
        after: order,
        safeFields: PRODUCTION_AUDIT_FIELDS,
      });
      await completeIdempotency(tx, context, claim, order);
      return masked(order, withCost);
    });
  } catch (error) {
    throw translateInventoryError(error);
  }
}

/** Posts the batch to the ledger and returns the order columns to store. */
async function postProduction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  order: OrderRow,
  input: { actualQty: string },
): Promise<Partial<typeof productionOrders.$inferInsert>> {
  const recipe = await requireProductionRecipe(tx, context, order.recipeId);
  if (recipe.outputItemId !== order.outputItemId)
    throw new HttpError(
      409,
      "CONFLICT",
      "The recipe now makes a different item; create a new production order.",
    );
  const plan = await recipeConsumptionPlan(tx, recipe, order.plannedQty);
  if (plan.has(order.outputItemId))
    throw new HttpError(
      422,
      "RECIPE_CYCLE",
      "A production batch cannot consume its own output item.",
    );
  const actualQty = formatDecimal4(parseDecimal4(input.actualQty));
  await lockLocations(tx, context.tenant.tenantId, [order.locationId]);
  let scaledCost = 0n;
  for (const itemId of [...plan.keys()].sort()) {
    const consumption = await consumeStockFefo(tx, context, {
      outletId: order.outletId,
      locationId: order.locationId,
      inventoryItemId: itemId,
      quantity: plan.get(itemId)!,
      movementType: "production_out",
      sourceType: "production_order",
      sourceId: order.id,
      actorUserId,
    });
    scaledCost += consumption.scaledCost;
  }
  // scaledCost is rupiah x 10^8; dividing by actualQty (x 10^4) leaves the
  // unit cost at Decimal4 scale: one rounding for the unit, one for the batch.
  const unitCostIdr = formatDecimal4(
    divideRounded(scaledCost, parseDecimal4(actualQty), ROUNDING_MODE),
  );
  await recordStockMovementInTransaction(tx, context, {
    outletId: order.outletId,
    locationId: order.locationId,
    inventoryItemId: order.outputItemId,
    movementType: "production_in",
    quantity: actualQty,
    unitCostIdr,
    sourceType: "production_order",
    sourceId: order.id,
    actor: { type: "user", id: actorUserId },
  });
  await evaluateParAlertsInTransaction(tx, context, order.outletId, {
    pairs: [...plan.keys(), order.outputItemId].map((inventoryItemId) => ({
      locationId: order.locationId,
      inventoryItemId,
    })),
  });
  return { actualQty, costIdr: idr(scaledCostToIdr(scaledCost)) };
}

/**
 * GET production orders of one outlet, newest first. Needs
 * `inventory.stock.view`; the batch cost needs a cost-view code (masked).
 */
export async function listProductionOrders(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ProductionOrderQuery,
): Promise<CursorPage<ProductionOrder>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    const snapshot = await requireOpsPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      query.outletId,
    );
    const withCost = canViewProductionCost(snapshot, query.outletId);
    const filters: SQL[] = [eq(productionOrders.outletId, query.outletId)];
    if (query.recipeId)
      filters.push(eq(productionOrders.recipeId, query.recipeId));
    if (query.status) filters.push(eq(productionOrders.status, query.status));
    const [createdAt, id] = cursorKeys(query.cursor, 2);
    if (createdAt !== undefined && id !== undefined) {
      const at = cursorInstant(createdAt);
      filters.push(
        or(
          lt(productionOrders.createdAt, at),
          and(
            eq(productionOrders.createdAt, at),
            sql`${productionOrders.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(productionOrders)
      .where(and(...filters))
      .orderBy(desc(productionOrders.createdAt), desc(productionOrders.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => masked(toOrder(row), withCost)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}
