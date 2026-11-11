// Pure math of the HPP reports (bead legend-2qq, PRD v1.7 §17): the actual vs
// theoretical food cost identity and the Kasavana-Smith menu-engineering
// matrix. Whole rupiah in, whole rupiah out; integer (bigint) arithmetic only,
// so no money value ever passes through a float. Nothing here touches the
// database.

import { divideRounded } from "@starter/shared/core";
import type { MenuEngineeringClass } from "@starter/shared/inventory";

// Same mode as `ROUNDING_MODE` in inventory-ops.shared.ts, repeated so this
// pure module (and its unit test) never loads the database layer.
const ROUNDING_MODE = "half_up" as const;

export type FoodCostParts = {
  /** SUM of the order line cost snapshots of the period (whole rupiah). */
  theoreticalIdr: number;
  /** Waste logged in the period; a loss, so >= 0. */
  wasteIdr: number;
  /** Count corrections and the unexplained sale-ledger residual (signed loss). */
  adjustmentIdr: number;
  /** Duty meals: stock used outside any recipe; a loss, so >= 0. */
  offRecipeUsageIdr: number;
};

export type FoodCostComposition = {
  actualCostIdr: number;
  varianceIdr: number;
  varianceBp: number;
};

/**
 * Actual cost = theoretical + waste + adjustment + off-recipe usage, never
 * below zero (a surplus larger than the whole theoretical cost would otherwise
 * read as a negative cost). When clamped, the variance becomes
 * `actual - theoretical` so `theoretical + variance = actual` still holds.
 * `varianceBp` is variance / theoretical, half up; 0 when theoretical is 0
 * (there is nothing to divide by, and 0 is not a claim of a margin).
 */
export function composeFoodCost(parts: FoodCostParts): FoodCostComposition {
  const theoretical = BigInt(parts.theoreticalIdr);
  const rawVariance =
    BigInt(parts.wasteIdr) +
    BigInt(parts.adjustmentIdr) +
    BigInt(parts.offRecipeUsageIdr);
  let actual = theoretical + rawVariance;
  let variance = rawVariance;
  if (actual < 0n) {
    actual = 0n;
    variance = actual - theoretical;
  }
  const varianceBp =
    theoretical === 0n
      ? 0n
      : divideRounded(variance * 10_000n, theoretical, ROUNDING_MODE);
  return {
    actualCostIdr: Number(actual),
    varianceIdr: Number(variance),
    varianceBp: Number(varianceBp),
  };
}

export type MenuEngineeringInput = {
  menuItemId: string;
  /** Portions sold in the period (> 0 for an item that sold). */
  unitsSold: number;
  /** SUM(line total - cost snapshot) of the item, whole rupiah. */
  grossMarginIdr: number;
};

/**
 * Kasavana-Smith matrix. Popularity cutoff is 70% x (1 / item count) of the
 * total units; margin cutoff is the weighted average margin per unit (total
 * gross margin / total units). A value equal to its cutoff counts as high.
 * Both comparisons are cross-multiplied, so they stay exact integers:
 *   popular  <=> units x count x 10 >= 7 x totalUnits
 *   profitable <=> margin x totalUnits >= totalMargin x units
 */
export function classifyMenuEngineering<T extends MenuEngineeringInput>(
  rows: readonly T[],
): (T & { classification: MenuEngineeringClass })[] {
  const count = BigInt(rows.length);
  const totalUnits = rows.reduce((sum, row) => sum + BigInt(row.unitsSold), 0n);
  const totalMargin = rows.reduce(
    (sum, row) => sum + BigInt(row.grossMarginIdr),
    0n,
  );
  return rows.map((row) => {
    if (totalUnits === 0n) return { ...row, classification: "dog" as const };
    const units = BigInt(row.unitsSold);
    const popular = units * count * 10n >= 7n * totalUnits;
    const profitable =
      BigInt(row.grossMarginIdr) * totalUnits >= totalMargin * units;
    const classification: MenuEngineeringClass = popular
      ? profitable
        ? "star"
        : "plowhorse"
      : profitable
        ? "puzzle"
        : "dog";
    return { ...row, classification };
  });
}
