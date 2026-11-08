// PPh 21 reference suite, Part B: masa pajak terakhir (annual recalculation),
// cases R19-R36 (PRD v1.7 §3 F30, PAYR-03, R15; bead legend-5cnk).
//
// Every expected value below is computed BY HAND from the regulation using
// REFERENCE_TABLES (statutory-tables.ts), never by calling or copying engine
// code. Multi-month scenarios list the monthly TER of each prior month by hand
// and sum it into `prior.*`.
//
// Sources
// - PP 58/2023 Pasal 2-3 + Lampiran A/B/C: TER monthly (Jan-Nov / non-last).
// - PMK 168/2023 Pasal 8, 10, 13-14: masa pajak terakhir recomputed with
//   Pasal 17 on the full-year figures.
// - PMK 168/2023 Pasal 10(2): biaya jabatan = 5% of bruto, max Rp500.000 per
//   month worked (Rp6 jt/year).
// - UU PPh Pasal 17(1)a (5% <=60 jt, 15% <=250 jt, 25% <=500 jt, 30% <=5 M,
//   35% above), Pasal 17(4) (PKP rounded down to whole thousands), Pasal
//   21(5a) (no NPWP: tax x 120%).
// - PMK 101/2016 Pasal 1: PTKP TK/0 54 jt, K/3 72 jt.
//
// Assumptions where the regulation/brief is silent (flagged in the report):
// - A1: JHT/JP are deducted only in the annual computation, so a prior month's
//   TER is computed on X without deducting them.
// - A2: prior.taxableGrossIdr is the sum of earlier periods' X, including any
//   tax allowance (gross-up) of those months.
// - A3: when a refund exists, pph21Idr is negative and pph21EmployerBorneIdr is
//   0; the employer's net-scheme share of the refund is subtracted from
//   pph21RefundIdr only (brief rule 4).
// - A4: "Full PTKP, no annualization" for joiners/leavers: PTKP is NOT
//   prorated by monthsWorked; only the biaya jabatan cap is.
import { describe, expect, it } from "vitest";
import { computePph21Period } from "../services/payroll-pph21.ts";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables";

type Input = Parameters<typeof computePph21Period>[1];

const run = (over: Partial<Input>) =>
  computePph21Period(REFERENCE_TABLES, {
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked: 12,
    taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior: { taxableGrossIdr: 0, employeeDeductibleIdr: 0, pph21Idr: 0 },
    ...over,
  } as Input);

describe("PPh 21 annual recalculation (R19-R36)", () => {
  it("R19 December, TK/0, flat 10 jt salary: biaya jabatan exactly at the 6 jt cap, PKP exactly 60 jt", () => {
    // Jan-Nov each month: X=10_000_000, TER A row 9 (s.d. 10_050_000) 2% => 200_000.
    //   prior pph21 = 11 x 200_000 = 2_200_000; prior gross = 11 x 10_000_000 = 110_000_000.
    // December: gross = 110_000_000 + 10_000_000 = 120_000_000.
    //   cost = min(5% x 120_000_000 = 6_000_000, 500_000 x 12 = 6_000_000) = 6_000_000.
    //   PKP = 120_000_000 - 6_000_000 - 0 - 54_000_000 = 60_000_000 (already a multiple of 1000).
    //   tax = 60_000_000 x 5% = 3_000_000. Dec = 3_000_000 - 2_200_000 = 800_000.
    // Src: PMK 168/2023 Pasal 8, 10; UU PPh Pasal 17(1)a.
    const r = run({
      prior: {
        taxableGrossIdr: 110_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 2_200_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.terCategory).toBeNull();
    expect(r.terRateBp).toBeNull();
    expect(r.taxableGrossIdr).toBe(10_000_000);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21Idr).toBe(800_000);
    expect(r.pph21WithheldIdr).toBe(800_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.noTaxIdSurchargeApplied).toBe(false);
    expect(r.annual).toEqual({
      grossIdr: 120_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_000_000,
      annualTaxIdr: 3_000_000,
      priorPph21Idr: 2_200_000,
    });
  });

  it("R20 December with employee JHT+JP deducted only in the annual computation", () => {
    // JHT 2% (200_000) + JP 1% (100_000) = 300_000 per month. TER months are on X=10_000_000
    // (deductions not applied to TER, assumption A1): 200_000 each => prior pph21 2_200_000.
    // prior gross 110_000_000; prior deductible = 11 x 300_000 = 3_300_000; Dec deductible 300_000.
    // gross 120_000_000; cost 6_000_000; deductible 3_300_000 + 300_000 = 3_600_000.
    // PKP = 120_000_000 - 6_000_000 - 3_600_000 - 54_000_000 = 56_400_000.
    // tax = 56_400_000 x 5% = 2_820_000. Dec = 2_820_000 - 2_200_000 = 620_000.
    // Src: PMK 168/2023 Pasal 10 (pengurang: iuran pensiun/JHT).
    const r = run({
      employeeDeductibleIdr: 300_000,
      prior: {
        taxableGrossIdr: 110_000_000,
        employeeDeductibleIdr: 3_300_000,
        pph21Idr: 2_200_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(620_000);
    expect(r.pph21WithheldIdr).toBe(620_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 120_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 3_600_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 56_400_000,
      annualTaxIdr: 2_820_000,
      priorPph21Idr: 2_200_000,
    });
  });

  it("R21 December, biaya jabatan below the cap (5% of bruto used)", () => {
    // Salary 8_000_000/month. Jan-Nov: TER A row 7 (s.d. 8_550_000) 1.5% => floor(8_000_000 x 150/10000) = 120_000.
    //   prior pph21 = 11 x 120_000 = 1_320_000; prior gross = 88_000_000.
    // Dec: gross = 96_000_000; cost = min(5% x 96_000_000 = 4_800_000, 6_000_000) = 4_800_000.
    //   PKP = 96_000_000 - 4_800_000 - 54_000_000 = 37_200_000. tax = 5% = 1_860_000.
    //   Dec = 1_860_000 - 1_320_000 = 540_000.
    const r = run({
      taxableLines: [{ amountIdr: 8_000_000, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 88_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 1_320_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(8_000_000);
    expect(r.pph21Idr).toBe(540_000);
    expect(r.pph21WithheldIdr).toBe(540_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 96_000_000,
      occupationalCostIdr: 4_800_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 37_200_000,
      annualTaxIdr: 1_860_000,
      priorPph21Idr: 1_320_000,
    });
  });

  it("R22 December, 20 jt salary: cap clearly binds and PKP crosses the 60 jt slice", () => {
    // Jan-Nov: X=20_000_000, TER A row 19 (s.d. 24_150_000) 9% => 1_800_000.
    //   prior pph21 = 11 x 1_800_000 = 19_800_000; prior gross = 220_000_000.
    // Dec: gross 240_000_000; 5% = 12_000_000 > cap, so cost = 6_000_000.
    //   PKP = 240_000_000 - 6_000_000 - 54_000_000 = 180_000_000.
    //   tax = 60_000_000 x 5% = 3_000_000 + 120_000_000 x 15% = 18_000_000 => 21_000_000.
    //   Dec = 21_000_000 - 19_800_000 = 1_200_000.
    const r = run({
      taxableLines: [{ amountIdr: 20_000_000, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 220_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 19_800_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(1_200_000);
    expect(r.pph21WithheldIdr).toBe(1_200_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 240_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 180_000_000,
      annualTaxIdr: 21_000_000,
      priorPph21Idr: 19_800_000,
    });
  });

  it("R23 joiner starting July (6 months): biaya jabatan cap 3 jt, full PTKP, lebih potong refund", () => {
    // Salary 15_000_000, months Jul-Dec (monthsWorked 6). Jul-Nov = 5 months:
    //   TER A: 15_000_000 is in row 16 (s.d. 15_100_000) 6% => 900_000 each.
    //   prior pph21 = 5 x 900_000 = 4_500_000; prior gross = 75_000_000.
    // Dec: gross 90_000_000; cost = min(5% x 90_000_000 = 4_500_000, 500_000 x 6 = 3_000_000) = 3_000_000.
    //   PKP = 90_000_000 - 3_000_000 - 54_000_000 (full PTKP, assumption A4) = 33_000_000.
    //   tax = 5% = 1_650_000. Dec = 1_650_000 - 4_500_000 = -2_850_000 (refund 2_850_000).
    // Src: PMK 168/2023 Pasal 10(2) (Rp500.000 x months worked).
    const r = run({
      monthsWorked: 6,
      taxableLines: [{ amountIdr: 15_000_000, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 75_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 4_500_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(-2_850_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(2_850_000);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 90_000_000,
      occupationalCostIdr: 3_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 33_000_000,
      annualTaxIdr: 1_650_000,
      priorPph21Idr: 4_500_000,
    });
  });

  it("R24 leaver exiting in May (5 months): masa pajak terakhir in May, cap 2.5 jt, refund", () => {
    // Salary 20_000_000, employment ends in May => lastTaxPeriod true, monthsWorked 5.
    // Jan-Apr: TER A row 19 9% => 1_800_000 each; prior pph21 = 4 x 1_800_000 = 7_200_000; prior gross 80_000_000.
    // May: gross 100_000_000; cost = min(5_000_000, 500_000 x 5 = 2_500_000) = 2_500_000.
    //   PKP = 100_000_000 - 2_500_000 - 54_000_000 = 43_500_000. tax = 5% = 2_175_000.
    //   May = 2_175_000 - 7_200_000 = -5_025_000 (refund 5_025_000).
    // Src: PMK 168/2023 Pasal 13-14 (masa pajak terakhir when employment ends).
    const r = run({
      monthsWorked: 5,
      taxableLines: [{ amountIdr: 20_000_000, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 80_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 7_200_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(-5_025_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(5_025_000);
    expect(r.annual).toEqual({
      grossIdr: 100_000_000,
      occupationalCostIdr: 2_500_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 43_500_000,
      annualTaxIdr: 2_175_000,
      priorPph21Idr: 7_200_000,
    });
  });

  it("R25 THR in March and bonus in December flow into the annual gross", () => {
    // Salary 10_000_000. Jan, Feb: X=10_000_000, TER A 2% => 200_000 each = 400_000.
    // Mar: salary + THR 10_000_000 => X=20_000_000, TER A row 19 9% => 1_800_000.
    // Apr-Nov: 8 x 200_000 = 1_600_000. prior pph21 = 400_000 + 1_800_000 + 1_600_000 = 3_800_000.
    // prior gross = 11 x 10_000_000 + 10_000_000 THR = 120_000_000.
    // Dec: lines 10_000_000 salary + 20_000_000 bonus => X=30_000_000; gross = 150_000_000.
    //   cost = 6_000_000 (cap). PKP = 150_000_000 - 6_000_000 - 54_000_000 = 90_000_000.
    //   tax = 60_000_000 x 5% = 3_000_000 + 30_000_000 x 15% = 4_500_000 => 7_500_000.
    //   Dec = 7_500_000 - 3_800_000 = 3_700_000.
    const r = run({
      taxableLines: [
        { amountIdr: 10_000_000, taxScheme: "gross" },
        { amountIdr: 20_000_000, taxScheme: "gross" },
      ],
      prior: {
        taxableGrossIdr: 120_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 3_800_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(30_000_000);
    expect(r.pph21Idr).toBe(3_700_000);
    expect(r.pph21WithheldIdr).toBe(3_700_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 150_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 90_000_000,
      annualTaxIdr: 7_500_000,
      priorPph21Idr: 3_800_000,
    });
  });

  it("R26 December lebih potong: a big January bonus taxed at a high TER rate is refunded", () => {
    // Jan: salary 10_000_000 + bonus 90_000_000 => X=100_000_000, TER A row 34 (s.d. 103_000_000) 24% => 24_000_000.
    // Feb-Nov: 10 x 200_000 = 2_000_000. prior pph21 = 26_000_000.
    // prior gross = 100_000_000 + 10 x 10_000_000 = 200_000_000.
    // Dec: X=10_000_000; gross 210_000_000; cost 6_000_000 (cap).
    //   PKP = 210_000_000 - 6_000_000 - 54_000_000 = 150_000_000.
    //   tax = 3_000_000 + 90_000_000 x 15% = 13_500_000 => 16_500_000.
    //   Dec = 16_500_000 - 26_000_000 = -9_500_000 (refund 9_500_000).
    const r = run({
      prior: {
        taxableGrossIdr: 200_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 26_000_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(-9_500_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(9_500_000);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 210_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 150_000_000,
      annualTaxIdr: 16_500_000,
      priorPph21Idr: 26_000_000,
    });
  });

  it("R27 December without NPWP: annual tax x 120% (two floors), prior months were also surcharged", () => {
    // Same as R19 but no NPWP.
    // Jan-Nov: tax0 = 200_000; tax = floor(200_000 x 12000/10000) = 240_000; prior pph21 = 11 x 240_000 = 2_640_000.
    // Dec: PKP 60_000_000; annualTax0 = 3_000_000; annualTax = floor(3_000_000 x 12000/10000) = 3_600_000.
    //   Dec = 3_600_000 - 2_640_000 = 960_000.
    // Src: UU PPh Pasal 21(5a); PMK 168/2023.
    const r = run({
      hasTaxId: false,
      prior: {
        taxableGrossIdr: 110_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 2_640_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.noTaxIdSurchargeApplied).toBe(true);
    expect(r.pph21Idr).toBe(960_000);
    expect(r.pph21WithheldIdr).toBe(960_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 120_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_000_000,
      annualTaxIdr: 3_600_000,
      priorPph21Idr: 2_640_000,
    });
  });

  it("R28 December pure gross-up: tunjangan pajak solved to a fixed point", () => {
    // Salary 10_000_000 on the gross_up scheme every month (pure gross-up: A = T).
    // Jan-Nov, each month: iterate A0=0 -> T(10_000_000)=floor(10_000_000 x 2%)=200_000 (row 9)
    //   A1=200_000: X=10_200_000 row 10 2.25% => 229_500
    //   A2=229_500: X=10_229_500 => floor(10_229_500 x 0.0225)=230_163
    //   A3=230_163: X=10_230_163 => 230_178
    //   A4=230_178: X=10_230_178 => 230_179
    //   A5=230_179: X=10_230_179 => floor(230_179.0275)=230_179 stable. A=230_179, X=10_230_179.
    //   prior pph21 = 11 x 230_179 = 2_531_969; prior gross (incl. allowance, assumption A2) = 11 x 10_230_179 = 112_531_969.
    // Dec: gross = 112_531_969 + 10_000_000 + A; cost = 6_000_000 (5% of ~123.5 jt > cap).
    //   T(A) = annualTax(gross) - 2_531_969, with annualTax = 3_000_000 + 15% x (PKP - 60_000_000),
    //   PKP = floor((gross - 60_000_000)/1000) x 1000. Iterate A:
    //   0 -> 847_681 -> 974_881 -> 993_931 -> 996_781 -> 997_231 -> 997_381 -> 997_381 stable.
    //   A=997_381: X = 10_997_381; gross = 123_529_350; PKP = floor(63_529_350/1000)x1000 = 63_529_000.
    //   annualTax = 3_000_000 + 3_529_000 x 15% = 3_000_000 + 529_350 = 3_529_350.
    //   T = 3_529_350 - 2_531_969 = 997_381 = A. OK. Withheld = T (employee), borne 0.
    const r = run({
      taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross_up" }],
      prior: {
        taxableGrossIdr: 112_531_969,
        employeeDeductibleIdr: 0,
        pph21Idr: 2_531_969,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxAllowanceIdr).toBe(997_381);
    expect(r.taxableGrossIdr).toBe(10_997_381);
    expect(r.pph21Idr).toBe(997_381);
    expect(r.pph21WithheldIdr).toBe(997_381);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 123_529_350,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 63_529_000,
      annualTaxIdr: 3_529_350,
      priorPph21Idr: 2_531_969,
    });
  });

  it("R29 December pure net scheme: the employer bears the whole December tax", () => {
    // Salary 10_000_000 net every month (no allowance in the gross; employer pays the tax).
    // Jan-Nov: TER A 2% => 200_000 owed each; prior pph21 = 2_200_000 (owed, not withheld); prior gross 110_000_000.
    // Dec: same annual figures as R19: T = 3_000_000 - 2_200_000 = 800_000.
    //   X = N = 10_000_000; borne = floor(800_000 x 10_000_000 / 10_000_000) = 800_000; withheld = 0.
    const r = run({
      taxableLines: [{ amountIdr: 10_000_000, taxScheme: "net" }],
      prior: {
        taxableGrossIdr: 110_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 2_200_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.taxableGrossIdr).toBe(10_000_000);
    expect(r.pph21Idr).toBe(800_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(800_000);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 120_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_000_000,
      annualTaxIdr: 3_000_000,
      priorPph21Idr: 2_200_000,
    });
  });

  it("R30 December, K/3 (PTKP 72 jt, TER category C)", () => {
    // Salary 20_000_000. Jan-Nov: K/3 => TER C; row 15 (s.d. 22_700_000) 8% => 1_600_000.
    //   prior pph21 = 11 x 1_600_000 = 17_600_000; prior gross = 220_000_000.
    // Dec: gross 240_000_000; cost 6_000_000. PTKP K/3 = 54_000_000 + 4_500_000 (kawin) + 3 x 4_500_000 = 72_000_000.
    //   PKP = 240_000_000 - 6_000_000 - 72_000_000 = 162_000_000.
    //   tax = 3_000_000 + 102_000_000 x 15% = 15_300_000 => 18_300_000.
    //   Dec = 18_300_000 - 17_600_000 = 700_000.
    const r = run({
      ptkpStatus: "K/3",
      taxableLines: [{ amountIdr: 20_000_000, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 220_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 17_600_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(700_000);
    expect(r.pph21WithheldIdr).toBe(700_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 240_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 72_000_000,
      taxableIncomeIdr: 162_000_000,
      annualTaxIdr: 18_300_000,
      priorPph21Idr: 17_600_000,
    });
  });

  it("R31 December, income below PTKP: PKP clamps to 0, no tax, no refund", () => {
    // Salary 4_000_000. Jan-Nov: TER A row 1 (s.d. 5_400_000) 0% => 0; prior pph21 0; prior gross 44_000_000.
    // Dec: gross 48_000_000; cost = min(5% x 48_000_000 = 2_400_000, 6_000_000) = 2_400_000.
    //   48_000_000 - 2_400_000 - 54_000_000 = -8_400_000 => PKP = 0. tax 0. Dec = 0 - 0 = 0.
    const r = run({
      taxableLines: [{ amountIdr: 4_000_000, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 44_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 0,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(0);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 48_000_000,
      occupationalCostIdr: 2_400_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 0,
      annualTaxIdr: 0,
      priorPph21Idr: 0,
    });
  });

  it("R32 December, PKP crosses the 250 jt boundary into the 25% slice", () => {
    // Salary 40_000_000. Jan-Nov: TER A row 26 (s.d. 43_850_000) 16% => 6_400_000.
    //   prior pph21 = 11 x 6_400_000 = 70_400_000; prior gross 440_000_000.
    // Dec: gross 480_000_000; cost 6_000_000. PKP = 480_000_000 - 6_000_000 - 54_000_000 = 420_000_000.
    //   tax = 60_000_000 x 5% = 3_000_000 + 190_000_000 x 15% = 28_500_000 + 170_000_000 x 25% = 42_500_000 => 74_000_000.
    //   Dec = 74_000_000 - 70_400_000 = 3_600_000.
    const r = run({
      taxableLines: [{ amountIdr: 40_000_000, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 440_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 70_400_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(3_600_000);
    expect(r.pph21WithheldIdr).toBe(3_600_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 480_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 420_000_000,
      annualTaxIdr: 74_000_000,
      priorPph21Idr: 70_400_000,
    });
  });

  it("R33 PKP is rounded DOWN to whole thousands before applying the slices", () => {
    // Jan-Nov 10_000_000 => prior pph21 2_200_000, prior gross 110_000_000 (as R19).
    // Dec X=10_000_999: gross = 120_000_999; 5% = 6_000_049 > cap, cost = 6_000_000.
    //   raw = 120_000_999 - 6_000_000 - 54_000_000 = 60_000_999 => PKP = 60_000_000 (floor to 1000).
    //   tax = 60_000_000 x 5% = 3_000_000 (not 3_000_149). Dec = 3_000_000 - 2_200_000 = 800_000.
    // Src: UU PPh Pasal 17(4).
    const r = run({
      taxableLines: [{ amountIdr: 10_000_999, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 110_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 2_200_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(10_000_999);
    expect(r.pph21Idr).toBe(800_000);
    expect(r.pph21WithheldIdr).toBe(800_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 120_000_999,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_000_000,
      annualTaxIdr: 3_000_000,
      priorPph21Idr: 2_200_000,
    });
  });

  it("R34 December, PKP crosses 500 jt into the 30% slice (100 jt salary)", () => {
    // Salary 100_000_000. Jan-Nov: TER A row 34 (s.d. 103_000_000) 24% => 24_000_000.
    //   prior pph21 = 11 x 24_000_000 = 264_000_000; prior gross = 1_100_000_000.
    // Dec: gross 1_200_000_000; cost 6_000_000. PKP = 1_200_000_000 - 6_000_000 - 54_000_000 = 1_140_000_000.
    //   tax = 60 jt x 5% = 3_000_000 + 190 jt x 15% = 28_500_000 + 250 jt x 25% = 62_500_000
    //         + (1_140 jt - 500 jt = 640 jt) x 30% = 192_000_000 => 286_000_000.
    //   Dec = 286_000_000 - 264_000_000 = 22_000_000.
    const r = run({
      taxableLines: [{ amountIdr: 100_000_000, taxScheme: "gross" }],
      prior: {
        taxableGrossIdr: 1_100_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 264_000_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(22_000_000);
    expect(r.pph21WithheldIdr).toBe(22_000_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 1_200_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 1_140_000_000,
      annualTaxIdr: 286_000_000,
      priorPph21Idr: 264_000_000,
    });
  });

  it("R35 December with employer benefit (taxable) and employee JHT/JP deduction", () => {
    // Salary 10_000_000 + employer JKK/JKM/BPJS-Kes share 400_000 => X=10_400_000 each month.
    // Jan-Nov: TER A row 11 (s.d. 10_700_000) 2.5% => floor(10_400_000 x 250/10000) = 260_000.
    //   prior pph21 = 11 x 260_000 = 2_860_000; prior gross = 11 x 10_400_000 = 114_400_000.
    //   employee JHT+JP 300_000/month: prior deductible 3_300_000, Dec 300_000 => 3_600_000.
    // Dec: gross = 114_400_000 + 10_400_000 = 124_800_000; cost 6_000_000 (cap; 5% = 6_240_000).
    //   PKP = 124_800_000 - 6_000_000 - 3_600_000 - 54_000_000 = 61_200_000.
    //   tax = 3_000_000 + 1_200_000 x 15% = 180_000 => 3_180_000.
    //   Dec = 3_180_000 - 2_860_000 = 320_000.
    const r = run({
      employerBenefitIdr: 400_000,
      employeeDeductibleIdr: 300_000,
      prior: {
        taxableGrossIdr: 114_400_000,
        employeeDeductibleIdr: 3_300_000,
        pph21Idr: 2_860_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(10_400_000);
    expect(r.pph21Idr).toBe(320_000);
    expect(r.pph21WithheldIdr).toBe(320_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 124_800_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 3_600_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 61_200_000,
      annualTaxIdr: 3_180_000,
      priorPph21Idr: 2_860_000,
    });
  });

  it("R36 December refund with a mixed gross + net payroll: employer's share of the refund is split by net proportion", () => {
    // Same history as R26 (prior pph21 26_000_000, prior gross 200_000_000): annual tax 16_500_000
    // => T = -9_500_000, refund R = 9_500_000. Dec lines: gross 6_000_000 + net 4_000_000; X = 10_000_000.
    // Rule (brief 4): T<0 => A=0, withheld 0, borne 0; employer share of refund = floor(9_500_000 x 4_000_000 / 10_000_000)
    //   = 3_800_000; refund paid to the employee = 9_500_000 - 3_800_000 = 5_700_000. (Assumption A3.)
    const r = run({
      taxableLines: [
        { amountIdr: 6_000_000, taxScheme: "gross" },
        { amountIdr: 4_000_000, taxScheme: "net" },
      ],
      prior: {
        taxableGrossIdr: 200_000_000,
        employeeDeductibleIdr: 0,
        pph21Idr: 26_000_000,
      },
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(10_000_000);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21Idr).toBe(-9_500_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(5_700_000);
    expect(r.annual).toEqual({
      grossIdr: 210_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 150_000_000,
      annualTaxIdr: 16_500_000,
      priorPph21Idr: 26_000_000,
    });
  });
});
