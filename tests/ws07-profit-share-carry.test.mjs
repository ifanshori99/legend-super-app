// Founder rule Q83, follow-up (bead legend-lzvh0): a correction shortfall that no
// shareholder's paid gross could absorb is deducted from that same shareholder's
// NEXT regular distribution, never charged to another shareholder.
//
// Pure shared-contract tests, no database and no web runtime. Run with Node type
// stripping: `node --test tests/ws07-profit-share-carry.test.mjs`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as accounting from "../packages/shared/src/accounting/index.ts";
import { idr } from "../packages/shared/src/core/money.ts";

const shId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = shId(1);
const B = shId(2);
const shortfall = (n) =>
  `00000000-0000-4000-8000-${String(n + 100).padStart(12, "0")}`;
const half = [
  { shareholderId: A, shareBp: 5_000 },
  { shareholderId: B, shareBp: 5_000 },
];

const base = {
  profitEntityId: "00000000-0000-4000-8000-0000000000e1",
  fiscalPeriodId: "00000000-0000-4000-8000-0000000000e2",
  period: "2026-10",
  periodStatus: "closed",
};
const policy = (taxWithholdingBp) => ({
  basis: "closed_period_net_profit",
  reserveBp: 0,
  frequency: "monthly",
  taxWithholdingBp,
});
const distribute = ({ netIdr = 1_000, taxBp = 0, carry, allocations = half }) =>
  accounting.calculateDistribution({
    ...base,
    periodNetProfitIdr: idr(netIdr),
    policy: policy(taxBp),
    allocations,
    ...(carry ? { carry } : {}),
  });
const lineOf = (calc, shareholderId) =>
  calc.lines.find((line) => line.shareholderId === shareholderId);

describe("carry deduction in a regular distribution", () => {
  test("without carry nothing is deducted", () => {
    const calc = distribute({});
    assert.equal(calc.carryDeductedIdr, 0);
    assert.deepEqual(calc.carryDeductions, []);
    assert.deepEqual(
      calc.lines.map((line) => line.carryDeductedIdr),
      [0, 0],
    );
    assert.equal(calc.distributableIdr, 1_000);
    assert.equal(calc.totalGrossIdr, 1_000);
  });

  test("a partial absorb reduces only that shareholder's gross", () => {
    const calc = distribute({
      carry: new Map([[A, [{ shortfallId: shortfall(1), amountIdr: 200 }]]]),
    });
    // Share before carry is 500 each. A gives up 200, B is untouched.
    assert.equal(lineOf(calc, A).grossIdr, 300);
    assert.equal(lineOf(calc, A).carryDeductedIdr, 200);
    assert.equal(lineOf(calc, B).grossIdr, 500);
    assert.equal(lineOf(calc, B).carryDeductedIdr, 0);
    assert.equal(calc.carryDeductedIdr, 200);
    assert.deepEqual(calc.carryDeductions, [
      { shareholderId: A, shortfallId: shortfall(1), amountIdr: 200 },
    ]);
    // distributable stays net profit - reserve; gross + carry = distributable.
    assert.equal(calc.distributableIdr, 1_000);
    assert.equal(calc.totalGrossIdr, 800);
    assert.equal(
      calc.totalGrossIdr + calc.carryDeductedIdr,
      calc.distributableIdr,
    );
  });

  test("a full absorb leaves no zero line but still records the deduction", () => {
    const calc = distribute({
      // 700 owed, share is 500: all 500 is taken and 200 stays open.
      carry: new Map([[A, [{ shortfallId: shortfall(1), amountIdr: 700 }]]]),
    });
    assert.equal(lineOf(calc, A), undefined);
    assert.deepEqual(
      calc.lines.map((line) => line.shareholderId),
      [B],
    );
    assert.deepEqual(calc.carryDeductions, [
      { shareholderId: A, shortfallId: shortfall(1), amountIdr: 500 },
    ]);
    assert.equal(calc.carryDeductedIdr, 500);
    assert.equal(calc.totalGrossIdr, 500);
    assert.equal(calc.distributableIdr, 1_000);
  });

  test("shortfalls are taken FIFO across two shortfalls of one shareholder", () => {
    const calc = distribute({
      carry: new Map([
        [
          A,
          [
            { shortfallId: shortfall(1), amountIdr: 300 },
            { shortfallId: shortfall(2), amountIdr: 400 },
          ],
        ],
      ]),
    });
    // Share 500: the oldest is cleared (300), the next gives the last 200.
    assert.deepEqual(calc.carryDeductions, [
      { shareholderId: A, shortfallId: shortfall(1), amountIdr: 300 },
      { shareholderId: A, shortfallId: shortfall(2), amountIdr: 200 },
    ]);
    assert.equal(calc.carryDeductedIdr, 500);
    assert.equal(lineOf(calc, A), undefined);
  });

  test("an older shortfall that fits leaves the newer one untouched", () => {
    const calc = distribute({
      carry: new Map([
        [
          A,
          [
            { shortfallId: shortfall(1), amountIdr: 100 },
            { shortfallId: shortfall(2), amountIdr: 100 },
          ],
        ],
      ]),
    });
    assert.deepEqual(
      calc.carryDeductions.map((row) => [row.shortfallId, row.amountIdr]),
      [
        [shortfall(1), 100],
        [shortfall(2), 100],
      ],
    );
    assert.equal(lineOf(calc, A).grossIdr, 300);
  });

  test("tax is computed on the gross after the deduction", () => {
    const calc = distribute({
      taxBp: 1_000,
      carry: new Map([[A, [{ shortfallId: shortfall(1), amountIdr: 200 }]]]),
    });
    // A: share 500 - carry 200 = gross 300, tax 10% = 30, net 270 (not 50 / 450).
    assert.deepEqual(
      [
        lineOf(calc, A).grossIdr,
        lineOf(calc, A).taxWithheldIdr,
        lineOf(calc, A).netIdr,
      ],
      [300, 30, 270],
    );
    assert.deepEqual(
      [
        lineOf(calc, B).grossIdr,
        lineOf(calc, B).taxWithheldIdr,
        lineOf(calc, B).netIdr,
      ],
      [500, 50, 450],
    );
    assert.equal(calc.totalGrossIdr, 800);
    assert.equal(calc.totalTaxWithheldIdr, 80);
    assert.equal(calc.totalNetIdr, 720);
  });

  test("every shareholder absorbed means NOTHING_TO_DISTRIBUTE", () => {
    assert.throws(
      () =>
        distribute({
          carry: new Map([
            [A, [{ shortfallId: shortfall(1), amountIdr: 500 }]],
            [B, [{ shortfallId: shortfall(2), amountIdr: 900 }]],
          ]),
        }),
      (error) =>
        error.code === "NOTHING_TO_DISTRIBUTE" &&
        /kekurangan koreksi/i.test(error.message),
    );
  });

  test("carry of a shareholder who is not in the split is ignored", () => {
    const calc = distribute({
      carry: new Map([
        [shId(9), [{ shortfallId: shortfall(1), amountIdr: 50 }]],
      ]),
    });
    assert.equal(calc.carryDeductedIdr, 0);
    assert.deepEqual(calc.carryDeductions, []);
  });

  test("the calculation schema ties distributable to gross plus carry", () => {
    const calc = distribute({
      carry: new Map([[A, [{ shortfallId: shortfall(1), amountIdr: 200 }]]]),
    });
    const { carryDeductions: _omit, ...plain } = calc;
    assert.doesNotThrow(() =>
      accounting.distributionCalculationSchema.parse(plain),
    );
    assert.throws(() =>
      accounting.distributionCalculationSchema.parse({
        ...plain,
        carryDeductedIdr: 0,
      }),
    );
  });
});

describe("adjustment: unabsorbed is reported per shareholder", () => {
  const adjust = (adjustmentIdr, held) =>
    accounting.calculateAdjustmentDistribution({
      ...base,
      adjustsRunId: "00000000-0000-4000-8000-0000000000e3",
      reason: "Koreksi",
      adjustmentIdr: idr(adjustmentIdr),
      taxWithholdingBp: 1_000,
      allocations: half,
      held,
    });

  test("unabsorbedByShareholder sums to unabsorbedIdr and names who is short", () => {
    const calc = adjust(
      -1_000,
      new Map([
        [A, { grossIdr: 100, taxWithheldIdr: 10 }],
        [B, { grossIdr: 900, taxWithheldIdr: 90 }],
      ]),
    );
    assert.equal(calc.unabsorbedIdr, 400);
    assert.deepEqual([...calc.unabsorbedByShareholder], [[A, 400]]);
    assert.equal(
      [...calc.unabsorbedByShareholder.values()].reduce((sum, v) => sum + v, 0),
      calc.unabsorbedIdr,
    );
  });

  test("two short shareholders each carry their own part", () => {
    const calc = adjust(
      -1_000,
      new Map([
        [A, { grossIdr: 100, taxWithheldIdr: 10 }],
        [B, { grossIdr: 350, taxWithheldIdr: 35 }],
      ]),
    );
    // Each part is -500: A is short 400, B is short 150.
    assert.equal(calc.unabsorbedByShareholder.get(A), 400);
    assert.equal(calc.unabsorbedByShareholder.get(B), 150);
    assert.equal(calc.unabsorbedIdr, 550);
  });

  test("nothing short gives an empty map", () => {
    const calc = adjust(
      -200,
      new Map([
        [A, { grossIdr: 500, taxWithheldIdr: 50 }],
        [B, { grossIdr: 500, taxWithheldIdr: 50 }],
      ]),
    );
    assert.equal(calc.unabsorbedIdr, 0);
    assert.equal(calc.unabsorbedByShareholder.size, 0);
  });

  test("a positive adjustment has no unabsorbed rest", () => {
    const calc = adjust(300);
    assert.equal(calc.unabsorbedByShareholder.size, 0);
  });
});
