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
import { DEFAULT_PPH21_POLICY } from "@starter/shared/hris/payroll";
import type { Pph21PolicyParameters } from "@starter/shared/hris/payroll";
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

  it("H3 (6q7o c) net TER-0% months followed by taxed gross months: the net months' scheme share still counts, so the employer bears the shortfall", () => {
    // Jan-Jun net 5_400_000 (TER A row 1, 0%): no tax, X = 5_400_000 each, all
    //   employer scheme. Jul-Nov gross 10_000_000 (TER A row 9, 2%): withheld
    //   200_000 each. Prior gross = 6 x 5_400_000 + 5 x 10_000_000 = 82_400_000;
    //   withheld 1_000_000, borne 0, allowance 0; E = 32_400_000, Gs = 50_000_000.
    // H = annual(82_400_000) - 1_000_000: cost 4_120_000, net 78_280_000,
    //   PKP 24_280_000, tax 1_214_000 -> H = 214_000.
    // pET = 0. Rule B, proportional: floor(1_214_000 x 32_400_000 / 82_400_000) - 0
    //   = 477_364, clamped to H => employerHistory 214_000, employeeHistory 0.
    //   Rule B, gross_first: annual(Gs = 50_000_000) = 0 (PKP 0), pEeT = 1_000_000
    //   => employeeHistory = clamp(0 - 1_000_000, 0, H) = 0, same split.
    //   (The old rule used pET / priorTax = 0, i.e. charged the employee all of H.)
    // December gross 10_000_000, G* = X0 = 10_000_000; the employer's H is borne.
    // gross_first: W = annual(92_400_000) - annual(82_400_000) + 0
    //   = 1_689_000 - 1_214_000 = 475_000.
    //   S0=0       T 689_000 W 475_000 next 214_000
    //   S1=214_000 T 699_150 W 475_000 next 224_150
    //   S2=224_150 T 699_600 W 475_000 next 224_600
    //   S3=224_600 T 699_650 W 475_000 next 224_650
    //   S4=224_650 gross 92_624_650 PKP 33_993_000 annual 1_699_650 T 699_650 next 224_650 stop.
    //   X = 10_224_650; T = 1_699_650 - 1_000_000 = 699_650; withheld 475_000, borne 224_650.
    // proportional: W = 0 + floor((T - 214_000) x 10_000_000 / X):
    //   S0=0       T 689_000 W 475_000 next 214_000
    //   S1=214_000 T 699_150 W 474_985 next 224_165
    //   S2=224_165 T 699_600 W 474_953 next 224_647
    //   S3=224_647 T 699_650 W 474_979 next 224_671
    //   S4=224_671 T 699_650 W 474_978 next 224_672
    //   S5=224_672 gross 92_624_672 annual 1_699_650 T 699_650 W 474_978 next 224_672 stop.
    //   X = 10_224_672; withheld 474_978, borne 224_672.
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
    expect(grossFirst.taxableGrossIdr).toBe(10_224_650);
    expect(grossFirst.pph21Idr).toBe(699_650);
    expect(grossFirst.pph21WithheldIdr).toBe(475_000);
    expect(grossFirst.pph21EmployerBorneIdr).toBe(224_650);
    expect(grossFirst.taxAllowanceIdr).toBe(0);
    expect(grossFirst.pph21RefundIdr).toBe(0);
    expect(grossFirst.annual?.annualTaxIdr).toBe(1_699_650);
    expect(grossFirst.annual?.priorPph21Idr).toBe(1_000_000);

    const proportional = run(input, { mixedSchemeAllocation: "proportional" });
    expect(proportional.method).toBe("annual_recalculation");
    expect(proportional.taxableGrossIdr).toBe(10_224_672);
    expect(proportional.pph21Idr).toBe(699_650);
    expect(proportional.pph21WithheldIdr).toBe(474_978);
    expect(proportional.pph21EmployerBorneIdr).toBe(224_672);
    expect(proportional.taxAllowanceIdr).toBe(0);
    expect(proportional.pph21RefundIdr).toBe(0);
    expect(proportional.annual?.annualTaxIdr).toBe(1_699_650);

    for (const r of [grossFirst, proportional]) {
      expect(r.pph21WithheldIdr + r.pph21EmployerBorneIdr).toBe(r.pph21Idr);
    }
  });

  it("H4 mixed payer history (net Jan-Jun, gross Jul-Nov): `proportional` splits H by scheme mix minus what the employer already paid; `gross_first` charges the employee only what his own gross base owes", () => {
    // Jan-Jun net 10_000_000: S = 230_179, X = 10_230_179 (see R28), borne
    //   230_179 each. Jul-Nov gross 10_000_000: withheld 200_000 each.
    // Prior gross = 6 x 10_230_179 + 5 x 10_000_000 = 111_381_074; withheld
    //   1_000_000; borne 1_381_074; allowance 0; priorTax 2_381_074;
    //   E = 61_381_074, Gs = 50_000_000 (same prior as R53).
    // H = annual(111_381_074) - 2_381_074: cost 5_569_053, net 105_812_021,
    //   PKP 51_812_000, tax 2_590_600 -> H = 209_526.
    // pET = 1_381_074 + 0; pEeT = priorTax - pET = 1_000_000.
    // Rule B, proportional: floor(2_590_600 x 61_381_074 / 111_381_074)
    //   = 1_427_655; minus pET = 46_581 => employerHistory 46_581,
    //   employeeHistory 162_945.
    // Rule B, gross_first: annual(Gs = 50_000_000): cost 2_500_000, net
    //   47_500_000, PKP 0 => 0. employeeHistory = clamp(0 - 1_000_000, 0, H) = 0,
    //   employerHistory = H = 209_526: the gross-scheme half of the year owes no
    //   tax on its own and the employee's 1_000_000 withheld already exceeds it.
    // December gross 10_000_000 (G* = X0):
    // gross_first: W = annual(121_381_074) - annual(111_381_074) + 0
    //   = 3_207_150 - 2_590_600 = 616_550.
    //   S0=0       T 826_076 W 616_550 next 209_526
    //   S1=209_526 T 857_426 next 240_876
    //   S2=240_876 T 862_076 next 245_526
    //   S3=245_526 T 862_826 next 246_276
    //   S4=246_276 T 862_976 next 246_426
    //   S5=246_426 gross 121_627_500 annual 3_244_050 T 862_976 next 246_426 stop.
    //   X = 10_246_426, T = 3_244_050 - 2_381_074 = 862_976; withheld 616_550, borne 246_426.
    //   (The old base-ratio rule gave the employee 162_945 of H: X 10_054_681,
    //   withheld 779_495, borne 54_681.)
    // proportional: W = 162_945 + floor((T - 209_526) x 10_000_000 / X):
    //   S0=0       T 826_076 W 779_495 next 46_581
    //   S1=46_581  T 832_976 W 783_504 next 49_472
    //   S2=49_472  T 833_426 W 783_773 next 49_653
    //   S3=49_653  T 833_426 W 783_762 next 49_664
    //   S4=49_664  T 833_426 W 783_761 next 49_665
    //   S5=49_665  gross 121_430_739 annual 3_214_500 T 833_426 W 783_761 next 49_665 stop.
    //   X = 10_049_665; withheld 783_761, borne 49_665.
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
    expect(grossFirst.taxableGrossIdr).toBe(10_246_426);
    expect(grossFirst.pph21Idr).toBe(862_976);
    expect(grossFirst.pph21WithheldIdr).toBe(616_550);
    expect(grossFirst.pph21EmployerBorneIdr).toBe(246_426);
    expect(grossFirst.annual?.annualTaxIdr).toBe(3_244_050);
    expect(grossFirst.annual?.priorPph21Idr).toBe(2_381_074);

    const proportional = run(input, { mixedSchemeAllocation: "proportional" });
    expect(proportional.taxableGrossIdr).toBe(10_049_665);
    expect(proportional.pph21Idr).toBe(833_426);
    expect(proportional.pph21WithheldIdr).toBe(783_761);
    expect(proportional.pph21EmployerBorneIdr).toBe(49_665);
    expect(proportional.annual?.annualTaxIdr).toBe(3_214_500);

    for (const r of [grossFirst, proportional]) {
      expect(r.pph21WithheldIdr + r.pph21EmployerBorneIdr).toBe(r.pph21Idr);
      expect(r.taxAllowanceIdr).toBe(0);
      expect(r.pph21RefundIdr).toBe(0);
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

  it("H7 (architect) gross 5 jt + gross-up 5 jt every month, gross_first: the employee pays tax only on his own 5 jt, not a share of the company-funded Jan-Nov shortfall", () => {
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
    //   = 1_237_500. Rule B, gross_first: annual(55_000_000) = 0 (PKP 0) =>
    //   employeeHistory = clamp(0 - 1_237_500, 0, 81_610) = 0. (The old base-ratio
    //   rule charged the employee a share of H: W 350_781.)
    // December the same lines: G* = 5_000_000, X0 = 10_000_000, S = employer part.
    //   W = annual(116_265_990) - annual(111_265_990) + 0: cost 5_813_299, net 110_452_691,
    //   PKP 56_452_000, tax 2_822_600 - 2_585_100 = 237_500 (5% x 4_750_000).
    //   S0=0       T 686_260 W 237_500 next 448_760
    //   S1=448_760 T 753_610 next 516_110
    //   S2=516_110 T 763_810 next 526_310
    //   S3=526_310 T 765_310 next 527_810
    //   S4=527_810 T 765_460 next 527_960
    //   S5=527_960 gross 121_793_950 annual 3_268_950 T 765_460 next 527_960 stop.
    //   X = 10_527_960, T = 3_268_950 - 2_503_490 = 765_460. Assumption: because
    //   December has a gross_up line, the employer's part S is a tax allowance
    //   (as in R72): allowance 527_960, withheld = T = 765_460 (employee's part
    //   237_500 + allowance 527_960), borne 0. Take-home = 10_000_000 + allowance - withheld
    //   = 10_000_000 - 237_500.
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
    expect(r.taxableGrossIdr).toBe(10_527_960);
    expect(r.pph21Idr).toBe(765_460);
    expect(r.taxAllowanceIdr).toBe(527_960);
    expect(r.pph21WithheldIdr).toBe(765_460);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual?.annualTaxIdr).toBe(3_268_950);
    expect(r.annual?.priorPph21Idr).toBe(2_503_490);
    // The employee's own share W = withheld - allowance = 237_500.
    expect(r.pph21WithheldIdr - r.taxAllowanceIdr).toBe(237_500);
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
