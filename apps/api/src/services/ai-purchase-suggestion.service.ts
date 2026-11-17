// AI-08 purchase suggestion, par-based (WS-12 wave 3, bead legend-hkd4).
//
// Per outlet, every `par_levels` row (a per-location par) whose stock location
// is active and whose item is active is compared with the `stock_balances`
// quantity (a missing balance row is 0 on hand). Below `par_min` suggests
// `par_max - on hand`; at or above `par_min` suggests nothing. Locations in an
// open blind count are hidden (same rule as every plain stock read). Forecast
// driven usage is a gap: there is no recipe table yet.
import { and, asc, eq, lt, sql } from "drizzle-orm";
import {
  listPurchaseSuggestionsQuerySchema,
  purchaseSuggestionSchema,
  type PurchaseSuggestion,
} from "@starter/shared/ai";
import { db } from "../db/index.ts";
import {
  inventoryItems,
  stockBalances,
  stockLocations,
  uoms,
} from "../db/schema/inventory.ts";
import { parLevels } from "../db/schema/inventory-setup.ts";
import { withTenant } from "../db/tenant.ts";
import { requireOutletContext } from "./ai-forecast.shared.ts";
import { blindCountHiddenFilter } from "./inventory-count.visibility.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export async function listPurchaseSuggestions(
  access: AccessSnapshot,
  input: { outletId: string; limit?: number; offset?: number },
): Promise<PurchaseSuggestion[]> {
  const query = listPurchaseSuggestionsQuerySchema.parse(input);
  const context = requireOutletContext(
    access,
    ["purchasing.request.create", "inventory.stock.view"],
    query.outletId,
  );
  const tenantId = access.tenant.tenantId;
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        inventoryItemId: parLevels.inventoryItemId,
        itemName: inventoryItems.name,
        locationId: parLevels.locationId,
        locationName: stockLocations.name,
        unit: uoms.code,
        parMin: parLevels.parMin,
        parMax: parLevels.parMax,
        onHand: stockBalances.quantity,
      })
      .from(parLevels)
      .innerJoin(
        stockLocations,
        and(
          eq(stockLocations.tenantId, parLevels.tenantId),
          eq(stockLocations.id, parLevels.locationId),
        ),
      )
      .innerJoin(
        inventoryItems,
        and(
          eq(inventoryItems.tenantId, parLevels.tenantId),
          eq(inventoryItems.id, parLevels.inventoryItemId),
        ),
      )
      .innerJoin(
        uoms,
        and(
          eq(uoms.tenantId, inventoryItems.tenantId),
          eq(uoms.id, inventoryItems.baseUomId),
        ),
      )
      .leftJoin(
        stockBalances,
        and(
          eq(stockBalances.tenantId, parLevels.tenantId),
          eq(stockBalances.locationId, parLevels.locationId),
          eq(stockBalances.inventoryItemId, parLevels.inventoryItemId),
        ),
      )
      .where(
        and(
          eq(parLevels.tenantId, tenantId),
          eq(parLevels.outletId, query.outletId),
          eq(stockLocations.isActive, true),
          eq(inventoryItems.isActive, true),
          lt(sql`coalesce(${stockBalances.quantity}, 0)`, parLevels.parMin),
          blindCountHiddenFilter(parLevels),
        ),
      )
      .orderBy(
        asc(inventoryItems.name),
        asc(stockLocations.name),
        asc(parLevels.id),
      )
      .limit(query.limit)
      .offset(query.offset),
  );

  const suggestions: PurchaseSuggestion[] = [];
  for (const row of rows) {
    const onHand = Number(row.onHand ?? 0);
    const parMin = Number(row.parMin);
    const parMax = Number(row.parMax);
    suggestions.push(
      purchaseSuggestionSchema.parse({
        inventoryItemId: row.inventoryItemId,
        itemName: row.itemName,
        locationId: row.locationId,
        locationName: row.locationName,
        unit: row.unit,
        onHand,
        parMin,
        parMax,
        suggestedQty: round4(parMax - onHand),
        reason: "below_min",
      }),
    );
  }
  return suggestions;
}
