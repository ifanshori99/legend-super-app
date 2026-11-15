// HPP snapshot per order line (bead legend-u4js6, WS-11; see docs/DECISIONS.md
// "HPP per baris pesanan saat penjualan"). Computes what
// `order_items.cost_snapshot_idr` stores at the moment a line is inserted: the
// theoretical cost of the WHOLE line (quantity x cost per portion), in whole
// rupiah, from `stock_balances.avg_cost_idr` at the location each draw is
// deducted from (legend-89zm: the recipe line's own location, else the outlet
// sale location).
//
// NULL means "unknown", never 0: no recipe, inactive or broken recipe, no sale
// location, quantity below 1, or any single ingredient without a balance or
// with a zero average cost (no partial values: a partial cost reads as a false
// margin). The cost is summed at full Decimal4 x Decimal4 scale and rounded
// half up ONCE per line (`scaledCostToIdr`). Reads run in a savepoint and an
// unexpected failure yields all NULL, so the order itself never fails.

import { and, eq, inArray } from "drizzle-orm";
import { parseDecimal4, type ScopedTenantContext } from "@starter/shared/core";
import { stockBalances } from "../db/schema/inventory.ts";
import { outletInventorySettings } from "../db/schema/recipe.ts";
import { logger } from "../lib/logger.ts";
import {
  outletLocationStates,
  scaledCostToIdr,
  type Tx,
} from "./inventory-ops.shared.ts";
import type { DeductionMenuLine } from "./recipe-deduction.service.ts";
import { explodeMenuLinesEach } from "./recipe-bom.service.ts";

/**
 * Line cost snapshots aligned with `lines`; `null` = unknown. One set of
 * queries per order, not per line.
 */
export async function computeLineCostSnapshots(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  lines: readonly DeductionMenuLine[],
): Promise<(number | null)[]> {
  const unknown = lines.map(() => null);
  if (lines.length === 0) return unknown;
  try {
    return await tx.transaction(async (savepoint) =>
      computeInSavepoint(savepoint, context, outletId, lines),
    );
  } catch (error) {
    logger.warn(
      {
        tenantId: context.tenant.tenantId,
        outletId,
        code: errorCodeOf(error),
      },
      "Order line cost snapshot could not be computed; stored as NULL",
    );
    return unknown;
  }
}

async function computeInSavepoint(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  lines: readonly DeductionMenuLine[],
): Promise<(number | null)[]> {
  const tenantId = context.tenant.tenantId;
  const result: (number | null)[] = lines.map(() => null);

  const [settings] = await tx
    .select({ saleLocationId: outletInventorySettings.saleLocationId })
    .from(outletInventorySettings)
    .where(
      and(
        eq(outletInventorySettings.tenantId, tenantId),
        eq(outletInventorySettings.outletId, outletId),
      ),
    );
  const saleLocationId = settings?.saleLocationId ?? null;

  // Only sellable lines are exploded; the rest stay NULL.
  const sellableIndexes = lines.flatMap((line, index) =>
    Number.isInteger(line.quantity) && line.quantity >= 1 ? [index] : [],
  );
  if (sellableIndexes.length === 0) return result;
  const outcomes = await explodeMenuLinesEach(
    tx,
    context,
    sellableIndexes.map((index) => lines[index]!),
  );

  // legend-89zm: a draw is costed at the location it is deducted from, i.e.
  // its recipe line's location when that is a location of this outlet, else the
  // sale location (same resolver as the deduction, including the fallback for a
  // line location of another outlet). A draw with no location makes its line
  // unknown (null), and so does an own but inactive recipe-line location: the
  // deduction refuses it (`recipe_error`), so no stock leaves and no HPP applies.
  // Same for an inactive sale location used as the fallback (`no_sale_location`).
  const draws = outcomes.flatMap((outcome) =>
    outcome.ok ? outcome.draws : [],
  );
  const ownLocations = await outletLocationStates(tx, tenantId, outletId, [
    ...draws.flatMap((draw) => draw.locationId ?? []),
    ...(saleLocationId === null ? [] : [saleLocationId]),
  ]);
  const usableSaleLocationId =
    saleLocationId !== null && ownLocations.get(saleLocationId) === true
      ? saleLocationId
      : null;
  const locationOf = (draw: { locationId: string | null }) => {
    if (draw.locationId === null) return usableSaleLocationId;
    const active = ownLocations.get(draw.locationId);
    if (active === undefined) return usableSaleLocationId;
    return active ? draw.locationId : null;
  };
  const locationIds = [
    ...new Set(draws.flatMap((draw) => locationOf(draw) ?? [])),
  ];
  const itemIds = [...new Set(draws.map((draw) => draw.itemId))];
  if (itemIds.length === 0 || locationIds.length === 0) return result;
  const balances = await tx
    .select({
      locationId: stockBalances.locationId,
      inventoryItemId: stockBalances.inventoryItemId,
      avgCostIdr: stockBalances.avgCostIdr,
    })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.tenantId, tenantId),
        eq(stockBalances.outletId, outletId),
        inArray(stockBalances.locationId, locationIds),
        inArray(stockBalances.inventoryItemId, itemIds),
      ),
    );
  const avgCost = new Map(
    balances.map((row) => [
      `${row.locationId}|${row.inventoryItemId}`,
      parseDecimal4(row.avgCostIdr),
    ]),
  );

  outcomes.forEach((outcome, position) => {
    if (!outcome.ok || outcome.draws.length === 0) return;
    let scaledCost = 0n;
    for (const draw of outcome.draws) {
      const locationId = locationOf(draw);
      if (locationId === null) return;
      const cost = avgCost.get(`${locationId}|${draw.itemId}`);
      if (cost === undefined || cost <= 0n) return;
      scaledCost += parseDecimal4(draw.quantity) * cost;
    }
    result[sellableIndexes[position]!] = scaledCostToIdr(scaledCost);
  });
  return result;
}

/** First string `code` on the error or its `cause` chain (drizzle wraps SQL errors). */
function findCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== "object" || error === null)
    return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return findCode(candidate.cause, depth + 1);
}

function errorCodeOf(error: unknown): string {
  const raw =
    findCode(error) ?? (error instanceof Error ? error.name : "UNKNOWN");
  return raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100) || "UNKNOWN";
}
