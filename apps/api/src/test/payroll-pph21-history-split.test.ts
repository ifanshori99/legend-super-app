// PPh 21 history split in the last tax period (beads legend-6q7o,
// legend-6p71; brief docs/briefs/sub-pph21-history-split.md).
//
// Replays years through the real payslip flow (`computePayslipTax` TER
// months -> `buildPph21Prior` -> last period) and checks who carries the
// Jan-Nov shortfall and the lebih potong. Exact hand-computed amounts of the
// three engine cases live in payroll-pph21-history-split-reference.test.ts;
// the Codex 6p71 amounts are asserted here.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PPH21_POLICY,
  buildPph21Prior,
  computePayslipTax,
  computePph21Period,
  type PayslipTaxEarning,
  type Pph21PolicyParameters,
  type Pph21PriorPeriod,
} from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Scheme = PayslipTaxEarning["taxScheme"];
type Month = { amountIdr: number; taxScheme: Scheme }[];

const ALLOCATIONS = ["proportional", "gross_first"] as const;

const policyOf = (
  allocation: Pph21PolicyParameters["mixedSchemeAllocation"],
): Pph21PolicyParameters => ({
  ...DEFAULT_PPH21_POLICY,
  mixedSchemeAllocation: allocation,
});

const earningsOf = (month: Month): PayslipTaxEarning[] =>
  month.map((line) => ({ ...line, taxable: true }));

function replay(
  months: readonly Month[],
  last: Month,
  policy: Pph21PolicyParameters,
) {
  const periods: Pph21PriorPeriod[] = months.map((month) => ({
    employeeDeductibleIdr: 0,
    tax: computePayslipTax({
      tables: REFERENCE_TABLES,
      policy,
      ptkpStatus: "TK/0",
      hasTaxId: true,
      lastTaxPeriod: false,
      monthsWorked: 12,
      earnings: earningsOf(month),
      employerBenefitIdr: 0,
      employeeDeductibleIdr: 0,
      prior: buildPph21Prior([]),
    }).tax,
  }));
  const prior = buildPph21Prior(periods);
  const result = computePayslipTax({
    tables: REFERENCE_TABLES,
    policy,
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked: months.length + 1,
    earnings: earningsOf(last),
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior,
  }).result;
  return { periods, prior, result };
}

describe("legend-6p71: the company's earlier tax is exact, never a base ratio", () => {
  for (const allocation of ALLOCATIONS) {
    it(`leaver after a net month and a gross month gets back exactly what each payer paid (${allocation})`, () => {
      // Codex 47: Jan net 20 jt, Feb gross 10 jt, leaves in Mar with gross
      // 1 jt (monthsWorked 3). The year's tax is 0, so each payer gets back
      // what it paid: employee 200_000, company 1_978_022.
      const { periods, result } = replay(
        [
          [{ amountIdr: 20_000_000, taxScheme: "net" }],
          [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        ],
        [{ amountIdr: 1_000_000, taxScheme: "gross" }],
        policyOf(allocation),
      );
      expect(periods[0]?.tax.taxableGrossIdr).toBe(21_978_022);
      expect(periods[0]?.tax.pph21EmployerBorneIdr).toBe(1_978_022);
      expect(periods[1]?.tax.pph21WithheldIdr).toBe(200_000);
      expect(result.pph21Idr).toBe(-2_178_022);
      expect(result.pph21RefundIdr).toBe(200_000);
      expect(result.pph21EmployerRefundIdr).toBe(1_978_022);
    });
  }

  it("refuses a history with employer-scheme pay and withheld tax but no reported allowance", () => {
    expect(() =>
      computePph21Period(REFERENCE_TABLES, DEFAULT_PPH21_POLICY, {
        ptkpStatus: "TK/0",
        hasTaxId: true,
        lastTaxPeriod: true,
        monthsWorked: 3,
        taxableLines: [{ amountIdr: 1_000_000, taxScheme: "gross" }],
        employerBenefitIdr: 0,
        employeeDeductibleIdr: 0,
        prior: {
          taxableGrossIdr: 31_978_022,
          employeeDeductibleIdr: 0,
          pph21WithheldIdr: 200_000,
          pph21EmployerBorneIdr: 1_978_022,
          grossSchemeBaseIdr: 10_000_000,
          employerSchemeBaseIdr: 21_978_022,
        },
      }),
    ).toThrow(RangeError);
  });
});

describe("legend-6q7o: the Jan-Nov shortfall follows who it belongs to", () => {
  for (const allocation of ALLOCATIONS) {
    it(`an unpaid last period after a gross-up year charges the employee nothing (${allocation})`, () => {
      const { result } = replay(
        Array.from({ length: 11 }, () => [
          { amountIdr: 8_000_000, taxScheme: "gross_up" as const },
        ]),
        [],
        policyOf(allocation),
      );
      expect(result.pph21Idr).toBeGreaterThan(0);
      expect(result.pph21WithheldIdr).toBe(0);
      expect(result.pph21EmployerBorneIdr).toBe(result.pph21Idr);
    });

    it(`a net-only December after a gross-up year charges the employee nothing (${allocation})`, () => {
      const { result } = replay(
        Array.from({ length: 11 }, () => [
          { amountIdr: 8_000_000, taxScheme: "gross_up" as const },
        ]),
        [{ amountIdr: 8_000_000, taxScheme: "net" }],
        policyOf(allocation),
      );
      expect(result.pph21Idr).toBeGreaterThan(0);
      expect(result.pph21WithheldIdr).toBe(0);
    });

    it(`a gross-only year and December leave nothing to the company (${allocation})`, () => {
      const { result } = replay(
        Array.from({ length: 11 }, () => [
          { amountIdr: 9_000_000, taxScheme: "gross" as const },
        ]),
        [{ amountIdr: 30_000_000, taxScheme: "gross" }],
        policyOf(allocation),
      );
      expect(result.pph21Idr).toBeGreaterThan(0);
      expect(result.pph21WithheldIdr).toBe(result.pph21Idr);
      expect(result.pph21EmployerBorneIdr).toBe(0);
    });
  }
});

describe("history split invariants over random years", () => {
  // Deterministic LCG so a failure reproduces.
  let seed = 0x6b7f;
  const rand = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  const schemes: Scheme[] = ["gross", "gross_up", "net"];
  const randomMonth = (only?: Scheme): Month =>
    Array.from({ length: 1 + rand(2) }, () => ({
      amountIdr: 1_000_000 + rand(25) * 1_000_000 + rand(1000),
      taxScheme: only ?? (schemes[rand(3)] as Scheme),
    }));

  // Bead legend-u1xq: with a Jan-Nov lebih potong each payer nets its own
  // part, so withheld may exceed T beside an employer refund. The split always
  // adds up to T (the DJP deposit), and a pure history stays on its payer.
  it("keeps withheld + borne - refunds = T, allowance <= withheld, and pure histories on their payer", () => {
    for (let i = 0; i < 300; i++) {
      const allocation = ALLOCATIONS[rand(2)] ?? "proportional";
      const policy = policyOf(allocation);
      const pure = rand(3); // 0 mixed, 1 employer-only, 2 gross-only
      const only: Scheme | undefined =
        pure === 1
          ? rand(2) === 0
            ? "gross_up"
            : "net"
          : pure === 2
            ? "gross"
            : undefined;
      const months = Array.from({ length: 1 + rand(11) }, () =>
        randomMonth(only),
      );
      const last = rand(10) === 0 ? [] : randomMonth(only);
      const { result: r } = replay(months, last, policy);
      expect(
        r.pph21WithheldIdr +
          r.pph21EmployerBorneIdr -
          r.pph21RefundIdr -
          r.pph21EmployerRefundIdr,
      ).toBe(r.pph21Idr);
      expect(r.taxAllowanceIdr).toBeLessThanOrEqual(r.pph21WithheldIdr);
      // A payer is either charged or refunded, never both.
      const w = r.pph21WithheldIdr - r.taxAllowanceIdr;
      expect(w === 0 || r.pph21RefundIdr === 0).toBe(true);
      expect(
        r.taxAllowanceIdr + r.pph21EmployerBorneIdr === 0 ||
          r.pph21EmployerRefundIdr === 0,
      ).toBe(true);
      if (r.pph21Idr >= 0 && pure !== 0)
        expect(r.pph21RefundIdr + r.pph21EmployerRefundIdr).toBe(0);
      if (pure === 1) {
        expect(w).toBe(0);
        expect(r.pph21RefundIdr).toBe(0);
      }
      if (pure === 2) {
        expect(r.taxAllowanceIdr).toBe(0);
        expect(r.pph21EmployerBorneIdr).toBe(0);
        expect(r.pph21EmployerRefundIdr).toBe(0);
      }
    }
  });
});
