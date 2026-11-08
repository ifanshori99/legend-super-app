// PPh 21 reference suite, Part A: TER monthly (cases R01-R18).
// PRD v1.7 §3 F30, PAYR-03, R15; bead legend-5cnk.
//
// Every expected value below was computed BY HAND from the regulation (PP
// 58/2023 Lampiran A/B/C, UU PPh Pasal 21(5a)); none is copied from, or
// produced by, the engine. Integer IDR, rounding down at every step.
//
// Method for a TER month: X = lines + employer benefit + tax allowance;
// rate r = bracket of X for the status category (upper bound inclusive);
// tax0 = floor(X * r / 10000); no NPWP: tax = floor(tax0 * 12000 / 10000).
//
// Assumptions (flagged where used):
// - K/I/n statuses: PP 58/2023 has no K/I category; the reference table maps
//   them like K/n (K/I/0 -> A, K/I/1 and K/I/2 -> B, K/I/3 -> C) (R08).
// - X = 0 is fed as an empty line list; method/rate are not asserted (R18).

import { describe, expect, it } from "vitest";
import type { PtkpStatus } from "@starter/shared/hris";
import { computePph21Period } from "../services/payroll-pph21.ts";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Scheme = "gross" | "gross_up" | "net";
type Line = { amountIdr: number; taxScheme: Scheme };

// Plain TER month (lastTaxPeriod false), everything else defaulted.
const terMonth = (
  ptkpStatus: PtkpStatus,
  taxableLines: Line[],
  overrides: {
    hasTaxId?: boolean;
    employerBenefitIdr?: number;
  } = {},
) =>
  computePph21Period(REFERENCE_TABLES, {
    ptkpStatus,
    hasTaxId: overrides.hasTaxId ?? true,
    lastTaxPeriod: false,
    monthsWorked: 1,
    taxableLines,
    employerBenefitIdr: overrides.employerBenefitIdr ?? 0,
    employeeDeductibleIdr: 0,
    prior: { taxableGrossIdr: 0, employeeDeductibleIdr: 0, pph21Idr: 0 },
  });

const gross = (amountIdr: number): Line => ({ amountIdr, taxScheme: "gross" });

describe("PPh 21 TER monthly reference cases", () => {
  it("R01 TK/0 gross at the exact upper bound of the 0% row is not taxed", () => {
    // X = 5_400_000; TER A row 1 (s.d. 5_400_000, bound inclusive) 0% => 0.
    // Src: PP 58/2023 Lampiran A.
    const r = terMonth("TK/0", [gross(5_400_000)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 0,
      taxableGrossIdr: 5_400_000,
      taxAllowanceIdr: 0,
      pph21Idr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
      annual: null,
    });
  });

  it("R02 TK/0 gross one rupiah above the 0% row falls into the 0.25% row", () => {
    // X = 5_400_001; TER A row 2 (s.d. 5_650_000) 0.25% = 25 bp.
    // tax = floor(5_400_001 * 25 / 10000) = floor(13_500.0025) = 13_500.
    // Src: PP 58/2023 Lampiran A.
    const r = terMonth("TK/0", [gross(5_400_001)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 25,
      taxableGrossIdr: 5_400_001,
      taxAllowanceIdr: 0,
      pph21Idr: 13_500,
      pph21WithheldIdr: 13_500,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
      annual: null,
    });
  });

  it("R03 TK/0 gross at the exact upper bound of a row uses that row's rate", () => {
    // X = 10_050_000; TER A row 9 (s.d. 10_050_000, inclusive) 2% = 200 bp.
    // tax = 10_050_000 * 200 / 10000 = 201_000.
    // Src: PP 58/2023 Lampiran A.
    const r = terMonth("TK/0", [gross(10_050_000)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 200,
      taxableGrossIdr: 10_050_000,
      taxAllowanceIdr: 0,
      pph21Idr: 201_000,
      pph21WithheldIdr: 201_000,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R04 TK/0 gross one rupiah above that bound moves to the next row", () => {
    // X = 10_050_001; TER A row 10 (s.d. 10_350_000) 2.25% = 225 bp.
    // tax = floor(10_050_001 * 225 / 10000) = floor(226_125.0225) = 226_125.
    // Src: PP 58/2023 Lampiran A.
    const r = terMonth("TK/0", [gross(10_050_001)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 225,
      taxableGrossIdr: 10_050_001,
      taxAllowanceIdr: 0,
      pph21Idr: 226_125,
      pph21WithheldIdr: 226_125,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  // Category probe: X = 12_000_000 lands in a different rate row per category,
  // so a wrong status -> category mapping cannot pass by accident.
  //   A row 14 (s.d. 12_500_000) 4%    => 480_000
  //   B row 9  (s.d. 12_600_000) 3%    => 360_000
  //   C row 9  (s.d. 12_050_000) 2%    => 240_000
  // Src: PP 58/2023 Pasal 2 + Lampiran A/B/C.
  describe("R05 category A statuses (TK/0 TK/1 K/0): 4% => 480_000", () => {
    it.each<PtkpStatus>(["TK/1", "K/0"])("%s", (status) => {
      const r = terMonth(status, [gross(12_000_000)]);
      expect(r).toMatchObject({
        method: "ter",
        terCategory: "A",
        terRateBp: 400,
        taxableGrossIdr: 12_000_000,
        taxAllowanceIdr: 0,
        pph21Idr: 480_000,
        pph21WithheldIdr: 480_000,
        pph21EmployerBorneIdr: 0,
        pph21RefundIdr: 0,
        noTaxIdSurchargeApplied: false,
      });
    });
    it("TK/0", () => {
      const r = terMonth("TK/0", [gross(12_000_000)]);
      expect(r).toMatchObject({
        terCategory: "A",
        terRateBp: 400,
        pph21Idr: 480_000,
        pph21WithheldIdr: 480_000,
      });
    });
  });

  describe("R06 category B statuses (TK/2 TK/3 K/1 K/2): 3% => 360_000", () => {
    it.each<PtkpStatus>(["TK/2", "TK/3", "K/1", "K/2"])("%s", (status) => {
      const r = terMonth(status, [gross(12_000_000)]);
      expect(r).toMatchObject({
        method: "ter",
        terCategory: "B",
        terRateBp: 300,
        taxableGrossIdr: 12_000_000,
        taxAllowanceIdr: 0,
        pph21Idr: 360_000,
        pph21WithheldIdr: 360_000,
        pph21EmployerBorneIdr: 0,
        pph21RefundIdr: 0,
        noTaxIdSurchargeApplied: false,
      });
    });
  });

  it("R07 K/3 is category C: 2% => 240_000", () => {
    // X = 12_000_000; TER C row 9 (s.d. 12_050_000) 2% = 200 bp => 240_000.
    // Src: PP 58/2023 Lampiran C (K/3 only).
    const r = terMonth("K/3", [gross(12_000_000)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "C",
      terRateBp: 200,
      taxableGrossIdr: 12_000_000,
      taxAllowanceIdr: 0,
      pph21Idr: 240_000,
      pph21WithheldIdr: 240_000,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  // ASSUMPTION: PP 58/2023 has no K/I category; the reference table maps K/I/n
  // like K/n: K/I/0 -> A (4%), K/I/1 and K/I/2 -> B (3%), K/I/3 -> C (2%).
  describe("R08 K/I statuses follow the K/n category mapping (assumption)", () => {
    it.each<[PtkpStatus, "A" | "B" | "C", number, number]>([
      ["K/I/0", "A", 400, 480_000],
      ["K/I/1", "B", 300, 360_000],
      ["K/I/2", "B", 300, 360_000],
      ["K/I/3", "C", 200, 240_000],
    ])("%s -> category %s", (status, category, rateBp, tax) => {
      const r = terMonth(status, [gross(12_000_000)]);
      expect(r).toMatchObject({
        method: "ter",
        terCategory: category,
        terRateBp: rateBp,
        taxableGrossIdr: 12_000_000,
        pph21Idr: tax,
        pph21WithheldIdr: tax,
        pph21EmployerBorneIdr: 0,
        pph21RefundIdr: 0,
      });
    });
  });

  it("R09 top bracket is 34% above Rp1.4 billion (category A)", () => {
    // X = 1_500_000_000 > 1_400_000_000 (A row 43 bound) => row 44 34% = 3400 bp.
    // tax = 1_500_000_000 * 3400 / 10000 = 510_000_000.
    // Src: PP 58/2023 Lampiran A (lapisan terakhir).
    const r = terMonth("TK/0", [gross(1_500_000_000)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 3400,
      taxableGrossIdr: 1_500_000_000,
      taxAllowanceIdr: 0,
      pph21Idr: 510_000_000,
      pph21WithheldIdr: 510_000_000,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R10 THR month: THR is added to the month's TER base", () => {
    // TK/0: salary 8_000_000 + THR 8_000_000 => X = 16_000_000.
    // TER A row 17 (s.d. 16_950_000; previous row ends 15_100_000) 7% = 700 bp.
    // tax = 16_000_000 * 700 / 10000 = 1_120_000. (Salary alone: 8M row 7 1.5%.)
    // Src: PP 58/2023 (penghasilan bruto bulan itu termasuk THR).
    const r = terMonth("TK/0", [gross(8_000_000), gross(8_000_000)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 700,
      taxableGrossIdr: 16_000_000,
      taxAllowanceIdr: 0,
      pph21Idr: 1_120_000,
      pph21WithheldIdr: 1_120_000,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R11 bonus month: bonus is added to the month's TER base (category B)", () => {
    // K/1: salary 12_000_000 + bonus 20_000_000 => X = 32_000_000.
    // TER B row 19 (s.d. 33_950_000; previous row ends 31_450_000) 13% = 1300 bp.
    // tax = 32_000_000 * 1300 / 10000 = 4_160_000.
    // Src: PP 58/2023 Pasal 3 + Lampiran B.
    const r = terMonth("K/1", [gross(12_000_000), gross(20_000_000)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "B",
      terRateBp: 1300,
      taxableGrossIdr: 32_000_000,
      taxAllowanceIdr: 0,
      pph21Idr: 4_160_000,
      pph21WithheldIdr: 4_160_000,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R12 employer benefit (JKK/JKM/BPJS Kesehatan) is taxable and can lift the bracket", () => {
    // TK/0: salary 10_000_000 + employer benefit 454_000 => X = 10_454_000.
    // TER A row 11 (s.d. 10_700_000; previous row ends 10_350_000) 2.5% = 250 bp.
    // tax = 10_454_000 * 250 / 10000 = 261_350. (Salary alone: 2% = 200_000.)
    // Src: PMK 168/2023 (premi dibayar pemberi kerja = penghasilan).
    const r = terMonth("TK/0", [gross(10_000_000)], {
      employerBenefitIdr: 454_000,
    });
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 250,
      taxableGrossIdr: 10_454_000,
      taxAllowanceIdr: 0,
      pph21Idr: 261_350,
      pph21WithheldIdr: 261_350,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R13 no NPWP: tax is 20% higher", () => {
    // TK/0, hasTaxId false, X = 10_000_000; A row 9 2% => tax0 = 200_000.
    // tax = floor(200_000 * 12000 / 10000) = 240_000.
    // Src: UU PPh Pasal 21 ayat (5a) (tarif 20% lebih tinggi tanpa NPWP).
    const r = terMonth("TK/0", [gross(10_000_000)], { hasTaxId: false });
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 200,
      taxableGrossIdr: 10_000_000,
      taxAllowanceIdr: 0,
      pph21Idr: 240_000,
      pph21WithheldIdr: 240_000,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: true,
    });
  });

  it("R14 no NPWP: base tax is floored first, then the surcharge is floored", () => {
    // TK/0, hasTaxId false, X = 5_999_999; A row 4 (s.d. 6_300_000) 0.75% = 75 bp.
    // tax0 = floor(5_999_999 * 75 / 10000) = floor(44_999.9925) = 44_999.
    // tax  = floor(44_999 * 12000 / 10000) = floor(53_998.8) = 53_998.
    // (A single floor over X*r*1.2 would give 53_999 - wrong order.)
    // Src: PP 58/2023 Pasal 3 + UU PPh Pasal 21 ayat (5a).
    const r = terMonth("TK/0", [gross(5_999_999)], { hasTaxId: false });
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 75,
      taxableGrossIdr: 5_999_999,
      taxAllowanceIdr: 0,
      pph21Idr: 53_998,
      pph21WithheldIdr: 53_998,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: true,
    });
  });

  it("R15 pure gross-up: the tax allowance equals the tax", () => {
    // TK/0, one gross_up line U = 10_000_000 (G = N = 0).
    // Need least A >= 0 with A = floor(T(X) * (U + A) / X), X = U + A, i.e. A = T(X).
    //   A0 = 0       : X = 10_000_000, A row 9 2%     => T = 200_000 -> A1 = 200_000
    //   A1 = 200_000 : X = 10_200_000, row 10 2.25%   => T = 229_500
    //   ... iterating: 0 -> 200_000 -> 229_500 -> 230_163 -> 230_178 -> 230_179
    //   A = 230_179  : X = 10_230_179, row 10 (s.d. 10_350_000) 2.25% = 225 bp;
    //     T = floor(10_230_179 * 225 / 10000) = floor(230_179.03) = 230_179 = A. Stable.
    //   Least: A = 230_178 gives T = 230_179 != A, so 230_179 is the first fixed point.
    // X = 10_230_179; pph21 = 230_179. No net line, so borne = 0 and the whole
    // tax is withheld (the allowance in X is what funds it).
    // Src: PMK 168/2023 (tunjangan pajak = penghasilan), Lampiran A.
    const r = terMonth("TK/0", [
      { amountIdr: 10_000_000, taxScheme: "gross_up" },
    ]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 225,
      taxableGrossIdr: 10_230_179,
      taxAllowanceIdr: 230_179,
      pph21Idr: 230_179,
      pph21WithheldIdr: 230_179,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R16 pure net scheme: the employer bears the whole tax", () => {
    // TK/0, one net line N = 10_000_000 (G = U = 0), no allowance: X = 10_000_000.
    // A row 9 2% => T = 200_000. borne = floor(200_000 * 10_000_000 / 10_000_000)
    // = 200_000; withheld = 200_000 - 200_000 = 0.
    // Src: PMK 168/2023 (pajak ditanggung pemberi kerja), Lampiran A.
    const r = terMonth("TK/0", [{ amountIdr: 10_000_000, taxScheme: "net" }]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 200,
      taxableGrossIdr: 10_000_000,
      taxAllowanceIdr: 0,
      pph21Idr: 200_000,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 200_000,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R17 mixed gross + gross_up + net lines", () => {
    // K/1 (B). G = 9_000_000 gross, U = 2_000_000 gross_up, N = 3_000_000 net.
    // Iterate A_{k+1} = floor(T(G+U+N+A_k) * (U + A_k) / (G+U+N+A_k)):
    //   A0 = 0       : X = 14_000_000, B row 11 (s.d. 14_950_000) 5% -> T = 700_000
    //                  A1 = floor(700_000 * 2_000_000 / 14_000_000) = 100_000
    //   A1 = 100_000 : X = 14_100_000, T = 705_000 -> A2 = floor(705_000 * 2_100_000 / 14_100_000) = 105_000
    //   A2 = 105_000 : X = 14_105_000, T = 705_250 -> A3 = 105_250
    //   A3 = 105_250 : X = 14_105_250, T = 705_262 -> A4 = 105_262
    //   A4 = 105_262 : X = 14_105_262, T = 705_263 -> A5 = 105_263
    //   A5 = 105_263 : X = 14_105_263, T = 705_263 -> A6 = 105_263 (stable)
    // X = 14_105_263 (still B row 11, 5% = 500 bp): T = floor(705_263.15) = 705_263.
    // borne = floor(705_263 * 3_000_000 / 14_105_263) = 149_999 (floor of 149_999.9...);
    // withheld = 705_263 - 149_999 = 555_264.
    // Src: PMK 168/2023, Lampiran B.
    const r = terMonth("K/1", [
      { amountIdr: 9_000_000, taxScheme: "gross" },
      { amountIdr: 2_000_000, taxScheme: "gross_up" },
      { amountIdr: 3_000_000, taxScheme: "net" },
    ]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "B",
      terRateBp: 500,
      taxableGrossIdr: 14_105_263,
      taxAllowanceIdr: 105_263,
      pph21Idr: 705_263,
      pph21WithheldIdr: 555_264,
      pph21EmployerBorneIdr: 149_999,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R18 nothing taxable (X = 0): every amount is 0", () => {
    // ASSUMPTION: X = 0 is fed as an empty line list (unpaid month); method and
    // rate are not asserted because the spec does not define them for X = 0.
    // X = 0 => tax 0 => allowance, withheld, borne, refund all 0.
    const r = terMonth("TK/0", []);
    expect(r).toMatchObject({
      taxableGrossIdr: 0,
      taxAllowanceIdr: 0,
      pph21Idr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      noTaxIdSurchargeApplied: false,
    });
  });
});
