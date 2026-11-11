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
  /** The adjustment actually used; below `parts.adjustmentIdr` when capped. */
  adjustmentIdr: number;
  varianceIdr: number;
  varianceBp: number;
};

/**
 * Actual cost = theoretical + waste + adjustment + off-recipe usage, never
 * below zero, and variance = waste + adjustment + off-recipe always holds. A
 * surplus (negative adjustment) larger than theoretical + waste + off-recipe
 * would read as a negative cost, so the surplus is capped:
 * `adjustment = -(theoretical + waste + offRecipe)`, which gives actual 0 and
 * variance = -theoretical. The returned `adjustmentIdr` is that effective
 * value and the report must show it, not the raw one. Waste and off-recipe
 * are losses (>= 0), so only the adjustment can be capped.
 * `varianceBp` is variance / theoretical, half up; 0 when theoretical is 0
 * (there is nothing to divide by, and 0 is not a claim of a margin).
 */
export function composeFoodCost(parts: FoodCostParts): FoodCostComposition {
  const theoretical = BigInt(parts.theoreticalIdr);
  const waste = BigInt(parts.wasteIdr);
  const offRecipe = BigInt(parts.offRecipeUsageIdr);
  let adjustment = BigInt(parts.adjustmentIdr);
  const floor = -(theoretical + waste + offRecipe);
  if (adjustment < floor) adjustment = floor;
  const variance = waste + adjustment + offRecipe;
  const actual = theoretical + variance;
  const varianceBp =
    theoretical === 0n
      ? 0n
      : divideRounded(variance * 10_000n, theoretical, ROUNDING_MODE);
  return {
    actualCostIdr: Number(actual),
    adjustmentIdr: Number(adjustment),
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
