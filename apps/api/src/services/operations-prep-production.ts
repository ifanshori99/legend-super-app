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
import { and, asc, eq } from "drizzle-orm";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import {
  prepListLineSchema,
  type PrepListLine,
} from "@starter/shared/operations";
import { prepListItems, prepLists } from "../db/schema/operations.ts";
import type { OperationsTx } from "./operations-idempotency.ts";

/** What the WS-06 creator needs to materialize the production orders. */
export type PrepProductionOrderInput = {
  prepListId: string;
  outletId: string;
  /** Business date in the outlet time zone (`prep_lists.prep_date`). */
  prepDate: string;
  lines: PrepListLine[];
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
    },
    now,
  );
}
