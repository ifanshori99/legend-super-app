// PPh 21 reference suite, Part E: the company's share of a Jan-Nov OVER
// withholding (H < 0) must not reduce the employee's December tax (bead
// legend-u1xq; brief docs/briefs/sub-pph21-overwithhold.md, tingkat K; PMK
// 168/2023 Pasal 15(1)-(3) and Pasal 21).
//
// Every expected value below is computed BY HAND (python3 big-integer
// arithmetic) from the regulation and the brief's design, using
// REFERENCE_TABLES (fixtures/payroll/statutory-tables.ts), never by calling or
// copying engine code. Conventions as payroll-pph21-history-split-reference
// (X = G + U + N + tax allowance + employer-borne tax; TER on X, one half_up
// rounding per tax amount; biaya jabatan = min(5% x bruto, 6_000_000); PKP
// floored to whole thousands; TK/0, with NPWP; months = 12).
//
// Notation (brief): H = annual(prior) - priorTax (< 0 here, last period only);
// C = -H (the credit); T = annual(prior + X) - priorTax; D = T - H =
// annual(prior + X) - annual(prior) (the extra tax caused by this month's X).
// pET = prior employer tax (borne + allowance), pEeT = priorTax - pET.
// G* = this month's employee (gross-scheme) part, X = taxable gross.
// New design for H < 0:
//   De = this month's employee share of D (`proportional` floor(D x G*/X);
//        `gross_first` min(D, annual(prior + G*) - annual(prior))), Dr = D - De.
//   Credit split by who overpaid (architect Q2, mirrors rule B of the
//        history-split brief), clampC = clamp to [0, C], annual(prior) =
//        priorTax + H:
//        scheme base sent, `gross_first`: Ce = clampC(pEeT - annual(Gs));
//        scheme base sent, `proportional`:
//          Cr = clampC(pET - floor(annual(prior) x E / (E + Gs)));
//        no scheme base, both policies: Cr = floor(C x pET/priorTax);
//        the other part is the rest (Ce + Cr = C).
//   Employee: De - Ce >= 0 -> W = De - Ce, else W = 0 and the employee is
//        refunded Ce - De. Company: Dr - Cr >= 0 -> S = Dr - Cr (least fixed
//        point, S feeds X), else S = 0 and the company is refunded Cr - Dr.
// New invariant: W + A + B - employeeRefund - employerRefund = T, where
//   pph21WithheldIdr = W + A (A = allowance), pph21EmployerBorneIdr = B;
//   take-home = G + U + N - W + employeeRefund; W <= De; employerRefund <= Cr;
//   employeeRefund <= Ce.
// Single-scheme months (pure gross, pure net, pure gross-up) give the same
// figures as the old code.
//
// Assumptions where the brief is silent (flagged in the report):
// - O1: pph21Idr of the period is T (annual(prior + X) - priorTax), also when
//   the company's refund is paid out; the invariant above is asserted on it.
// - O2: pph21WithheldIdr is W + A, so the employee's own tax W is
//   withheld - taxAllowance (same reading as the history-split suite).
// - O3: the fixed point uses the same stop rule as the history-split suite:
//   S0 = 0, S_{k+1} = max(0, Dr(X0 + S_k) - Cr), stop when S_{k+1} <= S_k.
// - O4: the first describe holds the unambiguous cases (the bead example,
//   single-scheme months). The second describe (round 2, O5/O6) holds the
//   mixed months under the architect's decisions Q1-Q4; its Jan-Nov history
//   is an assumed round-number ledger, and an all-gross_up employer part of a
//   mixed month is booked entirely as allowance (no net line, so no borne).
import { describe, expect, it } from "vitest";
import { DEFAULT_PPH21_POLICY } from "@starter/shared/hris/payroll";
import type { Pph21PolicyParameters } from "@starter/shared/hris/payroll";
import { computePph21Period } from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Input = Parameters<typeof computePph21Period>[2];
type Result = ReturnType<typeof computePph21Period>;

const ALLOCATIONS = ["proportional", "gross_first"] as const;

const prior = (
  taxableGrossIdr: number,
  pph21WithheldIdr: number,
  pph21EmployerBorneIdr = 0,
) => ({
  taxableGrossIdr,
  employeeDeductibleIdr: 0,
  pph21WithheldIdr,
  pph21EmployerBorneIdr,
});

const run = (
  over: Partial<Input>,
  policy: Partial<Pph21PolicyParameters> = {},
) =>
  computePph21Period(REFERENCE_TABLES, { ...DEFAULT_PPH21_POLICY, ...policy }, {
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked: 12,
    taxableLines: [],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior: prior(0, 0),
    ...over,
  } as Input);

// The new invariant, checked in every case: the money that leaves the
// employee and the company, less what is paid back, is exactly T.
const expectAccounting = (r: Result) => {
  expect(
    r.pph21WithheldIdr +
      r.pph21EmployerBorneIdr -
      r.pph21RefundIdr -
      r.pph21EmployerRefundIdr,
  ).toBe(r.pph21Idr);
  expect(r.pph21WithheldIdr).toBeGreaterThanOrEqual(r.taxAllowanceIdr);
};

// Eleven months of gross-up salary 15_000_000: X = 15_000_000 / (1 - 0,07) =
// 16_129_032 (TER A row 17, 7%: 16_129_032 x 700 / 10000 = 1_129_032,24 ->
// 1_129_032, stable), S = 1_129_032.
// All of it is the employer's money: withheld = allowance = 11 x 1_129_032 =
// 12_419_352, borne 0, prior gross 11 x 16_129_032 = 177_419_352.
const GROSS_UP_YEAR = {
  ...prior(177_419_352, 12_419_352, 0),
  taxAllowanceIdr: 12_419_352,
  grossSchemeBaseIdr: 0,
  employerSchemeBaseIdr: 177_419_352,
};

describe("PPh 21 over-withholding Jan-Nov: the company's credit is the company's (legend-u1xq)", () => {
  for (const allocation of ALLOCATIONS) {
    it(`O1 (bead example, ${allocation}) gross-up 15 jt Jan-Nov, December gross 15 jt: the employee pays the tax on his December salary, the company is refunded its credit`, () => {
      // H = annual(177_419_352) - 12_419_352: cost min(8_870_967, 6_000_000) =
      //   6_000_000, net 171_419_352, PKP 117_419_000, tax 3_000_000 + 15% x
      //   57_419_000 = 11_612_850 -> H = -806_502 (C = 806_502).
      // December gross 15_000_000 = G* = X (no employer part, S = 0):
      //   gross 192_419_352, net 186_419_352, PKP 132_419_000, annual
      //   3_000_000 + 15% x 72_419_000 = 13_862_850.
      //   T = 13_862_850 - 12_419_352 = 1_443_498.
      //   D = T - H = 13_862_850 - 11_612_850 = 2_250_000 (= 15% x 15_000_000).
      // De = D (G* = X, both policies), Dr = 0.
      // Credit: pET = 12_419_352 = priorTax, pEeT = 0, so the whole credit is
      //   the company's: Cr = floor(806_502 x 12_419_352 / 12_419_352) =
      //   806_502 (proportional); Ce = min(806_502, 0) = 0 (gross_first).
      // Employee: W = De - Ce = 2_250_000, no refund.
      // Company: Dr - Cr = -806_502 < 0 -> S = 0, refund 806_502.
      // Check: 2_250_000 - 806_502 = 1_443_498 = T. Take-home = 15_000_000 -
      //   2_250_000 = 12_750_000. The old code gave W = floor(T x G*/X) =
      //   1_443_498: the company's credit reduced the employee's tax.
      const r = run(
        {
          taxableLines: [{ amountIdr: 15_000_000, taxScheme: "gross" }],
          prior: GROSS_UP_YEAR,
        },
        { mixedSchemeAllocation: allocation },
      );
      expect(r.method).toBe("annual_recalculation");
      expect(r.taxableGrossIdr).toBe(15_000_000);
      expect(r.pph21Idr).toBe(1_443_498);
      expect(r.taxAllowanceIdr).toBe(0);
      expect(r.pph21WithheldIdr).toBe(2_250_000);
      expect(r.pph21EmployerBorneIdr).toBe(0);
      expect(r.pph21RefundIdr).toBe(0);
      expect(r.pph21EmployerRefundIdr).toBe(806_502);
      expect(r.annual?.annualTaxIdr).toBe(13_862_850);
      expect(r.annual?.priorPph21Idr).toBe(12_419_352);

      expectAccounting(r);
      const employeeTax = r.pph21WithheldIdr - r.taxAllowanceIdr;
      expect(employeeTax).toBeLessThanOrEqual(2_250_000); // W <= De
      expect(r.pph21EmployerRefundIdr).toBeLessThanOrEqual(806_502); // <= Cr
      expect(15_000_000 - employeeTax + r.pph21RefundIdr).toBe(12_750_000);
    });
  }

  for (const allocation of ALLOCATIONS) {
    it(`O2 (pure gross, ${allocation}) gross 12 jt every month: the employee gets back his own credit through a smaller December tax, the company has nothing`, () => {
      // Jan-Nov: TER A row 14 (4%): 12_000_000 x 400 / 10000 = 480_000 each,
      //   withheld 5_280_000, borne 0, allowance 0; prior gross 132_000_000.
      // H = annual(132_000_000) - 5_280_000: cost 6_000_000, net 126_000_000,
      //   PKP 72_000_000, tax 3_000_000 + 15% x 12_000_000 = 4_800_000 ->
      //   H = -480_000 (C = 480_000).
      // December gross 12_000_000 (G* = X, S = 0): gross 144_000_000, net
      //   138_000_000, PKP 84_000_000, annual 3_000_000 + 15% x 24_000_000 =
      //   6_600_000; T = 6_600_000 - 5_280_000 = 1_320_000;
      //   D = 6_600_000 - 4_800_000 = 1_800_000.
      // De = D = 1_800_000, Dr = 0. pET = 0: Cr = floor(480_000 x 0 /
      //   5_280_000) = 0 (proportional), Ce = min(480_000, pEeT = 5_280_000) =
      //   480_000 (gross_first); both give Ce = 480_000, Cr = 0.
      // Employee: W = 1_800_000 - 480_000 = 1_320_000 = T. Company: 0 - 0 = 0,
      //   no refund. Same as the old code.
      const r = run(
        {
          taxableLines: [{ amountIdr: 12_000_000, taxScheme: "gross" }],
          prior: {
            ...prior(132_000_000, 5_280_000, 0),
            taxAllowanceIdr: 0,
            grossSchemeBaseIdr: 132_000_000,
            employerSchemeBaseIdr: 0,
          },
        },
        { mixedSchemeAllocation: allocation },
      );
      expect(r.method).toBe("annual_recalculation");
      expect(r.taxableGrossIdr).toBe(12_000_000);
      expect(r.pph21Idr).toBe(1_320_000);
      expect(r.taxAllowanceIdr).toBe(0);
      expect(r.pph21WithheldIdr).toBe(1_320_000);
      expect(r.pph21EmployerBorneIdr).toBe(0);
      expect(r.pph21RefundIdr).toBe(0);
      expect(r.pph21EmployerRefundIdr).toBe(0);
      expect(r.annual?.annualTaxIdr).toBe(6_600_000);
      expect(r.annual?.priorPph21Idr).toBe(5_280_000);

      expectAccounting(r);
      expect(r.pph21WithheldIdr).toBeLessThanOrEqual(1_800_000); // W <= De
      expect(12_000_000 - r.pph21WithheldIdr).toBe(10_680_000); // take-home
    });
  }

  for (const allocation of ALLOCATIONS) {
    it(`O3 (pure net, ${allocation}) net 22,5 jt every month: the company bears December's tax net of its own credit, the employee pays nothing`, () => {
      // Jan-Nov: X = 22_500_000 / (1 - 0,10) = 25_000_000 (TER A row 20,
      //   10%: 25_000_000 x 1000 / 10000 = 2_500_000), S = 2_500_000 borne
      //   each month. Prior gross 275_000_000, withheld 0, borne 27_500_000,
      //   allowance 0; scheme base all employer.
      // H = annual(275_000_000) - 27_500_000: cost 6_000_000, net
      //   269_000_000, PKP 215_000_000, tax 3_000_000 + 15% x 155_000_000 =
      //   26_250_000 -> H = -1_250_000 (C = 1_250_000).
      // December net 22_500_000, X = 22_500_000 + S, G* = 0: De = 0, Dr = D.
      //   pET = priorTax: Cr = C (proportional), Ce = min(C, pEeT = 0) = 0
      //   (gross_first). W = max(0, 0 - 0) = 0. S = Dr - Cr = D - C = T.
      //   S0=0       gross 297_500_000 PKP 237_500_000 annual 29_625_000 T 2_125_000 next 2_125_000
      //   S1=2_125_000 gross 299_625_000 PKP 239_625_000 annual 29_943_750 T 2_443_750
      //   S2=2_443_750 gross 299_943_750 PKP 239_943_000 annual 29_991_450 T 2_491_450
      //   S3=2_491_450 gross 299_991_450 PKP 239_991_000 annual 29_998_650 T 2_498_650
      //   S4=2_498_650 gross 299_998_650 PKP 239_998_000 annual 29_999_700 T 2_499_700
      //   S5=2_499_700 gross 299_999_700 PKP 239_999_000 annual 29_999_850 T 2_499_850
      //   S6=2_499_850 gross 299_999_850 PKP 239_999_000 annual 29_999_850 T 2_499_850 stop.
      //   X = 24_999_850, T = 29_999_850 - 27_500_000 = 2_499_850; borne
      //   2_499_850, withheld 0, no refund on either side. Same as the old code.
      const r = run(
        {
          taxableLines: [{ amountIdr: 22_500_000, taxScheme: "net" }],
          prior: {
            ...prior(275_000_000, 0, 27_500_000),
            taxAllowanceIdr: 0,
            grossSchemeBaseIdr: 0,
            employerSchemeBaseIdr: 275_000_000,
          },
        },
        { mixedSchemeAllocation: allocation },
      );
      expect(r.method).toBe("annual_recalculation");
      expect(r.taxableGrossIdr).toBe(24_999_850);
      expect(r.pph21Idr).toBe(2_499_850);
      expect(r.taxAllowanceIdr).toBe(0);
      expect(r.pph21WithheldIdr).toBe(0);
      expect(r.pph21EmployerBorneIdr).toBe(2_499_850);
      expect(r.pph21RefundIdr).toBe(0);
      expect(r.pph21EmployerRefundIdr).toBe(0);
      expect(r.annual?.annualTaxIdr).toBe(29_999_850);
      expect(r.annual?.priorPph21Idr).toBe(27_500_000);

      expectAccounting(r);
      expect(22_500_000 - r.pph21WithheldIdr).toBe(22_500_000); // take-home
    });
  }

  for (const allocation of ALLOCATIONS) {
    it(`O4 (pure gross-up, ${allocation}) gross-up 15 jt Jan-Nov and December, H < 0: the employee pays nothing, the company's allowance is December's tax less its own credit`, () => {
      // Same history as O1 (H = -806_502, C = 806_502, priorTax = pET =
      //   12_419_352, pEeT = 0). December gross_up 15_000_000, X = 15_000_000
      //   + S, G* = 0: De = 0, Dr = D. Cr = C (proportional), Ce = 0
      //   (gross_first). W = 0. S = Dr - Cr = D - C = T, the allowance.
      //   S0=0       gross 192_419_352 PKP 132_419_000 annual 13_862_850 T 1_443_498 next 1_443_498
      //   S1=1_443_498 gross 193_862_850 PKP 133_862_000 annual 14_079_300 T 1_659_948
      //   S2=1_659_948 gross 194_079_300 PKP 134_079_000 annual 14_111_850 T 1_692_498
      //   S3=1_692_498 gross 194_111_850 PKP 134_111_000 annual 14_116_650 T 1_697_298
      //   S4=1_697_298 gross 194_116_650 PKP 134_116_000 annual 14_117_400 T 1_698_048
      //   S5=1_698_048 gross 194_117_400 PKP 134_117_000 annual 14_117_550 T 1_698_198
      //   S6=1_698_198 gross 194_117_550 PKP 134_117_000 annual 14_117_550 T 1_698_198 stop.
      //   X = 16_698_198, T = 14_117_550 - 12_419_352 = 1_698_198; allowance
      //   1_698_198 (= withheld, W = 0), borne 0, no refund. Same as the old code.
      const r = run(
        {
          taxableLines: [{ amountIdr: 15_000_000, taxScheme: "gross_up" }],
          prior: GROSS_UP_YEAR,
        },
        { mixedSchemeAllocation: allocation },
      );
      expect(r.method).toBe("annual_recalculation");
      expect(r.taxableGrossIdr).toBe(16_698_198);
      expect(r.pph21Idr).toBe(1_698_198);
      expect(r.taxAllowanceIdr).toBe(1_698_198);
      expect(r.pph21WithheldIdr).toBe(1_698_198);
      expect(r.pph21EmployerBorneIdr).toBe(0);
      expect(r.pph21RefundIdr).toBe(0);
      expect(r.pph21EmployerRefundIdr).toBe(0);
      expect(r.annual?.annualTaxIdr).toBe(14_117_550);
      expect(r.annual?.priorPph21Idr).toBe(12_419_352);

      expectAccounting(r);
      // The employee's own tax W = withheld - allowance = 0: take-home is
      // the full 15_000_000 salary + 1_698_198 allowance - 1_698_198 withheld.
      expect(r.pph21WithheldIdr - r.taxAllowanceIdr).toBe(0);
    });
  }
});

// Round 2: mixed months (this month has a gross line and a gross_up line, so
// G* is between 0 and X) after a mixed history. Architect decisions (brief):
// Q1 the new formula also holds for T < 0; Q3 the company side is netted
// (S = Dr - Cr); Q4 the fixed point is S = max(0, Dr(X(S)) - Cr) without a
// T > 0 gate; Q2 the credit split is
//   with scheme base, gross_first:  Ce = clamp(pEeT - annual(Gs), 0, C), Cr = C - Ce;
//   with scheme base, proportional: Cr = clamp(pET - floor(annual(prior) x E/mix), 0, C), Ce = C - Cr;
//   without scheme base (both):     Cr = floor(C x pET / priorTax), Ce = C - Cr.
//
// The history below is an ASSUMED ledger of Jan-Nov (round numbers chosen so
// every step can be checked by hand), not the output of eleven payslip runs:
//   prior gross 220_000_000 (Gs = 100_000_000 gross scheme, E = 120_000_000
//   gross-up / net scheme); withheld 17_550_000 of which 15_000_000 was the
//   company's tax allowance (so the employee paid pEeT = 2_550_000); borne
//   2_450_000. priorTax = 20_000_000, pET = 2_450_000 + 15_000_000 = 17_450_000.
//   annual(220_000_000): cost 6_000_000, net 214_000_000, PKP 160_000_000, tax
//   3_000_000 + 15% x 100_000_000 = 18_000_000 => H = -2_000_000, C = 2_000_000.
//   annual(Gs = 100_000_000): cost 5_000_000, net 95_000_000, PKP 41_000_000,
//   tax 2_050_000. floor(annual(prior) x E / mix) = floor(18_000_000 x
//   120_000_000 / 220_000_000) = 9_818_181.
// Credit split (C = 2_000_000):
//   with base, gross_first: Ce = clamp(2_550_000 - 2_050_000, 0, C) = 500_000,
//     Cr = 1_500_000.
//   with base, proportional: Cr = clamp(17_450_000 - 9_818_181, 0, C) =
//     2_000_000 (clamped), Ce = 0.
//   no base, both: Cr = floor(2_000_000 x 17_450_000 / 20_000_000) = 1_745_000,
//     Ce = 255_000.
const MIXED_HISTORY = {
  ...prior(220_000_000, 17_550_000, 2_450_000),
  taxAllowanceIdr: 15_000_000,
};
const MIXED_BASES = {
  grossSchemeBaseIdr: 100_000_000,
  employerSchemeBaseIdr: 120_000_000,
};

// Bounds of the new invariant for one case: the employee's tax W (withheld
// less allowance) <= its bound (De, or De + bE when the employee is short,
// bead legend-mmgd), the refunds <= what each payer over-paid.
const expectBounds = (r: Result, b: { de: number; ce: number; cr: number }) => {
  expect(r.pph21WithheldIdr - r.taxAllowanceIdr).toBeLessThanOrEqual(b.de);
  expect(r.pph21RefundIdr).toBeLessThanOrEqual(b.ce);
  expect(r.pph21EmployerRefundIdr).toBeLessThanOrEqual(b.cr);
};

describe("PPh 21 over-withholding Jan-Nov, mixed months (legend-u1xq round 2)", () => {
  describe("O5 H < 0, T >= 0: December gross 5 jt + gross_up 20 jt", () => {
    // X0 = 25_000_000, G* = 5_000_000. annual(prior + G*) = annual(225_000_000):
    //   cost 6_000_000, net 219_000_000, PKP 165_000_000, tax 3_000_000 + 15% x
    //   105_000_000 = 18_750_000 => the employee's own extra tax 750_000.
    // gross_first: De = min(D, 750_000) = 750_000 for every D here.
    // The company's extra tax Dr = D - De is covered (Dr > Cr), so S > 0 and S
    // is the company's allowance (the only employer-scheme line is gross_up).
    // Fixed point S_{k+1} = max(0, Dr(X0 + S_k) - Cr), stop when S_{k+1} <= S_k.
    type Case = {
      x: number;
      annual: number;
      t: number;
      w: number;
      s: number;
      de: number;
      ce: number;
      cr: number;
      employerRefund?: number; // bead legend-mmgd: default 0
    };
    const lines = [
      { amountIdr: 5_000_000, taxScheme: "gross" as const },
      { amountIdr: 20_000_000, taxScheme: "gross_up" as const },
    ];

    const check = (
      label: string,
      bases: object,
      allocation: (typeof ALLOCATIONS)[number],
      c: Case,
    ) =>
      it(`${label}, ${allocation}`, () => {
        const r = run(
          { taxableLines: lines, prior: { ...MIXED_HISTORY, ...bases } },
          { mixedSchemeAllocation: allocation },
        );
        expect(r.method).toBe("annual_recalculation");
        expect(r.taxableGrossIdr).toBe(c.x);
        expect(r.pph21Idr).toBe(c.t);
        expect(r.taxAllowanceIdr).toBe(c.s);
        expect(r.pph21WithheldIdr).toBe(c.w + c.s);
        expect(r.pph21EmployerBorneIdr).toBe(0);
        expect(r.pph21RefundIdr).toBe(0);
        expect(r.pph21EmployerRefundIdr).toBe(c.employerRefund ?? 0);
        expect(r.annual?.annualTaxIdr).toBe(c.annual);
        expect(r.annual?.priorPph21Idr).toBe(20_000_000);
        expectAccounting(r);
        expectBounds(r, { de: c.de, ce: c.ce, cr: c.cr });
        // take-home = G + U + N - W + employee refund (G + U + N = 25_000_000)
        expect(
          25_000_000 -
            (r.pph21WithheldIdr - r.taxAllowanceIdr) +
            r.pph21RefundIdr,
        ).toBe(25_000_000 - c.w);
      });

    // with scheme base, proportional (updated for bead legend-mmgd: signed
    //   balances, no clamp to [0, C]): aP = 18_000_000, pET = 17_450_000,
    //   pEeT = 2_550_000, bR = floor(18_000_000 x 120_000_000 / 220_000_000) -
    //   17_450_000 = 9_818_181 - 17_450_000 = -7_631_819 (the company
    //   over-paid by more than the whole credit); bE = H - bR = -2_000_000 +
    //   7_631_819 = 5_631_819 (the employee is SHORT). The old clamp gave
    //   Cr = 2_000_000, Ce = 0 and let the company's over-payment cover the
    //   employee's shortfall (old W 749_988, S 1_176_412).
    //   De = floor(D x 5_000_000 / X). Dr + bR < 0 at the first step, so
    //   covered stays 0 (no allowance):
    //   S0=0       X 25_000_000 gross 245_000_000 annual 21_750_000 T 1_750_000 D 3_750_000 De 750_000 Dr 3_000_000 next max(0, 3_000_000 - 7_631_819) = 0 stop.
    //   Employee: e = De + bE = 750_000 + 5_631_819 = 6_381_819 = W.
    //   Company: r = Dr + bR = 3_000_000 - 7_631_819 = -4_631_819 => company
    //   refund 4_631_819. T = 21_750_000 - 20_000_000 = 1_750_000.
    //   Check: 6_381_819 - 4_631_819 = 1_750_000 = T. W <= De + bE.
    check("with scheme base", MIXED_BASES, "proportional", {
      x: 25_000_000,
      annual: 21_750_000,
      t: 1_750_000,
      w: 6_381_819,
      s: 0,
      de: 6_381_819, // De 750_000 + bE 5_631_819 (bound on W)
      ce: 0,
      cr: 7_631_819, // max(0, -bR)
      employerRefund: 4_631_819,
    });
    // with scheme base, gross_first: Ce = 500_000, Cr = 1_500_000, De = 750_000.
    //   S0=0       X 25_000_000 annual 21_750_000 D 3_750_000 Dr 3_000_000 next 1_500_000
    //   S1=1_500_000 X 26_500_000 annual 21_975_000 D 3_975_000 Dr 3_225_000 next 1_725_000
    //   S2=1_725_000 X 26_725_000 annual 22_008_750 D 4_008_750 Dr 3_258_750 next 1_758_750
    //   S3=1_758_750 X 26_758_750 annual 22_013_700 D 4_013_700 Dr 3_263_700 next 1_763_700
    //   S4=1_763_700 X 26_763_700 annual 22_014_450 D 4_014_450 Dr 3_264_450 next 1_764_450
    //   S5=1_764_450 X 26_764_450 annual 22_014_600 D 4_014_600 Dr 3_264_600 next 1_764_600
    //   S6=1_764_600 X 26_764_600 annual 22_014_600 D 4_014_600 Dr 3_264_600 next 1_764_600 stop.
    //   W = 750_000 - 500_000 = 250_000, S = 3_264_600 - 1_500_000 = 1_764_600.
    //   T = 22_014_600 - 20_000_000 = 2_014_600 = W + S.
    check("with scheme base", MIXED_BASES, "gross_first", {
      x: 26_764_600,
      annual: 22_014_600,
      t: 2_014_600,
      w: 250_000,
      s: 1_764_600,
      de: 750_000,
      ce: 500_000,
      cr: 1_500_000,
    });
    // no scheme base, proportional: Cr = 1_745_000, Ce = 255_000.
    //   S0=0       X 25_000_000 annual 21_750_000 D 3_750_000 De 750_000 Dr 3_000_000 next 1_255_000
    //   S1=1_255_000 X 26_255_000 annual 21_938_250 D 3_938_250 De 750_000 Dr 3_188_250 next 1_443_250
    //   S2=1_443_250 X 26_443_250 annual 21_966_450 D 3_966_450 De 749_992 Dr 3_216_458 next 1_471_458
    //   S3=1_471_458 X 26_471_458 annual 21_970_650 D 3_970_650 De 749_987 Dr 3_220_663 next 1_475_663
    //   S4=1_475_663 X 26_475_663 annual 21_971_250 D 3_971_250 De 749_981 Dr 3_221_269 next 1_476_269
    //   S5=1_476_269 X 26_476_269 annual 21_971_400 D 3_971_400 De 749_992 Dr 3_221_408 next 1_476_408
    //   S6=1_476_408 X 26_476_408 annual 21_971_400 D 3_971_400 De 749_988 Dr 3_221_412 next 1_476_412
    //   S7=1_476_412 X 26_476_412 annual 21_971_400 D 3_971_400 De 749_988 Dr 3_221_412 next 1_476_412 stop.
    //   W = 749_988 - 255_000 = 494_988, S = 3_221_412 - 1_745_000 = 1_476_412.
    //   T = 21_971_400 - 20_000_000 = 1_971_400 = W + S.
    check("no scheme base", {}, "proportional", {
      x: 26_476_412,
      annual: 21_971_400,
      t: 1_971_400,
      w: 494_988,
      s: 1_476_412,
      de: 749_988,
      ce: 255_000,
      cr: 1_745_000,
    });
    // no scheme base, gross_first: Cr = 1_745_000, Ce = 255_000, De = 750_000.
    //   S0=0       X 25_000_000 annual 21_750_000 D 3_750_000 Dr 3_000_000 next 1_255_000
    //   S1=1_255_000 X 26_255_000 annual 21_938_250 D 3_938_250 Dr 3_188_250 next 1_443_250
    //   S2=1_443_250 X 26_443_250 annual 21_966_450 D 3_966_450 Dr 3_216_450 next 1_471_450
    //   S3=1_471_450 X 26_471_450 annual 21_970_650 D 3_970_650 Dr 3_220_650 next 1_475_650
    //   S4=1_475_650 X 26_475_650 annual 21_971_250 D 3_971_250 Dr 3_221_250 next 1_476_250
    //   S5=1_476_250 X 26_476_250 annual 21_971_400 D 3_971_400 Dr 3_221_400 next 1_476_400
    //   S6=1_476_400 X 26_476_400 annual 21_971_400 D 3_971_400 Dr 3_221_400 next 1_476_400 stop.
    //   W = 750_000 - 255_000 = 495_000, S = 3_221_400 - 1_745_000 = 1_476_400.
    //   T = 1_971_400 = W + S.
    check("no scheme base", {}, "gross_first", {
      x: 26_476_400,
      annual: 21_971_400,
      t: 1_971_400,
      w: 495_000,
      s: 1_476_400,
      de: 750_000,
      ce: 255_000,
      cr: 1_745_000,
    });
  });

  describe("O6 H < 0, T < 0: December gross 1 jt + gross_up 1 jt", () => {
    // X0 = 2_000_000, G* = 1_000_000. gross 222_000_000: cost 6_000_000, net
    // 216_000_000, PKP 162_000_000, annual 3_000_000 + 15% x 102_000_000 =
    // 18_300_000. T = 18_300_000 - 20_000_000 = -1_700_000.
    // D = 18_300_000 - 18_000_000 = 300_000. annual(prior + G*) = annual(221_000_000)
    // = 3_000_000 + 15% x 101_000_000 = 18_150_000 => De (gross_first) =
    // min(300_000, 150_000) = 150_000; proportional De = floor(300_000 x
    // 1_000_000 / 2_000_000) = 150_000. Dr = 150_000. Dr < every Cr here, so S
    // stays 0 (X = 2_000_000) at the first step.
    // Rule 6 (Q1): the same formula as T >= 0, so the employee still pays his
    // own De where Ce is smaller, although the month's T is negative.
    type Case = {
      w: number;
      refund: number;
      employerRefund: number;
      ce: number;
      cr: number;
      de?: number; // bound on W; default De = 150_000 (bead legend-mmgd)
    };
    const lines = [
      { amountIdr: 1_000_000, taxScheme: "gross" as const },
      { amountIdr: 1_000_000, taxScheme: "gross_up" as const },
    ];
    const check = (
      label: string,
      bases: object,
      allocation: (typeof ALLOCATIONS)[number],
      c: Case,
    ) =>
      it(`${label}, ${allocation}`, () => {
        const r = run(
          { taxableLines: lines, prior: { ...MIXED_HISTORY, ...bases } },
          { mixedSchemeAllocation: allocation },
        );
        expect(r.method).toBe("annual_recalculation");
        expect(r.taxableGrossIdr).toBe(2_000_000);
        expect(r.pph21Idr).toBe(-1_700_000);
        expect(r.taxAllowanceIdr).toBe(0);
        expect(r.pph21WithheldIdr).toBe(c.w);
        expect(r.pph21EmployerBorneIdr).toBe(0);
        expect(r.pph21RefundIdr).toBe(c.refund);
        expect(r.pph21EmployerRefundIdr).toBe(c.employerRefund);
        expect(r.annual?.annualTaxIdr).toBe(18_300_000);
        expect(r.annual?.priorPph21Idr).toBe(20_000_000);
        expectAccounting(r);
        expectBounds(r, { de: c.de ?? 150_000, ce: c.ce, cr: c.cr });
      });

    // with base, proportional (updated for bead legend-mmgd: signed balances,
    //   and bead legend-4ndx: W is capped at the available pay, the excess is
    //   the company's):
    //   bR = 9_818_181 - 17_450_000 = -7_631_819, bE = -2_000_000 + 7_631_819 =
    //   5_631_819 (as O5: the employee is short, the company over-paid).
    //   Employee's own amount De + bE = 150_000 + 5_631_819 = 5_781_819, but
    //   the cap is gross lines + gross_up + net lines - deductible =
    //   1_000_000 + 1_000_000 + 0 - 0 = 2_000_000 (the allowance is 0 here), so
    //   excess = 5_781_819 - 2_000_000 = 3_781_819 and W = 2_000_000 (no
    //   refund). Company: r = Dr + bR + excess = 150_000 - 7_631_819 +
    //   3_781_819 = -3_700_000 < 0 => company refund 3_700_000, borne 0 (the
    //   excess only reduces the refund). Check: 2_000_000 - 3_700_000 =
    //   -1_700_000 = T. (Without the cap: W 5_781_819, company refund
    //   7_481_819.)
    check("with scheme base", MIXED_BASES, "proportional", {
      w: 2_000_000,
      refund: 0,
      employerRefund: 3_700_000,
      ce: 0,
      cr: 7_631_819,
      de: 2_000_000, // the available pay (bead legend-4ndx), below De + bE 5_781_819
    });
    // with base, gross_first: Ce = 500_000, Cr = 1_500_000. Employee: 150_000
    //   - 500_000 < 0 -> W = 0, refund 350_000. Company: 150_000 - 1_500_000
    //   -> refund 1_350_000. Check: -350_000 - 1_350_000 = -1_700_000 = T.
    check("with scheme base", MIXED_BASES, "gross_first", {
      w: 0,
      refund: 350_000,
      employerRefund: 1_350_000,
      ce: 500_000,
      cr: 1_500_000,
    });
    // no base, both policies: Ce = 255_000, Cr = 1_745_000. Employee: 150_000
    //   - 255_000 < 0 -> W = 0, refund 105_000. Company: 150_000 - 1_745_000
    //   -> refund 1_595_000. Check: -105_000 - 1_595_000 = -1_700_000 = T.
    for (const allocation of ALLOCATIONS)
      check("no scheme base", {}, allocation, {
        w: 0,
        refund: 105_000,
        employerRefund: 1_595_000,
        ce: 255_000,
        cr: 1_745_000,
      });
  });
});
