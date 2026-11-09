// PPh 21 reference suite, Part D: how the Jan-Nov history shortfall H of the
// masa pajak terakhir is split between employee and employer (beads
// legend-6q7o a/b/c, legend-6p71; brief docs/briefs/sub-pph21-history-split.md,
// tingkat K; PMK 168/2023 Pasal 15(1)-(3) and Pasal 21).
//
// Every expected value below is computed BY HAND (python3 big-integer
// arithmetic) from the regulation and the brief's rules A-E, using
// REFERENCE_TABLES (fixtures/payroll/statutory-tables.ts), never by calling or
// copying engine code. Same conventions as payroll-pph21-annual.test.ts
// (X = G + U + N + tax allowance + employer-borne tax; one half_up rounding per
// tax amount; prior months use monthly TER on X without JHT/JP deduction; biaya
// jabatan = min(floor(5% x bruto), floor(6_000_000 x months / 12)); PKP floored
// to whole thousands; TK/0, with NPWP).
//
// Notation (brief): H = annual tax on prior income alone - priorTax (priorTax =
// prior withheld + prior borne). E / Gs = prior employer / gross scheme base.
// pET = prior employer tax = priorBorne + priorAllowance (rule A). G* = this
// period's employee (gross-scheme) part. T = annual(prior + X) - priorTax.
// Rule B, `proportional`: employerHistory = clamp(floor((H + priorTax) x E /
//   (E + Gs)) - pET, 0, H); employeeHistory = H - employerHistory.
// Rule B, `gross_first` (known scheme mix): employeeHistory =
//   clamp(annual(Gs) - (priorTax - pET), 0, H), annual(Gs) = Pasal 17 annual
//   tax on the prior gross-scheme base alone; employerHistory = H - employeeHistory.
// Rule C (`proportional`): W = employeeHistory + floor((T - H) x G* / X).
// Rule D (X = 0): W = min(employeeHistory, T); the employer's part is borne.
// Rule E (`gross_first`): W = min(T, [annual(prior + G*) - annual(prior)] +
//   employeeHistory) (= taxOf(G*) - H + employeeHistory). The employer's part S is a least fixed point:
//   S0 = 0, S_{k+1} = T(X0 + S_k) - W(X0 + S_k), stop when S_{k+1} <= S_k.
//
// Sources: PMK 168/2023 Pasal 10(2), 15(1)-(3), 21; UU PPh Pasal 17(1)a, 17(4);
// FAQ DJP PMK-66 no. 40 (employer-borne tax is taxable income); PP 58/2023
// Lampiran A (TER kategori A). URLs: see the header of
// payroll-pph21-annual.test.ts.
//
// Assumptions where the brief is silent (flagged in the report):
// - A1: with no lines at all (X0 = 0, case H2) there is no U + N to carry an
//   allowance, so the employer's part of December is booked as borne tax
//   (pph21EmployerBorneIdr), taxAllowanceIdr = 0.
// - A2: in the `proportional` December cases the expected S / W follow the
//   brief's fixed-point iteration literally (the floor in rule C makes the
//   sequence move by 1 rupiah, see traces); a different stopping rule would
//   shift those figures by a few rupiah.
// - A3: the RangeError of rule A is thrown for any prior with
//   priorWithheld > 0 and E > 0 that omits `taxAllowanceIdr`, including
//   employerSchemeBaseIdr as the only scheme field.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PPH21_POLICY,
  buildPph21Prior,
  computePayslipTax,
} from "@starter/shared/hris/payroll";
import type {
  Pph21PolicyParameters,
  PayslipTaxEarning,
  PayslipTaxInput,
} from "@starter/shared/hris/payroll";
import { computePph21Period } from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Input = Parameters<typeof computePph21Period>[2];

const ALLOCATIONS = ["proportional", "gross_first"] as const;

const prior = (
  taxableGrossIdr: number,
  pph21WithheldIdr: number,
  pph21EmployerBorneIdr = 0,
  employeeDeductibleIdr = 0,
) => ({
  taxableGrossIdr,
  employeeDeductibleIdr,
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
    taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior: prior(0, 0),
    ...over,
  } as Input);

// Eleven months of gross-up salary 8_000_000 (TER A row 7, 1,5%): each month
// S = 121_827, X = 8_121_827 (8_121_827 x 150 / 10000 = 121_827,405 -> 121_827,
// stable; see P1 of payroll-pph21-prior-reference.test.ts). All of it is the
// employer's money: withheld = allowance = 11 x 121_827 = 1_340_097, borne 0,
// prior gross X = 11 x 8_121_827 = 89_340_097, scheme base all employer.
const GROSS_UP_YEAR = {
  ...prior(89_340_097, 1_340_097, 0),
  taxAllowanceIdr: 1_340_097,
  grossSchemeBaseIdr: 0,
  employerSchemeBaseIdr: 89_340_097,
};

describe("PPh 21 history split between employee and employer (legend-6q7o, legend-6p71)", () => {
  it("H1 (6q7o a) gross December after a pure gross-up year: the Jan-Nov shortfall is the employer's, the employee pays only the tax on his own December salary", () => {
    // H = annual(89_340_097) - 1_340_097: cost 4_467_004, net 84_873_093,
    //   PKP 30_873_000, tax 1_543_650 -> H = 203_553.
    // pET = 0 + 1_340_097; E = 89_340_097, Gs = 0, mix > 0:
    //   floor((203_553 + 1_340_097) x E / E) - 1_340_097 = 203_553 = H
    //   => employerHistory 203_553, employeeHistory 0.
    // December gross 8_000_000 (G* = 8_000_000). X = 8_000_000 + S (S = borne).
    // gross_first: W = annual(97_340_097) - annual(89_340_097) + 0
    //   = 1_923_650 - 1_543_650 = 380_000 (cost 4_867_004, net 92_473_093, PKP 38_473_000).
    //   S0=0       T 583_553 W 380_000 next 203_553
    //   S1=203_553 T 593_203 W 380_000 next 213_203
    //   S2=213_203 T 593_653 W 380_000 next 213_653
    //   S3=213_653 T 593_703 W 380_000 next 213_703
    //   S4=213_703 gross 97_553_800 PKP 38_676_000 annual 1_933_800 T 593_703 next 213_703 stop.
    //   X = 8_213_703, T = 1_933_800 - 1_340_097 = 593_703; withheld 380_000, borne 213_703.
    // proportional: W = 0 + floor((T - H) x 8_000_000 / X), iterated:
    //   S0=0       T 583_553 W 380_000 next 203_553
    //   S1=203_553 T 593_203 W 379_981 next 213_222
    //   S2=213_222 T 593_653 W 379_972 next 213_681
    //   S3=213_681 T 593_703 W 380_000 next 213_703
    //   S4=213_703 T 593_703 W 379_999 next 213_704
    //   S5=213_704 gross 97_553_801 annual 1_933_800 T 593_703 W 379_999 next 213_704 stop.
    //   X = 8_213_704; withheld 379_999, borne 213_704.
    // The old proportional rule charged the employee 583_553 (= T at S0, the
    // employer's gross-up history shortfall included).
    const input = {
      taxableLines: [{ amountIdr: 8_000_000, taxScheme: "gross" as const }],
      prior: GROSS_UP_YEAR,
    };

    const grossFirst = run(input, { mixedSchemeAllocation: "gross_first" });
    expect(grossFirst.method).toBe("annual_recalculation");
    expect(grossFirst.taxableGrossIdr).toBe(8_213_703);
    expect(grossFirst.pph21Idr).toBe(593_703);
    expect(grossFirst.pph21WithheldIdr).toBe(380_000);
    expect(grossFirst.pph21EmployerBorneIdr).toBe(213_703);
    expect(grossFirst.taxAllowanceIdr).toBe(0);
    expect(grossFirst.pph21RefundIdr).toBe(0);
    expect(grossFirst.pph21EmployerRefundIdr).toBe(0);
    expect(grossFirst.annual?.annualTaxIdr).toBe(1_933_800);
    expect(grossFirst.annual?.priorPph21Idr).toBe(1_340_097);

    const proportional = run(input, { mixedSchemeAllocation: "proportional" });
    expect(proportional.method).toBe("annual_recalculation");
    expect(proportional.taxableGrossIdr).toBe(8_213_704);
    expect(proportional.pph21Idr).toBe(593_703);
    expect(proportional.pph21WithheldIdr).toBe(379_999);
    expect(proportional.pph21EmployerBorneIdr).toBe(213_704);
    expect(proportional.taxAllowanceIdr).toBe(0);
    expect(proportional.pph21RefundIdr).toBe(0);
    expect(proportional.pph21EmployerRefundIdr).toBe(0);
    expect(proportional.annual?.annualTaxIdr).toBe(1_933_800);

    // Invariants: A + B + W = T; the employee never exceeds T, and pays far
    // less than the old 583_553.
    for (const r of [grossFirst, proportional]) {
      expect(r.pph21WithheldIdr + r.pph21EmployerBorneIdr).toBe(r.pph21Idr);
      expect(r.pph21WithheldIdr).toBeLessThan(583_553);
    }
  });

  for (const allocation of ALLOCATIONS) {
    it(`H2 (6q7o b, ${allocation}) last period with no payment after a pure gross-up year: the employee bears nothing, the employer books the whole shortfall as borne tax`, () => {
      // December pays nothing (no lines, X0 = 0). Same prior as H1:
      //   H = 203_553, employerHistory 203_553, employeeHistory 0 (rule B).
      // Rule D: W = min(employeeHistory 0, T) = 0 under both policies. The
      // employer's part is borne tax and itself taxable (X = S):
      //   S0=0       gross 89_340_097 annual 1_543_650 T 203_553 next 203_553
      //   S1=203_553 gross 89_543_650 annual 1_553_300 T 213_203
      //   S2=213_203 gross 89_553_300 annual 1_553_750 T 213_653
      //   S3=213_653 gross 89_553_750 annual 1_553_800 T 213_703
      //   S4=213_703 gross 89_553_800 annual 1_553_800 T 213_703 stop.
      //   X = 213_703, T = 1_553_800 - 1_340_097 = 213_703; withheld 0, borne 213_703.
      // The old rule made the pure gross-up employee withhold the whole 203_553.
      const r = run(
        { taxableLines: [], prior: GROSS_UP_YEAR },
        { mixedSchemeAllocation: allocation },
      );
      expect(r.method).toBe("annual_recalculation");
      expect(r.taxableGrossIdr).toBe(213_703);
      expect(r.pph21Idr).toBe(213_703);
      expect(r.pph21WithheldIdr).toBe(0);
      expect(r.pph21EmployerBorneIdr).toBe(213_703);
      expect(r.taxAllowanceIdr).toBe(0);
      expect(r.pph21RefundIdr).toBe(0);
      expect(r.pph21EmployerRefundIdr).toBe(0);
      expect(r.annual?.annualTaxIdr).toBe(1_553_800);
      expect(r.annual?.priorPph21Idr).toBe(1_340_097);
    });
  }

  it("H3 (6q7o c, legend-mmgd) net TER-0% months followed by taxed gross months: each payer settles its own balance, the employee's over-payment is not used to cover the company's shortfall", () => {
    // Updated for bead legend-mmgd (brief sub-pph21-unclamped): the signed
    // balances bE + bR = H are no longer clamped to [0, H].
    // Jan-Jun net 5_400_000 (TER A row 1, 0%): no tax, X = 5_400_000 each, all
    //   employer scheme. Jul-Nov gross 10_000_000 (TER A row 9, 2%): withheld
    //   200_000 each. Prior gross = 6 x 5_400_000 + 5 x 10_000_000 = 82_400_000;
    //   withheld 1_000_000, borne 0, allowance 0; E = 32_400_000, Gs = 50_000_000.
    // H = annual(82_400_000) - 1_000_000: cost 4_120_000, net 78_280_000,
    //   PKP 24_280_000, tax 1_214_000 -> H = 214_000.
    // pET = 0, pEeT = 1_000_000.
    //   proportional: bR = floor(1_214_000 x 32_400_000 / 82_400_000) - 0 =
    //     floor(477_349,51) = 477_349 (an earlier draft said 477_364); bE =
    //     214_000 - 477_349 = -263_349.
    //   gross_first: annual(Gs = 50_000_000) = 0 (PKP 0) => bE = 0 - 1_000_000
    //     = -1_000_000, bR = 214_000 + 1_000_000 = 1_214_000.
    //   The employee over-paid; the old clamp to [0, H] hid this and charged
    //   him as if his balance were 0 (old W 475_000 / 474_978).
    // December gross 10_000_000, G* = X0 = 10_000_000. annual(92_400_000): cost
    //   4_620_000, net 87_780_000, PKP 33_780_000 -> 1_689_000, so the gross_first
    //   De cap = 1_689_000 - 1_214_000 = 475_000. D = annual(prior + X) - 1_214_000,
    //   covered_{k+1} = max(0, Dr + bR), Dr = D - De:
    // gross_first (De = 475_000 every step):
    //   S0=0         X 10_000_000 annual 1_689_000 T 689_000 D 475_000 Dr 0 next 1_214_000
    //   S1=1_214_000 X 11_214_000 annual 1_746_650 T 746_650 D 532_650 Dr 57_650 next 1_271_650
    //   S2=1_271_650 X 11_271_650 annual 1_749_400 T 749_400 D 535_400 Dr 60_400 next 1_274_400
    //   S3=1_274_400 X 11_274_400 annual 1_749_500 T 749_500 D 535_500 Dr 60_500 next 1_274_500
    //   S4=1_274_500 X 11_274_500 annual 1_749_500 T 749_500 D 535_500 Dr 60_500 next 1_274_500 stop.
    //   X = 11_274_500, T = 1_749_500 - 1_000_000 = 749_500. Employee: e =
    //   475_000 - 1_000_000 < 0 => W = 0, refund 525_000. Company: r = 60_500 +
    //   1_214_000 = 1_274_500 = borne. Check: 0 + 1_274_500 - 525_000 = 749_500.
    // proportional (De = floor(D x 10_000_000 / X)):
    //   S0=0       X 10_000_000 annual 1_689_000 T 689_000 D 475_000 De 475_000 Dr 0 next 477_349
    //   S1=477_349 X 10_477_349 annual 1_711_650 T 711_650 D 497_650 De 474_977 Dr 22_673 next 500_022
    //   S2=500_022 X 10_500_022 annual 1_712_750 T 712_750 D 498_750 De 474_999 Dr 23_751 next 501_100
    //   S3=501_100 X 10_501_100 annual 1_712_800 T 712_800 D 498_800 De 474_997 Dr 23_803 next 501_152
    //   S4=501_152 X 10_501_152 annual 1_712_800 T 712_800 D 498_800 De 474_995 Dr 23_805 next 501_154
    //   S5=501_154 X 10_501_154 annual 1_712_800 T 712_800 D 498_800 De 474_995 Dr 23_805 next 501_154 stop.
    //   X = 10_501_154, T = 712_800. Employee: e = 474_995 - 263_349 = 211_646 =
    //   W. Company: r = 23_805 + 477_349 = 501_154 = borne.
    //   Check: 211_646 + 501_154 = 712_800.
    const prior3 = {
      ...prior(82_400_000, 1_000_000, 0),
      taxAllowanceIdr: 0,
      grossSchemeBaseIdr: 50_000_000,
      employerSchemeBaseIdr: 32_400_000,
    };
    const input = {
      taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" as const }],
      prior: prior3,
    };

    const grossFirst = run(input, { mixedSchemeAllocation: "gross_first" });
    expect(grossFirst.method).toBe("annual_recalculation");
    expect(grossFirst.taxableGrossIdr).toBe(11_274_500);
    expect(grossFirst.pph21Idr).toBe(749_500);
    expect(grossFirst.pph21WithheldIdr).toBe(0);
    expect(grossFirst.pph21EmployerBorneIdr).toBe(1_274_500);
    expect(grossFirst.taxAllowanceIdr).toBe(0);
    expect(grossFirst.pph21RefundIdr).toBe(525_000);
    expect(grossFirst.pph21EmployerRefundIdr).toBe(0);
    expect(grossFirst.annual?.annualTaxIdr).toBe(1_749_500);
    expect(grossFirst.annual?.priorPph21Idr).toBe(1_000_000);

    const proportional = run(input, { mixedSchemeAllocation: "proportional" });
    expect(proportional.method).toBe("annual_recalculation");
    expect(proportional.taxableGrossIdr).toBe(10_501_154);
    expect(proportional.pph21Idr).toBe(712_800);
    expect(proportional.pph21WithheldIdr).toBe(211_646);
    expect(proportional.pph21EmployerBorneIdr).toBe(501_154);
    expect(proportional.taxAllowanceIdr).toBe(0);
    expect(proportional.pph21RefundIdr).toBe(0);
    expect(proportional.pph21EmployerRefundIdr).toBe(0);
    expect(proportional.annual?.annualTaxIdr).toBe(1_712_800);

    for (const r of [grossFirst, proportional]) {
      expect(
        r.pph21WithheldIdr +
          r.pph21EmployerBorneIdr -
          r.pph21RefundIdr -
          r.pph21EmployerRefundIdr,
      ).toBe(r.pph21Idr);
    }
  });

  it("H4 (legend-mmgd) mixed payer history (net Jan-Jun, gross Jul-Nov): `proportional` splits H by scheme mix minus what the employer already paid; `gross_first` refunds the employee what he over-paid beyond his own gross base", () => {
    // Updated for bead legend-mmgd (brief sub-pph21-unclamped): balances are
    // signed, no clamp to [0, H].
    // Jan-Jun net 10_000_000: S = 230_179, X = 10_230_179 (see R28), borne
    //   230_179 each. Jul-Nov gross 10_000_000: withheld 200_000 each.
    // Prior gross = 6 x 10_230_179 + 5 x 10_000_000 = 111_381_074; withheld
    //   1_000_000; borne 1_381_074; allowance 0; priorTax 2_381_074;
    //   E = 61_381_074, Gs = 50_000_000 (same prior as R53).
    // H = annual(111_381_074) - 2_381_074: cost 5_569_053, net 105_812_021,
    //   PKP 51_812_000, tax 2_590_600 -> H = 209_526.
    // pET = 1_381_074 + 0; pEeT = priorTax - pET = 1_000_000.
    //   proportional: bR = floor(2_590_600 x 61_381_074 / 111_381_074) - pET =
    //     1_427_655 - 1_381_074 = 46_581; bE = 209_526 - 46_581 = 162_945
    //     (same signs as the old clamp: unchanged).
    //   gross_first: annual(Gs = 50_000_000) = 0 => bE = 0 - 1_000_000 =
    //     -1_000_000 (the employee over-paid), bR = 209_526 + 1_000_000 =
    //     1_209_526. (Old clamp: bE 0, bR 209_526.)
    // December gross 10_000_000 (G* = X0). annual(121_381_074) = 3_207_150;
    //   gross_first De cap = 3_207_150 - 2_590_600 = 616_550.
    // gross_first (De = 616_550 every step):
    //   S0=0         X 10_000_000 annual 3_207_150 T 826_076 D 616_550 Dr 0 next 1_209_526
    //   S1=1_209_526 X 11_209_526 annual 3_388_500 T 1_007_426 D 797_900 Dr 181_350 next 1_390_876
    //   S2=1_390_876 X 11_390_876 annual 3_415_650 T 1_034_576 D 825_050 Dr 208_500 next 1_418_026
    //   S3=1_418_026 X 11_418_026 annual 3_419_850 T 1_038_776 D 829_250 Dr 212_700 next 1_422_226
    //   S4=1_422_226 X 11_422_226 annual 3_420_450 T 1_039_376 D 829_850 Dr 213_300 next 1_422_826
    //   S5=1_422_826 X 11_422_826 annual 3_420_450 T 1_039_376 D 829_850 Dr 213_300 next 1_422_826 stop.
    //   X = 11_422_826, T = 3_420_450 - 2_381_074 = 1_039_376. Employee: e =
    //   616_550 - 1_000_000 < 0 => W = 0, refund 383_450. Company: r = 213_300 +
    //   1_209_526 = 1_422_826 = borne. Check: 1_422_826 - 383_450 = 1_039_376.
    // proportional (bE = 162_945, bR = 46_581, De = floor(D x 10_000_000 / X)):
    //   S0=0      X 10_000_000 annual 3_207_150 T 826_076 D 616_550 De 616_550 Dr 0 next 46_581
    //   S1=46_581 X 10_046_581 annual 3_214_050 T 832_976 D 623_450 De 620_559 Dr 2_891 next 49_472
    //   S2=49_472 X 10_049_472 annual 3_214_500 T 833_426 D 623_900 De 620_828 Dr 3_072 next 49_653
    //   S3=49_653 X 10_049_653 annual 3_214_500 T 833_426 D 623_900 De 620_817 Dr 3_083 next 49_664
    //   S4=49_664 X 10_049_664 annual 3_214_500 T 833_426 D 623_900 De 620_816 Dr 3_084 next 49_665
    //   S5=49_665 X 10_049_665 annual 3_214_500 T 833_426 D 623_900 De 620_816 Dr 3_084 next 49_665 stop.
    //   X = 10_049_665, T = 833_426. W = 620_816 + 162_945 = 783_761; borne =
    //   3_084 + 46_581 = 49_665. Check: 783_761 + 49_665 = 833_426.
    const prior4 = {
      ...prior(111_381_074, 1_000_000, 1_381_074),
      taxAllowanceIdr: 0,
      grossSchemeBaseIdr: 50_000_000,
      employerSchemeBaseIdr: 61_381_074,
    };
    const input = {
      taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" as const }],
      prior: prior4,
    };

    const grossFirst = run(input, { mixedSchemeAllocation: "gross_first" });
    expect(grossFirst.taxableGrossIdr).toBe(11_422_826);
    expect(grossFirst.pph21Idr).toBe(1_039_376);
    expect(grossFirst.pph21WithheldIdr).toBe(0);
    expect(grossFirst.pph21EmployerBorneIdr).toBe(1_422_826);
    expect(grossFirst.pph21RefundIdr).toBe(383_450);
    expect(grossFirst.annual?.annualTaxIdr).toBe(3_420_450);
    expect(grossFirst.annual?.priorPph21Idr).toBe(2_381_074);

    const proportional = run(input, { mixedSchemeAllocation: "proportional" });
    expect(proportional.taxableGrossIdr).toBe(10_049_665);
    expect(proportional.pph21Idr).toBe(833_426);
    expect(proportional.pph21WithheldIdr).toBe(783_761);
    expect(proportional.pph21EmployerBorneIdr).toBe(49_665);
    expect(proportional.pph21RefundIdr).toBe(0);
    expect(proportional.annual?.annualTaxIdr).toBe(3_214_500);

    for (const r of [grossFirst, proportional]) {
      expect(
        r.pph21WithheldIdr +
          r.pph21EmployerBorneIdr -
          r.pph21RefundIdr -
          r.pph21EmployerRefundIdr,
      ).toBe(r.pph21Idr);
      expect(r.taxAllowanceIdr).toBe(0);
      expect(r.pph21EmployerRefundIdr).toBe(0);
    }
  });

  for (const allocation of ALLOCATIONS) {
    it(`H5 (invariant, ${allocation}) pure gross year: the employer bears none of the Jan-Nov shortfall`, () => {
      // Jan-Nov gross 10_000_000 (TER A 2% => 200_000): prior gross 110_000_000,
      // withheld 2_200_000, borne 0, allowance 0; Gs = 110_000_000, E = 0.
      // H = annual(110_000_000) - 2_200_000: cost 5_500_000, net 104_500_000,
      //   PKP 50_500_000, tax 2_525_000 -> H = 325_000.
      // Rule B, proportional: floor(2_525_000 x 0 / 110_000_000) - 0 = 0 =>
      //   employerHistory 0, employeeHistory 325_000. Rule B, gross_first:
      //   annual(Gs = 110_000_000) = 2_525_000, pEeT = 2_200_000 - 0 =>
      //   employeeHistory = clamp(325_000, 0, 325_000) = 325_000, same split.
      //   G* = X = 10_000_000, no S: W = T.
      //   December gross 10_000_000: gross 120_000_000, PKP 60_000_000, tax
      //   3_000_000, T = 3_000_000 - 2_200_000 = 800_000 (same as R19).
      const r = run(
        {
          prior: {
            ...prior(110_000_000, 2_200_000, 0),
            taxAllowanceIdr: 0,
            grossSchemeBaseIdr: 110_000_000,
            employerSchemeBaseIdr: 0,
          },
        },
        { mixedSchemeAllocation: allocation },
      );
      expect(r.taxableGrossIdr).toBe(10_000_000);
      expect(r.pph21Idr).toBe(800_000);
      expect(r.pph21WithheldIdr).toBe(800_000);
      expect(r.pph21EmployerBorneIdr).toBe(0);
      expect(r.taxAllowanceIdr).toBe(0);
      expect(r.pph21RefundIdr).toBe(0);
      expect(r.pph21EmployerRefundIdr).toBe(0);
    });
  }

  it("H7 (architect, legend-mmgd) gross 5 jt + gross-up 5 jt every month, gross_first: the employee owes tax only on his own 5 jt and is refunded the rest of his over-payment; the company's shortfall is its allowance", () => {
    // Updated for bead legend-mmgd (brief sub-pph21-unclamped): signed
    // balances, no clamp to [0, H].
    // Each Jan-Nov month: gross 5_000_000 + gross_up 5_000_000, TER A. X = 10_000_000 + A,
    //   A = employer allowance = round_half_up(2,25% x (5_000_000 + A)) (the gross-up
    //   part is grossed up, the 5_000_000 gross part is taxed as is):
    //   A = 115_090: 5_115_090 x 225 / 10000 = 115_089,525 -> 115_090 (stable; 115_089
    //   would give 115_090). X = 10_115_090 (TER row 10: 2,25%, bound 10_350_000),
    //   tax = 10_115_090 x 225 / 10000 = 227_589,525 -> 227_590; employee's own
    //   part 227_590 - 115_090 = 112_500 (= 2,25% x 5_000_000).
    // 11 months: prior gross 111_265_990, withheld 2_503_490 (11 x 227_590), allowance
    //   1_265_990 (11 x 115_090), borne 0; Gs = 55_000_000, E = 56_265_990.
    // H = annual(111_265_990) - 2_503_490: cost 5_563_299, net 105_702_691, PKP 51_702_000,
    //   tax 2_585_100 -> H = 81_610. pET = 0 + 1_265_990, pEeT = 2_503_490 - 1_265_990
    //   = 1_237_500. gross_first: annual(55_000_000) = 0 (PKP 0) =>
    //   bE = 0 - 1_237_500 = -1_237_500 (the employee over-paid), bR = 81_610 +
    //   1_237_500 = 1_319_110. (The old clamp to [0, H] gave bE 0, bR 81_610.)
    // December the same lines: G* = 5_000_000, X0 = 10_000_000, U = 5_000_000,
    //   N = 0. De cap = annual(116_265_990) - 2_585_100: cost 5_813_299, net
    //   110_452_691, PKP 56_452_000, tax 2_822_600 -> 237_500 (5% x 4_750_000).
    //   covered_{k+1} = max(0, Dr + bR), Dr = D - 237_500:
    //   S0=0         X 10_000_000 annual 3_189_750 T 686_260 D 604_650 Dr 367_150 next 1_686_260
    //   S1=1_686_260 X 11_686_260 annual 3_442_800 T 939_310 D 857_700 Dr 620_200 next 1_939_310
    //   S2=1_939_310 X 11_939_310 annual 3_480_750 T 977_260 D 895_650 Dr 658_150 next 1_977_260
    //   S3=1_977_260 X 11_977_260 annual 3_486_450 T 982_960 D 901_350 Dr 663_850 next 1_982_960
    //   S4=1_982_960 X 11_982_960 annual 3_487_200 T 983_710 D 902_100 Dr 664_600 next 1_983_710
    //   S5=1_983_710 X 11_983_710 annual 3_487_350 T 983_860 D 902_250 Dr 664_750 next 1_983_860
    //   S6=1_983_860 X 11_983_860 annual 3_487_350 T 983_860 D 902_250 Dr 664_750 next 1_983_860 stop.
    //   X = 11_983_860, T = 3_487_350 - 2_503_490 = 983_860. Employee: e =
    //   237_500 - 1_237_500 = -1_000_000 => W = 0, refund 1_000_000. Company:
    //   r = 664_750 + 1_319_110 = 1_983_860; December has a gross_up line and
    //   no net line, so A = min(covered x U/(U+N), r) = 1_983_860 allowance,
    //   borne 0 (as in R72). withheld = 0 + 1_983_860.
    //   Check: 1_983_860 - 1_000_000 = 983_860 = T.
    const december = [
      { amountIdr: 5_000_000, taxScheme: "gross" as const },
      { amountIdr: 5_000_000, taxScheme: "gross_up" as const },
    ];
    const r = run(
      {
        taxableLines: december,
        prior: {
          ...prior(111_265_990, 2_503_490, 0),
          taxAllowanceIdr: 1_265_990,
          grossSchemeBaseIdr: 55_000_000,
          employerSchemeBaseIdr: 56_265_990,
        },
      },
      { mixedSchemeAllocation: "gross_first" },
    );
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(11_983_860);
    expect(r.pph21Idr).toBe(983_860);
    expect(r.taxAllowanceIdr).toBe(1_983_860);
    expect(r.pph21WithheldIdr).toBe(1_983_860);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(1_000_000);
    expect(r.pph21EmployerRefundIdr).toBe(0);
    expect(r.annual?.annualTaxIdr).toBe(3_487_350);
    expect(r.annual?.priorPph21Idr).toBe(2_503_490);
    // The employee's own tax W = withheld - allowance = 0; he is refunded
    // 1_000_000 of his over-payment. withheld + borne - refund = T.
    expect(r.pph21WithheldIdr - r.taxAllowanceIdr).toBe(0);
    expect(
      r.pph21WithheldIdr +
        r.pph21EmployerBorneIdr -
        r.pph21RefundIdr -
        r.pph21EmployerRefundIdr,
    ).toBe(r.pph21Idr);
  });

  for (const allocation of ALLOCATIONS) {
    it(`guard (${allocation}): a prior with only grossSchemeBaseIdr (sum differs from taxableGrossIdr) is rejected with a RangeError`, () => {
      // Scheme bases must add up to the prior taxable gross (mix = E + Gs =
      // prior.taxableGrossIdr), otherwise the payer split is unknowable.
      // taxAllowanceIdr is given so that rule A is not what throws.
      const base = {
        ...prior(110_000_000, 2_200_000, 0),
        taxAllowanceIdr: 0,
      };
      expect(() =>
        run(
          { prior: { ...base, grossSchemeBaseIdr: 50_000_000 } },
          { mixedSchemeAllocation: allocation },
        ),
      ).toThrow(RangeError);
      // The same prior with the matching second base is accepted.
      expect(() =>
        run(
          {
            prior: {
              ...base,
              grossSchemeBaseIdr: 50_000_000,
              employerSchemeBaseIdr: 60_000_000,
            },
          },
          { mixedSchemeAllocation: allocation },
        ),
      ).not.toThrow();
    });
  }

  describe("H6 (6p71, Codex) exit after a net January and a gross February", () => {
    // Jan net 20_000_000 (TER A row 19, 9%): X = 21_978_022 (S = 1_978_022:
    //   21_978_022 x 900 / 10000 = 1_978_021,98 -> 1_978_022), borne 1_978_022.
    // Feb gross 10_000_000 (TER 2%): withheld 200_000. Employee leaves in March
    // (gross 1_000_000), monthsWorked 3.
    // prior gross = 21_978_022 + 10_000_000 = 31_978_022; withheld 200_000;
    // borne 1_978_022; E = 21_978_022, Gs = 10_000_000.
    // March: gross = 32_978_022; cost = min(floor(5% x ...) = 1_648_901,
    //   floor(6_000_000 x 3 / 12) = 1_500_000) = 1_500_000; net 31_478_022;
    //   PKP = max(0, 31_478_022 - 54_000_000) = 0; annual tax 0.
    //   T = 0 - (200_000 + 1_978_022) = -2_178_022: lebih potong Rf = 2_178_022.
    // Rule A: pET = 1_978_022 + allowance 0 => employer-funded share exact:
    //   proportional employerRefund = floor(2_178_022 x 1_978_022 / 2_178_022) = 1_978_022,
    //   employee refund 200_000; gross_first employee refund = min(Rf, 200_000)
    //   = 200_000, employer 1_978_022. (The old base-ratio pET gave 681_100 /
    //   1_496_922.)
    const base = {
      monthsWorked: 3,
      taxableLines: [{ amountIdr: 1_000_000, taxScheme: "gross" as const }],
    };
    const history = {
      ...prior(31_978_022, 200_000, 1_978_022),
      grossSchemeBaseIdr: 10_000_000,
      employerSchemeBaseIdr: 21_978_022,
    };

    for (const allocation of ALLOCATIONS) {
      it(`refund is split by who paid (${allocation})`, () => {
        const r = run(
          { ...base, prior: { ...history, taxAllowanceIdr: 0 } },
          { mixedSchemeAllocation: allocation },
        );
        expect(r.method).toBe("annual_recalculation");
        expect(r.taxableGrossIdr).toBe(1_000_000);
        expect(r.pph21Idr).toBe(-2_178_022);
        expect(r.pph21WithheldIdr).toBe(0);
        expect(r.pph21EmployerBorneIdr).toBe(0);
        expect(r.taxAllowanceIdr).toBe(0);
        expect(r.pph21RefundIdr).toBe(200_000);
        expect(r.pph21EmployerRefundIdr).toBe(1_978_022);
        expect(r.annual?.annualTaxIdr).toBe(0);
        expect(r.annual?.priorPph21Idr).toBe(2_178_022);
      });
    }

    it("rule A: rejects (RangeError) a prior with withheld tax and an employer scheme base but no taxAllowanceIdr, since the withheld amount may hide a gross-up allowance", () => {
      expect(() => run({ ...base, prior: history })).toThrow(RangeError);
      // Pure-gross history (E = 0) has no employer share to hide: allowed.
      expect(() =>
        run({
          ...base,
          prior: {
            ...prior(110_000_000, 2_200_000, 0),
            grossSchemeBaseIdr: 110_000_000,
            employerSchemeBaseIdr: 0,
          },
        }),
      ).not.toThrow();
      // Nothing withheld (all-net, all-borne history): allowed.
      expect(() =>
        run({
          ...base,
          prior: {
            ...prior(59_400_000, 0, 0),
            grossSchemeBaseIdr: 0,
            employerSchemeBaseIdr: 59_400_000,
          },
        }),
      ).not.toThrow();
    });
  });
});

// legend-m9gx: a month without taxable pay lines but with employer BPJS
// (employerBenefitIdr > 0) follows the tax scheme of the employment agreement
// (`contractTaxScheme`). Brief section "legend-m9gx". All figures below are
// hand computed (python3 big integers), never read from the engine.
//
// Assumptions (the brief is silent):
// - M1: the TER month figures use TER A (TK/0) with one half_up rounding; the
//   3_000_000 benefit falls in row 1 (0%), so every tax amount of that case is
//   0 and the case pins X and the stored scheme bases. An 8_000_000 benefit
//   (row 7, 1,5%) is added so that withheld / allowance / borne are non-zero.
// - M2: `contractTaxScheme` missing with benefit > 0 and no taxable line is a
//   RangeError in both a TER month and the last tax period. A zero benefit
//   with no lines needs no scheme.
// - M3: in the last period, with a gross_up line the employer's part of the
//   tax is an allowance inside withheld (as in H7), so the employee's own part
//   is pph21WithheldIdr - taxAllowanceIdr; with no line at all (rule D) it is
//   booked as borne tax (assumption A1 above).
describe("legend-m9gx benefit-only month follows the contract tax scheme", () => {
  const payslip = (over: Partial<PayslipTaxInput>) =>
    computePayslipTax({
      tables: REFERENCE_TABLES,
      policy: DEFAULT_PPH21_POLICY,
      ptkpStatus: "TK/0",
      hasTaxId: true,
      lastTaxPeriod: false,
      monthsWorked: 1,
      earnings: [],
      employerBenefitIdr: 0,
      employeeDeductibleIdr: 0,
      prior: prior(0, 0),
      ...over,
    });

  // Benefit 3_000_000 (X <= 5_400_000, TER A row 1, 0%): T = 0 under every
  // scheme, X = 3_000_000 (no tax to add). Stored bases follow G*:
  // gross => G* = 3_000_000, employer base 0; gross_up / net => G* = 0,
  // employer base X - 0 = 3_000_000.
  // Benefit 8_000_000 (row 7, 1,5%):
  //   gross:    X = 8_000_000, T = 8_000_000 x 150 / 10000 = 120_000, all
  //             withheld by the employee (G* = benefit); bases 8_000_000 / 0.
  //   gross_up: G* = 0, S = round_half_up(1,5% x (8_000_000 + S)) = 121_827
  //             (8_121_827 x 150 / 10000 = 121_827,405, stable), X = 8_121_827,
  //             T = 121_827 = allowance, withheld = allowance (the company's
  //             money inside the withheld tax), borne 0; bases 0 / 8_121_827.
  //   net:      G* = 0, same S, X = 8_121_827, T = 121_827 = borne,
  //             withheld 0, allowance 0; bases 0 / 8_121_827.
  const termCases = [
    {
      benefit: 3_000_000,
      scheme: "gross" as const,
      rateBp: 0,
      x: 3_000_000,
      t: 0,
      withheld: 0,
      allowance: 0,
      borne: 0,
      gBase: 3_000_000,
      eBase: 0,
    },
    {
      benefit: 3_000_000,
      scheme: "gross_up" as const,
      rateBp: 0,
      x: 3_000_000,
      t: 0,
      withheld: 0,
      allowance: 0,
      borne: 0,
      gBase: 0,
      eBase: 3_000_000,
    },
    {
      benefit: 3_000_000,
      scheme: "net" as const,
      rateBp: 0,
      x: 3_000_000,
      t: 0,
      withheld: 0,
      allowance: 0,
      borne: 0,
      gBase: 0,
      eBase: 3_000_000,
    },
    {
      benefit: 8_000_000,
      scheme: "gross" as const,
      rateBp: 150,
      x: 8_000_000,
      t: 120_000,
      withheld: 120_000,
      allowance: 0,
      borne: 0,
      gBase: 8_000_000,
      eBase: 0,
    },
    {
      benefit: 8_000_000,
      scheme: "gross_up" as const,
      rateBp: 150,
      x: 8_121_827,
      t: 121_827,
      withheld: 121_827,
      allowance: 121_827,
      borne: 0,
      gBase: 0,
      eBase: 8_121_827,
    },
    {
      benefit: 8_000_000,
      scheme: "net" as const,
      rateBp: 150,
      x: 8_121_827,
      t: 121_827,
      withheld: 0,
      allowance: 0,
      borne: 121_827,
      gBase: 0,
      eBase: 8_121_827,
    },
  ];

  for (const c of termCases) {
    it(`M1 TER month, no lines, benefit ${c.benefit}, contract ${c.scheme}: X ${c.x}, tax ${c.t}, withheld ${c.withheld}, allowance ${c.allowance}, borne ${c.borne}, bases ${c.gBase}/${c.eBase}`, () => {
      const { tax } = payslip({
        employerBenefitIdr: c.benefit,
        contractTaxScheme: c.scheme,
      });
      expect(tax.method).toBe("ter");
      expect(tax.terRateBp).toBe(c.rateBp);
      expect(tax.taxableGrossIdr).toBe(c.x);
      expect(tax.pph21Idr).toBe(c.t);
      expect(tax.pph21WithheldIdr).toBe(c.withheld);
      expect(tax.taxAllowanceIdr).toBe(c.allowance);
      expect(tax.pph21EmployerBorneIdr).toBe(c.borne);
      expect(tax.pph21RefundIdr).toBe(0);
      expect(tax.pph21EmployerRefundIdr).toBe(0);
      expect(tax.grossSchemeBaseIdr).toBe(c.gBase);
      expect(tax.employerSchemeBaseIdr).toBe(c.eBase);
      // Invariant: A + B + W = T and the bases add up to X.
      expect(tax.pph21WithheldIdr + tax.pph21EmployerBorneIdr).toBe(
        tax.pph21Idr,
      );
      expect(tax.grossSchemeBaseIdr + tax.employerSchemeBaseIdr).toBe(
        tax.taxableGrossIdr,
      );
    });
  }

  it("M2 without contractTaxScheme a benefit-only month is refused (RangeError), in a TER month and in the last tax period", () => {
    expect(() => payslip({ employerBenefitIdr: 3_000_000 })).toThrow(
      RangeError,
    );
    expect(() =>
      payslip({
        employerBenefitIdr: 3_000_000,
        lastTaxPeriod: true,
        monthsWorked: 12,
      }),
    ).toThrow(RangeError);
    // The same inputs with a scheme are accepted.
    expect(() =>
      payslip({ employerBenefitIdr: 3_000_000, contractTaxScheme: "gross" }),
    ).not.toThrow();
    // No benefit and no lines: nothing to attribute, no scheme needed.
    expect(() => payslip({})).not.toThrow();
  });

  it("M2 with taxable lines contractTaxScheme is ignored: same result with every scheme and without it", () => {
    // Gross line 10_000_000 + benefit 3_000_000, all gross scheme: X =
    // 13_000_000 (TER A row 15, 5%, bound 13_750_000), T = 650_000, all
    // withheld by the employee, bases 13_000_000 / 0.
    const earnings: PayslipTaxEarning[] = [
      { amountIdr: 10_000_000, taxable: true, taxScheme: "gross" },
    ];
    const without = payslip({ earnings, employerBenefitIdr: 3_000_000 });
    expect(without.tax.taxableGrossIdr).toBe(13_000_000);
    expect(without.tax.pph21Idr).toBe(650_000);
    expect(without.tax.pph21WithheldIdr).toBe(650_000);
    expect(without.tax.taxAllowanceIdr).toBe(0);
    expect(without.tax.pph21EmployerBorneIdr).toBe(0);
    expect(without.tax.grossSchemeBaseIdr).toBe(13_000_000);
    expect(without.tax.employerSchemeBaseIdr).toBe(0);
    for (const scheme of ["gross", "gross_up", "net"] as const) {
      const withScheme = payslip({
        earnings,
        employerBenefitIdr: 3_000_000,
        contractTaxScheme: scheme,
      });
      expect(withScheme.tax).toEqual(without.tax);
      expect(withScheme.result).toEqual(without.result);
    }
  });

  describe("reviewer repro: no NPWP, annual_only surcharge, Jan benefit only (contract gross_up), Feb-Nov gross_up 20_000_000, December gross_up 20_000_000", () => {
    // Feb-Nov: S = round_half_up(9% x (20_000_000 + S)) = 1_978_022
    //   (21_978_022 x 900 / 10000 = 1_978_021,98), X = 21_978_022, TER A row 19.
    //   Each month tax = withheld = allowance = 1_978_022, borne 0, bases 0 / X.
    //   No NPWP surcharge in TER months (annual_only).
    // Jan: X = 3_000_000, 0% => tax 0, bases 0 / 3_000_000 (contract gross_up).
    // Prior (11 payslips): X = 3_000_000 + 10 x 21_978_022 = 222_780_220;
    //   withheld = allowance = 10 x 1_978_022 = 19_780_220; borne 0;
    //   gross base 0, employer base 222_780_220 (pure gross-up history).
    // H (with the 20% no-NPWP surcharge, Pasal 21(5a) UU PPh): annual(prior) =
    //   cost 6_000_000 (cap), net 216_780_220, PKP 162_780_000, tax 3_000_000 +
    //   102_780_000 x 15% = 18_417_000, x 120% = 22_100_400; H = 22_100_400 -
    //   19_780_220 = 2_320_180 > 0, all the employer's (E = mix).
    // Employee part: G* = 0 and employeeHistory = 0 under both policies
    //   (proportional: employerHistory = clamp(floor((H + priorTax) x E / mix)
    //   - pET, 0, H) = H; gross_first: annual(Gs = 0) = 0), so W = 0.
    //
    // December paid (gross_up 20_000_000, S = employer part = T since W = 0):
    //   S0=0       T 5_920_180
    //   S1=5_920_180 T 6_985_780
    //   S2=6_985_780 T 7_177_660
    //   S3=7_177_660 T 7_212_040
    //   S4=7_212_040 T 7_218_340
    //   S5=7_218_340 T 7_219_420
    //   S6=7_219_420 T 7_219_600
    //   S7=7_219_600 T 7_219_600 stop.
    //   X = 27_219_600; gross 249_999_820; cost 6_000_000; net 243_999_820; PKP
    //   189_999_000; tax 3_000_000 + 129_999_000 x 15% = 22_499_850; x 120% =
    //   26_999_820; T = 26_999_820 - 19_780_220 = 7_219_600 = allowance =
    //   withheld; employee's own part 0 (the old rule: T 7_154_260, W 297_609).
    //
    // December with no pay at all (rule D, W = min(employeeHistory 0, T) = 0):
    //   S0=0 T 2_320_180; S1 2_737_780; S2 2_813_020; S3 2_826_520;
    //   S4 2_828_860; S5 2_829_400; S6=2_829_400 T 2_829_400 stop.
    //   X = 2_829_400 (gross 225_609_620, PKP 165_609_000, tax 18_841_350, x 120%
    //   22_609_620); T = 22_609_620 - 19_780_220 = 2_829_400, booked as borne
    //   (A1), withheld 0, allowance 0.
    const policyOf = (
      mixedSchemeAllocation: Pph21PolicyParameters["mixedSchemeAllocation"],
    ): Pph21PolicyParameters => ({
      ...DEFAULT_PPH21_POLICY,
      noTaxIdSurcharge: "annual_only",
      mixedSchemeAllocation,
    });

    const history = (
      mixedSchemeAllocation: Pph21PolicyParameters["mixedSchemeAllocation"],
    ) => {
      const policy = policyOf(mixedSchemeAllocation);
      const jan = payslip({
        policy,
        hasTaxId: false,
        employerBenefitIdr: 3_000_000,
        contractTaxScheme: "gross_up",
      });
      const feb = payslip({
        policy,
        hasTaxId: false,
        earnings: [
          { amountIdr: 20_000_000, taxable: true, taxScheme: "gross_up" },
        ],
      });
      return { jan, feb, policy };
    };

    for (const allocation of ALLOCATIONS) {
      it(`${allocation}: the stored Jan and Feb payslips and the summed prior`, () => {
        const { jan, feb } = history(allocation);
        expect(jan.tax.taxableGrossIdr).toBe(3_000_000);
        expect(jan.tax.pph21Idr).toBe(0);
        expect(jan.tax.noTaxIdSurchargeApplied).toBe(false);
        expect(jan.tax.grossSchemeBaseIdr).toBe(0);
        expect(jan.tax.employerSchemeBaseIdr).toBe(3_000_000);
        expect(feb.tax.taxableGrossIdr).toBe(21_978_022);
        expect(feb.tax.pph21Idr).toBe(1_978_022);
        expect(feb.tax.pph21WithheldIdr).toBe(1_978_022);
        expect(feb.tax.taxAllowanceIdr).toBe(1_978_022);
        expect(feb.tax.pph21EmployerBorneIdr).toBe(0);
        expect(feb.tax.noTaxIdSurchargeApplied).toBe(false);
        expect(feb.tax.grossSchemeBaseIdr).toBe(0);
        expect(feb.tax.employerSchemeBaseIdr).toBe(21_978_022);

        const prior = buildPph21Prior([
          { tax: jan.tax, employeeDeductibleIdr: 0 },
          ...Array.from({ length: 10 }, () => ({
            tax: feb.tax,
            employeeDeductibleIdr: 0,
          })),
        ]);
        expect(prior.taxableGrossIdr).toBe(222_780_220);
        expect(prior.pph21WithheldIdr).toBe(19_780_220);
        expect(prior.taxAllowanceIdr).toBe(19_780_220);
        expect(prior.pph21EmployerBorneIdr).toBe(0);
        expect(prior.grossSchemeBaseIdr).toBe(0);
        expect(prior.employerSchemeBaseIdr).toBe(222_780_220);
      });

      const priorFor = () => {
        const { jan, feb } = history(allocation);
        return buildPph21Prior([
          { tax: jan.tax, employeeDeductibleIdr: 0 },
          ...Array.from({ length: 10 }, () => ({
            tax: feb.tax,
            employeeDeductibleIdr: 0,
          })),
        ]);
      };

      it(`${allocation}: December gross_up 20_000_000, the employee bears none of the tax (T 7_219_600 is all the company's allowance)`, () => {
        const r = payslip({
          policy: policyOf(allocation),
          hasTaxId: false,
          lastTaxPeriod: true,
          monthsWorked: 12,
          earnings: [
            { amountIdr: 20_000_000, taxable: true, taxScheme: "gross_up" },
          ],
          prior: priorFor(),
        });
        expect(r.tax.method).toBe("annual_recalculation");
        expect(r.tax.noTaxIdSurchargeApplied).toBe(true);
        expect(r.tax.taxableGrossIdr).toBe(27_219_600);
        expect(r.tax.pph21Idr).toBe(7_219_600);
        expect(r.tax.taxAllowanceIdr).toBe(7_219_600);
        expect(r.tax.pph21WithheldIdr).toBe(7_219_600);
        expect(r.tax.pph21EmployerBorneIdr).toBe(0);
        expect(r.tax.pph21RefundIdr).toBe(0);
        expect(r.tax.pph21EmployerRefundIdr).toBe(0);
        expect(r.tax.grossSchemeBaseIdr).toBe(0);
        expect(r.tax.employerSchemeBaseIdr).toBe(27_219_600);
        // W: the employee's own part of the withheld tax is 0 (old: 297_609).
        expect(r.tax.pph21WithheldIdr - r.tax.taxAllowanceIdr).toBe(0);
      });

      it(`${allocation}: December with no pay (rule D) after the same history, W = 0, the whole tax is borne by the company`, () => {
        const r = payslip({
          policy: policyOf(allocation),
          hasTaxId: false,
          lastTaxPeriod: true,
          monthsWorked: 12,
          earnings: [],
          employerBenefitIdr: 0,
          prior: priorFor(),
        });
        expect(r.tax.method).toBe("annual_recalculation");
        expect(r.tax.noTaxIdSurchargeApplied).toBe(true);
        expect(r.tax.taxableGrossIdr).toBe(2_829_400);
        expect(r.tax.pph21Idr).toBe(2_829_400);
        expect(r.tax.pph21WithheldIdr).toBe(0);
        expect(r.tax.taxAllowanceIdr).toBe(0);
        expect(r.tax.pph21EmployerBorneIdr).toBe(2_829_400);
        expect(r.tax.pph21RefundIdr).toBe(0);
        expect(r.tax.pph21EmployerRefundIdr).toBe(0);
        expect(r.tax.grossSchemeBaseIdr).toBe(0);
        expect(r.tax.employerSchemeBaseIdr).toBe(2_829_400);
      });
    }
  });
});
