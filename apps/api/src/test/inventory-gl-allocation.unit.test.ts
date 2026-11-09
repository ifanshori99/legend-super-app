// IT-68 (tier K, money): unit test of the pure whole-rupiah allocation used by
// the waste posting. A waste log rounds once over the whole log
// (waste_logs.value_idr); that total is split over the outlet business dates
// of its ledger rows by largest remainder.
//
// Assumptions (the brief only fixes the name and a signature sketch):
// - `allocateRoundedIdr(scaledParts, scale)` takes non-negative parts at
//   `scale` (COST_PRODUCT_SCALE = 10^8, i.e. Decimal4 x Decimal4) in date
//   order, oldest first, and returns whole rupiah per part, same order.
// - The total is Σ parts / scale rounded half up (what scaledCostToIdr does).
// - A tie in the fractional remainder goes to the oldest (lowest index) part.

import { describe, expect, it } from "vitest";
import { allocateRoundedIdr } from "../services/inventory-gl-consumer.ts";
import { COST_PRODUCT_SCALE } from "../services/inventory-ops.shared.ts";

/** 10^8: one rupiah at the product scale of two Decimal4 factors. */
const SCALE = COST_PRODUCT_SCALE;
/** Rupiah with a fraction, e.g. idr(0.4) -> 0.4 x SCALE (exact, 4 decimals). */
const idr = (value: string): bigint => {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0").slice(0, 8));
};
const total = (values: number[]) => values.reduce((a, b) => a + b, 0);
const roundedTotal = (parts: bigint[]) =>
  Number((parts.reduce((a, b) => a + b, 0n) + SCALE / 2n) / SCALE);

describe("IT-68 allocateRoundedIdr", () => {
  it("INV-GL-ALLOC-01 two parts of Rp0,4 allocate the one rupiah of the total to exactly one part, the oldest", () => {
    // Both parts alone round to 0; together 0,8 rounds to 1.
    expect(allocateRoundedIdr([idr("0.4"), idr("0.4")], SCALE)).toEqual([1, 0]);
  });

  it("INV-GL-ALLOC-02 the sum always equals the total rounded once", () => {
    const cases = [
      ["0.4", "0.4"],
      ["0.3", "0.3", "0.3"],
      ["1.4", "2.4", "3.4"],
      ["0.6", "0.6", "0.6", "0.6", "0.6"],
      ["10.5", "20.5", "30.5"],
      ["0.0001", "0.0002"],
      ["999.9999", "0.0001", "0.5"],
    ].map((row) => row.map(idr));
    for (const parts of cases) {
      const result = allocateRoundedIdr(parts, SCALE);
      expect(total(result), `parts ${parts.join(",")}`).toBe(
        roundedTotal(parts),
      );
      expect(result).toHaveLength(parts.length);
      for (const share of result) {
        expect(Number.isInteger(share)).toBe(true);
        expect(share).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("INV-GL-ALLOC-03 equal remainders go to the oldest part first", () => {
    // Four quarters: total 1, all remainders equal -> the first part.
    expect(
      allocateRoundedIdr(
        [idr("0.25"), idr("0.25"), idr("0.25"), idr("0.25")],
        SCALE,
      ),
    ).toEqual([1, 0, 0, 0]);
    // Three halves: total 1,5 rounds half up to 2 -> the two oldest parts.
    expect(
      allocateRoundedIdr([idr("0.5"), idr("0.5"), idr("0.5")], SCALE),
    ).toEqual([1, 1, 0]);
  });

  it("INV-GL-ALLOC-04 the larger fractional remainder wins over age", () => {
    // 0,3 + 0,7 = 1,0: the extra rupiah belongs to the 0,7 part, not the older.
    expect(allocateRoundedIdr([idr("0.3"), idr("0.7")], SCALE)).toEqual([0, 1]);
    // Floors 1 + 2 = 3, total 3,9 -> 4; the 0,9 remainder (2,9) takes it.
    expect(allocateRoundedIdr([idr("1.0"), idr("2.9")], SCALE)).toEqual([1, 3]);
  });

  it("INV-GL-ALLOC-05 parts that are whole rupiah come back unchanged", () => {
    expect(allocateRoundedIdr([3n * SCALE, 5n * SCALE, 0n], SCALE)).toEqual([
      3, 5, 0,
    ]);
    expect(allocateRoundedIdr([1500n * SCALE], SCALE)).toEqual([1500]);
  });

  it("INV-GL-ALLOC-06 no parts allocate nothing; a single fractional part is the total rounded", () => {
    expect(allocateRoundedIdr([], SCALE)).toEqual([]);
    expect(allocateRoundedIdr([idr("0.4")], SCALE)).toEqual([0]);
    expect(allocateRoundedIdr([idr("0.5")], SCALE)).toEqual([1]);
    expect(allocateRoundedIdr([idr("1000.5")], SCALE)).toEqual([1001]);
  });

  it("INV-GL-ALLOC-07 is deterministic: the same parts give the same allocation", () => {
    const parts = [idr("0.4"), idr("0.4"), idr("0.4"), idr("0.4")];
    expect(allocateRoundedIdr(parts, SCALE)).toEqual(
      allocateRoundedIdr([...parts], SCALE),
    );
  });
});
