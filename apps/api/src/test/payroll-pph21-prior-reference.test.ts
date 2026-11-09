// PPh 21 reference suite, Part C: the prior-year history builder
// (buildPph21Prior) feeding the masa pajak terakhir (bead legend-s5c1, brief
// docs/briefs/sub-pph21-prior.md; PMK 168/2023 Pasal 15 and Pasal 21).
//
// Every expected value below is computed BY HAND (python3 big-integer
// arithmetic) from the regulation using REFERENCE_TABLES
// (fixtures/payroll/statutory-tables.ts) and the tenant policy rules, never by
// calling or copying engine or builder code. Same conventions as
// payroll-pph21-annual.test.ts (X = G + U + N + tax allowance + employer-borne
// tax; one half_up rounding per tax amount; prior months use monthly TER on X
// with no JHT/JP deduction; PKP floored to whole thousands).
//
// Sources
// - PP 58/2023 Lampiran A (TER kategori A, TK/0), PMK 168/2023 Pasal 10(2),
//   15(1)-(3), 21 (kelebihan potong), UU PPh Pasal 17(1)a and 17(4); see the
//   header of payroll-pph21-annual.test.ts for the URLs.
// - FAQ DJP PMK-66 no. 40: tax the employer bears is itself taxable income.
//
// Rules of the builder under test (contract v2, architect review):
// - Pph21PriorPeriod = { tax: PayslipTax, employeeDeductibleIdr }. The stored
//   tax carries the hand-computed grossSchemeBaseIdr + employerSchemeBaseIdr
//   (sum == taxableGrossIdr). The builder sums every field.
// - Per period (computed here by hand when the payslip tax is stored):
//   g = taxable gross-scheme lines + employer benefit, u = gross_up, n = net.
//   Gross part = grossLines + floor(benefit x grossLines / (grossLines + u + n)),
//   all of g when u + n = 0; employer part = X - gross part (it includes the
//   tax allowance and the employer-borne tax).
//
// Assumptions where the brief is silent (flagged in the report):
// - A1: benefit is split by the gross share of the LINES (grossLines over
//   grossLines + u + n), exactly as the brief formula states.
// - A2: the December result uses the engine rules of the annual suite:
//   `proportional` (default) employee share = floor(T x employeeG / X);
//   refunds follow the payer history (employer-funded = allowance + borne).
// - A3: the stored tax of a prior TER month has pph21Idr = withheld + borne
//   (allowance is part of withheld), refund fields 0.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PPH21_POLICY,
  buildPph21Prior,
  computePayslipTax,
  payslipTaxSchema,
} from "@starter/shared/hris/payroll";
import type {
  Pph21PolicyParameters,
  Pph21PriorPeriod,
  PayslipTaxEarning,
} from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

const ALLOCATIONS = ["proportional", "gross_first"] as const;

/** Stored tax of a prior TER month (TK/0, category A). */
const terTax = (t: {
  rateBp: number;
  taxableGrossIdr: number;
  pph21Idr: number;
  withheldIdr: number;
  allowanceIdr: number;
  borneIdr: number;
  /** Hand-computed split of taxableGrossIdr (sum must equal it). */
  grossSchemeBaseIdr: number;
  employerSchemeBaseIdr: number;
}) =>
  payslipTaxSchema.parse({
    ptkpStatus: "TK/0",
    method: "ter",
    terCategory: "A",
    terRateBp: t.rateBp,
    taxableGrossIdr: t.taxableGrossIdr,
    pph21Idr: t.pph21Idr,
    pph21WithheldIdr: t.withheldIdr,
    taxAllowanceIdr: t.allowanceIdr,
    grossSchemeBaseIdr: t.grossSchemeBaseIdr,
    employerSchemeBaseIdr: t.employerSchemeBaseIdr,
    pph21EmployerBorneIdr: t.borneIdr,
    pph21RefundIdr: 0,
    pph21EmployerRefundIdr: 0,
    noTaxIdSurchargeApplied: false,
  });

const earning = (
  amountIdr: number,
  taxScheme: PayslipTaxEarning["taxScheme"],
): PayslipTaxEarning => ({ amountIdr, taxable: true, taxScheme });

const many = <T>(count: number, value: T): T[] =>
  Array.from({ length: count }, () => value);

const december = (
  prior: ReturnType<typeof buildPph21Prior>,
  over: {
    earnings: PayslipTaxEarning[];
    employerBenefitIdr?: number;
    employeeDeductibleIdr?: number;
  },
  mixedSchemeAllocation: Pph21PolicyParameters["mixedSchemeAllocation"],
) =>
  computePayslipTax({
    tables: REFERENCE_TABLES,
    policy: { ...DEFAULT_PPH21_POLICY, mixedSchemeAllocation },
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked: 12,
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    ...over,
    prior,
  });

describe("PPh 21 prior-year builder feeding the last period (legend-s5c1)", () => {
  it("P1 pure gross-up year, December shortfall: the employee bears nothing (invariant 2)", () => {
    // TK/0, gross_up salary, Jan-Jun 8_000_000 and Jul-Nov 9_000_000.
    // Each TER month: smallest S with S = round_half_up(X x rate), X = salary + S.
    //   8 jt: S = 121_827, X = 8_121_827, TER A row 7 (s.d. 8_550_000) 1,5%:
    //     8_121_827 x 150 / 10000 = 121_827,405 -> 121_827 (stable).
    //   9 jt: S = 160_305, X = 9_160_305, row 8 (s.d. 9_650_000) 1,75%:
    //     9_160_305 x 175 / 10000 = 160_305,3375 -> 160_305 (stable).
    //   Each month: tax = withheld = allowance = S, employer-borne 0.
    // Sums: X = 6 x 8_121_827 + 5 x 9_160_305 = 48_730_962 + 45_801_525 = 94_532_487.
    //   allowance = withheld = 6 x 121_827 + 5 x 160_305 = 730_962 + 801_525 = 1_532_487.
    // Scheme split (u = salary, n = 0, no benefit): grossSchemeBase 0 every
    //   month; employerSchemeBase = X, so Σ = 94_532_487.
    // December gross_up 8_500_000, X = 8_500_000 + S, gross = 94_532_487 + X:
    //   history H = tax(94_532_487) - 1_532_487: cost 4_726_624 (5%), net 89_805_863,
    //   PKP 35_805_000, tax 1_790_250 -> H = 257_763 > 0, all the employer's.
    //   Employee share is 0 (no gross line), so S = T. Fixed point S = 694_513:
    //   X = 9_194_513; gross = 103_727_000; cost = floor(5% x 103_727_000) = 5_186_350;
    //   net = 98_540_650; PKP = 44_540_650 -> 44_540_000;
    //   annual tax = 2_227_000 (5% x 44_540_000); T = 2_227_000 - 1_532_487 = 694_513 = S.
    //   Withheld = allowance = 694_513; employee take-home = 8_500_000 exactly.
    const periods: Pph21PriorPeriod[] = [
      ...many(6, {
        employeeDeductibleIdr: 0,
        tax: terTax({
          rateBp: 150,
          taxableGrossIdr: 8_121_827,
          grossSchemeBaseIdr: 0,
          employerSchemeBaseIdr: 8_121_827,
          pph21Idr: 121_827,
          withheldIdr: 121_827,
          allowanceIdr: 121_827,
          borneIdr: 0,
        }),
      }),
      ...many(5, {
        employeeDeductibleIdr: 0,
        tax: terTax({
          rateBp: 175,
          taxableGrossIdr: 9_160_305,
          grossSchemeBaseIdr: 0,
          employerSchemeBaseIdr: 9_160_305,
          pph21Idr: 160_305,
          withheldIdr: 160_305,
          allowanceIdr: 160_305,
          borneIdr: 0,
        }),
      }),
    ];
    const prior = buildPph21Prior(periods);
    expect(prior).toEqual({
      taxableGrossIdr: 94_532_487,
      employeeDeductibleIdr: 0,
      pph21WithheldIdr: 1_532_487,
      pph21EmployerBorneIdr: 0,
      grossSchemeBaseIdr: 0,
      employerSchemeBaseIdr: 94_532_487,
      taxAllowanceIdr: 1_532_487,
    });

    for (const allocation of ALLOCATIONS) {
      const { result, tax } = december(
        prior,
        { earnings: [earning(8_500_000, "gross_up")] },
        allocation,
      );
      expect(result.method).toBe("annual_recalculation");
      expect(result.taxableGrossIdr).toBe(9_194_513);
      expect(result.pph21Idr).toBe(694_513);
      expect(result.taxAllowanceIdr).toBe(694_513);
      expect(result.pph21WithheldIdr).toBe(694_513);
      expect(result.pph21WithheldIdr).toBe(result.taxAllowanceIdr);
      expect(result.pph21EmployerBorneIdr).toBe(0);
      expect(result.pph21RefundIdr).toBe(0);
      expect(result.pph21EmployerRefundIdr).toBe(0);
      expect(result.annual).toEqual({
        grossIdr: 103_727_000,
        occupationalCostIdr: 5_186_350,
        deductibleIdr: 0,
        netIdr: 98_540_650,
        annualizedNetIdr: 98_540_650,
        ptkpIdr: 54_000_000,
        taxableIncomeIdr: 44_540_000,
        annualTaxIdr: 2_227_000,
        priorPph21Idr: 1_532_487,
      });
      // Take-home: salary + allowance - withheld = salary (nothing out of pocket).
      expect(8_500_000 + result.taxAllowanceIdr - result.pph21WithheldIdr).toBe(
        8_500_000,
      );
      expect(tax.pph21WithheldIdr).toBe(tax.taxAllowanceIdr);
    }
  });

  it("P2 pure gross-up year ending in lebih potong: the employee refund is 0, the employer gets it all (invariant 1)", () => {
    // TK/0 gross_up. Jan: salary 10_000_000 + bonus 60_000_000, both gross_up.
    //   X = 70_000_000 + S, TER A row 34 (s.d. 103_000_000) 24%:
    //   S = 22_105_263, X = 92_105_263 (row 34: > 89_000_000), 92_105_263 x 2400 / 10000
    //   = 22_105_263,12 -> 22_105_263 (stable). Lower rows give no fixed point
    //   (22%: S = 19_743_589 -> X = 89_743_589 > 77_500_000; 23%: S = 20_909_090
    //   -> X = 90_909_090 > 89_000_000).
    // Feb-Nov (10 months) 10_000_000 gross_up: S = 230_179, X = 10_230_179,
    //   row 10 (s.d. 10_350_000) 2,25%: 10_230_179 x 225 / 10000 = 230_179,0275 -> 230_179.
    // Sums: X = 92_105_263 + 10 x 10_230_179 = 92_105_263 + 102_301_790 = 194_407_053.
    //   allowance = withheld = 22_105_263 + 2_301_790 = 24_407_053; borne 0.
    //   grossSchemeBase 0, employerSchemeBase = 194_407_053.
    // December gross_up 10_000_000, X = 10_000_000 (S = 0 since T < 0):
    //   gross = 204_407_053; cost 6_000_000 (cap; 5% = 10_220_352); net = 198_407_053;
    //   PKP = 144_407_053 -> 144_407_000; tax = 3_000_000 + 84_407_000 x 15% = 15_661_050.
    //   T = 15_661_050 - 24_407_053 = -8_746_003.
    //   All prior tax was employer-funded (allowance), so the employee refund
    //   is 0 and the employer refund 8_746_003, in both allocations:
    //   proportional: floor(8_746_003 x 24_407_053 / 24_407_053) = 8_746_003;
    //   gross_first: employee-paid prior tax = 24_407_053 - 24_407_053 = 0.
    const periods: Pph21PriorPeriod[] = [
      {
        employeeDeductibleIdr: 0,
        tax: terTax({
          rateBp: 2400,
          taxableGrossIdr: 92_105_263,
          grossSchemeBaseIdr: 0,
          employerSchemeBaseIdr: 92_105_263,
          pph21Idr: 22_105_263,
          withheldIdr: 22_105_263,
          allowanceIdr: 22_105_263,
          borneIdr: 0,
        }),
      },
      ...many(10, {
        employeeDeductibleIdr: 0,
        tax: terTax({
          rateBp: 225,
          taxableGrossIdr: 10_230_179,
          grossSchemeBaseIdr: 0,
          employerSchemeBaseIdr: 10_230_179,
          pph21Idr: 230_179,
          withheldIdr: 230_179,
          allowanceIdr: 230_179,
          borneIdr: 0,
        }),
      }),
    ];
    const prior = buildPph21Prior(periods);
    expect(prior).toEqual({
      taxableGrossIdr: 194_407_053,
      employeeDeductibleIdr: 0,
      pph21WithheldIdr: 24_407_053,
      pph21EmployerBorneIdr: 0,
      grossSchemeBaseIdr: 0,
      employerSchemeBaseIdr: 194_407_053,
      taxAllowanceIdr: 24_407_053,
    });

    for (const allocation of ALLOCATIONS) {
      const { result, tax } = december(
        prior,
        { earnings: [earning(10_000_000, "gross_up")] },
        allocation,
      );
      expect(result.method).toBe("annual_recalculation");
      expect(result.taxableGrossIdr).toBe(10_000_000);
      expect(result.pph21Idr).toBe(-8_746_003);
      expect(result.pph21RefundIdr).toBe(0);
      expect(result.pph21EmployerRefundIdr).toBe(8_746_003);
      expect(result.pph21WithheldIdr).toBe(0);
      expect(result.pph21EmployerBorneIdr).toBe(0);
      expect(result.taxAllowanceIdr).toBe(0);
      expect(result.annual).toEqual({
        grossIdr: 204_407_053,
        occupationalCostIdr: 6_000_000,
        deductibleIdr: 0,
        netIdr: 198_407_053,
        annualizedNetIdr: 198_407_053,
        ptkpIdr: 54_000_000,
        taxableIncomeIdr: 144_407_000,
        annualTaxIdr: 15_661_050,
        priorPph21Idr: 24_407_053,
      });
      expect(tax.pph21RefundIdr).toBe(0);
      expect(tax.pph21EmployerRefundIdr).toBe(8_746_003);
    }
  });

  it("P3 net-scheme year with TER 0%: employerSchemeBase = Σ X, grossSchemeBase = 0, and the employee is charged nothing in December (invariant 3)", () => {
    // TK/0, net 5_300_000 + employer benefit 100_000 (JKK/JKM/BPJS-Kes), JHT/JP
    // 20_000 a month. Jan-Nov: X = n + benefit = 5_400_000, TER A row 1
    // (s.d. 5_400_000, inclusive) 0% => tax 0 for 11 months; nothing withheld,
    // nothing borne, no allowance.
    // Sums: X = 11 x 5_400_000 = 59_400_000; deductible = 11 x 20_000 = 220_000.
    // Scheme split per month: u + n = 5_300_000 > 0, grossLines = 0 =>
    //   grossSchemeBase = 0 + floor(100_000 x 0 / 5_300_000) = 0;
    //   employerSchemeBase = 5_400_000 - 0, so Σ = 59_400_000.
    // December net 5_300_000 + benefit 100_000, deductible 20_000:
    //   history H > 0 although nothing was paid (tax on 59_400_000 alone:
    //   cost 2_970_000, deductible 240_000, net 56_190_000, PKP 2_190_000,
    //   tax 109_500), all of it employer scheme => the employee carries 0.
    //   X = 5_400_000 + S; employee share 0 (no gross line) so S = T. S = 384_200:
    //   X = 5_784_200; gross = 59_400_000 + 5_784_200 = 65_184_200;
    //   cost = floor(5% x 65_184_200) = 3_259_210; deductible = 240_000;
    //   net = 65_184_200 - 3_259_210 - 240_000 = 61_684_990;
    //   PKP = 7_684_990 -> 7_684_000; annual tax = 5% x 7_684_000 = 384_200;
    //   T = 384_200 - 0 = 384_200 = S. Withheld 0, borne 384_200.
    const periods: Pph21PriorPeriod[] = many(11, {
      employeeDeductibleIdr: 20_000,
      tax: terTax({
        rateBp: 0,
        taxableGrossIdr: 5_400_000,
        grossSchemeBaseIdr: 0,
        employerSchemeBaseIdr: 5_400_000,
        pph21Idr: 0,
        withheldIdr: 0,
        allowanceIdr: 0,
        borneIdr: 0,
      }),
    });
    const prior = buildPph21Prior(periods);
    expect(prior).toEqual({
      taxableGrossIdr: 59_400_000,
      employeeDeductibleIdr: 220_000,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      grossSchemeBaseIdr: 0,
      employerSchemeBaseIdr: 59_400_000,
      taxAllowanceIdr: 0,
    });

    for (const allocation of ALLOCATIONS) {
      const { result } = december(
        prior,
        {
          earnings: [earning(5_300_000, "net")],
          employerBenefitIdr: 100_000,
          employeeDeductibleIdr: 20_000,
        },
        allocation,
      );
      expect(result.method).toBe("annual_recalculation");
      expect(result.taxableGrossIdr).toBe(5_784_200);
      expect(result.pph21Idr).toBe(384_200);
      expect(result.pph21WithheldIdr).toBe(0);
      expect(result.taxAllowanceIdr).toBe(0);
      expect(result.pph21EmployerBorneIdr).toBe(384_200);
      expect(result.pph21RefundIdr).toBe(0);
      expect(result.pph21EmployerRefundIdr).toBe(0);
      expect(result.annual).toEqual({
        grossIdr: 65_184_200,
        occupationalCostIdr: 3_259_210,
        deductibleIdr: 240_000,
        netIdr: 61_684_990,
        annualizedNetIdr: 61_684_990,
        ptkpIdr: 54_000_000,
        taxableIncomeIdr: 7_684_000,
        annualTaxIdr: 384_200,
        priorPph21Idr: 0,
      });
    }
  });

  it("P4 mixed gross + net + gross-up year with employer benefit: floor split of the schemes, Σ of both bases = Σ X (invariant 4)", () => {
    // TK/0. Jan-Jun: gross 6_000_000 + net 2_000_000 + gross_up 1_000_000,
    // employer benefit 400_000. Jul-Nov: gross 6_000_000 only, benefit 400_000.
    //
    // Jan-Jun month: g = 6_400_000, u = 1_000_000, n = 2_000_000, X = 9_400_000 + S.
    //   employee gross part eG = 6_000_000 + floor(400_000 x 6_000_000 / 9_000_000)
    //     = 6_000_000 + 266_666 = 6_266_666.
    //   TER A row 8 (s.d. 9_650_000) 1,75%. Employee share w = floor(T x eG / X),
    //   S = T - w: S = 55_811, X = 9_455_811, T = 9_455_811 x 175 / 10000
    //   = 165_476,69 -> 165_477; w = floor(165_477 x 6_266_666 / 9_455_811)
    //   = 109_666; S = 165_477 - 109_666 = 55_811 (stable).
    //   Allowance = floor(S x u/(u+n)) = floor(55_811 / 3) = 18_603;
    //   borne = 55_811 - 18_603 = 37_208; withheld = 109_666 + 18_603 = 128_269.
    //   Scheme split: grossSchemeBase = 6_266_666; employerSchemeBase =
    //   9_455_811 - 6_266_666 = 3_189_145.
    // Jul-Nov month: X = g = 6_400_000, u + n = 0 => grossSchemeBase = 6_400_000,
    //   employerSchemeBase = 0. TER row 5 (s.d. 6_750_000) 1%: T = 64_000, all
    //   withheld from the employee.
    // Sums: X = 6 x 9_455_811 + 5 x 6_400_000 = 56_734_866 + 32_000_000 = 88_734_866.
    //   withheld = 6 x 128_269 + 5 x 64_000 = 769_614 + 320_000 = 1_089_614.
    //   borne = 6 x 37_208 = 223_248. allowance = 6 x 18_603 = 111_618.
    //   grossSchemeBase = 6 x 6_266_666 + 5 x 6_400_000 = 37_599_996 + 32_000_000 = 69_599_996.
    //   employerSchemeBase = 6 x 3_189_145 = 19_134_870.
    //   69_599_996 + 19_134_870 = 88_734_866 = Σ X.
    // December (proportional, same lines as Jan-Jun): X = 9_400_000 + S, eG = 6_266_666.
    //   S = 230_328, X = 9_630_328; gross = 88_734_866 + 9_630_328 = 98_365_194;
    //   cost = floor(5% x 98_365_194) = 4_918_259; net = 93_446_935;
    //   PKP = 39_446_935 -> 39_446_000; annual tax = 5% x 39_446_000 = 1_972_300;
    //   prior tax = 1_089_614 + 223_248 = 1_312_862; T = 1_972_300 - 1_312_862 = 659_438.
    //   Employee share w = floor(659_438 x 6_266_666 / 9_630_328) = 429_110
    //   (S = 659_438 - 429_110 = 230_328, stable).
    //   Allowance = floor(230_328 / 3) = 76_776; borne = 230_328 - 76_776 = 153_552;
    //   withheld = 429_110 + 76_776 = 505_886.
    const mixLines = [
      earning(6_000_000, "gross"),
      earning(2_000_000, "net"),
      earning(1_000_000, "gross_up"),
    ];
    const mixedMonth: Pph21PriorPeriod = {
      employeeDeductibleIdr: 0,
      tax: terTax({
        rateBp: 175,
        taxableGrossIdr: 9_455_811,
        grossSchemeBaseIdr: 6_266_666,
        employerSchemeBaseIdr: 3_189_145,
        pph21Idr: 165_477,
        withheldIdr: 128_269,
        allowanceIdr: 18_603,
        borneIdr: 37_208,
      }),
    };
    const grossMonth: Pph21PriorPeriod = {
      employeeDeductibleIdr: 0,
      tax: terTax({
        rateBp: 100,
        taxableGrossIdr: 6_400_000,
        grossSchemeBaseIdr: 6_400_000,
        employerSchemeBaseIdr: 0,
        pph21Idr: 64_000,
        withheldIdr: 64_000,
        allowanceIdr: 0,
        borneIdr: 0,
      }),
    };
    const prior = buildPph21Prior([
      ...many(6, mixedMonth),
      ...many(5, grossMonth),
    ]);
    expect(prior).toEqual({
      taxableGrossIdr: 88_734_866,
      employeeDeductibleIdr: 0,
      pph21WithheldIdr: 1_089_614,
      pph21EmployerBorneIdr: 223_248,
      grossSchemeBaseIdr: 69_599_996,
      employerSchemeBaseIdr: 19_134_870,
      taxAllowanceIdr: 111_618,
    });
    expect(prior.grossSchemeBaseIdr + prior.employerSchemeBaseIdr).toBe(
      prior.taxableGrossIdr,
    );

    const { result } = december(
      prior,
      { earnings: mixLines, employerBenefitIdr: 400_000 },
      "proportional",
    );
    expect(result.method).toBe("annual_recalculation");
    expect(result.taxableGrossIdr).toBe(9_630_328);
    expect(result.pph21Idr).toBe(659_438);
    expect(result.taxAllowanceIdr).toBe(76_776);
    expect(result.pph21WithheldIdr).toBe(505_886);
    expect(result.pph21EmployerBorneIdr).toBe(153_552);
    expect(result.pph21RefundIdr).toBe(0);
    expect(result.pph21EmployerRefundIdr).toBe(0);
    // Withheld + borne = total tax of the period.
    expect(result.pph21WithheldIdr + result.pph21EmployerBorneIdr).toBe(
      result.pph21Idr,
    );
    expect(result.annual).toEqual({
      grossIdr: 98_365_194,
      occupationalCostIdr: 4_918_259,
      deductibleIdr: 0,
      netIdr: 93_446_935,
      annualizedNetIdr: 93_446_935,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 39_446_000,
      annualTaxIdr: 1_972_300,
      priorPph21Idr: 1_312_862,
    });
  });

  it("P5 an empty history is all zeros", () => {
    expect(buildPph21Prior([])).toEqual({
      taxableGrossIdr: 0,
      employeeDeductibleIdr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      grossSchemeBaseIdr: 0,
      employerSchemeBaseIdr: 0,
      taxAllowanceIdr: 0,
    });
  });
});
