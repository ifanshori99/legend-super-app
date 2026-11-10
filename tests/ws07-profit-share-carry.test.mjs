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

  test("a full absorb gives a zero line that carries the deduction", () => {
    const calc = distribute({
      // 700 owed, share is 500: all 500 is taken and 200 stays open.
      carry: new Map([[A, [{ shortfallId: shortfall(1), amountIdr: 700 }]]]),
    });
    assert.deepEqual(
      calc.lines.map((line) => line.shareholderId),
      [A, B],
    );
    assert.deepEqual(
      [
        lineOf(calc, A).grossIdr,
        lineOf(calc, A).taxWithheldIdr,
        lineOf(calc, A).netIdr,
        lineOf(calc, A).carryDeductedIdr,
      ],
      [0, 0, 0, 500],
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
    assert.equal(lineOf(calc, A).grossIdr, 0);
    assert.equal(lineOf(calc, A).carryDeductedIdr, 500);
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

  test("every shareholder absorbed gives all-zero lines, not NOTHING_TO_DISTRIBUTE", () => {
    const calc = distribute({
      taxBp: 1_000,
      carry: new Map([
        [A, [{ shortfallId: shortfall(1), amountIdr: 500 }]],
        [B, [{ shortfallId: shortfall(2), amountIdr: 900 }]],
      ]),
    });
    assert.equal(calc.lines.length, 2);
    for (const line of calc.lines) {
      assert.deepEqual(
        [
          line.grossIdr,
          line.taxWithheldIdr,
          line.netIdr,
          line.carryDeductedIdr,
        ],
        [0, 0, 0, 500],
      );
    }
    assert.equal(calc.totalGrossIdr, 0);
    assert.equal(calc.carryDeductedIdr, 1_000);
    assert.equal(calc.distributableIdr, 1_000);
  });

  test("a zero line without carry is refused by the schemas", () => {
    const zero = {
      shareholderId: A,
      shareBp: 5_000,
      grossIdr: 0,
      taxWithheldIdr: 0,
      netIdr: 0,
    };
    assert.throws(() =>
      accounting.distributionCalculationLineSchema.parse(zero),
    );
    assert.doesNotThrow(() =>
      accounting.distributionCalculationLineSchema.parse({
        ...zero,
        carryDeductedIdr: 5,
      }),
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
    const plain = { ...calc };
    delete plain.carryDeductions;
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

describe("positive adjustment (top-up) takes carry first", () => {
  const topUp = (adjustmentIdr, carry) =>
    accounting.calculateAdjustmentDistribution({
      ...base,
      adjustsRunId: "00000000-0000-4000-8000-0000000000e3",
      reason: "Tambahan",
      adjustmentIdr: idr(adjustmentIdr),
      taxWithholdingBp: 1_000,
      allocations: half,
      ...(carry ? { carry } : {}),
    });

  test("no carry: nothing deducted", () => {
    const calc = topUp(1_000);
    assert.equal(calc.carryDeductedIdr, 0);
    assert.deepEqual(calc.carryDeductions, []);
    assert.equal(calc.adjustmentIdr, 1_000);
  });

  test("partial: carry reduces that holder's gross before tax", () => {
    const calc = topUp(
      1_000,
      new Map([[A, [{ shortfallId: shortfall(1), amountIdr: 200 }]]]),
    );
    const a = lineOf(calc, A);
    assert.deepEqual(
      [a.grossIdr, a.carryDeductedIdr, a.taxWithheldIdr, a.netIdr],
      [300, 200, 30, 270],
    );
    assert.deepEqual(calc.carryDeductions, [
      { shareholderId: A, shortfallId: shortfall(1), amountIdr: 200 },
    ]);
    assert.equal(calc.carryDeductedIdr, 200);
    assert.equal(calc.totalGrossIdr, 800);
    assert.equal(calc.adjustmentIdr, 1_000);
  });

  test("full absorb: zero line for that holder", () => {
    const calc = topUp(
      1_000,
      new Map([[A, [{ shortfallId: shortfall(1), amountIdr: 700 }]]]),
    );
    const a = lineOf(calc, A);
    assert.deepEqual(
      [a.grossIdr, a.taxWithheldIdr, a.netIdr, a.carryDeductedIdr],
      [0, 0, 0, 500],
    );
    assert.equal(calc.totalGrossIdr, 500);
    assert.equal(calc.adjustmentIdr, 1_000);
  });

  test("a claw-back ignores carry", () => {
    const calc = accounting.calculateAdjustmentDistribution({
      ...base,
      adjustsRunId: "00000000-0000-4000-8000-0000000000e3",
      reason: "Koreksi",
      adjustmentIdr: idr(-200),
      taxWithholdingBp: 1_000,
      allocations: half,
      held: new Map([
        [A, { grossIdr: 500, taxWithheldIdr: 50 }],
        [B, { grossIdr: 500, taxWithheldIdr: 50 }],
      ]),
      carry: new Map([[A, [{ shortfallId: shortfall(1), amountIdr: 700 }]]]),
    });
    assert.equal(calc.carryDeductedIdr, 0);
    assert.deepEqual(calc.carryDeductions, []);
  });
});

describe("approve auto-pays zero lines", () => {
  const user = (n) =>
    `00000000-0000-4000-8000-${String(n + 500).padStart(12, "0")}`;
  const runId = shId(900);
  const line = (n, shareholderId, gross, carry) => ({
    id: shId(700 + n),
    tenantId: shId(800),
    distributionRunId: runId,
    shareholderId,
    shareBp: 5_000,
    grossIdr: gross,
    carryDeductedIdr: carry,
    taxWithheldIdr: 0,
    netIdr: gross,
    paymentStatus: "pending",
    paymentRef: null,
    paidAt: null,
    statementFileKey: null,
  });
  const run = (lines, carryDeductions) =>
    accounting.distributionRunSchema.parse({
      id: runId,
      tenantId: shId(800),
      profitEntityId: base.profitEntityId,
      fiscalPeriodId: base.fiscalPeriodId,
      period: base.period,
      type: "regular",
      basis: "closed_period_net_profit",
      status: "draft",
      shareVersion: 1,
      periodNetProfitIdr: 1_000,
      reserveIdr: 0,
      distributableIdr: 1_000,
      lines,
      totalGrossIdr: lines.reduce((sum, l) => sum + l.grossIdr, 0),
      totalTaxWithheldIdr: 0,
      totalNetIdr: lines.reduce((sum, l) => sum + l.netIdr, 0),
      requestedBy: user(1),
      requestedAt: "2026-11-01T00:00:00.000Z",
      approvedBy: null,
      approvedAt: null,
      paidAt: null,
      adjustsRunId: null,
      adjustmentReason: null,
      reversalJournalEntryId: null,
      unabsorbedIdr: 0,
      carryDeductedIdr: carryDeductions.reduce((s, d) => s + d.amountIdr, 0),
      carryDeductions,
    });
  const approve = (draft) =>
    accounting.transitionDistributionRun(
      accounting.transitionDistributionRun(draft, {
        type: "submit",
        actorId: draft.requestedBy,
      }),
      { type: "approve", actorId: user(2), now: "2026-11-02T00:00:00.000Z" },
    );
  const deduction = (shareholderId, amountIdr) => ({
    shareholderId,
    shortfallRunId: shId(950),
    amountIdr,
  });

  test("a mixed run pays only the zero line and stays approved", () => {
    const approved = approve(
      run([line(1, A, 0, 500), line(2, B, 500, 0)], [deduction(A, 500)]),
    );
    assert.equal(approved.status, "approved");
    assert.equal(approved.paidAt, null);
    const zero = approved.lines.find((l) => l.shareholderId === A);
    assert.equal(zero.paymentStatus, "paid");
    assert.equal(zero.paymentRef, "POTONG-KEKURANGAN");
    assert.equal(zero.paidAt, "2026-11-02T00:00:00.000Z");
    assert.equal(zero.statementFileKey, null);
    assert.equal(
      approved.lines.find((l) => l.shareholderId === B).paymentStatus,
      "pending",
    );
  });

  test("the last real payment completes the run with the max paidAt", () => {
    const approved = approve(
      run([line(1, A, 0, 500), line(2, B, 500, 0)], [deduction(A, 500)]),
    );
    const paid = accounting.transitionDistributionRun(approved, {
      type: "record_payment",
      actorId: user(2),
      lineId: shId(702),
      paymentRef: "TRF-1",
      paidAt: "2026-11-05T00:00:00.000Z",
    });
    assert.equal(paid.status, "paid");
    assert.equal(paid.paidAt, "2026-11-05T00:00:00.000Z");
  });

  test("all zero lines: approve goes straight to paid at approvedAt", () => {
    const approved = approve(
      run(
        [line(1, A, 0, 500), line(2, B, 0, 500)],
        [deduction(A, 500), deduction(B, 500)],
      ),
    );
    assert.equal(approved.status, "paid");
    assert.equal(approved.paidAt, "2026-11-02T00:00:00.000Z");
    assert.equal(approved.approvedAt, "2026-11-02T00:00:00.000Z");
    for (const l of approved.lines) {
      assert.equal(l.paymentStatus, "paid");
      assert.equal(l.paymentRef, "POTONG-KEKURANGAN");
    }
  });

  test("a run without zero lines approves as before", () => {
    const approved = approve(run([line(1, A, 500, 0), line(2, B, 500, 0)], []));
    assert.equal(approved.status, "approved");
    assert.ok(approved.lines.every((l) => l.paymentStatus === "pending"));
  });
});
