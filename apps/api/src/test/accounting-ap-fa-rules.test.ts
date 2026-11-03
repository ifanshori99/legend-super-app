// Pure rules of bead legend-hpgo (no database): depreciation catch-up and
// rounding, the revaluation journal amounts, and the idempotency fingerprint
// (PRD v1.7 §3.19 Aset Tetap; ACC-01 balanced journals).

import { describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import { commandFingerprint } from "../services/accounting-ap-fa-shared";
import {
  pendingDepreciation,
  revaluationPlan,
} from "../services/accounting-fixed-assets.service";

const basis = {
  costIdr: idr(10_000_001),
  residualValueIdr: idr(1),
  usefulLifeMonths: 3,
  depreciationStartPeriod: "2026-11",
};

describe("legend-hpgo depreciation and revaluation rules (§3.19 Aset Tetap)", () => {
  it("§3.19 straight-line rounding: months are whole rupiah and sum to cost − residual; catch-up crosses the year", () => {
    const pending = pendingDepreciation(basis, new Set(), "2027-01");
    expect(pending).toEqual([
      { period: "2026-11", amountIdr: 3_333_334 },
      { period: "2026-12", amountIdr: 3_333_333 },
      { period: "2027-01", amountIdr: 3_333_333 },
    ]);
    expect(pending.reduce((sum, row) => sum + row.amountIdr, 0)).toBe(
      10_000_000,
    );
  });

  it("§3.19 idempotent per asset+period: posted months and months after the run period are never pending", () => {
    expect(
      pendingDepreciation(basis, new Set(["2026-11"]), "2026-12").map(
        (row) => row.period,
      ),
    ).toEqual(["2026-12"]);
    expect(pendingDepreciation(basis, new Set(), "2026-10")).toEqual([]);
    // A base smaller than the life leaves zero months, which post nothing.
    expect(
      pendingDepreciation(
        {
          costIdr: idr(3),
          residualValueIdr: idr(1),
          usefulLifeMonths: 3,
          depreciationStartPeriod: "2026-01",
        },
        new Set(),
        "2026-12",
      ).map((row) => row.amountIdr),
    ).toEqual([1, 1]);
  });

  it("ACC-01 §3.19 revaluation amounts balance: accumulated + (new − cost) + loss = surplus", () => {
    const asset = {
      costIdr: idr(12_000_000),
      residualValueIdr: idr(0),
      usefulLifeMonths: 12,
      depreciationStartPeriod: "2026-01",
      accumulatedDepreciationIdr: idr(2_000_000),
    };
    const up = revaluationPlan(asset, "2026-02-25", 13_000_000);
    expect(up).toEqual({
      amounts: {
        accumulatedIdr: 2_000_000,
        costChangeIdr: 1_000_000,
        surplusIdr: 3_000_000,
        lossIdr: 0,
      },
      newStartPeriod: "2026-03",
      remainingMonths: 10,
    });
    const down = revaluationPlan(asset, "2026-02-25", 7_000_000);
    expect(down.amounts).toEqual({
      accumulatedIdr: 2_000_000,
      costChangeIdr: -5_000_000,
      surplusIdr: 0,
      lossIdr: 3_000_000,
    });
    for (const { amounts } of [up, down])
      expect(
        amounts.accumulatedIdr + amounts.costChangeIdr + amounts.lossIdr,
      ).toBe(amounts.surplusIdr);
  });

  it("§3.19 revaluation refuses a no-op, a value at or below residual, and an asset with no life left", () => {
    const fresh = {
      costIdr: idr(1_000_000),
      residualValueIdr: idr(100_000),
      usefulLifeMonths: 2,
      depreciationStartPeriod: "2026-01",
      accumulatedDepreciationIdr: idr(0),
    };
    expect(() => revaluationPlan(fresh, "2025-12-20", 1_000_000)).toThrow(
      /equals the current one/,
    );
    expect(() => revaluationPlan(fresh, "2025-12-20", 100_000)).toThrow(
      /residual value/,
    );
    expect(() => revaluationPlan(fresh, "2026-02-20", 2_000_000)).toThrow(
      /no remaining useful life/,
    );
  });

  it("idempotency fingerprint ignores key order but not values or operation", () => {
    const a = commandFingerprint("t", "op", { b: 1, a: { y: 2, x: 1 } });
    const b = commandFingerprint("t", "op", { a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(commandFingerprint("t", "op", { b: 2, a: { x: 1, y: 2 } })).not.toBe(
      a,
    );
    expect(
      commandFingerprint("t", "other", { b: 1, a: { x: 1, y: 2 } }),
    ).not.toBe(a);
    expect(
      commandFingerprint("t2", "op", { b: 1, a: { x: 1, y: 2 } }),
    ).not.toBe(a);
  });
});
