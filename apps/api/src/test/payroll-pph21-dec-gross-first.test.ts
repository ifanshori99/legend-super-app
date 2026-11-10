// PPh 21 December `gross_first` employee part (bead legend-y2lf, founder
// decision Q52; tingkat K, UU PPh Pasal 17(1)a, PMK 168/2023 Pasal 15 and 21).
//
// Before: the employee's December part was annual(P + G*) - annual(P) (P = ALL
// income Jan-Nov), while his Jan-Nov balance is annual(Gs) - paid (Gs = the
// gross-scheme part of Jan-Nov). Two scales: the employee could pay more than
// the tax his own gross pay carries (H7: own tax 150_000, charged 237_500).
// Now (priorMix > 0, Gs known): employee part = min(annual(Gs + G*) -
// annual(Gs), D), D = tax this month adds. priorMix = 0 keeps the old rule.
//
// Every expected value is computed BY HAND (python3 big integers, a model of
// the rules written apart from the engine) with REFERENCE_TABLES: biaya
// jabatan = min(5% x bruto, 6_000_000), PKP floored to whole thousands,
// TK/0 with NPWP, 12 months. annual(x) = Pasal 17 tax on a year's gross x:
//   annual(55_000_000) = 0 (net 52_250_000 < PTKP 54_000_000)
//   annual(60_000_000) = 150_000 (cost 3_000_000, net 57_000_000, PKP 3_000_000)
//   annual(62_000_000) = 245_000 (cost 3_100_000, net 58_900_000, PKP 4_900_000)
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PPH21_POLICY,
  computePph21Period,
} from "@starter/shared/hris/payroll";
import type { Pph21PolicyParameters } from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Input = Parameters<typeof computePph21Period>[2];

const run = (
  over: Partial<Input>,
  policy: Partial<Pph21PolicyParameters> = {
    mixedSchemeAllocation: "gross_first",
  },
) =>
  computePph21Period(REFERENCE_TABLES, { ...DEFAULT_PPH21_POLICY, ...policy }, {
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked: 12,
    taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior: {
      taxableGrossIdr: 0,
      employeeDeductibleIdr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
    },
    ...over,
  } as Input);

// Rule: withheld + borne - refunds = T (what the month adds to the year).
const expectBalanced = (r: ReturnType<typeof run>) =>
  expect(
    r.pph21WithheldIdr +
      r.pph21EmployerBorneIdr -
      r.pph21RefundIdr -
      r.pph21EmployerRefundIdr,
  ).toBe(r.pph21Idr);

describe("legend-y2lf: December gross_first employee part is annual(Gs + G*) - annual(Gs), capped at D", () => {
  it("H7: gross 5 jt + gross-up 5 jt every month: the employee's whole-year burden is his own tax 150_000, not 237_500", () => {
    // Prior (see H7 in payroll-pph21-history-split-reference.test.ts): 11
    // months, prior gross 111_265_990, withheld 2_503_490 (allowance
    // 1_265_990, so the employee paid pEeT = 1_237_500), Gs = 55_000_000,
    // E = 56_265_990. H = annual(111_265_990) - 2_503_490 = 2_585_100 -
    // 2_503_490 = 81_610. Employer balance bR = H - (annual(Gs) - pEeT) =
    // 81_610 + 1_237_500 = 1_319_110; employee balance bE = -1_237_500.
    // December: G* = 5_000_000, U = 5_000_000. Employee part = annual(60 jt) -
    //   annual(55 jt) = 150_000 - 0 = 150_000 (D = 917_700 is far above).
    //   Fixed point S (covered): S = Dr + bR, Dr = D - 150_000:
    //   S0=0         X 10_000_000 annual 3_189_750 D 604_650 Dr 454_650 next 1_773_760
    //   S1=1_773_760 X 11_773_760 annual 3_455_850 D 870_750 Dr 720_750 next 2_039_860
    //   S2=2_039_860 X 12_039_860 annual 3_495_750 D 910_650 Dr 760_650 next 2_079_760
    //   S3=2_079_760 X 12_079_760 annual 3_501_750 D 916_650 Dr 766_650 next 2_085_760
    //   S4=2_085_760 X 12_085_760 annual 3_502_650 D 917_550 Dr 767_550 next 2_086_660
    //   S5=2_086_660 X 12_086_660 annual 3_502_800 D 917_700 Dr 767_700 next 2_086_810
    //   S6=2_086_810 X 12_086_810 annual 3_502_800 D 917_700 Dr 767_700 next 2_086_810 stop.
    //   X = 12_086_810, T = 3_502_800 - 2_503_490 = 999_310.
    // Employee: 150_000 + bE = -1_087_500 => W = 0, refund 1_087_500. Company:
    //   767_700 + 1_319_110 = 2_086_810 = allowance (gross_up line, no net).
    //   Check: 2_086_810 - 1_087_500 = 999_310 = T.
    // Employee whole year: paid 1_237_500 + W 0 - refund 1_087_500 = 150_000 =
    //   annual(60 jt), his own tax. (Old rule: 1_237_500 - 1_000_000 = 237_500.)
    const r = run({
      taxableLines: [
        { amountIdr: 5_000_000, taxScheme: "gross" },
        { amountIdr: 5_000_000, taxScheme: "gross_up" },
      ],
      prior: {
        taxableGrossIdr: 111_265_990,
        employeeDeductibleIdr: 0,
        pph21WithheldIdr: 2_503_490,
        pph21EmployerBorneIdr: 0,
        taxAllowanceIdr: 1_265_990,
        grossSchemeBaseIdr: 55_000_000,
        employerSchemeBaseIdr: 56_265_990,
      },
    });
    expect(r.taxableGrossIdr).toBe(12_086_810);
    expect(r.pph21Idr).toBe(999_310);
    expect(r.taxAllowanceIdr).toBe(2_086_810);
    expect(r.pph21WithheldIdr).toBe(2_086_810);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(1_087_500);
    expect(r.pph21EmployerRefundIdr).toBe(0);
    expect(r.annual?.annualTaxIdr).toBe(3_502_800);
    expectBalanced(r);
    const priorEmployeeTax = 2_503_490 - 1_265_990;
    const employeeWhole =
      priorEmployeeTax +
      (r.pph21WithheldIdr - r.taxAllowanceIdr) -
      r.pph21RefundIdr;
    expect(employeeWhole).toBe(150_000);
    expect(employeeWhole).toBeLessThanOrEqual(150_000);
  });

  it("no gross-up (all gross, no employer scheme): the result is the same as before the change", () => {
    // Prior 55_000_000 all gross scheme, nothing withheld (annual(55 jt) = 0,
    // H = 0). December gross 7_000_000: Gs = P, so annual(Gs + G*) -
    // annual(Gs) = annual(62 jt) - annual(55 jt) = 245_000 = D (X = G*, no S):
    // W = T = 245_000, identical under the old formula (P = Gs).
    const prior = {
      taxableGrossIdr: 55_000_000,
      employeeDeductibleIdr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      taxAllowanceIdr: 0,
      grossSchemeBaseIdr: 55_000_000,
      employerSchemeBaseIdr: 0,
    };
    const lines = [{ amountIdr: 7_000_000, taxScheme: "gross" as const }];
    const gf = run({ taxableLines: lines, prior });
    expect(gf.taxableGrossIdr).toBe(7_000_000);
    expect(gf.pph21Idr).toBe(245_000);
    expect(gf.pph21WithheldIdr).toBe(245_000);
    expect(gf.pph21EmployerBorneIdr).toBe(0);
    expect(gf.taxAllowanceIdr).toBe(0);
    expect(gf.pph21RefundIdr).toBe(0);
    expect(gf.pph21EmployerRefundIdr).toBe(0);
    expectBalanced(gf);
    const pr = run(
      { taxableLines: lines, prior },
      { mixedSchemeAllocation: "proportional" },
    );
    expect(pr.pph21WithheldIdr).toBe(gf.pph21WithheldIdr);
    expect(pr.pph21Idr).toBe(gf.pph21Idr);
  });

  it("cap D: the employee part never exceeds the tax the month adds (annual(Gs + G*) - annual(Gs) = 71_300 > D = 71_250)", () => {
    // Prior: Gs = 59_111_407, E = 13_209_757 (gross 72_321_164), withheld
    // 690_896 = allowance 641_759 + employee 49_137, borne 0.
    //   annual(Gs) = 107_750, annual(P) = 735_250 => H = 735_250 - 690_896 =
    //   44_354. bR = H - (annual(Gs) - 49_137) = 44_354 - 58_613 = -14_259,
    //   bE = 58_613.
    // December gross 1_500_606 (G* = X, no S): own = annual(Gs + G*) -
    //   annual(Gs) = 179_050 - 107_750 = 71_300; T = annual(P + G*) - 690_896 =
    //   806_500 - 690_896 = 115_604, D = T - H = 115_604 - 44_354 = 71_250 <
    //   71_300 (PKP is floored to whole thousands) => part = 71_250. W = 71_250 + 58_613 = 129_863;
    //   employer refund 14_259 (the allowance it over-paid). Check:
    //   129_863 - 14_259 = 115_604 = T.
    const r = run({
      taxableLines: [{ amountIdr: 1_500_606, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 72_321_164,
        employeeDeductibleIdr: 0,
        pph21WithheldIdr: 690_896,
        pph21EmployerBorneIdr: 0,
        taxAllowanceIdr: 641_759,
        grossSchemeBaseIdr: 59_111_407,
        employerSchemeBaseIdr: 13_209_757,
      },
    });
    expect(r.taxableGrossIdr).toBe(1_500_606);
    expect(r.pph21Idr).toBe(115_604);
    expect(r.pph21WithheldIdr).toBe(129_863);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.pph21EmployerRefundIdr).toBe(14_259);
    expect(r.annual?.annualTaxIdr).toBe(806_500);
    expectBalanced(r);
  });

  it("priorMix = 0 (no scheme bases, Gs unknown): keeps the old rule annual(P + G*) - annual(P)", () => {
    // Prior 100_000_000 gross, withheld 2_000_000, no scheme bases, no
    // allowance reported (E = 0, nothing to hide). H = annual(100 jt) -
    // 2_000_000 = 2_050_000 - 2_000_000 = 50_000, all the employee's (no
    // employer tax paid). December gross 5_000_000 + gross-up 3_000_000.
    // Old rule: own = annual(105 jt) - annual(100 jt) = 2_287_500 - 2_050_000 =
    // 237_500 (annual(105 jt): cost 5_250_000, net 99_750_000, PKP 45_750_000).
    // The employer part S is the least fixed point of S = D - 237_500 (D =
    // T - H, T = annual(100 jt + 8_000_000 + S) - 2_000_000):
    //   S0=0         X 8_000_000 annual 2_430_000 D 380_000 next 142_500
    //   S1=142_500   X 8_142_500 annual 2_436_750 D 386_750 next 149_250
    //   S2=149_250   X 8_149_250 annual 2_437_050 D 387_050 next 149_550
    //   S3=149_550   X 8_149_550 annual 2_437_100 D 387_100 next 149_600
    //   S4=149_600   X 8_149_600 annual 2_437_100 D 387_100 next 149_600 stop.
    //   X = 8_149_600, T = 2_437_100 - 2_000_000 = 437_100.
    // Employee: 237_500 + 50_000 = 287_500 = W (cap 8_000_000); allowance
    // 149_600; withheld 437_100 = T.
    const r = run({
      taxableLines: [
        { amountIdr: 5_000_000, taxScheme: "gross" },
        { amountIdr: 3_000_000, taxScheme: "gross_up" },
      ],
      prior: {
        taxableGrossIdr: 100_000_000,
        employeeDeductibleIdr: 0,
        pph21WithheldIdr: 2_000_000,
        pph21EmployerBorneIdr: 0,
      },
    });
    expect(r.taxableGrossIdr).toBe(8_149_600);
    expect(r.pph21Idr).toBe(437_100);
    expect(r.pph21WithheldIdr).toBe(437_100);
    expect(r.taxAllowanceIdr).toBe(149_600);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.pph21EmployerRefundIdr).toBe(0);
    expect(r.annual?.annualTaxIdr).toBe(2_437_100);
    expect(r.pph21WithheldIdr - r.taxAllowanceIdr).toBe(287_500);
    expectBalanced(r);
  });
});
