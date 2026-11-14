// PPh 21 reference suite, Part B: masa pajak terakhir (annual recalculation),
// cases R19-R65 (PRD v1.7 §3 F30, PAYR-03, R15; beads legend-5cnk, legend-y4wp).
//
// Every expected value below is computed BY HAND (python3 big-integer
// arithmetic) from the regulation using REFERENCE_TABLES
// (fixtures/payroll/statutory-tables.ts) and the tenant policy rules, never by
// calling or copying engine code. Multi-month scenarios list the monthly TER of
// each prior month and sum it into `prior.*`.
//
// Sources
// - PP 58/2023 Lampiran A/B/C (TER, Jan-Nov / non-last periods):
//   https://pajak.go.id/sites/default/files/lampiran/Lampiran%20PP58TAHUN2023.pdf
// - PMK 168/2023 (https://www.jdih.kemenkeu.go.id/api/download/e60a82e0-b218-40f5-9d18-b924aa1e11ce/2023pmkeuangan168.pdf):
//   Pasal 10(2) biaya jabatan 5% of bruto, max Rp500.000 a month / Rp6.000.000
//   a year; Pasal 15(1)-(3) masa pajak terakhir (annual recomputation with
//   Pasal 17, minus tax already withheld); Pasal 21 kelebihan potong (lebih
//   potong); Lampiran I.2.2.3 penyetahunan (annualisation when the kewajiban
//   pajak subjektif starts or ends within the year).
// - FAQ DJP PMK-66 no. 40 (tax the employer bears is a taxable benefit of the
//   employee, so it enters the taxable gross):
//   https://pajak.go.id/sites/default/files/2023-12/FAQ%20Terkait%20PMK-66%20Tahun%202023.pdf
// - PER-11/PJ/2025 Pasal 129 (rounding of PPh 21 amounts):
//   https://pajak.go.id/index.php/id/peraturan/ketentuan-pelaporan-pajak-penghasilan-pajak-pertambahan-nilai-pajak-penjualan-atas-0
// - Buku Cermat PPh 21 DJP p.53 (official worked example of a partial year):
//   https://static.pajak.go.id/download/kalkulator/Buku_PPh2126_Release_20240108.pdf
// - UU HPP / UU PPh Pasal 17(1)a (5% <=60 jt, 15% <=250 jt, 25% <=500 jt, 30%
//   <=5 M, 35% above), Pasal 17(4) (PKP rounded down to whole thousands),
//   Pasal 21(5a) (no NPWP: tax x 120%):
//   https://jdih.kemenkeu.go.id/api/download/a9faab97-aca7-4f87-9fdc-faa8123d1454/7TAHUN2021UU.pdf
// - PMK 101/2016 Pasal 1: PTKP TK/0 54 jt, K/0 58,5 jt, K/3 72 jt.
//
// Engine v2 conventions (brief legend-5cnk round 2):
// - X (taxableGrossIdr) = G + U + N + tax allowance + employer-borne tax.
// - prior = payer history: gross X, employee deductions, tax WITHHELD from
//   the employee and tax BORNE by the employer in earlier periods.
// - One rounding per tax amount (policy.roundingMode, default half_up).
// - T < 0 (lebih potong): S = 0; the refund is split by payer history:
//   `proportional` employerRefund = floor(Rf * hb / (hw + hb)), `gross_first`
//   employee refund = min(Rf, hw).
//
// Assumptions where the regulation/brief is silent (flagged in the report):
// - A1: JHT/JP are deducted only in the annual computation, so a prior month's
//   TER is computed on X without deducting them.
// - A2: prior.taxableGrossIdr is the sum of earlier periods' X, including any
//   tax allowance / employer-borne tax of those months.
// - A3: "Full PTKP, no annualization" for ordinary joiners/leavers: PTKP is NOT
//   prorated by monthsWorked; only the biaya jabatan cap is (per policy).
// - A4: annual.priorPph21Idr = prior withheld + prior employer-borne.
// - A5: annual.netIdr = gross - biaya jabatan - deductible (before PTKP).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PPH21_POLICY,
  PayrollError,
} from "@starter/shared/hris/payroll";
import type { Pph21PolicyParameters } from "@starter/shared/hris/payroll";
import { computePph21Period } from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Input = Parameters<typeof computePph21Period>[2];

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

describe("PPh 21 annual recalculation (R19-R62)", () => {
  it("[PAYR-03] R19 December, TK/0, flat 10 jt salary: biaya jabatan exactly at the 6 jt cap, PKP exactly 60 jt", () => {
    // Jan-Nov each month: X=10_000_000, TER A row 9 (s.d. 10_050_000) 2% => 200_000.
    //   prior withheld = 11 x 200_000 = 2_200_000; prior gross = 110_000_000.
    // December: gross = 110_000_000 + 10_000_000 = 120_000_000.
    //   cost = min(5% x 120_000_000 = 6_000_000, floor(6_000_000 x 12/12) = 6_000_000) = 6_000_000.
    //   net = 120_000_000 - 6_000_000 = 114_000_000.
    //   PKP = 114_000_000 - 54_000_000 = 60_000_000 (a multiple of 1000).
    //   tax = 60_000_000 x 5% = 3_000_000. Dec = 3_000_000 - 2_200_000 = 800_000.
    // Src: PMK 168/2023 Pasal 10(2), 15(1)-(3); UU PPh Pasal 17(1)a.
    const r = run({ prior: prior(110_000_000, 2_200_000) });
    expect(r.method).toBe("annual_recalculation");
    expect(r.terCategory).toBeNull();
    expect(r.terRateBp).toBeNull();
    expect(r.withholdingStatus).toBe("TK/0");
    expect(r.taxableGrossIdr).toBe(10_000_000);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21Idr).toBe(800_000);
    expect(r.pph21WithheldIdr).toBe(800_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.pph21EmployerRefundIdr).toBe(0);
    expect(r.noTaxIdSurchargeApplied).toBe(false);
    expect(r.annual).toEqual({
      grossIdr: 120_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 114_000_000,
      annualizedNetIdr: 114_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_000_000,
      annualTaxIdr: 3_000_000,
      priorPph21Idr: 2_200_000,
    });
  });

  it("[PAYR-03] R20 December with employee JHT+JP deducted only in the annual computation", () => {
    // JHT 2% (200_000) + JP 1% (100_000) = 300_000 per month. TER months are on X=10_000_000
    // (deductions not applied to TER, assumption A1): 200_000 each => prior withheld 2_200_000.
    // prior gross 110_000_000; prior deductible = 11 x 300_000 = 3_300_000; Dec deductible 300_000.
    // gross 120_000_000; cost 6_000_000; deductible 3_300_000 + 300_000 = 3_600_000.
    // net = 120_000_000 - 6_000_000 - 3_600_000 = 110_400_000.
    // PKP = 110_400_000 - 54_000_000 = 56_400_000.
    // tax = 56_400_000 x 5% = 2_820_000. Dec = 2_820_000 - 2_200_000 = 620_000.
    // Src: PMK 168/2023 Pasal 10 (pengurang: iuran pensiun/JHT).
    const r = run({
      employeeDeductibleIdr: 300_000,
      prior: prior(110_000_000, 2_200_000, 0, 3_300_000),
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
      netIdr: 110_400_000,
      annualizedNetIdr: 110_400_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 56_400_000,
      annualTaxIdr: 2_820_000,
      priorPph21Idr: 2_200_000,
    });
  });

  it("[PAYR-03] R21 December, biaya jabatan below the cap (5% of bruto used)", () => {
    // Salary 8_000_000/month. Jan-Nov: TER A row 7 (s.d. 8_550_000) 1.5% => 8_000_000 x 150/10000 = 120_000.
    //   prior withheld = 11 x 120_000 = 1_320_000; prior gross = 88_000_000.
    // Dec: gross = 96_000_000; cost = min(5% x 96_000_000 = 4_800_000, 6_000_000) = 4_800_000.
    //   net = 91_200_000; PKP = 91_200_000 - 54_000_000 = 37_200_000. tax = 5% = 1_860_000.
    //   Dec = 1_860_000 - 1_320_000 = 540_000.
    const r = run({
      taxableLines: [{ amountIdr: 8_000_000, taxScheme: "gross" }],
      prior: prior(88_000_000, 1_320_000),
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
      netIdr: 91_200_000,
      annualizedNetIdr: 91_200_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 37_200_000,
      annualTaxIdr: 1_860_000,
      priorPph21Idr: 1_320_000,
    });
  });

  it("[PAYR-03] R22 December, 20 jt salary: cap clearly binds and PKP crosses the 60 jt slice", () => {
    // Jan-Nov: X=20_000_000, TER A row 19 (s.d. 24_150_000) 9% => 1_800_000.
    //   prior withheld = 11 x 1_800_000 = 19_800_000; prior gross = 220_000_000.
    // Dec: gross 240_000_000; 5% = 12_000_000 > cap, so cost = 6_000_000; net 234_000_000.
    //   PKP = 234_000_000 - 54_000_000 = 180_000_000.
    //   tax = 60_000_000 x 5% = 3_000_000 + 120_000_000 x 15% = 18_000_000 => 21_000_000.
    //   Dec = 21_000_000 - 19_800_000 = 1_200_000.
    const r = run({
      taxableLines: [{ amountIdr: 20_000_000, taxScheme: "gross" }],
      prior: prior(220_000_000, 19_800_000),
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
      netIdr: 234_000_000,
      annualizedNetIdr: 234_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 180_000_000,
      annualTaxIdr: 21_000_000,
      priorPph21Idr: 19_800_000,
    });
  });

  it("[PAYR-03] R23 joiner starting July (6 months): biaya jabatan cap 3 jt, full PTKP, lebih potong refund", () => {
    // Salary 15_000_000, months Jul-Dec (monthsWorked 6). Jul-Nov = 5 months:
    //   TER A: 15_000_000 is in row 16 (s.d. 15_100_000) 6% => 900_000 each.
    //   prior withheld = 5 x 900_000 = 4_500_000; prior gross = 75_000_000.
    // Dec: gross 90_000_000; cost = min(5% x 90_000_000 = 4_500_000, floor(6_000_000 x 6/12) = 3_000_000) = 3_000_000.
    //   net = 87_000_000. PKP = 87_000_000 - 54_000_000 (full PTKP, assumption A3) = 33_000_000.
    //   tax = 5% = 1_650_000. Dec = 1_650_000 - 4_500_000 = -2_850_000 (refund 2_850_000).
    //   History: all withheld from the employee => the whole refund goes to the employee.
    // Src: PMK 168/2023 Pasal 10(2) (Rp500.000 x months worked), Pasal 21 (kelebihan potong).
    const r = run({
      monthsWorked: 6,
      taxableLines: [{ amountIdr: 15_000_000, taxScheme: "gross" }],
      prior: prior(75_000_000, 4_500_000),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(-2_850_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(2_850_000);
    expect(r.pph21EmployerRefundIdr).toBe(0);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 90_000_000,
      occupationalCostIdr: 3_000_000,
      deductibleIdr: 0,
      netIdr: 87_000_000,
      annualizedNetIdr: 87_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 33_000_000,
      annualTaxIdr: 1_650_000,
      priorPph21Idr: 4_500_000,
    });
  });

  it("[PAYR-03] R24 leaver exiting in May (5 months): masa pajak terakhir in May, cap 2.5 jt, refund", () => {
    // Salary 20_000_000, employment ends in May => lastTaxPeriod true, monthsWorked 5.
    // Jan-Apr: TER A row 19 9% => 1_800_000 each; prior withheld = 4 x 1_800_000 = 7_200_000; prior gross 80_000_000.
    // May: gross 100_000_000; cost = min(5_000_000, floor(6_000_000 x 5/12) = 2_500_000) = 2_500_000.
    //   net = 97_500_000. PKP = 97_500_000 - 54_000_000 = 43_500_000. tax = 5% = 2_175_000.
    //   May = 2_175_000 - 7_200_000 = -5_025_000 (refund 5_025_000, all to the employee).
    // Src: PMK 168/2023 Pasal 15(1)-(3) (masa pajak terakhir when employment ends).
    const r = run({
      monthsWorked: 5,
      taxableLines: [{ amountIdr: 20_000_000, taxScheme: "gross" }],
      prior: prior(80_000_000, 7_200_000),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(-5_025_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(5_025_000);
    expect(r.pph21EmployerRefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 100_000_000,
      occupationalCostIdr: 2_500_000,
      deductibleIdr: 0,
      netIdr: 97_500_000,
      annualizedNetIdr: 97_500_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 43_500_000,
      annualTaxIdr: 2_175_000,
      priorPph21Idr: 7_200_000,
    });
  });

  it("[PAYR-03] R25 THR in March and bonus in December flow into the annual gross", () => {
    // Salary 10_000_000. Jan, Feb: X=10_000_000, TER A 2% => 200_000 each = 400_000.
    // Mar: salary + THR 10_000_000 => X=20_000_000, TER A row 19 9% => 1_800_000.
    // Apr-Nov: 8 x 200_000 = 1_600_000. prior withheld = 400_000 + 1_800_000 + 1_600_000 = 3_800_000.
    // prior gross = 11 x 10_000_000 + 10_000_000 THR = 120_000_000.
    // Dec: lines 10_000_000 salary + 20_000_000 bonus => X=30_000_000; gross = 150_000_000.
    //   cost = 6_000_000 (cap); net 144_000_000. PKP = 144_000_000 - 54_000_000 = 90_000_000.
    //   tax = 60_000_000 x 5% = 3_000_000 + 30_000_000 x 15% = 4_500_000 => 7_500_000.
    //   Dec = 7_500_000 - 3_800_000 = 3_700_000.
    const r = run({
      taxableLines: [
        { amountIdr: 10_000_000, taxScheme: "gross" },
        { amountIdr: 20_000_000, taxScheme: "gross" },
      ],
      prior: prior(120_000_000, 3_800_000),
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
      netIdr: 144_000_000,
      annualizedNetIdr: 144_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 90_000_000,
      annualTaxIdr: 7_500_000,
      priorPph21Idr: 3_800_000,
    });
  });

  it("[PAYR-03] R26 December lebih potong: a big January bonus taxed at a high TER rate is refunded", () => {
    // Jan: salary 10_000_000 + bonus 90_000_000 => X=100_000_000, TER A row 34 (s.d. 103_000_000) 24% => 24_000_000.
    // Feb-Nov: 10 x 200_000 = 2_000_000. prior withheld = 26_000_000 (all from the employee).
    // prior gross = 100_000_000 + 10 x 10_000_000 = 200_000_000.
    // Dec: X=10_000_000; gross 210_000_000; cost 6_000_000 (cap); net 204_000_000.
    //   PKP = 204_000_000 - 54_000_000 = 150_000_000.
    //   tax = 3_000_000 + 90_000_000 x 15% = 13_500_000 => 16_500_000.
    //   Dec = 16_500_000 - 26_000_000 = -9_500_000 (refund 9_500_000 to the employee).
    const r = run({ prior: prior(200_000_000, 26_000_000) });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(-9_500_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(9_500_000);
    expect(r.pph21EmployerRefundIdr).toBe(0);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 210_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 204_000_000,
      annualizedNetIdr: 204_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 150_000_000,
      annualTaxIdr: 16_500_000,
      priorPph21Idr: 26_000_000,
    });
  });

  it("R27 December without NPWP: annual tax x 120%, prior months were also surcharged", () => {
    // Same as R19 but no NPWP; default policy surcharges TER and annual (s = 2000).
    // Jan-Nov: tax = 10_000_000 x 200 x 12000 / 10^8 = 240_000; prior withheld = 11 x 240_000 = 2_640_000.
    // Dec: PKP 60_000_000; annualTax = 60_000_000 x 500 x 12000 / 10^8 = 3_600_000.
    //   Dec = 3_600_000 - 2_640_000 = 960_000.
    // Src: UU PPh Pasal 21(5a); PMK 168/2023 Pasal 15(1)-(3).
    const r = run({
      hasTaxId: false,
      prior: prior(110_000_000, 2_640_000),
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
      netIdr: 114_000_000,
      annualizedNetIdr: 114_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_000_000,
      annualTaxIdr: 3_600_000,
      priorPph21Idr: 2_640_000,
    });
  });

  it("[PAYR-03] R28 December pure gross-up: tunjangan pajak solved to a fixed point", () => {
    // Salary 10_000_000 on the gross_up scheme every month (pure gross-up: A = S = T, G = N = 0).
    // Jan-Nov, each month: smallest S with S = T(10_000_000 + S), T = X x rate (TER A, single rounding):
    //   S = 230_179: X = 10_230_179, row 10 (s.d. 10_350_000) 2.25% => 10_230_179 x 225/10000 = 230_179.0275
    //   => 230_179 = S (stable; S = 230_178 gives X = 10_230_178, T = 230_179.005 -> 230_179 > S, so not a fixed point).
    //   Each month: allowance 230_179, withheld by the employee via the allowance 230_179.
    //   prior withheld = 11 x 230_179 = 2_531_969; prior gross = 11 x 10_230_179 = 112_531_969 (A2).
    // Dec: gross = 112_531_969 + 10_000_000 + S; cost = 6_000_000 (5% of ~123.5 jt > cap).
    //   T(S) = annualTax(gross) - 2_531_969 with annualTax = 3_000_000 + 15% x (PKP - 60_000_000),
    //   PKP = floor((gross - 6_000_000 - 54_000_000)/1000) x 1000. Iterate S (S_{k+1} = T(S_k)):
    //   0 -> 847_681 -> 974_881 -> 993_931 -> 996_781 -> 997_231 -> 997_381 -> 997_381 stable.
    //   S=997_381: X = 10_997_381; gross = 123_529_350; net = 117_529_350;
    //   PKP = floor(63_529_350/1000) x 1000 = 63_529_000.
    //   annualTax = 3_000_000 + 3_529_000 x 15% = 3_000_000 + 529_350 = 3_529_350.
    //   T = 3_529_350 - 2_531_969 = 997_381 = S. OK.
    //   W = floor(T x G / X) = 0 (G = 0); A = floor(S x U/(U+N)) = S = 997_381; B = 0.
    //   Withheld = W + A = 997_381. Employee take-home = G + U + N - W = 10_000_000 (exact).
    // History split (legend-6q7o rule A/B): the prior withheld tax is all tunjangan
    // (prior.taxAllowanceIdr = 2_531_969 = 11 x 230_179), so pET = 2_531_969 and the
    // employer owns all of the Jan-Nov shortfall:
    //   H = annualTax(112_531_969) - 2_531_969: cost 5_626_598 (5%), net 106_905_371,
    //   PKP 52_905_000, tax 2_645_250 => H = 113_281;
    //   employerHistory = floor(113_281 x 2_531_969 / 2_531_969) = 113_281, employeeHistory = 0.
    //   W = 0 + floor((T - H) x 0 / X) = 0, so the result below is unchanged.
    const r = run({
      taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross_up" }],
      prior: { ...prior(112_531_969, 2_531_969), taxAllowanceIdr: 2_531_969 },
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
      netIdr: 117_529_350,
      annualizedNetIdr: 117_529_350,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 63_529_000,
      annualTaxIdr: 3_529_350,
      priorPph21Idr: 2_531_969,
    });
  });

  it("[PAYR-03] R29 December pure net scheme: the employer bears the whole December tax, which is itself taxable income", () => {
    // Salary 10_000_000 net every month (employer pays the tax). The borne tax is a taxable
    // benefit (FAQ DJP PMK-66 no. 40), so X = N + S, S = employer-borne tax.
    // Jan-Nov, each month: S = 230_179 is the fixed point (see R28):
    //   X = 10_230_179, T = 230_179 all borne by the employer; withheld 0.
    //   prior gross = 11 x 10_230_179 = 112_531_969; prior withheld 0; prior borne = 2_531_969.
    // Dec: same annual figures as R28 (the borne tax enters the gross exactly like an allowance):
    //   S iteration 0 -> 847_681 -> 974_881 -> 993_931 -> 996_781 -> 997_231 -> 997_381 stable.
    //   X = 10_000_000 + 997_381 = 10_997_381; gross = 123_529_350; PKP = 63_529_000;
    //   annualTax = 3_529_350; T = 3_529_350 - (0 + 2_531_969) = 997_381.
    //   W = 0 (G = 0); A = floor(S x U/(U+N)) = 0 (U = 0); B = T - W - A = 997_381.
    //   Withheld = 0, borne = 997_381.
    const r = run({
      taxableLines: [{ amountIdr: 10_000_000, taxScheme: "net" }],
      prior: prior(112_531_969, 0, 2_531_969),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.taxableGrossIdr).toBe(10_997_381);
    expect(r.pph21Idr).toBe(997_381);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(997_381);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 123_529_350,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 117_529_350,
      annualizedNetIdr: 117_529_350,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 63_529_000,
      annualTaxIdr: 3_529_350,
      priorPph21Idr: 2_531_969,
    });
  });

  it("[PAYR-03] R30 December, K/3 (PTKP 72 jt, TER category C)", () => {
    // Salary 20_000_000. Jan-Nov: K/3 => TER C; row 15 (s.d. 22_700_000) 8% => 1_600_000.
    //   prior withheld = 11 x 1_600_000 = 17_600_000; prior gross = 220_000_000.
    // Dec: gross 240_000_000; cost 6_000_000; net 234_000_000.
    //   PTKP K/3 = 54_000_000 + 4_500_000 (kawin) + 3 x 4_500_000 = 72_000_000.
    //   PKP = 234_000_000 - 72_000_000 = 162_000_000.
    //   tax = 3_000_000 + 102_000_000 x 15% = 15_300_000 => 18_300_000.
    //   Dec = 18_300_000 - 17_600_000 = 700_000.
    const r = run({
      ptkpStatus: "K/3",
      taxableLines: [{ amountIdr: 20_000_000, taxScheme: "gross" }],
      prior: prior(220_000_000, 17_600_000),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.withholdingStatus).toBe("K/3");
    expect(r.pph21Idr).toBe(700_000);
    expect(r.pph21WithheldIdr).toBe(700_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 240_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 234_000_000,
      annualizedNetIdr: 234_000_000,
      ptkpIdr: 72_000_000,
      taxableIncomeIdr: 162_000_000,
      annualTaxIdr: 18_300_000,
      priorPph21Idr: 17_600_000,
    });
  });

  it("[PAYR-03] R31 December, income below PTKP: PKP clamps to 0, no tax, no refund", () => {
    // Salary 4_000_000. Jan-Nov: TER A row 1 (s.d. 5_400_000) 0% => 0; prior withheld 0; prior gross 44_000_000.
    // Dec: gross 48_000_000; cost = min(5% x 48_000_000 = 2_400_000, 6_000_000) = 2_400_000.
    //   net = 45_600_000; 45_600_000 - 54_000_000 = -8_400_000 => PKP = 0. tax 0. Dec = 0 - 0 = 0.
    const r = run({
      taxableLines: [{ amountIdr: 4_000_000, taxScheme: "gross" }],
      prior: prior(44_000_000, 0),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(0);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.pph21EmployerRefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 48_000_000,
      occupationalCostIdr: 2_400_000,
      deductibleIdr: 0,
      netIdr: 45_600_000,
      annualizedNetIdr: 45_600_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 0,
      annualTaxIdr: 0,
      priorPph21Idr: 0,
    });
  });

  it("[PAYR-03] R32 December, PKP crosses the 250 jt boundary into the 25% slice", () => {
    // Salary 40_000_000. Jan-Nov: TER A row 26 (s.d. 43_850_000) 16% => 6_400_000.
    //   prior withheld = 11 x 6_400_000 = 70_400_000; prior gross 440_000_000.
    // Dec: gross 480_000_000; cost 6_000_000; net 474_000_000. PKP = 474_000_000 - 54_000_000 = 420_000_000.
    //   tax = 60_000_000 x 5% = 3_000_000 + 190_000_000 x 15% = 28_500_000 + 170_000_000 x 25% = 42_500_000 => 74_000_000.
    //   Dec = 74_000_000 - 70_400_000 = 3_600_000.
    const r = run({
      taxableLines: [{ amountIdr: 40_000_000, taxScheme: "gross" }],
      prior: prior(440_000_000, 70_400_000),
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
      netIdr: 474_000_000,
      annualizedNetIdr: 474_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 420_000_000,
      annualTaxIdr: 74_000_000,
      priorPph21Idr: 70_400_000,
    });
  });

  it("[PAYR-03] R33 PKP is rounded DOWN to whole thousands before applying the slices", () => {
    // Jan-Nov 10_000_000 => prior withheld 2_200_000, prior gross 110_000_000 (as R19).
    // Dec X=10_000_999: gross = 120_000_999; 5% = 6_000_049 > cap, cost = 6_000_000; net 114_000_999.
    //   raw = 114_000_999 - 54_000_000 = 60_000_999 => PKP = 60_000_000 (floor to 1000).
    //   tax = 60_000_000 x 5% = 3_000_000 (not 3_000_149). Dec = 3_000_000 - 2_200_000 = 800_000.
    // This floor is not affected by the half_up rounding mode of the tax itself.
    // Src: UU PPh Pasal 17(4).
    const r = run({
      taxableLines: [{ amountIdr: 10_000_999, taxScheme: "gross" }],
      prior: prior(110_000_000, 2_200_000),
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
      netIdr: 114_000_999,
      annualizedNetIdr: 114_000_999,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_000_000,
      annualTaxIdr: 3_000_000,
      priorPph21Idr: 2_200_000,
    });
  });

  it("[PAYR-03] R34 December, PKP crosses 500 jt into the 30% slice (100 jt salary)", () => {
    // Salary 100_000_000. Jan-Nov: TER A row 34 (s.d. 103_000_000) 24% => 24_000_000.
    //   prior withheld = 11 x 24_000_000 = 264_000_000; prior gross = 1_100_000_000.
    // Dec: gross 1_200_000_000; cost 6_000_000; net 1_194_000_000.
    //   PKP = 1_194_000_000 - 54_000_000 = 1_140_000_000.
    //   tax = 60 jt x 5% = 3_000_000 + 190 jt x 15% = 28_500_000 + 250 jt x 25% = 62_500_000
    //         + (1_140 jt - 500 jt = 640 jt) x 30% = 192_000_000 => 286_000_000.
    //   Dec = 286_000_000 - 264_000_000 = 22_000_000.
    const r = run({
      taxableLines: [{ amountIdr: 100_000_000, taxScheme: "gross" }],
      prior: prior(1_100_000_000, 264_000_000),
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
      netIdr: 1_194_000_000,
      annualizedNetIdr: 1_194_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 1_140_000_000,
      annualTaxIdr: 286_000_000,
      priorPph21Idr: 264_000_000,
    });
  });

  it("[PAYR-03] R35 December with employer benefit (taxable) and employee JHT/JP deduction", () => {
    // Salary 10_000_000 + employer JKK/JKM/BPJS-Kes share 400_000 => X=10_400_000 each month.
    // Jan-Nov: TER A row 11 (s.d. 10_700_000) 2.5% => 10_400_000 x 250/10000 = 260_000.
    //   prior withheld = 11 x 260_000 = 2_860_000; prior gross = 11 x 10_400_000 = 114_400_000.
    //   employee JHT+JP 300_000/month: prior deductible 3_300_000, Dec 300_000 => 3_600_000.
    // Dec: gross = 114_400_000 + 10_400_000 = 124_800_000; cost 6_000_000 (cap; 5% = 6_240_000).
    //   net = 124_800_000 - 6_000_000 - 3_600_000 = 115_200_000.
    //   PKP = 115_200_000 - 54_000_000 = 61_200_000.
    //   tax = 3_000_000 + 1_200_000 x 15% = 180_000 => 3_180_000.
    //   Dec = 3_180_000 - 2_860_000 = 320_000.
    const r = run({
      employerBenefitIdr: 400_000,
      employeeDeductibleIdr: 300_000,
      prior: prior(114_400_000, 2_860_000, 0, 3_300_000),
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
      netIdr: 115_200_000,
      annualizedNetIdr: 115_200_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 61_200_000,
      annualTaxIdr: 3_180_000,
      priorPph21Idr: 2_860_000,
    });
  });

  it("R36 December refund with a mixed gross + net payroll: the Jan-Nov credit goes back by payer history, each payer net of its own December tax (legend-u1xq)", () => {
    // Same annual figures as R26: annual tax 16_500_000 on prior gross 200_000_000.
    // Payer history this year: withheld from the employee 19_500_000, borne by the employer 6_500_000
    //   (total 26_000_000). T = 16_500_000 - 26_000_000 = -9_500_000, refund Rf = 9_500_000.
    // Dec lines: gross 6_000_000 + net 4_000_000 (X = 10_000_000, S = 0, A = B = W = 0).
    // Src: PMK 168/2023 Pasal 21 (kelebihan potong returns what was withheld).
    //
    // Updated for bead legend-u1xq (each payer's Jan-Nov credit is reduced by its own share
    // of this month's extra tax D). Old: employerRefund = floor(9_500_000 x 6_500_000 /
    // 26_000_000) = 2_375_000, employee refund 7_125_000 (the whole -T split by history).
    // New, `proportional` (default), no scheme base so the credit follows the payer history:
    //   annual(prior alone 200_000_000): cost 6_000_000, net 194_000_000, PKP 140_000_000,
    //   tax 3_000_000 + 15% x 80_000_000 = 15_000_000 => H = 15_000_000 - 26_000_000 =
    //   -11_000_000, credit C = 11_000_000. pET = borne 6_500_000, priorTax 26_000_000:
    //   Cr = floor(11_000_000 x 6_500_000 / 26_000_000) = 2_750_000, Ce = 8_250_000.
    //   D = 16_500_000 - 15_000_000 = 1_500_000 (X = 10_000_000, G* = 6_000_000):
    //   De = floor(1_500_000 x 6_000_000 / 10_000_000) = 900_000, Dr = 600_000.
    //   Company: Dr - Cr = 600_000 - 2_750_000 < 0 => S = 0 (X stays 10_000_000), refund
    //   2_150_000. Employee: De - Ce = 900_000 - 8_250_000 < 0 => W = 0, refund 7_350_000.
    //   Check: 7_350_000 + 2_150_000 = 9_500_000 = -T.
    const r = run({
      taxableLines: [
        { amountIdr: 6_000_000, taxScheme: "gross" },
        { amountIdr: 4_000_000, taxScheme: "net" },
      ],
      prior: prior(200_000_000, 19_500_000, 6_500_000),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(10_000_000);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21Idr).toBe(-9_500_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(7_350_000);
    expect(r.pph21EmployerRefundIdr).toBe(2_150_000);
    // New invariant (legend-u1xq): withheld + borne - refunds = T; refunds <= Ce / Cr.
    expect(
      r.pph21WithheldIdr +
        r.pph21EmployerBorneIdr -
        r.pph21RefundIdr -
        r.pph21EmployerRefundIdr,
    ).toBe(r.pph21Idr);
    expect(r.pph21RefundIdr).toBeLessThanOrEqual(8_250_000);
    expect(r.pph21EmployerRefundIdr).toBeLessThanOrEqual(2_750_000);
    expect(r.annual).toEqual({
      grossIdr: 210_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 204_000_000,
      annualizedNetIdr: 204_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 150_000_000,
      annualTaxIdr: 16_500_000,
      priorPph21Idr: 26_000_000,
    });
  });

  it("R49 Codex refund case: history entirely withheld from the employee => no employer refund; the employer bears the December net line, the employee gets their credit net of their own December tax (legend-u1xq)", () => {
    // prior gross 200_000_000, prior withheld 26_000_000 (all employee), borne 0.
    // Dec lines: gross 6_000_000 + net 4_000_000 => X = 10_000_000; gross 210_000_000; cost 6_000_000;
    //   net 204_000_000; PKP 150_000_000; annualTax 16_500_000 (as R26). T = -9_500_000.
    // (The old v1 rule split by this month's net share, 3_800_000 to the employer: wrong, the
    //  employer never paid any of this tax.)
    //
    // Updated for bead legend-u1xq. Old: the whole 9_500_000 = -T to the employee, X = 10_000_000,
    // nothing borne. Why it changed: the credit of each payer is reduced by its own share of the
    // extra tax D, and the NET line of this month is the company's tax, borne and taxable (in X).
    // annual(prior alone) = 15_000_000 (see R36) => H = 15_000_000 - 26_000_000 = -11_000_000,
    // C = 11_000_000. pET = 0 => Cr = 0 (both policies, no scheme base), Ce = 11_000_000.
    // The company has no credit, so the extra tax on the net line is paid by it: S = Dr, a fixed
    // point (X = 10_000_000 + S, G* = 6_000_000, D(X) = annual(200_000_000 + X) - 15_000_000):
    //   gross_first: De = min(D, annual(206_000_000) - 15_000_000 = 15_900_000 - 15_000_000 = 900_000)
    //     S0=0       annual 16_500_000 D 1_500_000 De 900_000 Dr 600_000
    //     S1=600_000 annual 16_590_000 D 1_590_000 Dr 690_000
    //     S2=690_000 annual 16_603_500 D 1_603_500 Dr 703_500
    //     S3=703_500 annual 16_605_450 D 1_605_450 Dr 705_450
    //     S4=705_450 annual 16_605_750 D 1_605_750 Dr 705_750
    //     S5=705_750 annual 16_605_750 Dr 705_750 stop.
    //     X = 10_705_750, T = 16_605_750 - 26_000_000 = -9_394_250; employee: W = 0, refund
    //     11_000_000 - 900_000 = 10_100_000; borne 705_750; company refund 0.
    //   proportional: De = floor(D x 6_000_000 / X), iterated the same way:
    //     0 -> 600_000 -> 690_000 -> 703_500 -> 705_493 -> 705_792 -> 705_817 -> 705_819 -> 705_819 stop
    //     (D stays 1_605_750 from S = 705_450 on, De = 899_931 at the end, Dr = 705_819).
    //     X = 10_705_819, T = -9_394_250; refund 11_000_000 - 899_931 = 10_100_069; borne 705_819.
    // Check: 705_750 - 10_100_000 = -9_394_250 = T (and 705_819 - 10_100_069 likewise).
    const lines = [
      { amountIdr: 6_000_000, taxScheme: "gross" as const },
      { amountIdr: 4_000_000, taxScheme: "net" as const },
    ];
    const expected = {
      proportional: { x: 10_705_819, borne: 705_819, refund: 10_100_069 },
      gross_first: { x: 10_705_750, borne: 705_750, refund: 10_100_000 },
    } as const;
    for (const mixedSchemeAllocation of [
      "proportional",
      "gross_first",
    ] as const) {
      const e = expected[mixedSchemeAllocation];
      const r = run(
        { taxableLines: lines, prior: prior(200_000_000, 26_000_000) },
        { mixedSchemeAllocation },
      );
      expect(r.pph21Idr).toBe(-9_394_250);
      expect(r.pph21RefundIdr).toBe(e.refund);
      expect(r.pph21EmployerRefundIdr).toBe(0);
      expect(r.pph21WithheldIdr).toBe(0);
      expect(r.pph21EmployerBorneIdr).toBe(e.borne);
      expect(r.taxAllowanceIdr).toBe(0);
      expect(r.taxableGrossIdr).toBe(e.x);
      // New invariant (legend-u1xq): withheld + borne - refunds = T; refund <= Ce.
      expect(
        r.pph21WithheldIdr +
          r.pph21EmployerBorneIdr -
          r.pph21RefundIdr -
          r.pph21EmployerRefundIdr,
      ).toBe(r.pph21Idr);
      expect(r.pph21RefundIdr).toBeLessThanOrEqual(11_000_000);
    }
  });

  it("R50 refund with mixed payers and no scheme base: both policies split the credit by payer history (legend-u1xq)", () => {
    // Same annual figures as R49: T = -9_500_000, Rf = 9_500_000.
    // History: withheld hw = 15_600_000, employer-borne hb = 10_400_000 (total 26_000_000).
    // Updated for bead legend-u1xq. Old: proportional employerRefund = floor(9_500_000 x
    // 10_400_000 / 26_000_000) = 3_800_000, employee 5_700_000; gross_first employee refund
    // 9_500_000, employer 0 (the whole -T split by history).
    // New: H = annual(200_000_000) - 26_000_000 = 15_000_000 - 26_000_000 = -11_000_000 (R36),
    // C = 11_000_000. No scheme base: both policies Cr = floor(11_000_000 x 10_400_000 /
    // 26_000_000) = 4_400_000 (exact), Ce = 6_600_000. This month (gross 6 jt + net 4 jt):
    // D = 1_500_000, De = 900_000, Dr = 600_000 (both policies: gross_first De = min(D,
    // 15_900_000 - 15_000_000) = 900_000). Company: 600_000 - 4_400_000 < 0 => S = 0 (X =
    // 10_000_000), refund 3_800_000. Employee: 900_000 - 6_600_000 < 0 => W = 0, refund
    // 5_700_000. -T = 9_500_000 = 5_700_000 + 3_800_000. gross_first no longer returns the
    // employee's own payments first when no scheme base is known.
    const common = {
      taxableLines: [
        { amountIdr: 6_000_000, taxScheme: "gross" as const },
        { amountIdr: 4_000_000, taxScheme: "net" as const },
      ],
      prior: prior(200_000_000, 15_600_000, 10_400_000),
    };
    const proportional = run(common, { mixedSchemeAllocation: "proportional" });
    expect(proportional.pph21Idr).toBe(-9_500_000);
    expect(proportional.pph21RefundIdr).toBe(5_700_000);
    expect(proportional.pph21EmployerRefundIdr).toBe(3_800_000);
    expect(proportional.pph21WithheldIdr).toBe(0);
    expect(proportional.pph21EmployerBorneIdr).toBe(0);

    const grossFirst = run(common, { mixedSchemeAllocation: "gross_first" });
    expect(grossFirst.pph21Idr).toBe(-9_500_000);
    expect(grossFirst.pph21RefundIdr).toBe(5_700_000);
    expect(grossFirst.pph21EmployerRefundIdr).toBe(3_800_000);
    expect(grossFirst.pph21WithheldIdr).toBe(0);
    expect(grossFirst.pph21EmployerBorneIdr).toBe(0);
    // New invariant (legend-u1xq): withheld + borne - refunds = T; refunds <= Ce / Cr.
    for (const r of [proportional, grossFirst]) {
      expect(
        r.pph21WithheldIdr +
          r.pph21EmployerBorneIdr -
          r.pph21RefundIdr -
          r.pph21EmployerRefundIdr,
      ).toBe(r.pph21Idr);
      expect(r.pph21RefundIdr).toBeLessThanOrEqual(6_600_000);
      expect(r.pph21EmployerRefundIdr).toBeLessThanOrEqual(4_400_000);
    }
  });

  it("R51 refund larger than what the employee ever paid, no scheme base: both policies split the credit by payer history, the employer rounded down (legend-u1xq)", () => {
    // Same annual figures: Rf = 9_500_000. History: hw = 5_000_000, hb = 21_000_000 (total 26_000_000).
    // Updated for bead legend-u1xq. Old: gross_first employee refund min(9_500_000, 5_000_000) =
    // 5_000_000, employer 4_500_000; proportional employerRefund floor(9_500_000 x 21_000_000 /
    // 26_000_000) = 7_673_076, employee 1_826_924 (the whole -T split by history).
    // New: C = 11_000_000 (H = -11_000_000, see R36). No scheme base: both policies Cr =
    // floor(11_000_000 x 21_000_000 / 26_000_000) = floor(8_884_615,38) = 8_884_615, Ce =
    // 11_000_000 - 8_884_615 = 2_115_385. This month D = 1_500_000, De = 900_000, Dr = 600_000
    // (see R50), S = 0 (600_000 < Cr). Employee: 900_000 - 2_115_385 < 0 => W = 0, refund
    // 1_215_385. Company: 600_000 - 8_884_615 < 0 => refund 8_284_615.
    // 1_215_385 + 8_284_615 = 9_500_000 = -T. gross_first no longer caps the employee refund at
    // what the employee paid (5_000_000) because the credit is split by payer history alone.
    const common = {
      taxableLines: [
        { amountIdr: 6_000_000, taxScheme: "gross" as const },
        { amountIdr: 4_000_000, taxScheme: "net" as const },
      ],
      prior: prior(200_000_000, 5_000_000, 21_000_000),
    };
    const grossFirst = run(common, { mixedSchemeAllocation: "gross_first" });
    expect(grossFirst.pph21Idr).toBe(-9_500_000);
    expect(grossFirst.pph21RefundIdr).toBe(1_215_385);
    expect(grossFirst.pph21EmployerRefundIdr).toBe(8_284_615);

    const proportional = run(common, { mixedSchemeAllocation: "proportional" });
    expect(proportional.pph21Idr).toBe(-9_500_000);
    expect(proportional.pph21RefundIdr).toBe(1_215_385);
    expect(proportional.pph21EmployerRefundIdr).toBe(8_284_615);
    // New invariant (legend-u1xq): withheld + borne - refunds = T; refunds <= Ce / Cr.
    for (const r of [proportional, grossFirst]) {
      expect(
        r.pph21WithheldIdr +
          r.pph21EmployerBorneIdr -
          r.pph21RefundIdr -
          r.pph21EmployerRefundIdr,
      ).toBe(r.pph21Idr);
      expect(r.pph21RefundIdr).toBeLessThanOrEqual(2_115_385);
      expect(r.pph21EmployerRefundIdr).toBeLessThanOrEqual(8_884_615);
    }
  });

  it("R52 gross -> net switch: Jan-Jun on gross, Jul-Nov on net, December on gross", () => {
    // Jan-Jun gross, X = 10_000_000, TER A 2% => 200_000 withheld each: 6 x 200_000 = 1_200_000.
    // Jul-Nov net: X = 10_230_179 (10 jt + borne 230_179, see R28), borne 230_179 each, withheld 0:
    //   5 x 230_179 = 1_150_895 borne; gross 5 x 10_230_179 = 51_150_895.
    // prior gross = 6 x 10_000_000 + 51_150_895 = 111_150_895; hw = 1_200_000; hb = 1_150_895.
    // Dec gross 10_000_000: gross = 121_150_895; 5% = 6_057_544 > cap => cost 6_000_000;
    //   net = 115_150_895; raw PKP = 61_150_895 => PKP 61_150_000;
    //   tax = 3_000_000 + 1_150_000 x 15% = 172_500 => 3_172_500.
    //   T = 3_172_500 - (1_200_000 + 1_150_895) = 3_172_500 - 2_350_895 = 821_605.
    //   (Superseded by legend-6q7o: this X = 10_000_000 / W = T = 821_605 was the old result.)
    //
    // History split (legend-6q7o rules A-D), proportional (the default policy):
    //   H = annualTax(prior alone) - priorTax: cost 5% x 111_150_895 = 5_557_544 (< cap),
    //   net 105_593_351, PKP 51_593_000, tax 2_579_650 => H = 2_579_650 - 2_350_895 = 228_755.
    //   No scheme base, no allowance (E = 0): pET = priorBorne = 1_150_895, priorTax = 2_350_895,
    //   employerHistory = floor(228_755 x 1_150_895 / 2_350_895) = 111_988, employeeHistory = 116_767.
    //   The employer's 111_988 is borne tax, hence taxable: X = 10_000_000 + S, G* = 10_000_000.
    //   S_{k+1} = T(X) - W(X), W = employeeHistory + floor((T - H) x G* / X):
    //   0 -> 111_988 -> 118_740 -> 119_155 -> 119_181 -> 119_183 -> 119_183 stable.
    //   S = 119_183: X = 10_119_183; gross = 121_270_078; cost 6_000_000; net = 115_270_078;
    //   PKP = 61_270_000; tax = 3_000_000 + 1_270_000 x 15% = 190_500 => 3_190_500.
    //   T = 3_190_500 - 2_350_895 = 839_605.
    //   W = 116_767 + floor((839_605 - 228_755) x 10_000_000 / 10_119_183) = 116_767 + 603_655 = 720_422.
    //   B = T - W = 119_183 = S (the employer's earlier borne share of the history stays the employer's).
    const r = run({ prior: prior(111_150_895, 1_200_000, 1_150_895) });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(10_119_183);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21Idr).toBe(839_605);
    expect(r.pph21WithheldIdr).toBe(720_422);
    expect(r.pph21EmployerBorneIdr).toBe(119_183);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 121_270_078,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 115_270_078,
      annualizedNetIdr: 115_270_078,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 61_270_000,
      annualTaxIdr: 3_190_500,
      priorPph21Idr: 2_350_895,
    });
  });

  it("R53 net -> gross switch: Jan-Jun on net, Jul-Nov on gross, December on net", () => {
    // Jan-Jun net: X = 10_230_179, borne 230_179 each: hb = 6 x 230_179 = 1_381_074; gross 61_381_074.
    // Jul-Nov gross: X = 10_000_000, withheld 200_000 each: hw = 1_000_000; gross 50_000_000.
    // prior gross = 111_381_074.
    // Dec net 10_000_000, S = employer-borne tax in the gross. Iterate S_{k+1} = T(10_000_000 + S_k):
    //   0 -> 826_076 -> 949_976 -> 968_576 -> 971_276 -> 971_726 -> 971_726 stable. S = 971_726.
    //   X = 10_971_726; gross = 122_352_800; cost 6_000_000; net = 116_352_800;
    //   raw PKP = 62_352_800 => PKP 62_352_000; tax = 3_000_000 + 2_352_000 x 15% = 352_800 => 3_352_800.
    //   T = 3_352_800 - (1_000_000 + 1_381_074) = 3_352_800 - 2_381_074 = 971_726 = S.
    //   G = U = 0 => W = 0, A = 0, B = T = 971_726. Withheld 0, borne 971_726.
    //   (Superseded by legend-6q7o: the employee did pay 1_000_000 of the year's tax in
    //   Jul-Nov, so they keep their part of the Jan-Jun shortfall below.)
    //
    // History split (legend-6q7o rules A-D), proportional (default policy), G* = 0:
    //   H = annualTax(111_381_074) - 2_381_074: cost 5% = 5_569_053, net 105_812_021,
    //   PKP 51_812_000, tax 2_590_600 => H = 209_526.
    //   pET = priorBorne = 1_381_074 (no allowance, E = 0); priorTax = 2_381_074;
    //   employerHistory = floor(209_526 x 1_381_074 / 2_381_074) = 121_529; employeeHistory = 87_997.
    //   W = 87_997 + floor((T - H) x 0 / X) = 87_997 (G* = 0, only the history share).
    //   Fixed point, S_{k+1} = T(X) - W, X = 10_000_000 + S:
    //   0 -> 738_079 -> 848_779 -> 865_279 -> 867_829 -> 868_129 -> 868_279 -> 868_279 stable.
    //   S = 868_279: X = 10_868_279; gross = 122_249_353; net = 116_249_353;
    //   PKP = 62_249_000; tax = 3_000_000 + 2_249_000 x 15% = 337_350 => 3_337_350.
    //   T = 3_337_350 - 2_381_074 = 956_276. W = 87_997; A = 0 (U = 0); B = 956_276 - 87_997 = 868_279.
    const r = run({
      taxableLines: [{ amountIdr: 10_000_000, taxScheme: "net" }],
      prior: prior(111_381_074, 1_000_000, 1_381_074),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(10_868_279);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21Idr).toBe(956_276);
    expect(r.pph21WithheldIdr).toBe(87_997);
    expect(r.pph21EmployerBorneIdr).toBe(868_279);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 122_249_353,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 116_249_353,
      annualizedNetIdr: 116_249_353,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 62_249_000,
      annualTaxIdr: 3_337_350,
      priorPph21Idr: 2_381_074,
    });
  });

  it("R54 K/I/0 under `normalize` (default): husband 10 jt/month is withheld as K/0 in TER months and reconciled with PTKP K/0 in December", () => {
    // K/I/0 is an SPT status, not a withholding status (PP 58/2023 has no K/I TER category).
    // Normalised to K/0: TER category A, PTKP 58_500_000 (not 112_500_000).
    // Jan-Nov: X=10_000_000 TER A 2% => 200_000; prior withheld 2_200_000; prior gross 110_000_000.
    // Dec: gross 120_000_000; cost 6_000_000; net 114_000_000; PKP = 114_000_000 - 58_500_000 = 55_500_000.
    //   tax = 55_500_000 x 5% = 2_775_000. Dec = 2_775_000 - 2_200_000 = 575_000.
    const r = run({
      ptkpStatus: "K/I/0",
      prior: prior(110_000_000, 2_200_000),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.withholdingStatus).toBe("K/0");
    expect(r.pph21Idr).toBe(575_000);
    expect(r.pph21WithheldIdr).toBe(575_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 120_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 114_000_000,
      annualizedNetIdr: 114_000_000,
      ptkpIdr: 58_500_000,
      taxableIncomeIdr: 55_500_000,
      annualTaxIdr: 2_775_000,
      priorPph21Idr: 2_200_000,
    });
  });

  it("R55 K/I/0 under `reject`: the computation is refused with PAYROLL_PPH21_STATUS_UNSUPPORTED (422)", () => {
    let error: unknown;
    try {
      run(
        { ptkpStatus: "K/I/0", prior: prior(110_000_000, 2_200_000) },
        { combinedSpouseStatus: "reject" },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PayrollError);
    expect(error).toMatchObject({
      code: "PAYROLL_PPH21_STATUS_UNSUPPORTED",
      status: 422,
    });
    // A non-combined status still works under the same policy (K/0 => PTKP 58_500_000, as R54).
    const ok = run(
      { ptkpStatus: "K/0", prior: prior(110_000_000, 2_200_000) },
      { combinedSpouseStatus: "reject" },
    );
    expect(ok.pph21Idr).toBe(575_000);
  });

  it("[PAYR-03] R56 partial-year tax subject, official example: TK/0, 17,5 jt a month Jan-Aug, annualised, December-style recalculation in August => 1.200.000", () => {
    // Kewajiban pajak subjektif ends in August (e.g. leaves Indonesia for good): monthsWorked 8,
    // partialYearTaxSubject true. PMK 168/2023 Pasal 15(3), Lampiran I.2.2.3; Buku Cermat PPh 21 p.53.
    // Jan-Jul: X=17_500_000, TER A row 18 (16_950_000 < X <= 19_750_000) 8% => 1_400_000.
    //   prior withheld = 7 x 1_400_000 = 9_800_000; prior gross = 7 x 17_500_000 = 122_500_000.
    // Aug: gross = 122_500_000 + 17_500_000 = 140_000_000.
    //   cost = min(5% x 140_000_000 = 7_000_000, floor(6_000_000 x 8/12) = 4_000_000) = 4_000_000.
    //   net = 136_000_000. annualised net = floor(136_000_000 x 12/8) = 204_000_000.
    //   PKP = 204_000_000 - 54_000_000 = 150_000_000.
    //   annual tax at full-year rates = 60_000_000 x 5% + 90_000_000 x 15% = 3_000_000 + 13_500_000 = 16_500_000.
    //   de-annualised: 16_500_000 x 8/12 = 11_000_000.
    //   Aug = 11_000_000 - 9_800_000 = 1_200_000 (the DJP example's result).
    const r = run({
      monthsWorked: 8,
      partialYearTaxSubject: true,
      taxableLines: [{ amountIdr: 17_500_000, taxScheme: "gross" }],
      prior: prior(122_500_000, 9_800_000),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(1_200_000);
    expect(r.pph21WithheldIdr).toBe(1_200_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.noTaxIdSurchargeApplied).toBe(false);
    expect(r.annual).toEqual({
      grossIdr: 140_000_000,
      occupationalCostIdr: 4_000_000,
      deductibleIdr: 0,
      netIdr: 136_000_000,
      annualizedNetIdr: 204_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 150_000_000,
      annualTaxIdr: 11_000_000,
      priorPph21Idr: 9_800_000,
    });
  });

  it("R57 partial-year tax subject without NPWP: same example, 120% on TER months and on the annual tax", () => {
    // Jan-Jul: tax = 17_500_000 x 800 x 12000 / 10^8 = 1_680_000 each; prior withheld = 7 x 1_680_000 = 11_760_000.
    // Aug: same annual figures as R56 (gross 140_000_000, cost 4_000_000, net 136_000_000,
    //   annualised 204_000_000, PKP 150_000_000); annual tax = 16_500_000 x 12000/10000 x 8/12
    //   = 19_800_000 x 8/12 = 13_200_000.
    //   Aug = 13_200_000 - 11_760_000 = 1_440_000.
    const r = run({
      hasTaxId: false,
      monthsWorked: 8,
      partialYearTaxSubject: true,
      taxableLines: [{ amountIdr: 17_500_000, taxScheme: "gross" }],
      prior: prior(122_500_000, 11_760_000),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.noTaxIdSurchargeApplied).toBe(true);
    expect(r.pph21Idr).toBe(1_440_000);
    expect(r.pph21WithheldIdr).toBe(1_440_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 140_000_000,
      occupationalCostIdr: 4_000_000,
      deductibleIdr: 0,
      netIdr: 136_000_000,
      annualizedNetIdr: 204_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 150_000_000,
      annualTaxIdr: 13_200_000,
      priorPph21Idr: 11_760_000,
    });
  });

  it("R58 December, PKP above 5 miliar reaches the 35% slice", () => {
    // Salary 500_000_000 a month, TK/0. Jan-Nov: TER A row 40 (s.d. 550_000_000; 454_000_000 < X) 30%
    //   => 500_000_000 x 3000/10000 = 150_000_000 each.
    //   prior withheld = 11 x 150_000_000 = 1_650_000_000; prior gross = 5_500_000_000.
    // Dec: gross = 6_000_000_000; cost = min(300_000_000, 6_000_000) = 6_000_000; net 5_994_000_000.
    //   PKP = 5_994_000_000 - 54_000_000 = 5_940_000_000.
    //   slices: 60 jt x 5% = 3_000_000; 190 jt x 15% = 28_500_000; 250 jt x 25% = 62_500_000;
    //           4_500 jt (500 jt..5 M) x 30% = 1_350_000_000; 940 jt (5 M..5,94 M) x 35% = 329_000_000.
    //   annual tax = 3_000_000 + 28_500_000 + 62_500_000 + 1_350_000_000 + 329_000_000 = 1_773_000_000.
    //   Dec = 1_773_000_000 - 1_650_000_000 = 123_000_000.
    // Src: UU PPh Pasal 17(1)a as amended by UU HPP (35% above Rp5 miliar).
    const r = run({
      taxableLines: [{ amountIdr: 500_000_000, taxScheme: "gross" }],
      prior: prior(5_500_000_000, 1_650_000_000),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.pph21Idr).toBe(123_000_000);
    expect(r.pph21WithheldIdr).toBe(123_000_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 6_000_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 5_994_000_000,
      annualizedNetIdr: 5_994_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 5_940_000_000,
      annualTaxIdr: 1_773_000_000,
      priorPph21Idr: 1_650_000_000,
    });
  });

  it("R59 occupationalCostCap: `pro_rata_months` vs `full_annual` for a July joiner", () => {
    // Same figures as R23: Jul-Dec, 15_000_000 a month, prior gross 75_000_000, prior withheld 4_500_000.
    // Dec gross 90_000_000; 5% = 4_500_000.
    // pro_rata_months (default): cap = floor(6_000_000 x 6/12) = 3_000_000 => cost 3_000_000;
    //   net 87_000_000; PKP 33_000_000; tax 1_650_000; T = 1_650_000 - 4_500_000 = -2_850_000.
    // full_annual: cap = 6_000_000 => cost = min(4_500_000, 6_000_000) = 4_500_000;
    //   net 85_500_000; PKP = 31_500_000; tax = 1_575_000; T = 1_575_000 - 4_500_000 = -2_925_000.
    // Src: PMK 168/2023 Pasal 10(2) ("paling banyak Rp6.000.000 setahun atau Rp500.000 sebulan").
    const input = {
      monthsWorked: 6,
      taxableLines: [{ amountIdr: 15_000_000, taxScheme: "gross" as const }],
      prior: prior(75_000_000, 4_500_000),
    };
    const proRata = run(input, { occupationalCostCap: "pro_rata_months" });
    expect(proRata.pph21Idr).toBe(-2_850_000);
    expect(proRata.pph21RefundIdr).toBe(2_850_000);
    expect(proRata.annual).toEqual({
      grossIdr: 90_000_000,
      occupationalCostIdr: 3_000_000,
      deductibleIdr: 0,
      netIdr: 87_000_000,
      annualizedNetIdr: 87_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 33_000_000,
      annualTaxIdr: 1_650_000,
      priorPph21Idr: 4_500_000,
    });

    const full = run(input, { occupationalCostCap: "full_annual" });
    expect(full.pph21Idr).toBe(-2_925_000);
    expect(full.pph21RefundIdr).toBe(2_925_000);
    expect(full.annual).toEqual({
      grossIdr: 90_000_000,
      occupationalCostIdr: 4_500_000,
      deductibleIdr: 0,
      netIdr: 85_500_000,
      annualizedNetIdr: 85_500_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 31_500_000,
      annualTaxIdr: 1_575_000,
      priorPph21Idr: 4_500_000,
    });
  });

  it("[PAYR-03] R60 December with salary, THR and bonus paid in the same month", () => {
    // Jan-Nov flat 10_000_000: prior withheld 2_200_000, prior gross 110_000_000.
    // Dec lines: salary 10_000_000 + THR 10_000_000 + bonus 15_000_000 => X = 35_000_000.
    //   gross = 145_000_000; cost = 6_000_000 (cap; 5% = 7_250_000); net 139_000_000.
    //   PKP = 139_000_000 - 54_000_000 = 85_000_000.
    //   tax = 3_000_000 + 25_000_000 x 15% = 3_750_000 => 6_750_000.
    //   Dec = 6_750_000 - 2_200_000 = 4_550_000.
    const r = run({
      taxableLines: [
        { amountIdr: 10_000_000, taxScheme: "gross" },
        { amountIdr: 10_000_000, taxScheme: "gross" },
        { amountIdr: 15_000_000, taxScheme: "gross" },
      ],
      prior: prior(110_000_000, 2_200_000),
    });
    expect(r.method).toBe("annual_recalculation");
    expect(r.taxableGrossIdr).toBe(35_000_000);
    expect(r.pph21Idr).toBe(4_550_000);
    expect(r.pph21WithheldIdr).toBe(4_550_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.annual).toEqual({
      grossIdr: 145_000_000,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 139_000_000,
      annualizedNetIdr: 139_000_000,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 85_000_000,
      annualTaxIdr: 6_750_000,
      priorPph21Idr: 2_200_000,
    });
  });

  it("R61 rounding mode on a fractional annual tax: `half_up` rounds .5 up, `down` floors", () => {
    // Partial year (monthsWorked 7, partialYearTaxSubject), TK/0, X = 10_000_084.
    // prior gross = 6 x 10_000_084 = 60_000_504; prior withheld fixed at 1_200_012
    //   (6 x half_up(10_000_084 x 200/10000 = 200_001.68 => 200_002)).
    // gross = 70_000_588; cost = min(5% x 70_000_588 = 3_500_029, floor(6_000_000 x 7/12) = 3_500_000) = 3_500_000.
    // net = 66_500_588; annualised net = floor(66_500_588 x 12/7) = 114_001_008 (exact: 798_007_056 / 7).
    // PKP = floor((114_001_008 - 54_000_000)/1000) x 1000 = 60_001_000 (floor to 1000 in both modes).
    // annual tax at full-year rates = 60_000_000 x 5% + 1_000 x 15% = 3_000_150; x 7/12 = 1_750_087.5.
    // half_up => 1_750_088; down => 1_750_087.
    // T = annual tax - 1_200_012: half_up 550_076; down 550_075.
    // Src: PER-11/PJ/2025 Pasal 129 (Coretax rounding); PKP floor is Pasal 17(4) UU PPh, mode-independent.
    const input = {
      monthsWorked: 7,
      partialYearTaxSubject: true,
      taxableLines: [{ amountIdr: 10_000_084, taxScheme: "gross" as const }],
      prior: prior(60_000_504, 1_200_012),
    };
    const up = run(input, { roundingMode: "half_up" });
    expect(up.annual).toEqual({
      grossIdr: 70_000_588,
      occupationalCostIdr: 3_500_000,
      deductibleIdr: 0,
      netIdr: 66_500_588,
      annualizedNetIdr: 114_001_008,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_001_000,
      annualTaxIdr: 1_750_088,
      priorPph21Idr: 1_200_012,
    });
    expect(up.pph21Idr).toBe(550_076);
    expect(up.pph21WithheldIdr).toBe(550_076);

    const down = run(input, { roundingMode: "down" });
    expect(down.annual).toEqual({
      grossIdr: 70_000_588,
      occupationalCostIdr: 3_500_000,
      deductibleIdr: 0,
      netIdr: 66_500_588,
      annualizedNetIdr: 114_001_008,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_001_000,
      annualTaxIdr: 1_750_087,
      priorPph21Idr: 1_200_012,
    });
    expect(down.pph21Idr).toBe(550_075);
    expect(down.pph21WithheldIdr).toBe(550_075);
  });

  it("R62 December mixed gross 6 jt + net 4 jt: `proportional` vs `gross_first` allocation of the employer-borne share", () => {
    // Jan-Nov flat 10_000_000 gross: prior withheld 2_200_000, prior gross 110_000_000.
    // G = 6_000_000, N = 4_000_000, U = 0. X = G + N + S, S = employer-borne tax (taxable benefit).
    // Annual tax of X: gross = 110_000_000 + X; cost 6_000_000; PKP = floor((gross - 60_000_000)/1000)x1000;
    //   tax = 3_000_000 + 15% x (PKP - 60_000_000); T(X) = tax - 2_200_000.
    //
    // proportional (legend-6q7o rule C, H > 0): W(X) = employeeHistory + floor((T(X) - H) x G* / X),
    //   C(S) = T(X) - W(X). (Old rule W = floor(T x G / X): S = 359_310, W = 494_540.)
    //   H = annualTax(110 jt) - 2_200_000: cost 5_500_000, net 104_500_000, PKP 50_500_000,
    //   tax 2_525_000 => H = 325_000. Pure gross history (no borne, no allowance):
    //   pET = 0, employerHistory = 0, employeeHistory = 325_000. G* = 6_000_000.
    //   S: 0 -> 190_000 -> 207_033 -> 208_579 -> 208_686 -> 208_689 -> 208_689 stable.
    //   S = 208_689: X = 10_208_689; gross = 120_208_689; net = 114_208_689;
    //   PKP = floor(60_208_689/1000)x1000 = 60_208_000; tax = 3_000_000 + 208_000 x 15% = 31_200 => 3_031_200.
    //   T = 3_031_200 - 2_200_000 = 831_200.
    //   W = 325_000 + floor((831_200 - 325_000) x 6_000_000 / 10_208_689) = 325_000 + 297_511 = 622_511. A = 0.
    //   B = 831_200 - 622_511 = 208_689 = S. Withheld = 622_511, borne = 208_689.
    //
    // gross_first: W = min(T(X), max(0, Talone)) with Talone = T(G = 6_000_000):
    //   gross 116_000_000; cost = 5% x 116_000_000 = 5_800_000; PKP = 116_000_000 - 5_800_000 - 54_000_000
    //   = 56_200_000; tax 2_810_000; Talone = 2_810_000 - 2_200_000 = 610_000.
    //   C(S) = T(X) - 610_000. S: 0 -> 190_000 -> 218_500 -> 222_700 -> 223_300 -> 223_450 -> 223_450 stable.
    //   S = 223_450: X = 10_223_450; gross = 120_223_450; net = 114_223_450; PKP = 60_223_000;
    //   tax = 3_000_000 + 223_000 x 15% = 33_450 => 3_033_450. T = 833_450.
    //   W = min(833_450, 610_000) = 610_000; B = 833_450 - 610_000 = 223_450. Withheld 610_000, borne 223_450.
    //   (Rule E re-check: Talone = tax(116 jt) - 2_200_000 - H + employeeHistory = 610_000 - 325_000 + 325_000
    //   = 610_000, so gross_first is unchanged by legend-6q7o.)
    // Employee take-home = G + U + N - W (exact): 10_000_000 - W.
    const lines = [
      { amountIdr: 6_000_000, taxScheme: "gross" as const },
      { amountIdr: 4_000_000, taxScheme: "net" as const },
    ];
    const proportional = run(
      { taxableLines: lines, prior: prior(110_000_000, 2_200_000) },
      { mixedSchemeAllocation: "proportional" },
    );
    expect(proportional.taxableGrossIdr).toBe(10_208_689);
    expect(proportional.taxAllowanceIdr).toBe(0);
    expect(proportional.pph21Idr).toBe(831_200);
    expect(proportional.pph21WithheldIdr).toBe(622_511);
    expect(proportional.pph21EmployerBorneIdr).toBe(208_689);
    expect(proportional.pph21RefundIdr).toBe(0);
    expect(proportional.annual).toEqual({
      grossIdr: 120_208_689,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 114_208_689,
      annualizedNetIdr: 114_208_689,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_208_000,
      annualTaxIdr: 3_031_200,
      priorPph21Idr: 2_200_000,
    });

    const grossFirst = run(
      { taxableLines: lines, prior: prior(110_000_000, 2_200_000) },
      { mixedSchemeAllocation: "gross_first" },
    );
    expect(grossFirst.taxableGrossIdr).toBe(10_223_450);
    expect(grossFirst.taxAllowanceIdr).toBe(0);
    expect(grossFirst.pph21Idr).toBe(833_450);
    expect(grossFirst.pph21WithheldIdr).toBe(610_000);
    expect(grossFirst.pph21EmployerBorneIdr).toBe(223_450);
    expect(grossFirst.pph21RefundIdr).toBe(0);
    expect(grossFirst.annual).toEqual({
      grossIdr: 120_223_450,
      occupationalCostIdr: 6_000_000,
      deductibleIdr: 0,
      netIdr: 114_223_450,
      annualizedNetIdr: 114_223_450,
      ptkpIdr: 54_000_000,
      taxableIncomeIdr: 60_223_000,
      annualTaxIdr: 3_033_450,
      priorPph21Idr: 2_200_000,
    });
  });
});

describe("PPh 21 history shortfall and unpaid last period (R63-R65, review round 2)", () => {
  it("R62b proportional December, mixed gross 6 jt + net 4 jt + employer BPJS 500_000: W = employeeHistory + floor((T - H) x G* / X)", () => {
    // CTO decision 2026-11-08 (the employer benefit's tax splits by the month's line
    // schemes) is superseded by legend-6q7o rule C: under `proportional` with a
    // history shortfall H > 0, only T - H follows the per-scheme gross share; H
    // follows the payer history.
    //   employee base G* = 6_000_000 + floor(500_000 x 6_000_000 / 10_000_000) = 6_300_000;
    //   the net line's 200_000 of the benefit is the company's.
    //   H = annualTax(110 jt) - 2_200_000 = 2_525_000 - 2_200_000 = 325_000 (cost 5_500_000,
    //   PKP 50_500_000); pure gross history => employerHistory 0, employeeHistory 325_000.
    //   X0 = 6_500_000 + 4_000_000 = 10_500_000. S: 0 -> 220_000 -> 240_379 -> 242_270 -> 242_454
    //   -> 242_460 -> 242_460 stable. S = 242_460: X = 10_742_460; gross = 120_742_460;
    //   net = 114_742_460; PKP = 60_742_000; tax = 3_000_000 + 742_000 x 15% = 111_300 => 3_111_300.
    //   T = 3_111_300 - 2_200_000 = 911_300.
    //   W = 325_000 + floor((911_300 - 325_000) x 6_300_000 / 10_742_460) = 325_000 + 343_840 = 668_840.
    //   B = 911_300 - 668_840 = 242_460 = S.
    const lines = [
      { amountIdr: 6_000_000, taxScheme: "gross" as const },
      { amountIdr: 4_000_000, taxScheme: "net" as const },
    ];
    const r = run(
      {
        taxableLines: lines,
        employerBenefitIdr: 500_000,
        prior: prior(110_000_000, 2_200_000),
      },
      { mixedSchemeAllocation: "proportional" },
    );
    const x = BigInt(r.taxableGrossIdr);
    const t = BigInt(r.pph21Idr);
    const history = 325_000n;
    expect(x).toBe(10_742_460n);
    expect(t).toBe(911_300n);
    expect(BigInt(r.pph21WithheldIdr)).toBe(
      history + ((t - history) * 6_300_000n) / x,
    );
    expect(r.pph21WithheldIdr).toBe(668_840);
    expect(r.pph21EmployerBorneIdr).toBe(242_460);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21WithheldIdr + r.pph21EmployerBorneIdr).toBe(r.pph21Idr);
    expect(r.pph21RefundIdr).toBe(0);
  });

  it("R63 unpaid December: the shortfall cannot be withheld from pay that does not exist, so it is the employee's receivable", () => {
    // Jan-Nov paid 132 jt in total with nothing withheld; December pays nothing.
    // Bead legend-4ndx: W is capped at the available pay (no lines, no benefit,
    // no deductible: cap 0). Founder decision B8 (bead legend-kn3n): the excess
    // is the employee's receivable, not the company's cost: no borne tax, no
    // gross-up, so X stays 0 and the deposit stays T. (Before B8 the company
    // bore it and X = T = B = 5_646_900 by fixed point.)
    // gross = 132_000_000, cost = 6_000_000, net 126_000_000, PKP 72_000_000;
    // tax = 3_000_000 + 15% x 12_000_000 = 4_800_000; prior tax 0, so T = annual.
    // W = 0, B = 0, receivable = 4_800_000, no refund.
    const r = run({
      taxableLines: [],
      prior: prior(132_000_000, 0),
    });
    expect(r.taxableGrossIdr).toBe(0);
    expect(r.pph21Idr).toBe(4_800_000);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.pph21ReceivableIdr).toBe(4_800_000);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.pph21EmployerRefundIdr).toBe(0);
    expect(r.annual?.annualTaxIdr).toBe(4_800_000);
    expect(r.annual?.taxableIncomeIdr).toBe(72_000_000);
  });

  it("R64 gross_first, pure net December after an all-borne year: nothing is deducted from the employee", () => {
    // Prior: gross 110 jt, withheld 0, borne 2 jt (all net). December: net 10 jt.
    // History shortfall H = tax(110 jt) - 2 jt; the employer bore all of the
    //   history, so the employee part of H is 0; G = 0, so W = 0.
    // Fixed point on S (X = 10 jt + S, gross = 120 jt + S, cost 6 jt):
    //   S0=0         PKP 60_000_000 tax 3_000_000 T 1_000_000
    //   S1=1_000_000 PKP 61_000_000 tax 3_150_000 T 1_150_000
    //   S2=1_150_000 PKP 61_150_000 tax 3_172_500 T 1_172_500
    //   S3=1_172_500 PKP 61_172_000 tax 3_175_800 T 1_175_800
    //   S4=1_175_800 PKP 61_175_000 tax 3_176_250 T 1_176_250
    //   S5=1_176_250 PKP 61_176_000 tax 3_176_400 T 1_176_400
    //   S6=1_176_400 PKP 61_176_000 same -> stop.
    const r = run(
      {
        taxableLines: [{ amountIdr: 10_000_000, taxScheme: "net" }],
        prior: prior(110_000_000, 0, 2_000_000),
      },
      { mixedSchemeAllocation: "gross_first" },
    );
    expect(r.taxableGrossIdr).toBe(11_176_400);
    expect(r.pph21Idr).toBe(1_176_400);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(1_176_400);
  });

  it("R65 gross_first, gross December after a half-borne year: the employer keeps its part of the history shortfall, and it is taxable", () => {
    // Prior: gross 110 jt, withheld 1 jt, borne 1 jt. December: gross 10 jt.
    // H = tax(110 jt) - 2 jt: cost 5_500_000, net 104_500_000, PKP 50_500_000,
    //   tax 2_525_000 -> H = 525_000; employer part floor(525_000 x 1/2) =
    //   262_500, employee part 262_500.
    // Employee share = tax(prior + G) - H + 262_500
    //   = (3_000_000 - 2_000_000) - 525_000 + 262_500 = 737_500.
    // The employer part is borne, hence taxable (fixed point, X = 10 jt + S):
    //   S0=0       T 1_000_000 next 262_500
    //   S1=262_500 PKP 60_262_000 tax 3_039_300 T 1_039_300 next 301_800
    //   S2=301_800 PKP 60_301_000 tax 3_045_150 T 1_045_150 next 307_650
    //   S3=307_650 PKP 60_307_000 tax 3_046_050 T 1_046_050 next 308_550
    //   S4=308_550 PKP 60_308_000 tax 3_046_200 T 1_046_200 next 308_700
    //   S5=308_700 PKP 60_308_000 same -> stop.
    const r = run(
      {
        taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        prior: prior(110_000_000, 1_000_000, 1_000_000),
      },
      { mixedSchemeAllocation: "gross_first" },
    );
    expect(r.taxableGrossIdr).toBe(10_308_700);
    expect(r.pph21Idr).toBe(1_046_200);
    expect(r.pph21WithheldIdr).toBe(737_500);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(308_700);
  });

  it("R69 gross_first, pure net December after an all-net year that paid no tax (TER 0%): the Jan-Nov shortfall is the employer's, not cut from the employee", () => {
    // TK/0 net 5_400_000 a month (TER 0% row), Jan-Nov: prior gross 59_400_000,
    // withheld 0, borne 0, all on the employer scheme (prior base given).
    // H = tax(59_400_000) - 0: cost 2_970_000, net 56_430_000, PKP 2_430_000
    //   (floor to thousands), tax 5% = 121_500. priorTax = 0, so the payer
    //   split comes from the prior scheme mix: employer 100% => employee part 0.
    // G = 0 => employee share = 0. December net 5_400_000, X = 5_400_000 + S:
    //   S0=0       gross 64_800_000 cost 3_240_000 net 61_560_000 PKP 7_560_000 T 378_000
    //   S1=378_000 gross 65_178_000 cost 3_258_900 net 61_919_100 PKP 7_919_000 T 395_950
    //   S2=395_950 gross 65_195_950 PKP 7_936_000 T 396_800
    //   S3=396_800 gross 65_196_800 PKP 7_936_000 T 396_800 -> stop.
    const r = run(
      {
        taxableLines: [{ amountIdr: 5_400_000, taxScheme: "net" }],
        prior: {
          ...prior(59_400_000, 0, 0),
          employerSchemeBaseIdr: 59_400_000,
        },
      },
      { mixedSchemeAllocation: "gross_first" },
    );
    expect(r.taxableGrossIdr).toBe(5_796_800);
    expect(r.pph21Idr).toBe(396_800);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(396_800);
  });

  it("R70 same year without a prior scheme base: the shortfall follows this month's mix (all net => employer)", () => {
    // As R69 but the caller gave no per-scheme base; G/X of December is
    // 0/5_400_000, so the employer carries all of H. Same expected amounts.
    const r = run(
      {
        taxableLines: [{ amountIdr: 5_400_000, taxScheme: "net" }],
        prior: prior(59_400_000, 0, 0),
      },
      { mixedSchemeAllocation: "gross_first" },
    );
    expect(r.taxableGrossIdr).toBe(5_796_800);
    expect(r.pph21Idr).toBe(396_800);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(396_800);
  });

  it("R71 half gross-scheme, half net-scheme year that paid no tax: the employer carries the whole Jan-Nov shortfall (the gross-scheme half owes no tax on its own)", () => {
    // As R69 with prior base 29_700_000 gross scheme + 29_700_000 employer scheme.
    // H = tax(59_400_000) - 0 = 121_500 (cost 2_970_000, net 56_430_000, PKP 2_430_000).
    // Rule B (gross_first, legend-6q7o): employeeHistory = clamp(annual(Gs) - (priorTax - pET), 0, H).
    //   annual(Gs = 29_700_000): cost 1_485_000, net 28_215_000, PKP 0 => tax 0;
    //   priorTax = pET = 0 => employeeHistory = clamp(0 - 0, 0, 121_500) = 0.
    //   (The old base-ratio rule gave the employee half of H, 60_750; the gross
    //   half of the year never reached the taxable threshold on its own.)
    // G* = 0 => employee share W = tax(prior) - H + employeeHistory = 0.
    // December net 5_400_000, X = 5_400_000 + S, S = T (W = 0), same as R69:
    //   S0=0       X 5_400_000 T 378_000
    //   S1=378_000 X 5_778_000 T 395_950
    //   S2=395_950 X 5_795_950 T 396_800
    //   S3=396_800 X 5_796_800 T 396_800 stop.
    //   X = 5_796_800, T = 396_800, withheld 0, borne 396_800.
    const r = run(
      {
        taxableLines: [{ amountIdr: 5_400_000, taxScheme: "net" }],
        prior: {
          ...prior(59_400_000, 0, 0),
          grossSchemeBaseIdr: 29_700_000,
          employerSchemeBaseIdr: 29_700_000,
        },
      },
      { mixedSchemeAllocation: "gross_first" },
    );
    expect(r.taxableGrossIdr).toBe(5_796_800);
    expect(r.pph21Idr).toBe(396_800);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21EmployerBorneIdr).toBe(396_800);
  });

  for (const allocation of ["gross_first", "proportional"] as const) {
    it(`R72 gross-up December after a gross-up year with prior tax > 0 (${allocation}): the company-funded Jan-Nov shortfall is not cut from the employee`, () => {
      // Prior: gross 90_200_000 (11 x 8_200_000), PPh 21 220_000 (11 x 20_000)
      // all gross-up allowance: withheld 220_000 of which allowance 220_000,
      // borne 0. December: gross_up 8_000_000.
      // H = tax(90_200_000) - 220_000: cost 4_510_000, net 85_690_000,
      //   PKP 31_690_000, tax 1_584_500 -> H = 1_364_500, all the employer's.
      // G = 0 => the employee's share W = 0, S = T (X = 8_000_000 + S):
      //   S0=0         gross 98_200_000 PKP 39_290_000 tax 1_964_500 T 1_744_500
      //   S1=1_744_500 gross 99_944_500 PKP 40_947_000 tax 2_047_350 T 1_827_350
      //   S2=1_827_350 PKP 41_025_000 tax 2_051_250 T 1_831_250
      //   S3=1_831_250 PKP 41_029_000 tax 2_051_450 T 1_831_450
      //   S4=1_831_450 PKP 41_029_000 same -> stop. Allowance = withheld = S.
      // Take-home = 8_000_000 + allowance - withheld = 8_000_000.
      const r = run(
        {
          taxableLines: [{ amountIdr: 8_000_000, taxScheme: "gross_up" }],
          prior: {
            ...prior(90_200_000, 220_000, 0),
            taxAllowanceIdr: 220_000,
          },
        },
        { mixedSchemeAllocation: allocation },
      );
      expect(r.taxableGrossIdr).toBe(9_831_450);
      expect(r.pph21Idr).toBe(1_831_450);
      expect(r.taxAllowanceIdr).toBe(1_831_450);
      expect(r.pph21WithheldIdr).toBe(1_831_450);
      expect(r.pph21EmployerBorneIdr).toBe(0);
      expect(8_000_000 + r.taxAllowanceIdr - r.pph21WithheldIdr).toBe(
        8_000_000,
      );
    });

    it(`R73 gross-up year ends in lebih potong (${allocation}): the refund of company-funded allowance goes back to the employer`, () => {
      // Prior: gross 110_000_000, PPh 21 5_000_000, all allowance (withheld
      // 5_000_000 = allowance 5_000_000). December gross_up 10_000_000:
      // gross 120_000_000, cost 6_000_000, PKP 60_000_000, tax 3_000_000
      // => T = 3_000_000 - 5_000_000 = -2_000_000. S = 0 (T < 0).
      // The whole prior tax was company-funded => employer refund 2_000_000.
      const r = run(
        {
          taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross_up" }],
          prior: {
            ...prior(110_000_000, 5_000_000, 0),
            taxAllowanceIdr: 5_000_000,
          },
        },
        { mixedSchemeAllocation: allocation },
      );
      expect(r.pph21Idr).toBe(-2_000_000);
      expect(r.pph21RefundIdr).toBe(0);
      expect(r.pph21EmployerRefundIdr).toBe(2_000_000);
      expect(r.pph21WithheldIdr).toBe(0);
    });
  }

  it("R74 refund of a year paid 3_000_000 by the employee and 2_000_000 as allowance: both policies split the credit 3:2 without a scheme base (legend-u1xq)", () => {
    // Prior: gross 110_000_000, withheld 5_000_000 (allowance 2_000_000 of it),
    // borne 0. December gross 10_000_000 => T = 3_000_000 - 5_000_000 = -2_000_000.
    // Updated for bead legend-u1xq. Old: proportional employer refund floor(2_000_000 x
    // 2_000_000 / 5_000_000) = 800_000, employee 1_200_000; gross_first employee refund
    // 2_000_000, employer 0 (the whole -T split by history).
    // New: annual(110_000_000): cost 5_500_000, net 104_500_000, PKP 50_500_000, tax 2_525_000
    // => H = 2_525_000 - 5_000_000 = -2_475_000, C = 2_475_000. pET = allowance 2_000_000,
    // priorTax 5_000_000; no scheme base so both policies: Cr = floor(2_475_000 x 2_000_000 /
    // 5_000_000) = 990_000, Ce = 1_485_000. December gross 10_000_000 (G* = X): annual(120_000_000)
    // = 3_000_000, D = 3_000_000 - 2_525_000 = 475_000, De = 475_000, Dr = 0.
    // Employee: 475_000 - 1_485_000 < 0 => W = 0, refund 1_010_000. Company: 0 - 990_000 < 0
    // => refund 990_000. 1_010_000 + 990_000 = 2_000_000 = -T. The December salary's own tax
    // (475_000) is now paid out of the employee's credit instead of being left to the company.
    const input = {
      taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" as const }],
      prior: {
        ...prior(110_000_000, 5_000_000, 0),
        taxAllowanceIdr: 2_000_000,
      },
    };
    const proportional = run(input, { mixedSchemeAllocation: "proportional" });
    expect(proportional.pph21Idr).toBe(-2_000_000);
    expect(proportional.pph21EmployerRefundIdr).toBe(990_000);
    expect(proportional.pph21RefundIdr).toBe(1_010_000);
    const grossFirst = run(input, { mixedSchemeAllocation: "gross_first" });
    expect(grossFirst.pph21Idr).toBe(-2_000_000);
    expect(grossFirst.pph21EmployerRefundIdr).toBe(990_000);
    expect(grossFirst.pph21RefundIdr).toBe(1_010_000);
    // New invariant (legend-u1xq): withheld + borne - refunds = T; refunds <= Ce / Cr.
    for (const r of [proportional, grossFirst]) {
      expect(
        r.pph21WithheldIdr +
          r.pph21EmployerBorneIdr -
          r.pph21RefundIdr -
          r.pph21EmployerRefundIdr,
      ).toBe(r.pph21Idr);
      expect(r.pph21RefundIdr).toBeLessThanOrEqual(1_485_000);
      expect(r.pph21EmployerRefundIdr).toBeLessThanOrEqual(990_000);
    }
  });

  it("R75 gross-up year without a reported prior allowance: rejected (legend-6p71 rule A)", () => {
    // As R72 gross_first, but the caller gives only the scheme mix
    // (employer scheme 90_200_000 of 90_200_000) and prior withheld 220_000 > 0.
    // The withheld tax of a history with employer-scheme pay may hide gross-up
    // allowance that cannot be told apart from tax the employee paid, and the
    // scheme-base ratio no longer stands in for it: prior.taxAllowanceIdr is
    // required (0 when none) => RangeError. (Old: 1_831_450 via the ratio.)
    expect(() =>
      run(
        {
          taxableLines: [{ amountIdr: 8_000_000, taxScheme: "gross_up" }],
          prior: {
            ...prior(90_200_000, 220_000, 0),
            employerSchemeBaseIdr: 90_200_000,
          },
        },
        { mixedSchemeAllocation: "gross_first" },
      ),
    ).toThrow(RangeError);
  });

  it("R76 rejects a prior allowance above the prior withheld tax", () => {
    expect(() =>
      run({ prior: { ...prior(0, 100, 0), taxAllowanceIdr: 101 } }),
    ).toThrow(RangeError);
  });
});
