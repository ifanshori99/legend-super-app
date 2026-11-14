// PPh 21 reference suite, Part A: TER monthly (cases R01-R48), engine v2.
// PRD v1.7 §3 F30, PAYR-03, R15; beads legend-5cnk, legend-y4wp.
//
// Every expected value below was computed BY HAND (python3, exact integer
// arithmetic) from the regulation; none is copied from, or produced by, the
// engine. Integer IDR.
//
// Method for a TER month (policy = DEFAULT_PPH21_POLICY unless a case says
// otherwise): X = G + U + N + S, where G = gross lines + employer benefit,
// U = gross_up lines, N = net lines and S = A + B = the tax the employer
// covers (tunjangan pajak A for gross_up, borne tax B for net; the borne tax
// is itself a taxable benefit). Rate r = TER bracket of X for the status
// category (upper bound inclusive). Tax T(X) = R(X * r * (10000 + s) / 10^8)
// with ONE rounding R (half_up: .5 rounds away from zero; down: floor), s =
// 2000 bp only when there is no NPWP/NIK (and the policy surcharges TER
// months). With no S, T = T(X) and everything is withheld from the employee.
// With S, S is the least fixed point of S_0 = 0, S_{k+1} = C(S_k) = T(X_k) -
// W(X_k), stopping when S_{k+1} <= S_k; W is the employee's gross share:
// proportional floor(T*G/X), gross_first min(T, T(G alone)). Then A =
// floor(S*U/(U+N)), B = T - W - A, withheld = W + A.
//
// Sources:
// - PP 58/2023 (TER, Pasal 2-3, Lampiran A/B/C):
//   https://pajak.go.id/sites/default/files/lampiran/Lampiran%20PP58TAHUN2023.pdf
// - PMK 168/2023 (Pasal 10(2), Pasal 15(1)-(3), Pasal 21, Lampiran I.2.2.3):
//   https://www.jdih.kemenkeu.go.id/api/download/e60a82e0-b218-40f5-9d18-b924aa1e11ce/2023pmkeuangan168.pdf
// - FAQ DJP PMK-66/2023 no. 40 (pajak ditanggung pemberi kerja = penghasilan):
//   https://pajak.go.id/sites/default/files/2023-12/FAQ%20Terkait%20PMK-66%20Tahun%202023.pdf
// - PER-11/PJ/2025 Pasal 129 (pembulatan, Coretax):
//   https://pajak.go.id/index.php/id/peraturan/ketentuan-pelaporan-pajak-penghasilan-pajak-pertambahan-nilai-pajak-penjualan-atas-0
// - Buku Cermat PPh 21 DJP p.53:
//   https://static.pajak.go.id/download/kalkulator/Buku_PPh2126_Release_20240108.pdf
// - UU HPP (UU 7/2021, Pasal 21(5a) UU PPh):
//   https://jdih.kemenkeu.go.id/api/download/a9faab97-aca7-4f87-9fdc-faa8123d1454/7TAHUN2021UU.pdf
//
// Assumptions (flagged where used):
// - K/I/n statuses: PP 58/2023 has no K/I category. Under the default
//   `normalize` policy they are withheld as K/n (category AND PTKP), and the
//   result reports withholdingStatus K/n (R08, R43); under `reject` the
//   computation throws PAYROLL_PPH21_STATUS_UNSUPPORTED (R44).
// - X = 0 is fed as an empty line list; method/rate are not asserted (R18).
// - Take-home of the employee = cash lines + tax allowance - withheld (the
//   allowance is paid then withheld, so it cancels: lines - W) (R47, R48).

import { describe, expect, it } from "vitest";
import type { PtkpStatus } from "@starter/shared/hris";
import {
  DEFAULT_PPH21_POLICY,
  PayrollError,
} from "@starter/shared/hris/payroll";
import type { Pph21PolicyParameters } from "@starter/shared/hris/payroll";
import { computePph21Period } from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Scheme = "gross" | "gross_up" | "net";
type Line = { amountIdr: number; taxScheme: Scheme };

const policyWith = (
  overrides: Partial<Pph21PolicyParameters>,
): Pph21PolicyParameters => ({ ...DEFAULT_PPH21_POLICY, ...overrides });

// Plain TER month (lastTaxPeriod false), everything else defaulted.
const terMonth = (
  ptkpStatus: PtkpStatus,
  taxableLines: Line[],
  overrides: {
    hasTaxId?: boolean;
    employerBenefitIdr?: number;
    policy?: Pph21PolicyParameters;
  } = {},
) =>
  computePph21Period(
    REFERENCE_TABLES,
    overrides.policy ?? DEFAULT_PPH21_POLICY,
    {
      ptkpStatus,
      hasTaxId: overrides.hasTaxId ?? true,
      lastTaxPeriod: false,
      monthsWorked: 1,
      taxableLines,
      employerBenefitIdr: overrides.employerBenefitIdr ?? 0,
      employeeDeductibleIdr: 0,
      prior: {
        taxableGrossIdr: 0,
        employeeDeductibleIdr: 0,
        pph21WithheldIdr: 0,
        pph21EmployerBorneIdr: 0,
      },
    },
  );

const gross = (amountIdr: number): Line => ({ amountIdr, taxScheme: "gross" });
const grossUp = (amountIdr: number): Line => ({
  amountIdr,
  taxScheme: "gross_up",
});
const net = (amountIdr: number): Line => ({ amountIdr, taxScheme: "net" });

// A TER month with no refund and no annual block.
const NO_REFUND = {
  pph21RefundIdr: 0,
  pph21EmployerRefundIdr: 0,
} as const;

describe("PPh 21 TER monthly reference cases", () => {
  it("[PAYR-03] R01 TK/0 gross at the exact upper bound of the 0% row is not taxed", () => {
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("[PAYR-03] R02 TK/0 gross one rupiah above the 0% row falls into the 0.25% row", () => {
    // X = 5_400_001; TER A row 2 (s.d. 5_650_000) 0.25% = 25 bp.
    // tax = R(5_400_001 * 25 / 10000) = R(13_500.0025) = 13_500 (half_up and down agree).
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("[PAYR-03] R03 TK/0 gross at the exact upper bound of a row uses that row's rate", () => {
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("[PAYR-03] R04 TK/0 gross one rupiah above that bound moves to the next row", () => {
    // X = 10_050_001; TER A row 10 (s.d. 10_350_000) 2.25% = 225 bp.
    // tax = R(10_050_001 * 225 / 10000) = R(226_125.0225) = 226_125.
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  // Category probe: X = 12_000_000 lands in a different rate row per category,
  // so a wrong status -> category mapping cannot pass by accident.
  //   A row 14 (s.d. 12_500_000) 4%    => 480_000
  //   B row 9  (s.d. 12_600_000) 3%    => 360_000
  //   C row 9  (s.d. 12_050_000) 2%    => 240_000
  // Src: PP 58/2023 Pasal 2 + Lampiran A/B/C.
  describe("[PAYR-03] R05 category A statuses (TK/0 TK/1 K/0): 4% => 480_000", () => {
    it.each<PtkpStatus>(["TK/1", "K/0"])("%s", (status) => {
      const r = terMonth(status, [gross(12_000_000)]);
      expect(r).toMatchObject({
        method: "ter",
        withholdingStatus: status,
        terCategory: "A",
        terRateBp: 400,
        taxableGrossIdr: 12_000_000,
        taxAllowanceIdr: 0,
        pph21Idr: 480_000,
        pph21WithheldIdr: 480_000,
        pph21EmployerBorneIdr: 0,
        ...NO_REFUND,
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

  describe("[PAYR-03] R06 category B statuses (TK/2 TK/3 K/1 K/2): 3% => 360_000", () => {
    it.each<PtkpStatus>(["TK/2", "TK/3", "K/1", "K/2"])("%s", (status) => {
      const r = terMonth(status, [gross(12_000_000)]);
      expect(r).toMatchObject({
        method: "ter",
        withholdingStatus: status,
        terCategory: "B",
        terRateBp: 300,
        taxableGrossIdr: 12_000_000,
        taxAllowanceIdr: 0,
        pph21Idr: 360_000,
        pph21WithheldIdr: 360_000,
        pph21EmployerBorneIdr: 0,
        ...NO_REFUND,
        noTaxIdSurchargeApplied: false,
      });
    });
  });

  it("[PAYR-03] R07 K/3 is category C: 2% => 240_000", () => {
    // X = 12_000_000; TER C row 9 (s.d. 12_050_000) 2% = 200 bp => 240_000.
    // Src: PP 58/2023 Lampiran C (K/3 only).
    const r = terMonth("K/3", [gross(12_000_000)]);
    expect(r).toMatchObject({
      method: "ter",
      withholdingStatus: "K/3",
      terCategory: "C",
      terRateBp: 200,
      taxableGrossIdr: 12_000_000,
      taxAllowanceIdr: 0,
      pph21Idr: 240_000,
      pph21WithheldIdr: 240_000,
      pph21EmployerBorneIdr: 0,
      ...NO_REFUND,
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
        withholdingStatus: status.replace("K/I/", "K/"),
        terCategory: category,
        terRateBp: rateBp,
        taxableGrossIdr: 12_000_000,
        pph21Idr: tax,
        pph21WithheldIdr: tax,
        pph21EmployerBorneIdr: 0,
        ...NO_REFUND,
      });
    });
  });

  it("[PAYR-03] R09 top bracket is 34% above Rp1.4 billion (category A)", () => {
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("[PAYR-03] R10 THR month: THR is added to the month's TER base", () => {
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("[PAYR-03] R11 bonus month: bonus is added to the month's TER base (category B)", () => {
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("[PAYR-03] R12 employer benefit (JKK/JKM/BPJS Kesehatan) is taxable and can lift the bracket", () => {
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R13 no NPWP: tax is 20% higher", () => {
    // TK/0, hasTaxId false, X = 10_000_000; A row 9 2% = 200 bp.
    // tax = R(10_000_000 * 200 * 12000 / 10^8) = 240_000 (exact).
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: true,
    });
  });

  it("R14 no NPWP: the surcharge is applied before the single rounding", () => {
    // TK/0, hasTaxId false, X = 5_999_999; A row 4 (s.d. 6_300_000) 0.75% = 75 bp.
    // tax = R(5_999_999 * 75 * 12000 / 10^8) = R(53_999.991) = 54_000 under
    // half_up (53_999 under `down`, see R40). One rounding over the whole
    // product; rounding the base tax first (45_000) and then adding 20% would
    // reach 54_000 here only by luck of the path.
    // Src: PP 58/2023 Pasal 3 + UU PPh Pasal 21 ayat (5a); PER-11/PJ/2025 Pasal 129.
    const r = terMonth("TK/0", [gross(5_999_999)], { hasTaxId: false });
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 75,
      taxableGrossIdr: 5_999_999,
      taxAllowanceIdr: 0,
      pph21Idr: 54_000,
      pph21WithheldIdr: 54_000,
      pph21EmployerBorneIdr: 0,
      ...NO_REFUND,
      noTaxIdSurchargeApplied: true,
    });
  });

  it("[PAYR-03] R15 pure gross-up: the tax allowance equals the tax", () => {
    // TK/0, one gross_up line U = 10_000_000 (G = N = 0). W = floor(T*0/X) = 0.
    // S_{k+1} = T(10_000_000 + S_k), stop when S_{k+1} <= S_k:
    //   S=0       X=10_000_000 2%    T=200_000
    //   S=200_000 X=10_200_000 2.25% T=229_500
    //   S=229_500 X=10_229_500       T=230_164  (R(230_163.75))
    //   S=230_164 X=10_230_164       T=230_179  (R(230_178.69))
    //   S=230_179 X=10_230_179       T=230_179  -> stop, S = 230_179.
    // A = floor(S * U / (U + N)) = S = 230_179; B = T - W - A = 0.
    // X = 10_230_179 (A row 10, s.d. 10_350_000, 225 bp). The allowance is paid
    // and withheld, so the employee's take-home is exactly U = 10_000_000.
    // Src: PMK 168/2023 (tunjangan pajak = penghasilan), PP 58/2023 Lampiran A.
    const r = terMonth("TK/0", [grossUp(10_000_000)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 225,
      taxableGrossIdr: 10_230_179,
      taxAllowanceIdr: 230_179,
      pph21Idr: 230_179,
      pph21WithheldIdr: 230_179,
      pph21EmployerBorneIdr: 0,
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R16 pure net scheme: the employer bears the whole tax, which is itself taxable", () => {
    // TK/0, one net line N = 10_000_000 (G = U = 0). W = 0, A = floor(S*0/N) = 0.
    // The borne tax is a taxable benefit (FAQ DJP PMK-66 no. 40), so X = N + S
    // and S is the same fixed point as R15:
    //   0 -> 200_000 -> 229_500 -> 230_164 -> 230_179 (stable).
    // X = 10_230_179 (225 bp); T = 230_179; B = T - W - A = 230_179; withheld 0.
    // Src: PMK 168/2023, FAQ DJP PMK-66 no. 40, PP 58/2023 Lampiran A.
    const r = terMonth("TK/0", [net(10_000_000)]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "A",
      terRateBp: 225,
      taxableGrossIdr: 10_230_179,
      taxAllowanceIdr: 0,
      pph21Idr: 230_179,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 230_179,
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R17 mixed gross + gross_up + net lines", () => {
    // K/1 (B). G = 9_000_000, U = 2_000_000, N = 3_000_000. Proportional.
    // S_{k+1} = T(X_k) - floor(T(X_k) * G / X_k), X_k = 14_000_000 + S_k:
    //   S=0       X=14_000_000 5% T=700_000 W=450_000 -> C=250_000
    //   S=250_000 X=14_250_000    T=712_500 W=450_000 -> C=262_500
    //   S=262_500 X=14_262_500    T=713_125 W=450_000 -> C=263_125
    //   S=263_125 X=14_263_125    T=713_156 W=449_999 -> C=263_157
    //   S=263_157 X=14_263_157    T=713_158 W=450_000 -> C=263_158
    //   S=263_158 X=14_263_158    T=713_158 W=450_000 -> C=263_158 stop.
    // (B row 11, s.d. 14_950_000, 500 bp.) X = 14_263_158; T = R(713_157.9) = 713_158;
    // W = floor(713_158 * 9M / 14_263_158) = 450_000; A = floor(263_158 * 2M / 5M)
    // = 105_263; B = 713_158 - 450_000 - 105_263 = 157_895; withheld = W + A = 555_263.
    // Src: PMK 168/2023, FAQ DJP PMK-66 no. 40, PP 58/2023 Lampiran B.
    const r = terMonth("K/1", [
      gross(9_000_000),
      grossUp(2_000_000),
      net(3_000_000),
    ]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "B",
      terRateBp: 500,
      taxableGrossIdr: 14_263_158,
      taxAllowanceIdr: 105_263,
      pph21Idr: 713_158,
      pph21WithheldIdr: 555_263,
      pph21EmployerBorneIdr: 157_895,
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  it("R17b mixed lines plus a taxable employer benefit (split by gross share of the lines)", () => {
    // As R17 with employer benefit 300_000. The benefit's tax is split by the
    // month's line schemes: lines gross 9M + gross_up 2M + net 3M = 14M, so the
    // gross share is 9/14 (floor) and the rest is the company's:
    //   employee benefit = floor(300_000 x 9_000_000 / 14_000_000) = 192_857;
    //   employee base G = 9_000_000 + 192_857 = 9_192_857.
    // X = 14_300_000 + S (all lines + benefit + employer-covered tax S), TER B
    // (row 11 s.d. 14_950_000 = 500 bp, row 12 s.d. 16_400_000 = 600 bp), W = floor(T x G / X):
    //   S=0       X=14_300_000 T=715_000 W=459_642 -> S=255_358
    //   S=255_358 X=14_555_358 T=727_768 W=459_642 -> S=268_126
    //   S=268_126 X=14_568_126 T=728_406 W=459_642 -> S=268_764
    //   S=268_764 X=14_568_764 T=728_438 W=459_642 -> S=268_796
    //   S=268_796 X=14_568_796 T=728_440 W=459_642 -> S=268_798
    //   S=268_798 X=14_568_798 T=728_440 W=459_642 -> S=268_798 stop.
    // T = R(14_568_798 x 5%) = R(728_439.9) = 728_440; W = 459_642;
    // A = floor(268_798 x 2M / 5M) = 107_519; B = 728_440 - 459_642 - 107_519 = 161_279;
    // withheld = W + A = 567_161. Take-home = 14_000_000 - 459_642.
    // (Old rule, whole benefit in the gross share, gave W = 465_000, see git history.)
    // Src: PMK 168/2023 (premi dibayar pemberi kerja), FAQ DJP PMK-66 no. 40.
    const r = terMonth(
      "K/1",
      [gross(9_000_000), grossUp(2_000_000), net(3_000_000)],
      { employerBenefitIdr: 300_000 },
    );
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "B",
      terRateBp: 500,
      taxableGrossIdr: 14_568_798,
      taxAllowanceIdr: 107_519,
      pph21Idr: 728_440,
      pph21WithheldIdr: 567_161,
      pph21EmployerBorneIdr: 161_279,
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
    expect(r.pph21WithheldIdr - r.taxAllowanceIdr).toBe(459_642);
    expect(
      r.pph21WithheldIdr -
        r.taxAllowanceIdr +
        r.taxAllowanceIdr +
        r.pph21EmployerBorneIdr,
    ).toBe(r.pph21Idr);
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
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  // ---------------------------------------------------------------------
  // R37-R48: policy and boundary cases (engine v2).
  // ---------------------------------------------------------------------

  it("[PAYR-03] R37 THR and bonus in the same month are both in that month's TER base", () => {
    // K/2 (B): salary 9_000_000 + THR 9_000_000 + bonus 12_345_679
    // => X = 30_345_679. TER B row 18 (s.d. 31_450_000; previous row ends
    // 29_350_000) 12% = 1200 bp. tax = R(30_345_679 * 1200 / 10^4) =
    // R(3_641_481.48) = 3_641_481. (Salary alone: 9M, row 5 1% = 90_000.)
    // Src: PP 58/2023 Pasal 3 (bruto bulan itu termasuk THR dan bonus), Lampiran B.
    const r = terMonth("K/2", [
      gross(9_000_000),
      gross(9_000_000),
      gross(12_345_679),
    ]);
    expect(r).toMatchObject({
      method: "ter",
      terCategory: "B",
      terRateBp: 1200,
      taxableGrossIdr: 30_345_679,
      taxAllowanceIdr: 0,
      pph21Idr: 3_641_481,
      pph21WithheldIdr: 3_641_481,
      pph21EmployerBorneIdr: 0,
      ...NO_REFUND,
      noTaxIdSurchargeApplied: false,
    });
  });

  // Category B exact bounds and +1 (K/1). tax = R(X * rate / 10^4).
  //   6_200_000 row 1 (0%) => 0            6_200_001 row 2 25 bp => R(15_500.0025) = 15_500
  //   14_950_000 row 11 500 bp => 747_500  14_950_001 row 12 600 bp => R(897_000.06) = 897_000
  //   1_405_000_000 row 39 3300 bp => 463_650_000
  //   1_405_000_001 row 40 3400 bp => R(477_700_000.34) = 477_700_000
  // Src: PP 58/2023 Lampiran B (bound "s.d." inclusive).
  describe("[PAYR-03] R38 category B exact bounds and +1", () => {
    it.each<[number, number, number]>([
      [6_200_000, 0, 0],
      [6_200_001, 25, 15_500],
      [14_950_000, 500, 747_500],
      [14_950_001, 600, 897_000],
      [1_405_000_000, 3300, 463_650_000],
      [1_405_000_001, 3400, 477_700_000],
    ])("X = %i -> %i bp, tax %i", (x, rateBp, tax) => {
      const r = terMonth("K/1", [gross(x)]);
      expect(r).toMatchObject({
        method: "ter",
        terCategory: "B",
        terRateBp: rateBp,
        taxableGrossIdr: x,
        pph21Idr: tax,
        pph21WithheldIdr: tax,
        pph21EmployerBorneIdr: 0,
        ...NO_REFUND,
      });
    });
  });

  // Category C exact bounds and +1 (K/3). tax = R(X * rate / 10^4).
  //   6_600_000 row 1 (0%) => 0            6_600_001 row 2 25 bp => R(16_500.0025) = 16_500
  //   12_050_000 row 9 200 bp => 241_000   12_050_001 row 10 300 bp => R(361_500.03) = 361_500
  //   1_419_000_000 row 40 3300 bp => 468_270_000
  //   1_419_000_001 row 41 3400 bp => R(482_460_000.34) = 482_460_000
  // Src: PP 58/2023 Lampiran C (bound "s.d." inclusive).
  describe("[PAYR-03] R39 category C exact bounds and +1", () => {
    it.each<[number, number, number]>([
      [6_600_000, 0, 0],
      [6_600_001, 25, 16_500],
      [12_050_000, 200, 241_000],
      [12_050_001, 300, 361_500],
      [1_419_000_000, 3300, 468_270_000],
      [1_419_000_001, 3400, 482_460_000],
    ])("X = %i -> %i bp, tax %i", (x, rateBp, tax) => {
      const r = terMonth("K/3", [gross(x)]);
      expect(r).toMatchObject({
        method: "ter",
        terCategory: "C",
        terRateBp: rateBp,
        taxableGrossIdr: x,
        pph21Idr: tax,
        pph21WithheldIdr: tax,
        pph21EmployerBorneIdr: 0,
        ...NO_REFUND,
      });
    });
  });

  describe("R40 rounding mode: down vs half_up on 5_999_999 TK/0", () => {
    // X = 5_999_999; A row 4 (s.d. 6_300_000) 75 bp.
    // 5_999_999 * 75 / 10^4 = 44_999.9925 -> down 44_999, half_up 45_000.
    // Src: PER-11/PJ/2025 Pasal 129 (half_up from the Coretax periods).
    it("down floors to 44_999", () => {
      const r = terMonth("TK/0", [gross(5_999_999)], {
        policy: policyWith({ roundingMode: "down" }),
      });
      expect(r).toMatchObject({
        terRateBp: 75,
        pph21Idr: 44_999,
        pph21WithheldIdr: 44_999,
      });
    });
    it("half_up (default) rounds to 45_000", () => {
      const r = terMonth("TK/0", [gross(5_999_999)]);
      expect(r).toMatchObject({
        terRateBp: 75,
        pph21Idr: 45_000,
        pph21WithheldIdr: 45_000,
      });
    });
    it("no NPWP, single rounding under down: 53_999 (54_000 under half_up, R14)", () => {
      // 5_999_999 * 75 * 12000 / 10^8 = 53_999.991.
      const down = terMonth("TK/0", [gross(5_999_999)], {
        hasTaxId: false,
        policy: policyWith({ roundingMode: "down" }),
      });
      expect(down).toMatchObject({
        pph21Idr: 53_999,
        noTaxIdSurchargeApplied: true,
      });
    });
  });

  it("R41 half_up rounds an exact .5 away from zero; down floors it", () => {
    // TK/0, X = 5_400_200; A row 2 (s.d. 5_650_000) 25 bp.
    // 5_400_200 * 25 / 10^4 = 13_500.5 exactly -> half_up 13_501, down 13_500.
    // Src: PER-11/PJ/2025 Pasal 129.
    const up = terMonth("TK/0", [gross(5_400_200)]);
    expect(up).toMatchObject({
      terRateBp: 25,
      pph21Idr: 13_501,
      pph21WithheldIdr: 13_501,
    });
    const down = terMonth("TK/0", [gross(5_400_200)], {
      policy: policyWith({ roundingMode: "down" }),
    });
    expect(down).toMatchObject({
      terRateBp: 25,
      pph21Idr: 13_500,
      pph21WithheldIdr: 13_500,
    });
  });

  describe("R42 surcharge policy annual_only: a TER month has no no-NPWP surcharge", () => {
    // TK/0, no NPWP, X = 10_000_000, A row 9 2% = 200 bp.
    // annual_only: tax = R(10_000_000 * 200 / 10^4) = 200_000, flag false.
    // ter_and_annual (default): 200_000 * 1.2 = 240_000, flag true.
    // Src: UU PPh Pasal 21(5a); the policy choice is tenant data (pph21-policy.ts).
    it("annual_only", () => {
      const r = terMonth("TK/0", [gross(10_000_000)], {
        hasTaxId: false,
        policy: policyWith({ noTaxIdSurcharge: "annual_only" }),
      });
      expect(r).toMatchObject({
        method: "ter",
        terRateBp: 200,
        pph21Idr: 200_000,
        pph21WithheldIdr: 200_000,
        noTaxIdSurchargeApplied: false,
      });
    });
    it("ter_and_annual", () => {
      const r = terMonth("TK/0", [gross(10_000_000)], {
        hasTaxId: false,
        policy: policyWith({ noTaxIdSurcharge: "ter_and_annual" }),
      });
      expect(r).toMatchObject({
        terRateBp: 200,
        pph21Idr: 240_000,
        pph21WithheldIdr: 240_000,
        noTaxIdSurchargeApplied: true,
      });
    });
  });

  // R43: policy combinedSpouseStatus `normalize` (default): K/I/n is withheld as
  // K/n for the TER category and reported as withholdingStatus K/n.
  // X = 12_000_000: K/I/0 -> K/0 A 4% 480_000; K/I/1 -> K/1 B 3% 360_000;
  // K/I/2 -> K/2 B 3% 360_000; K/I/3 -> K/3 C 2% 240_000.
  // Src: PP 58/2023 Pasal 2 (kategori A/B/C only), PMK 168/2023 Pasal 15.
  describe("R43 K/I statuses normalise to K/n", () => {
    it.each<[PtkpStatus, PtkpStatus, "A" | "B" | "C", number, number]>([
      ["K/I/0", "K/0", "A", 400, 480_000],
      ["K/I/1", "K/1", "B", 300, 360_000],
      ["K/I/2", "K/2", "B", 300, 360_000],
      ["K/I/3", "K/3", "C", 200, 240_000],
    ])("%s withheld as %s", (status, withholding, category, rateBp, tax) => {
      const r = terMonth(status, [gross(12_000_000)], {
        policy: policyWith({ combinedSpouseStatus: "normalize" }),
      });
      expect(r).toMatchObject({
        method: "ter",
        withholdingStatus: withholding,
        terCategory: category,
        terRateBp: rateBp,
        pph21Idr: tax,
        pph21WithheldIdr: tax,
      });
    });
  });

  describe("R44 K/I statuses under the reject policy", () => {
    const reject = policyWith({ combinedSpouseStatus: "reject" });
    const thrownBy = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    it.each<PtkpStatus>(["K/I/0", "K/I/1", "K/I/2", "K/I/3"])(
      "%s throws PAYROLL_PPH21_STATUS_UNSUPPORTED",
      (status) => {
        const error = thrownBy(() =>
          terMonth(status, [gross(12_000_000)], { policy: reject }),
        );
        expect(error).toBeInstanceOf(PayrollError);
        expect((error as PayrollError).code).toBe(
          "PAYROLL_PPH21_STATUS_UNSUPPORTED",
        );
      },
    );
    it("K/1 is unaffected by reject", () => {
      // Plain K/n statuses are withholding statuses; X = 12_000_000 B 3% = 360_000.
      const r = terMonth("K/1", [gross(12_000_000)], { policy: reject });
      expect(r).toMatchObject({
        withholdingStatus: "K/1",
        terCategory: "B",
        pph21Idr: 360_000,
      });
    });
  });

  describe("R45 mixed gross + net: proportional vs gross_first allocation", () => {
    // TK/0 (A). G = 6_000_000 gross, N = 6_000_000 net (U = 0, so A = 0).
    // proportional: W = floor(T*G/X).
    //   S: 0 -> 240_000 -> 249_600 -> 249_984 -> 250_000 (C(250_000) = 250_000 stop).
    //   X = 12_250_000 (row 14, s.d. 12_500_000, 400 bp); T = 490_000;
    //   W = floor(490_000 * 6M / 12.25M) = 240_000; B = 490_000 - 240_000 = 250_000.
    // gross_first: W = min(T, T(G alone)); T(6_000_000) = R(6M * 75 / 10^4) = 45_000
    //   (row 4, s.d. 6_300_000).
    //   S: 0 -> 435_000 -> 452_400 -> 453_096 -> 453_124 -> 453_125 (stable).
    //   X = 12_453_125 (400 bp); T = R(498_125.0) = 498_125; W = 45_000;
    //   B = 498_125 - 45_000 = 453_125.
    // The employer covers more under gross_first; the employee withholds 45_000
    // instead of 240_000.
    // Src: PMK 168/2023, FAQ DJP PMK-66 no. 40; allocation is tenant policy.
    it("proportional (default)", () => {
      const r = terMonth("TK/0", [gross(6_000_000), net(6_000_000)], {
        policy: policyWith({ mixedSchemeAllocation: "proportional" }),
      });
      expect(r).toMatchObject({
        terCategory: "A",
        terRateBp: 400,
        taxableGrossIdr: 12_250_000,
        taxAllowanceIdr: 0,
        pph21Idr: 490_000,
        pph21WithheldIdr: 240_000,
        pph21EmployerBorneIdr: 250_000,
        ...NO_REFUND,
      });
    });
    it("gross_first", () => {
      const r = terMonth("TK/0", [gross(6_000_000), net(6_000_000)], {
        policy: policyWith({ mixedSchemeAllocation: "gross_first" }),
      });
      expect(r).toMatchObject({
        terCategory: "A",
        terRateBp: 400,
        taxableGrossIdr: 12_453_125,
        taxAllowanceIdr: 0,
        pph21Idr: 498_125,
        pph21WithheldIdr: 45_000,
        pph21EmployerBorneIdr: 453_125,
        ...NO_REFUND,
      });
    });
  });

  describe("R46 mixed gross + gross_up: proportional vs gross_first allocation", () => {
    // K/1 (B). G = 8_000_000 gross, U = 4_000_000 gross_up (N = 0, so B = 0
    // and A = S).
    // proportional: S: 0 -> 120_000 -> 123_600 -> 123_708 -> 123_712 (stable).
    //   X = 12_123_712 (row 9, s.d. 12_600_000, 300 bp); T = R(363_711.36) = 363_711;
    //   W = floor(363_711 * 8M / 12_123_712) = 239_999; A = S = 123_712; B = 0.
    //   withheld = W + A = 363_711.
    // gross_first: T(8_000_000 alone) = R(8M * 100 / 10^4) = 80_000 (row 5, s.d. 9_200_000).
    //   S: 0 -> 280_000 -> 288_400 -> 288_652 -> 288_660 (stable).
    //   X = 12_288_660 (300 bp); T = R(368_659.8) = 368_660; W = 80_000;
    //   A = S = 288_660; withheld = 368_660.
    // Take-home = 8M + 4M - W: 11_760_001 proportional, 11_920_000 gross_first.
    // Src: PMK 168/2023 (tunjangan pajak), PP 58/2023 Lampiran B.
    it("proportional (default)", () => {
      const r = terMonth("K/1", [gross(8_000_000), grossUp(4_000_000)], {
        policy: policyWith({ mixedSchemeAllocation: "proportional" }),
      });
      expect(r).toMatchObject({
        terCategory: "B",
        terRateBp: 300,
        taxableGrossIdr: 12_123_712,
        taxAllowanceIdr: 123_712,
        pph21Idr: 363_711,
        pph21WithheldIdr: 363_711,
        pph21EmployerBorneIdr: 0,
        ...NO_REFUND,
      });
      // take-home = cash lines (8M + 4M) + allowance - withheld.
      expect(12_000_000 + r.taxAllowanceIdr - r.pph21WithheldIdr).toBe(
        11_760_001,
      );
    });
    it("gross_first", () => {
      const r = terMonth("K/1", [gross(8_000_000), grossUp(4_000_000)], {
        policy: policyWith({ mixedSchemeAllocation: "gross_first" }),
      });
      expect(r).toMatchObject({
        terCategory: "B",
        terRateBp: 300,
        taxableGrossIdr: 12_288_660,
        taxAllowanceIdr: 288_660,
        pph21Idr: 368_660,
        pph21WithheldIdr: 368_660,
        pph21EmployerBorneIdr: 0,
        ...NO_REFUND,
      });
      expect(12_000_000 + r.taxAllowanceIdr - r.pph21WithheldIdr).toBe(
        11_920_000,
      );
    });
  });

  describe("R47 take-home invariant: gross_up 6M + net 6M (no gross line)", () => {
    // TK/0 (A). G = 0, U = 6_000_000, N = 6_000_000. W = 0 under both policies.
    //   S: 0 -> 480_000 -> 499_200 -> 499_968 -> 499_999 -> 500_000 (stable).
    //   X = 12_500_000 (row 14, s.d. 12_500_000 inclusive, 400 bp); T = 500_000.
    //   A = floor(500_000 * 6M / 12M) = 250_000; B = 500_000 - 0 - 250_000 = 250_000.
    //   withheld = W + A = 250_000; A + B + W = T = 500_000.
    //   Take-home = cash lines 12_000_000 + allowance 250_000 - withheld 250_000
    //   = 12_000_000 = G_lines + U + N - W exactly.
    // Src: PMK 168/2023, FAQ DJP PMK-66 no. 40.
    it.each<Pph21PolicyParameters["mixedSchemeAllocation"]>([
      "proportional",
      "gross_first",
    ])("%s", (mixedSchemeAllocation) => {
      const r = terMonth("TK/0", [grossUp(6_000_000), net(6_000_000)], {
        policy: policyWith({ mixedSchemeAllocation }),
      });
      expect(r).toMatchObject({
        method: "ter",
        terCategory: "A",
        terRateBp: 400,
        taxableGrossIdr: 12_500_000,
        taxAllowanceIdr: 250_000,
        pph21Idr: 500_000,
        pph21WithheldIdr: 250_000,
        pph21EmployerBorneIdr: 250_000,
        ...NO_REFUND,
      });
      expect(12_000_000 + r.taxAllowanceIdr - r.pph21WithheldIdr).toBe(
        12_000_000,
      );
      // withheld = W + A with W = 0; A + B + W = T.
      expect(r.pph21WithheldIdr + r.pph21EmployerBorneIdr).toBe(r.pph21Idr);
    });
  });

  describe("R48 take-home invariant: gross 4M + gross_up 6M + net 6M", () => {
    // TK/0 (A). G = 4_000_000, U = 6_000_000, N = 6_000_000.
    // proportional: W = floor(T*G/X).
    //   S: 0 -> 840_000 -> 898_800 -> 902_916 -> 903_205 -> 903_225 -> 903_226 (stable).
    //   X = 16_903_226 (row 17, s.d. 16_950_000, 700 bp); T = R(1_183_225.82) = 1_183_226;
    //   W = floor(1_183_226 * 4M / 16_903_226) = 280_000;
    //   A = floor(903_226 * 6M / 12M) = 451_613; B = 1_183_226 - 280_000 - 451_613 = 451_613.
    //   withheld = 280_000 + 451_613 = 731_613. Take-home = 16M - 280_000 = 15_720_000.
    // gross_first: T(4_000_000 alone) = 0 (<= 5_400_000, 0%), so W = 0.
    //   S: 0 -> 1_120_000 -> 1_369_600 -> 1_389_568 -> 1_391_165 -> 1_391_293 ->
    //      1_391_303 -> 1_391_304 (stable).
    //   X = 17_391_304 (row 18, s.d. 19_750_000, 800 bp); T = R(1_391_304.32) = 1_391_304;
    //   A = floor(1_391_304 * 6M / 12M) = 695_652; B = 695_652; withheld = 695_652.
    //   Take-home = 16M - 0 = 16_000_000.
    // Src: PMK 168/2023, FAQ DJP PMK-66 no. 40; PP 58/2023 Lampiran A.
    it("proportional", () => {
      const r = terMonth(
        "TK/0",
        [gross(4_000_000), grossUp(6_000_000), net(6_000_000)],
        { policy: policyWith({ mixedSchemeAllocation: "proportional" }) },
      );
      expect(r).toMatchObject({
        terCategory: "A",
        terRateBp: 700,
        taxableGrossIdr: 16_903_226,
        taxAllowanceIdr: 451_613,
        pph21Idr: 1_183_226,
        pph21WithheldIdr: 731_613,
        pph21EmployerBorneIdr: 451_613,
        ...NO_REFUND,
      });
      // W = withheld - A = 280_000; A + B + W = T.
      const w = r.pph21WithheldIdr - r.taxAllowanceIdr;
      expect(w).toBe(280_000);
      expect(r.taxAllowanceIdr + r.pph21EmployerBorneIdr + w).toBe(r.pph21Idr);
      expect(16_000_000 + r.taxAllowanceIdr - r.pph21WithheldIdr).toBe(
        15_720_000,
      );
    });
    it("gross_first", () => {
      const r = terMonth(
        "TK/0",
        [gross(4_000_000), grossUp(6_000_000), net(6_000_000)],
        { policy: policyWith({ mixedSchemeAllocation: "gross_first" }) },
      );
      expect(r).toMatchObject({
        terCategory: "A",
        terRateBp: 800,
        taxableGrossIdr: 17_391_304,
        taxAllowanceIdr: 695_652,
        pph21Idr: 1_391_304,
        pph21WithheldIdr: 695_652,
        pph21EmployerBorneIdr: 695_652,
        ...NO_REFUND,
      });
      const w = r.pph21WithheldIdr - r.taxAllowanceIdr;
      expect(w).toBe(0);
      expect(r.taxAllowanceIdr + r.pph21EmployerBorneIdr + w).toBe(r.pph21Idr);
      expect(16_000_000 + r.taxAllowanceIdr - r.pph21WithheldIdr).toBe(
        16_000_000,
      );
    });
  });
});

describe("PPh 21 employer BPJS tax belongs to the company for net / gross-up employees (R66-R68, founder decision 2026-11-08)", () => {
  // TK/0 (category A), salary 10_000_000, employer BPJS benefit 400_000.
  // The benefit is taxable (PMK 168/2023, premi dibayar pemberi kerja), but for
  // a net or gross-up employee the tax on it is the company's, never taken
  // from take-home. Fixed point on the employer-covered tax S with
  // X = 10_400_000 + S, half up (TER A: s.d. 10_700_000 = 250 bp):
  //   S=0       X=10_400_000 T=260_000
  //   S=260_000 X=10_660_000 T=266_500
  //   S=266_500 X=10_666_500 T=266_662.5 -> 266_663
  //   S=266_663 X=10_666_663 T=266_666.575 -> 266_667
  //   S=266_667 X=10_666_667 T=266_666.675 -> 266_667 stop.
  const policies = ["proportional", "gross_first"] as const;

  for (const allocation of policies) {
    const policy = policyWith({ mixedSchemeAllocation: allocation });

    it(`R66 pure net (${allocation}): the employer bears the tax on the BPJS benefit, take-home stays 10_000_000`, () => {
      const r = terMonth("TK/0", [net(10_000_000)], {
        employerBenefitIdr: 400_000,
        policy,
      });
      expect(r).toMatchObject({
        taxableGrossIdr: 10_666_667,
        taxAllowanceIdr: 0,
        pph21Idr: 266_667,
        pph21WithheldIdr: 0,
        pph21EmployerBorneIdr: 266_667,
        ...NO_REFUND,
      });
      expect(10_000_000 - r.pph21WithheldIdr).toBe(10_000_000);
    });

    it(`R67 pure gross-up (${allocation}): the tax on the BPJS benefit goes into the tax allowance, take-home stays 10_000_000`, () => {
      const r = terMonth("TK/0", [grossUp(10_000_000)], {
        employerBenefitIdr: 400_000,
        policy,
      });
      expect(r).toMatchObject({
        taxableGrossIdr: 10_666_667,
        taxAllowanceIdr: 266_667,
        pph21Idr: 266_667,
        pph21WithheldIdr: 266_667,
        pph21EmployerBorneIdr: 0,
        ...NO_REFUND,
      });
      expect(10_000_000 + r.taxAllowanceIdr - r.pph21WithheldIdr).toBe(
        10_000_000,
      );
    });

    it(`R68 gross employee (${allocation}) is unchanged: the employee still carries the tax on the BPJS benefit`, () => {
      // X = 10_400_000, 250 bp => 260_000, all withheld.
      const r = terMonth("TK/0", [gross(10_000_000)], {
        employerBenefitIdr: 400_000,
        policy,
      });
      expect(r).toMatchObject({
        taxableGrossIdr: 10_400_000,
        taxAllowanceIdr: 0,
        pph21Idr: 260_000,
        pph21WithheldIdr: 260_000,
        pph21EmployerBorneIdr: 0,
        ...NO_REFUND,
      });
    });
  }
});

describe("PPh 21 employer BPJS tax split on mixed lines: boundaries (R77-R82)", () => {
  // TK/0 (category A), benefit 400_000, lines in two schemes. The employee base
  // is G = gross lines + floor(benefit x gross lines / all lines); the rest of
  // the tax is the company's (borne for net, allowance for gross-up).
  const benefit = { employerBenefitIdr: 400_000 };

  it("R77 a Rp1 gross line moves only its proportional share (proportional)", () => {
    // gross 1 + net 10_000_000: G = 1 + floor(400_000 x 1 / 10_000_001) = 1.
    // X = 10_400_001 + S; TER A row 11 (s.d. 10_700_000) 250 bp, half up:
    //   S=0       X=10_400_001 T=260_000 W=floor(260_000 x 1 / X)=0 -> S=260_000
    //   S=260_000 X=10_660_001 T=266_500 W=0 -> S=266_500
    //   S=266_500 X=10_666_501 T=266_663 -> S=266_663
    //   S=266_663 X=10_666_664 T=266_667 -> S=266_667
    //   S=266_667 X=10_666_668 T=266_667 (266_666.7) stop.
    // W = 0, borne = 266_667: the whole tax is the company's; the old
    // all-or-nothing rule put the benefit tax on the employee.
    const r = terMonth("TK/0", [gross(1), net(10_000_000)], {
      ...benefit,
      policy: policyWith({ mixedSchemeAllocation: "proportional" }),
    });
    expect(r).toMatchObject({
      taxableGrossIdr: 10_666_668,
      taxAllowanceIdr: 0,
      pph21Idr: 266_667,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 266_667,
      ...NO_REFUND,
    });
  });

  it("R78 a Rp1 gross line (gross_first): TER 0% on the employee's own base, the company bears the rest", () => {
    // gross_first W = min(T, tax of G alone) = tax(G = 1) = 0 (TER 0% row), so
    // S = T at every step and the fixed point is R77's: X = 10_666_668,
    // T = S = 266_667.
    const r = terMonth("TK/0", [gross(1), net(10_000_000)], {
      ...benefit,
      policy: policyWith({ mixedSchemeAllocation: "gross_first" }),
    });
    expect(r).toMatchObject({
      taxableGrossIdr: 10_666_668,
      pph21Idr: 266_667,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 266_667,
      ...NO_REFUND,
    });
  });

  it("R79 50/50 gross vs net (proportional): the employee carries tax on half the benefit", () => {
    // gross 5_000_000 + net 5_000_000: G = 5_000_000 + 200_000 = 5_200_000.
    // X = 10_400_000 + S, W = floor(T x 5_200_000 / X):
    //   S=0       X=10_400_000 T=260_000 W=130_000 -> S=130_000
    //   S=130_000 X=10_530_000 T=263_250 W=130_000 -> S=133_250
    //   S=133_250 X=10_533_250 T=263_331 (263_331.25) W=129_999 -> S=133_332
    //   S=133_332 X=10_533_332 T=263_333 W=129_999 -> S=133_334
    //   S=133_334 X=10_533_334 T=263_333 (263_333.35) W=129_999 -> S=133_334 stop.
    // withheld = W = 129_999, borne = 263_333 - 129_999 = 133_334.
    const r = terMonth("TK/0", [gross(5_000_000), net(5_000_000)], {
      ...benefit,
      policy: policyWith({ mixedSchemeAllocation: "proportional" }),
    });
    expect(r).toMatchObject({
      taxableGrossIdr: 10_533_334,
      taxAllowanceIdr: 0,
      pph21Idr: 263_333,
      pph21WithheldIdr: 129_999,
      pph21EmployerBorneIdr: 133_334,
      ...NO_REFUND,
    });
    expect(r.pph21WithheldIdr + r.pph21EmployerBorneIdr).toBe(r.pph21Idr);
  });

  it("R80 50/50 gross vs gross-up (proportional): the company's part is the tax allowance", () => {
    // Same fixed point as R79 with gross_up instead of net: A = S x U/(U+N) = S.
    // withheld = W + A = 129_999 + 133_334 = 263_333 = T, borne 0.
    // Take-home = 10_000_000 + A - withheld = 10_000_000 - W = 9_870_001.
    const r = terMonth("TK/0", [gross(5_000_000), grossUp(5_000_000)], {
      ...benefit,
      policy: policyWith({ mixedSchemeAllocation: "proportional" }),
    });
    expect(r).toMatchObject({
      taxableGrossIdr: 10_533_334,
      taxAllowanceIdr: 133_334,
      pph21Idr: 263_333,
      pph21WithheldIdr: 263_333,
      pph21EmployerBorneIdr: 0,
      ...NO_REFUND,
    });
    expect(10_000_000 + r.taxAllowanceIdr - r.pph21WithheldIdr).toBe(9_870_001);
  });

  it("R81 50/50 gross vs net (gross_first): the employee's own 5_200_000 is TER 0%, the company bears all", () => {
    // W = min(T, tax(G = 5_200_000)) = 0 (0% row s.d. 5_400_000).
    // Fixed point as R66 (TER file): X = 10_666_667, T = S = 266_667.
    const r = terMonth("TK/0", [gross(5_000_000), net(5_000_000)], {
      ...benefit,
      policy: policyWith({ mixedSchemeAllocation: "gross_first" }),
    });
    expect(r).toMatchObject({
      taxableGrossIdr: 10_666_667,
      pph21Idr: 266_667,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 266_667,
      ...NO_REFUND,
    });
  });

  it("R82 100% gross is unchanged by the split (both policies): same numbers as R12-style gross pay", () => {
    // No net / gross-up line: G = 10_000_000 + 400_000, X = 10_400_000, 250 bp
    // => 260_000, all withheld.
    for (const mixedSchemeAllocation of [
      "proportional",
      "gross_first",
    ] as const) {
      const r = terMonth("TK/0", [gross(10_000_000)], {
        ...benefit,
        policy: policyWith({ mixedSchemeAllocation }),
      });
      expect(r).toMatchObject({
        taxableGrossIdr: 10_400_000,
        pph21Idr: 260_000,
        pph21WithheldIdr: 260_000,
        pph21EmployerBorneIdr: 0,
        taxAllowanceIdr: 0,
      });
    }
  });
});
