// AI-08 purchase suggestions, rule-based (PRD v1.7 §3 F16 "Par Level & Saran
// Pembelian"; §AI-08 "Saran kuantitas pembelian dan par level dari prediksi
// dan stok", users purchasing + kitchen lead; flow I step 1; bead legend-ugo).
//
// AI-07 forecasts do not exist yet (legend-hkd4), so the basis is the par
// level alone, the same rule the web screen uses (legend-vxj): a location/item
// whose on-hand quantity is below its effective parMin should be refilled up
// to parMax, i.e. suggestedQty = parMax − onHand, in the item's base unit.
// Nothing is ordered here: the kitchen lead turns selected rows into a
// Purchase Request, which still goes through approval (flow I).

import { and, eq, inArray } from "drizzle-orm";
import {
  decimal4Schema,
  formatDecimal4,
  outletIdSchema,
  parseDecimal4,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  inventoryItemIdSchema,
  nonnegativeDecimal4Schema,
  parStatus,
  positiveDecimal4Schema,
  stockLocationIdSchema,
  uomIdSchema,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { inventoryItems, stockLocations } from "../db/schema/inventory.ts";
import { withTenant } from "../db/tenant.ts";
import { assertOutlet, requireOpsPermission } from "./inventory-ops.shared.ts";
import {
  parPositions,
  shortfallRatioCompare,
} from "./inventory-par-alerts.service.ts";

// ---- Response contract (proposed for packages/shared/src/inventory) -------

export const purchaseSuggestionSchema = z.strictObject({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  baseUomId: uomIdSchema,
  /** May be negative when real-time sale deduction ran ahead of a receipt. */
  onHand: decimal4Schema,
  parMin: nonnegativeDecimal4Schema,
  parMax: nonnegativeDecimal4Schema,
  suggestedQty: positiveDecimal4Schema,
  /** Which par applied: the location override or the item default. */
  parSource: z.enum(["location", "item_default"]),
  /** Rule basis; `forecast` joins once AI-07 lands (legend-hkd4). */
  basis: z.literal("par_level"),
});
export type PurchaseSuggestion = z.infer<typeof purchaseSuggestionSchema>;

export const purchaseSuggestionQuerySchema = z.strictObject({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema.optional(),
});

/**
 * GET purchase suggestions for one outlet, most critical first (lowest
 * onHand / parMin), then by location and item for a stable order. Needs
 * `inventory.stock.view` on the outlet: both AI-08 roles (purchasing, kitchen
 * lead) hold it, and the rows reveal nothing beyond the stock view.
 * Inactive items and inactive locations are skipped.
 */
export async function listPurchaseSuggestions(
  context: ScopedTenantContext,
  actorUserId: string,
  query: z.infer<typeof purchaseSuggestionQuerySchema>,
): Promise<PurchaseSuggestion[]> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      query.outletId,
    );
    const positions = [...(await parPositions(tx, query.outletId)).values()]
      .filter(
        (position) =>
          query.locationId === undefined ||
          position.locationId === query.locationId,
      )
      .filter(
        (position) =>
          position.par !== null &&
          parStatus(position.onHand, position.par) === "below_min",
      );
    if (positions.length === 0) return [];
    const activeLocations = new Set(
      (
        await tx
          .select({ id: stockLocations.id })
          .from(stockLocations)
          .where(
            and(
              eq(stockLocations.outletId, query.outletId),
              eq(stockLocations.isActive, true),
            ),
          )
      ).map((row) => row.id),
    );
    const items = await tx
      .select({ id: inventoryItems.id, baseUomId: inventoryItems.baseUomId })
      .from(inventoryItems)
      .where(
        inArray(inventoryItems.id, [
          ...new Set(positions.map((position) => position.inventoryItemId)),
        ]),
      );
    const baseUom = new Map(items.map((item) => [item.id, item.baseUomId]));
    const rows: PurchaseSuggestion[] = [];
    for (const position of positions) {
      const par = position.par!;
      const baseUomId = baseUom.get(position.inventoryItemId);
      if (!activeLocations.has(position.locationId) || !baseUomId) continue;
      // parMax >= parMin > onHand, so the refill is always positive.
      const suggested =
        parseDecimal4(par.parMax) - parseDecimal4(position.onHand);
      if (suggested <= 0n) continue;
      rows.push(
        purchaseSuggestionSchema.parse({
          outletId: query.outletId,
          locationId: position.locationId,
          inventoryItemId: position.inventoryItemId,
          baseUomId,
          onHand: position.onHand,
          parMin: par.parMin,
          parMax: par.parMax,
          suggestedQty: formatDecimal4(suggested),
          parSource: position.parSource,
          basis: "par_level",
        }),
      );
    }
    return rows.sort(
      (left, right) =>
        shortfallRatioCompare(left, right) ||
        (left.locationId < right.locationId
          ? -1
          : left.locationId > right.locationId
            ? 1
            : left.inventoryItemId < right.inventoryItemId
              ? -1
              : left.inventoryItemId > right.inventoryItemId
                ? 1
                : 0),
    );
  });
}
