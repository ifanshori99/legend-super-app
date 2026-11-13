// Prep list -> production batch link (PRD v1.7 §3 F41 "Daftar Prep Harian",
// the daily prep list whose lines come from the AI-07 forecast; bead
// legend-sdet, WS-14).
//
// The production-order aggregate (WS-06 `production_orders`, bead legend-ugo)
// is not on this branch yet. Instead of inventing a table, this module exposes
// a small fail-closed port:
//
//   - the default creator is a no-op, so completing a prep list never writes a
//     production order or a `prep_list_items.production_order_id` on its own;
//   - the WS-06 service installs its real creator with
//     `setPrepProductionOrderCreator` and records the created order id on the
//     prep list line (wiring bead: legend-ugo, discovered-from legend-sdet);
//   - `setPrepProductionOrderCreator(null)` restores the no-op, which is what
//     tests use after injecting a double.
//
// The port runs inside the caller's tenant transaction (`OperationsTx`), so the
// completed status change and the production orders commit (or roll back)
// together.
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import {
  prepListLineSchema,
  type PrepListLine,
} from "@starter/shared/operations";
import { stockLocations } from "../db/schema/inventory.ts";
import { productionOrders } from "../db/schema/inventory-ops.ts";
import { prepListItems, prepLists } from "../db/schema/operations.ts";
import { recipes } from "../db/schema/recipe.ts";
import { PRODUCTION_WRITE_PERMISSION } from "./inventory-production.service.ts";
import { outletTarget, recordOpsAudit } from "./inventory-ops.shared.ts";
import type { OperationsTx } from "./operations-idempotency.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";

/** What the WS-06 creator needs to materialize the production orders. */
export type PrepProductionOrderInput = {
  prepListId: string;
  outletId: string;
  /** Business date in the outlet time zone (`prep_lists.prep_date`). */
  prepDate: string;
  lines: PrepListLine[];
  /**
   * The user who completed the list; becomes `production_orders.created_by`
   * (NOT NULL). Without it the real creator creates nothing (fail closed).
   */
  actorUserId?: string;
};

/**
 * Creates the production orders for a completed prep list. Runs in the
 * caller's transaction and must be idempotent for the same prep list, because
 * a completed list stays completed.
 */
export type PrepProductionOrderCreator = (
  tx: OperationsTx,
  context: ScopedTenantContext,
  input: PrepProductionOrderInput,
  now: Date,
) => Promise<void>;

/** Fail closed: completing a prep list does nothing until WS-06 wires this. */
const noopCreator: PrepProductionOrderCreator = async () => {};

let activeCreator: PrepProductionOrderCreator = noopCreator;

/** Installs the WS-06 creator; `null` resets to the no-op (tests, teardown). */
export function setPrepProductionOrderCreator(
  creator: PrepProductionOrderCreator | null,
): void {
  activeCreator = creator ?? noopCreator;
}

/**
 * Loads the completed prep list and its lines, then hands them to the
 * installed creator. The no-op default leaves `production_order_id` null,
 * which the contract already allows (`prepListLineSchema.productionOrderId`).
 *
 * Throws NOT_FOUND when the list is gone and CONFLICT when it is not
 * completed: a production batch can only exist for a finished plan.
 */
export async function linkProductionOrdersForPrepList(
  tx: OperationsTx,
  context: ScopedTenantContext,
  prepListId: string,
  now: Date = new Date(),
  actorUserId?: string,
): Promise<void> {
  const [list] = await tx
    .select()
    .from(prepLists)
    .where(
      and(
        eq(prepLists.tenantId, context.tenant.tenantId),
        eq(prepLists.id, prepListId),
      ),
    )
    .limit(1);
  if (!list) throw new CoreError("NOT_FOUND", "Daftar prep tidak ditemukan.");
  if (list.status !== "completed")
    throw new CoreError("CONFLICT", "Daftar prep belum selesai.");

  const rows = await tx
    .select({
      id: prepListItems.id,
      inventoryItemId: prepListItems.inventoryItemId,
      plannedQuantity: prepListItems.plannedQuantity,
      productionOrderId: prepListItems.productionOrderId,
    })
    .from(prepListItems)
    .where(
      and(
        eq(prepListItems.tenantId, context.tenant.tenantId),
        eq(prepListItems.prepListId, prepListId),
      ),
    )
    .orderBy(asc(prepListItems.id));

  const lines = rows.map((row) =>
    prepListLineSchema.parse({
      id: row.id,
      inventoryItemId: row.inventoryItemId,
      plannedQuantity: row.plannedQuantity,
      productionOrderId: row.productionOrderId,
    }),
  );

  await activeCreator(
    tx,
    context,
    {
      prepListId: list.id,
      outletId: list.outletId,
      prepDate: list.prepDate,
      lines,
      ...(actorUserId === undefined ? {} : { actorUserId }),
    },
    now,
  );
}

const PREP_PRODUCTION_AUDIT_FIELDS = [
  "recipeId",
  "plannedQty",
  "status",
  "prepListId",
] as const;

/**
 * The WS-06 creator (bead legend-qq4k): one `draft` production order per prep
 * line that has none yet. Draft only: no cost, stock movement or GL entry
 * (those happen when the batch itself is completed). A line is skipped, never
 * guessed, when its item has zero or several active recipes, or when the
 * outlet has no single active kitchen location. The actor must hold
 * `inventory.production.record` on the outlet (same permission as
 * `createProductionOrder`); without it nothing is created and no error is
 * thrown, so completing the prep list still succeeds. Replays are safe: the line
 * rows are locked and only lines with a null `production_order_id` are filled.
 */
export const productionOrderPrepCreator: PrepProductionOrderCreator = async (
  tx,
  context,
  input,
  now,
) => {
  if (input.actorUserId === undefined) return;
  const tenantId = context.tenant.tenantId;

  // Non-throwing check (requireOpsPermission throws): a denied actor skips
  // every line instead of aborting the completion transaction.
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    input.actorUserId,
    now,
  );
  if (
    !snapshot.allows(PRODUCTION_WRITE_PERMISSION, outletTarget(input.outletId))
  )
    return;

  const pending = await tx
    .select({
      id: prepListItems.id,
      inventoryItemId: prepListItems.inventoryItemId,
      plannedQuantity: prepListItems.plannedQuantity,
    })
    .from(prepListItems)
    .where(
      and(
        eq(prepListItems.tenantId, tenantId),
        eq(prepListItems.prepListId, input.prepListId),
        isNull(prepListItems.productionOrderId),
      ),
    )
    .orderBy(asc(prepListItems.id))
    .for("update");
  if (pending.length === 0) return;

  const kitchens = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.tenantId, tenantId),
        eq(stockLocations.outletId, input.outletId),
        eq(stockLocations.type, "kitchen"),
        eq(stockLocations.isActive, true),
      ),
    )
    .limit(2);
  if (kitchens.length !== 1) return;
  const locationId = kitchens[0]!.id;

  for (const line of pending) {
    const found = await tx
      .select({ id: recipes.id })
      .from(recipes)
      .where(
        and(
          eq(recipes.tenantId, tenantId),
          eq(recipes.outputItemId, line.inventoryItemId),
          eq(recipes.isActive, true),
        ),
      )
      .limit(2);
    if (found.length !== 1) continue;
    const recipeId = found[0]!.id;

    const [order] = await tx
      .insert(productionOrders)
      .values({
        id: randomUUID(),
        tenantId,
        outletId: input.outletId,
        locationId,
        recipeId,
        outputItemId: line.inventoryItemId,
        plannedQty: line.plannedQuantity,
        status: "draft",
        createdBy: input.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: productionOrders.id });
    await tx
      .update(prepListItems)
      .set({ productionOrderId: order!.id })
      .where(
        and(
          eq(prepListItems.tenantId, tenantId),
          eq(prepListItems.id, line.id),
          isNull(prepListItems.productionOrderId),
        ),
      );
    await recordOpsAudit(tx, context, {
      actorUserId: input.actorUserId,
      outletId: input.outletId,
      action: "inventory.production_created",
      objectType: "production_order",
      objectId: order!.id,
      before: null,
      after: {
        recipeId,
        plannedQty: line.plannedQuantity,
        status: "draft",
        prepListId: input.prepListId,
      },
      safeFields: PREP_PRODUCTION_AUDIT_FIELDS,
    });
  }
};

// Installed when this module loads (the food-safety service imports it), so
// completing a prep list reaches WS-06. `setPrepProductionOrderCreator(null)`
// still resets to the no-op.
setPrepProductionOrderCreator(productionOrderPrepCreator);
