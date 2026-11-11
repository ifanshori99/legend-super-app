// Pure HPP math tests (bead legend-2qq; PRD v1.7 §17 "Menu Engineering" and
// "Food cost aktual vs teoritis"). No database.
//
// Assumptions (the design brief fixes names, not shapes):
// - Module: `apps/api/src/services/hpp-math.ts`.
// - `classifyMenuEngineering(rows)` takes `{ menuItemId, unitsSold,
//   grossMarginIdr }[]` and returns one object per input row that carries
//   `menuItemId` and `classification` (order is not asserted; rows are found
//   by `menuItemId`). `grossMarginIdr` is the item's TOTAL margin in whole
//   rupiah (units x margin per unit), as in `menuEngineeringRowSchema`.
// - Kasavana-Smith: popularity cutoff = 70% x (1 / itemCount) of total units;
//   margin cutoff = total gross margin / total units. At the cutoff an item
//   counts as HIGH (ties go to the high side). Compared in exact integer
//   math, so a cutoff that is not a whole number still ties exactly.
// - `composeFoodCost` takes whole-rupiah numbers; varianceBp is
//   round_half_up(variance x 10000 / theoretical), 0 when theoretical is 0.
//   Actual cost never goes below 0; when that clamp bites, varianceIdr is
//   actual - theoretical so that actual = theoretical + variance still holds.
import { describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import {
  classifyMenuEngineering,
  composeFoodCost,
} from "../services/hpp-math.ts";

type Input = { menuItemId: string; unitsSold: number; grossMarginIdr: number };

function classes(rows: Input[]): Record<string, string> {
  const result = classifyMenuEngineering(rows) as unknown as {
    menuItemId: string;
    classification: string;
  }[];
  expect(result).toHaveLength(rows.length);
  return Object.fromEntries(
    result.map((row) => [row.menuItemId, row.classification]),
  );
}

const row = (
  menuItemId: string,
  unitsSold: number,
  grossMarginIdr: number,
): Input => ({ menuItemId, unitsSold, grossMarginIdr });

describe("HPP-MATH classifyMenuEngineering", () => {
  it("HPP-MATH-class puts each item in star, plowhorse, puzzle or dog", () => {
    // Total 90 units, 4 items: popularity cutoff 0.7 x 90 / 4 = 15.75 units.
    // Total margin 785.000 / 90 units = Rp8.722,2 per unit.
    const result = classes([
      row("star", 40, 600_000), // 15.000 per unit: high / high
      row("plowhorse", 40, 80_000), // 2.000 per unit: high / low
      row("puzzle", 5, 100_000), // 20.000 per unit: low / high
      row("dog", 5, 5_000), // 1.000 per unit: low / low
    ]);
    expect(result).toEqual({
      star: "star",
      plowhorse: "plowhorse",
      puzzle: "puzzle",
      dog: "dog",
    });
  });

  it("HPP-MATH-class an item exactly on both cutoffs is a star (ties go high)", () => {
    // 20 units over 2 items: cutoff 0.7 x 20 / 2 = 7 units. Both items earn
    // Rp1.000 per unit, so the margin cutoff (20.000 / 20 = 1.000) is a tie too.
    const result = classes([row("a", 7, 7_000), row("b", 13, 13_000)]);
    expect(result).toEqual({ a: "star", b: "star" });
  });

  it("HPP-MATH-class compares a margin cutoff that is not a whole rupiah exactly", () => {
    // 6 units, cutoff Rp333,33 per unit. Both items earn exactly that
    // (1.000 / 3), so neither may fall to the low side by rounding.
    const result = classes([row("a", 3, 1_000), row("b", 3, 1_000)]);
    expect(result).toEqual({ a: "star", b: "star" });
  });

  it("HPP-MATH-class one unit below the popularity cutoff is low popularity", () => {
    // 3 items, 30 units: cutoff 0.7 x 30 / 3 = 7 units. 6 units is below.
    // Unit margins: all Rp1.000, so every item is high margin.
    const result = classes([
      row("below", 6, 6_000),
      row("onCutoff", 7, 7_000),
      row("above", 17, 17_000),
    ]);
    expect(result).toEqual({
      below: "puzzle",
      onCutoff: "star",
      above: "star",
    });
  });

  it("HPP-MATH-class an item with a negative margin is low margin", () => {
    // 2 items, 20 units: cutoff 7 units. Total margin 4.000 -> 200 per unit.
    const result = classes([row("loss", 10, -6_000), row("gain", 10, 10_000)]);
    expect(result).toEqual({ loss: "plowhorse", gain: "star" });
  });

  it("HPP-MATH-class a single item is a star", () => {
    expect(classes([row("only", 12, 24_000)])).toEqual({ only: "star" });
  });

  it("HPP-MATH-class no items give no rows", () => {
    expect(classifyMenuEngineering([])).toEqual([]);
  });
});

describe("HPP-MATH composeFoodCost", () => {
  const compose = (input: {
    theoreticalIdr: number;
    wasteIdr: number;
    adjustmentIdr: number;
    offRecipeUsageIdr: number;
  }) =>
    composeFoodCost({
      theoreticalIdr: idr(input.theoreticalIdr),
      wasteIdr: idr(input.wasteIdr),
      adjustmentIdr: idr(input.adjustmentIdr),
      offRecipeUsageIdr: idr(input.offRecipeUsageIdr),
    });

  it("HPP-MATH-food variance is the exact sum of waste, adjustment and off-recipe usage", () => {
    const result = compose({
      theoreticalIdr: 17_400,
      wasteIdr: 1_250,
      adjustmentIdr: 300,
      offRecipeUsageIdr: 2_000,
    });
    expect(result.varianceIdr).toBe(1_250 + 300 + 2_000);
    expect(result.actualCostIdr).toBe(17_400 + 3_550);
    // 3.550 x 10.000 / 17.400 = 2.040,23 basis points.
    expect(result.varianceBp).toBe(2_040);
  });

  it("HPP-MATH-food a surplus (negative adjustment) lowers the variance", () => {
    const result = compose({
      theoreticalIdr: 10_000,
      wasteIdr: 0,
      adjustmentIdr: -500,
      offRecipeUsageIdr: 0,
    });
    expect(result).toMatchObject({
      varianceIdr: -500,
      actualCostIdr: 9_500,
      varianceBp: -500,
    });
  });

  it("HPP-MATH-food no variance parts leave actual equal to theoretical", () => {
    expect(
      compose({
        theoreticalIdr: 8_000,
        wasteIdr: 0,
        adjustmentIdr: 0,
        offRecipeUsageIdr: 0,
      }),
    ).toMatchObject({ varianceIdr: 0, actualCostIdr: 8_000, varianceBp: 0 });
  });

  it("HPP-MATH-food actual cost never goes below zero; the variance is clamped to match", () => {
    const result = compose({
      theoreticalIdr: 1_000,
      wasteIdr: 0,
      adjustmentIdr: -10_000,
      offRecipeUsageIdr: 0,
    });
    expect(result.actualCostIdr).toBe(0);
    expect(result.varianceIdr).toBe(-1_000);
    expect(result.actualCostIdr).toBe(1_000 + result.varianceIdr);
    expect(result.varianceBp).toBe(-10_000);
  });

  it("HPP-MATH-food zero theoretical cost gives 0 basis points, not a division error", () => {
    expect(
      compose({
        theoreticalIdr: 0,
        wasteIdr: 500,
        adjustmentIdr: 0,
        offRecipeUsageIdr: 0,
      }),
    ).toMatchObject({ varianceIdr: 500, actualCostIdr: 500, varianceBp: 0 });
    expect(
      compose({
        theoreticalIdr: 0,
        wasteIdr: 0,
        adjustmentIdr: -300,
        offRecipeUsageIdr: 0,
      }),
    ).toMatchObject({ varianceIdr: 0, actualCostIdr: 0, varianceBp: 0 });
  });

  it("HPP-MATH-food varianceBp rounds half up once", () => {
    const bp = (variance: number, theoretical: number) =>
      compose({
        theoreticalIdr: theoretical,
        wasteIdr: variance,
        adjustmentIdr: 0,
        offRecipeUsageIdr: 0,
      }).varianceBp;
    expect(bp(1, 3)).toBe(3_333); // 3333,33
    expect(bp(2, 3)).toBe(6_667); // 6666,67
    expect(bp(1, 20_000)).toBe(1); // exactly 0,5 rounds up
  });
});

// Finding 7 (design hpp-fix-design.md): composeFoodCost must keep BOTH
// invariants at once: actual >= 0 AND variance = waste + adjustment +
// off-recipe. When theoretical + waste + adjustment + off-recipe would drop
// below zero, the surplus (negative adjustment) is capped so that actual = 0
// and variance = -theoretical, and the capped adjustment is returned as
// `adjustmentIdr` so the report can show the identity exactly.
describe("HPP-MATH composeFoodCost surplus cap (finding 7)", () => {
  const composeFull = (input: {
    theoreticalIdr: number;
    wasteIdr: number;
    adjustmentIdr: number;
    offRecipeUsageIdr: number;
  }) =>
    composeFood(input) as unknown as {
      actualCostIdr: number;
      varianceIdr: number;
      varianceBp: number;
      adjustmentIdr: number;
    };

  function composeFood(input: {
    theoreticalIdr: number;
    wasteIdr: number;
    adjustmentIdr: number;
    offRecipeUsageIdr: number;
  }) {
    return composeFoodCost({
      theoreticalIdr: idr(input.theoreticalIdr),
      wasteIdr: idr(input.wasteIdr),
      adjustmentIdr: idr(input.adjustmentIdr),
      offRecipeUsageIdr: idr(input.offRecipeUsageIdr),
    });
  }

  it("HPP-MATH-food-cap a large surplus keeps actual >= 0 and variance = waste + adjustment + off-recipe", () => {
    const result = composeFull({
      theoreticalIdr: 1_000,
      wasteIdr: 200,
      adjustmentIdr: -10_000,
      offRecipeUsageIdr: 300,
    });
    // Capped: -(1.000 + 200 + 300) = -1.500, so actual lands exactly on 0.
    expect(result.adjustmentIdr).toBe(-1_500);
    expect(result.actualCostIdr).toBe(0);
    expect(result.varianceIdr).toBe(-1_000);
    expect(result.varianceIdr).toBe(200 + result.adjustmentIdr + 300);
    expect(result.actualCostIdr).toBe(1_000 + result.varianceIdr);
    expect(result.varianceBp).toBe(-10_000);
  });

  it("HPP-MATH-food-cap a surplus with no waste or off-recipe is capped at minus the theoretical cost", () => {
    const result = composeFull({
      theoreticalIdr: 1_000,
      wasteIdr: 0,
      adjustmentIdr: -10_000,
      offRecipeUsageIdr: 0,
    });
    expect(result.adjustmentIdr).toBe(-1_000);
    expect(result.actualCostIdr).toBe(0);
    expect(result.varianceIdr).toBe(-1_000);
  });

  it("HPP-MATH-food-cap a surplus that lands exactly on zero is not capped", () => {
    const result = composeFull({
      theoreticalIdr: 1_000,
      wasteIdr: 0,
      adjustmentIdr: -1_000,
      offRecipeUsageIdr: 0,
    });
    expect(result.adjustmentIdr).toBe(-1_000);
    expect(result.actualCostIdr).toBe(0);
    expect(result.varianceIdr).toBe(-1_000);
  });

  it("HPP-MATH-food-cap a surplus that keeps actual positive is returned unchanged", () => {
    const result = composeFull({
      theoreticalIdr: 10_000,
      wasteIdr: 0,
      adjustmentIdr: -500,
      offRecipeUsageIdr: 0,
    });
    expect(result.adjustmentIdr).toBe(-500);
    expect(result.actualCostIdr).toBe(9_500);
    expect(result.varianceIdr).toBe(-500);
  });

  it("HPP-MATH-food-cap a positive adjustment is returned unchanged", () => {
    const result = composeFull({
      theoreticalIdr: 17_400,
      wasteIdr: 1_250,
      adjustmentIdr: 300,
      offRecipeUsageIdr: 2_000,
    });
    expect(result.adjustmentIdr).toBe(300);
    expect(result.varianceIdr).toBe(1_250 + 300 + 2_000);
  });

  it("HPP-MATH-food-cap with zero theoretical cost a lone surplus is capped to 0 and the identity holds", () => {
    const result = composeFull({
      theoreticalIdr: 0,
      wasteIdr: 0,
      adjustmentIdr: -300,
      offRecipeUsageIdr: 0,
    });
    expect(result.adjustmentIdr).toBe(0);
    expect(result.actualCostIdr).toBe(0);
    expect(result.varianceIdr).toBe(0);
    expect(result.varianceBp).toBe(0);
  });

  it("HPP-MATH-food-cap the variance identity holds for every combination in a small grid", () => {
    for (const theoreticalIdr of [0, 1_000, 5_000])
      for (const wasteIdr of [0, 400])
        for (const adjustmentIdr of [-20_000, -3_000, -1, 0, 700])
          for (const offRecipeUsageIdr of [0, 250]) {
            const result = composeFull({
              theoreticalIdr,
              wasteIdr,
              adjustmentIdr,
              offRecipeUsageIdr,
            });
            const label = JSON.stringify({
              theoreticalIdr,
              wasteIdr,
              adjustmentIdr,
              offRecipeUsageIdr,
            });
            expect(result.actualCostIdr, label).toBeGreaterThanOrEqual(0);
            expect(result.varianceIdr, label).toBe(
              wasteIdr + result.adjustmentIdr + offRecipeUsageIdr,
            );
            expect(result.actualCostIdr, label).toBe(
              theoreticalIdr + result.varianceIdr,
            );
            // A cap only ever shrinks a surplus, never turns it into a loss.
            expect(result.adjustmentIdr, label).toBeGreaterThanOrEqual(
              Math.min(adjustmentIdr, 0),
            );
            expect(result.adjustmentIdr, label).toBeLessThanOrEqual(
              Math.max(adjustmentIdr, 0),
            );
          }
  });
});
