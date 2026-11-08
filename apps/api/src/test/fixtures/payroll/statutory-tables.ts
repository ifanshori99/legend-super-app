// Reference statutory tables for the PPh 21 reference suite (PRD v1.7 §3 F30,
// PAYR-03, R15; bead legend-5cnk). Unlike the ILLUSTRATIVE fixtures in
// packages/shared/src/hris/payroll/fixtures.ts, these are the regulation in
// force since 2024-01-01, typed in by hand from the regulations (NOT copied
// from any engine or app fixture):
//
// - PTKP: PMK 101/PMK.010/2016 Pasal 1 — Rp54.000.000 wajib pajak, +Rp4.500.000
//   kawin, +Rp54.000.000 penghasilan istri digabung (K/I), +Rp4.500.000 per
//   tanggungan (maks 3).
// - TER bulanan: PP 58/2023 Pasal 2 and Lampiran huruf A (kategori A: TK/0,
//   TK/1, K/0; 44 lapisan), B (TK/2, TK/3, K/1, K/2; 40 lapisan), C (K/3; 41
//   lapisan). Bounds are the "s.d." upper limits, inclusive.
// - Pasal 17 ayat (1) huruf a UU PPh as amended by UU 7/2021 (HPP): 5% s.d.
//   Rp60 jt, 15% s.d. Rp250 jt, 25% s.d. Rp500 jt, 30% s.d. Rp5 M, 35% above.
// - Biaya jabatan: PMK 168/2023 Pasal 10 ayat (2), 5% of bruto, maks Rp6 jt
//   setahun (Rp500.000 sebulan).
// - PKP rounded down to whole thousands: Pasal 17 ayat (4) UU PPh.
// - No-NPWP surcharge: Pasal 21 ayat (5a) UU PPh, tarif 20% lebih tinggi.
//
// Rounding: the tables keep `roundingMode: "down"` for other consumers, but
// the PPh 21 engine rounds with the tenant policy's versioned mode
// (pph21-policy.ts; default half up for Coretax periods, PER-11/PJ/2025
// Pasal 129
// https://pajak.go.id/index.php/id/peraturan/ketentuan-pelaporan-pajak-penghasilan-pajak-pertambahan-nilai-pajak-penjualan-atas-0).
// Lampiran PP 58/2023:
// https://pajak.go.id/sites/default/files/lampiran/Lampiran%20PP58TAHUN2023.pdf
//
// K/I statuses: PP 58/2023 lists no K/I category (withholding uses the
// employee's own status); they are mapped like K/n here so the table is total,
// and the engine normalises K/I/n to K/n (or rejects it) per tenant policy.

import {
  ptkpParametersSchema,
  terParametersSchema,
  pph21AnnualParametersSchema,
} from "@starter/shared/hris/payroll";
import type {
  PtkpParameters,
  TerParameters,
  Pph21AnnualParameters,
} from "@starter/shared/hris/payroll";

const b = (upToIdr: number | null, rateBp: number) => ({ upToIdr, rateBp });

export const REFERENCE_PTKP: PtkpParameters = ptkpParametersSchema.parse({
  annualAmountIdrByStatus: {
    "TK/0": 54_000_000,
    "TK/1": 58_500_000,
    "TK/2": 63_000_000,
    "TK/3": 67_500_000,
    "K/0": 58_500_000,
    "K/1": 63_000_000,
    "K/2": 67_500_000,
    "K/3": 72_000_000,
    "K/I/0": 112_500_000,
    "K/I/1": 117_000_000,
    "K/I/2": 121_500_000,
    "K/I/3": 126_000_000,
  },
});

export const REFERENCE_TER: TerParameters = terParametersSchema.parse({
  categoryByPtkpStatus: {
    "TK/0": "A",
    "TK/1": "A",
    "K/0": "A",
    "TK/2": "B",
    "TK/3": "B",
    "K/1": "B",
    "K/2": "B",
    "K/3": "C",
    "K/I/0": "A",
    "K/I/1": "B",
    "K/I/2": "B",
    "K/I/3": "C",
  },
  bracketsByCategory: {
    A: [
      b(5_400_000, 0), // 1: 0%
      b(5_650_000, 25), // 2: 0.25%
      b(5_950_000, 50), // 3: 0.5%
      b(6_300_000, 75), // 4: 0.75%
      b(6_750_000, 100), // 5: 1%
      b(7_500_000, 125), // 6: 1.25%
      b(8_550_000, 150), // 7: 1.5%
      b(9_650_000, 175), // 8: 1.75%
      b(10_050_000, 200), // 9: 2%
      b(10_350_000, 225), // 10: 2.25%
      b(10_700_000, 250), // 11: 2.5%
      b(11_050_000, 300), // 12: 3%
      b(11_600_000, 350), // 13: 3.5%
      b(12_500_000, 400), // 14: 4%
      b(13_750_000, 500), // 15: 5%
      b(15_100_000, 600), // 16: 6%
      b(16_950_000, 700), // 17: 7%
      b(19_750_000, 800), // 18: 8%
      b(24_150_000, 900), // 19: 9%
      b(26_450_000, 1000), // 20: 10%
      b(28_000_000, 1100), // 21: 11%
      b(30_050_000, 1200), // 22: 12%
      b(32_400_000, 1300), // 23: 13%
      b(35_400_000, 1400), // 24: 14%
      b(39_100_000, 1500), // 25: 15%
      b(43_850_000, 1600), // 26: 16%
      b(47_800_000, 1700), // 27: 17%
      b(51_400_000, 1800), // 28: 18%
      b(56_300_000, 1900), // 29: 19%
      b(62_200_000, 2000), // 30: 20%
      b(68_600_000, 2100), // 31: 21%
      b(77_500_000, 2200), // 32: 22%
      b(89_000_000, 2300), // 33: 23%
      b(103_000_000, 2400), // 34: 24%
      b(125_000_000, 2500), // 35: 25%
      b(157_000_000, 2600), // 36: 26%
      b(206_000_000, 2700), // 37: 27%
      b(337_000_000, 2800), // 38: 28%
      b(454_000_000, 2900), // 39: 29%
      b(550_000_000, 3000), // 40: 30%
      b(695_000_000, 3100), // 41: 31%
      b(910_000_000, 3200), // 42: 32%
      b(1_400_000_000, 3300), // 43: 33%
      b(null, 3400), // 44: 34%
    ],
    B: [
      b(6_200_000, 0), // 1: 0%
      b(6_500_000, 25), // 2: 0.25%
      b(6_850_000, 50), // 3: 0.5%
      b(7_300_000, 75), // 4: 0.75%
      b(9_200_000, 100), // 5: 1%
      b(10_750_000, 150), // 6: 1.5%
      b(11_250_000, 200), // 7: 2%
      b(11_600_000, 250), // 8: 2.5%
      b(12_600_000, 300), // 9: 3%
      b(13_600_000, 400), // 10: 4%
      b(14_950_000, 500), // 11: 5%
      b(16_400_000, 600), // 12: 6%
      b(18_450_000, 700), // 13: 7%
      b(21_850_000, 800), // 14: 8%
      b(26_000_000, 900), // 15: 9%
      b(27_700_000, 1000), // 16: 10%
      b(29_350_000, 1100), // 17: 11%
      b(31_450_000, 1200), // 18: 12%
      b(33_950_000, 1300), // 19: 13%
      b(37_100_000, 1400), // 20: 14%
      b(41_100_000, 1500), // 21: 15%
      b(45_800_000, 1600), // 22: 16%
      b(49_500_000, 1700), // 23: 17%
      b(53_800_000, 1800), // 24: 18%
      b(58_500_000, 1900), // 25: 19%
      b(64_000_000, 2000), // 26: 20%
      b(71_000_000, 2100), // 27: 21%
      b(80_000_000, 2200), // 28: 22%
      b(93_000_000, 2300), // 29: 23%
      b(109_000_000, 2400), // 30: 24%
      b(129_000_000, 2500), // 31: 25%
      b(163_000_000, 2600), // 32: 26%
      b(211_000_000, 2700), // 33: 27%
      b(374_000_000, 2800), // 34: 28%
      b(459_000_000, 2900), // 35: 29%
      b(555_000_000, 3000), // 36: 30%
      b(704_000_000, 3100), // 37: 31%
      b(957_000_000, 3200), // 38: 32%
      b(1_405_000_000, 3300), // 39: 33%
      b(null, 3400), // 40: 34%
    ],
    C: [
      b(6_600_000, 0), // 1: 0%
      b(6_950_000, 25), // 2: 0.25%
      b(7_350_000, 50), // 3: 0.5%
      b(7_800_000, 75), // 4: 0.75%
      b(8_850_000, 100), // 5: 1%
      b(9_800_000, 125), // 6: 1.25%
      b(10_950_000, 150), // 7: 1.5%
      b(11_200_000, 175), // 8: 1.75%
      b(12_050_000, 200), // 9: 2%
      b(12_950_000, 300), // 10: 3%
      b(14_150_000, 400), // 11: 4%
      b(15_550_000, 500), // 12: 5%
      b(17_050_000, 600), // 13: 6%
      b(19_500_000, 700), // 14: 7%
      b(22_700_000, 800), // 15: 8%
      b(26_600_000, 900), // 16: 9%
      b(28_100_000, 1000), // 17: 10%
      b(30_100_000, 1100), // 18: 11%
      b(32_600_000, 1200), // 19: 12%
      b(35_400_000, 1300), // 20: 13%
      b(38_900_000, 1400), // 21: 14%
      b(43_000_000, 1500), // 22: 15%
      b(47_400_000, 1600), // 23: 16%
      b(51_200_000, 1700), // 24: 17%
      b(55_800_000, 1800), // 25: 18%
      b(60_400_000, 1900), // 26: 19%
      b(66_700_000, 2000), // 27: 20%
      b(74_500_000, 2100), // 28: 21%
      b(83_200_000, 2200), // 29: 22%
      b(95_600_000, 2300), // 30: 23%
      b(110_000_000, 2400), // 31: 24%
      b(134_000_000, 2500), // 32: 25%
      b(169_000_000, 2600), // 33: 26%
      b(221_000_000, 2700), // 34: 27%
      b(390_000_000, 2800), // 35: 28%
      b(463_000_000, 2900), // 36: 29%
      b(561_000_000, 3000), // 37: 30%
      b(709_000_000, 3100), // 38: 31%
      b(965_000_000, 3200), // 39: 32%
      b(1_419_000_000, 3300), // 40: 33%
      b(null, 3400), // 41: 34%
    ],
  },
  roundingMode: "down",
});

export const REFERENCE_PPH21_ANNUAL: Pph21AnnualParameters =
  pph21AnnualParametersSchema.parse({
    brackets: [
      b(60_000_000, 500),
      b(250_000_000, 1500),
      b(500_000_000, 2500),
      b(5_000_000_000, 3000),
      b(null, 3500),
    ],
    occupationalCostRateBp: 500,
    occupationalCostAnnualCapIdr: 6_000_000,
    taxableIncomeRoundDownToIdr: 1000,
    noTaxIdSurchargeBp: 2000,
    roundingMode: "down",
  });

export const REFERENCE_TABLES = {
  ptkp: REFERENCE_PTKP,
  ter: REFERENCE_TER,
  annual: REFERENCE_PPH21_ANNUAL,
} as const;
