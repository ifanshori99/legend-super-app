# Brief second-opinion Codex: PPh 21 Desember `gross_first` (bead legend-y2lf)

Tingkat K (pajak). Effort xhigh. Hanya review dan analisis, jangan ubah kode.

## Konteks

Engine PPh 21: `packages/shared/src/hris/payroll/pph21.ts`, fungsi
`computePph21Period`. Di masa pajak terakhir (Desember) pajak tahunan dihitung
ulang, dan sisa Jan-Nov dibagi antara karyawan dan perusahaan (saldo masing-masing).
Kebijakan `mixedSchemeAllocation` = `gross_first` mengalokasikan tambahan pajak
Desember (D) ke karyawan hanya sebesar pajak yang dibawa gaji skema gross.

Notasi: P = seluruh pendapatan Jan-Nov. Gs = bagian skema gross Jan-Nov
(`prior.grossSchemeBaseIdr`). E = bagian skema employer. G* = gaji skema gross
Desember. D = tambahan pajak bulan ini = annual(P + X) - annual(P). annual(x) =
pajak Pasal 17 setahun atas penghasilan x (biaya jabatan, PTKP, PKP dibulatkan
ke ribuan).

## Rumus lama vs baru

- Saldo karyawan Jan-Nov (tidak berubah): annual(Gs) - dibayar karyawan.
- Bagian karyawan Desember, lama: min(annual(P + G*) - annual(P), D).
- Bagian karyawan Desember, baru (keputusan founder Q52): min(annual(Gs + G*) -
  annual(Gs), D), hanya bila `lastTaxPeriod && priorMix > 0` (Gs diketahui).
  Bila priorMix = 0, rumus lama. Kode: `employeeAloneAdded` di pph21.ts.

Masalah yang diperbaiki: dua skala berbeda (annual(Gs) vs annual(P)) sehingga
karyawan bisa membayar lebih dari pajak gross-nya sendiri.

## Contoh H7

Jan-Nov gross 5 jt + gross-up 5 jt per bulan, Desember sama. Gs = 55 jt,
pajak karyawan Jan-Nov 1.237.500. Pajak sendiri atas gross 60 jt setahun =
annual(60 jt) = 150.000. Lama: bagian Desember 237.500, total beban karyawan
237.500. Baru: bagian 150.000, beban karyawan Jan-Dec 1.237.500 - 1.087.500
(refund) = 150.000. Pajak tahunan akhir naik sedikit (3.502.800 vs 3.487.350)
karena pajak yang ditanggung perusahaan ikut menjadi bruto (FAQ DJP PMK-66 no. 40).

## Pertanyaan

1. Monoton: bila G* naik, apakah beban karyawan tidak turun? Bila Gs naik?
2. Cap D benar? annual(Gs + G*) - annual(Gs) bisa melebihi D karena pembulatan
   PKP ke ribuan (contoh 71.300 vs 71.250). Apakah ada kasus lain di mana cap
   mengubah hasil secara tak wajar?
3. Fallback priorMix = 0: apakah mempertahankan rumus lama aman, atau lebih
   baik menolak/perlakuan lain?
4. Kasus campuran `proportional`: tidak diubah. Apakah ada interaksi (mis.
   bulan campuran dalam satu tahun, kebijakan berganti) yang bermasalah?
5. Konsekuensi PTKP: Gs kecil (di bawah PTKP) membuat bagian karyawan 0 dan
   seluruh pajak Desember jatuh ke perusahaan (contoh N1: karyawan 2.250.000
   menjadi 0, perusahaan menanggung 1.698.198). Apakah ini sesuai maksud
   Pasal 15/21 PMK 168/2023, atau perlu pembagian PTKP antar skema?

## Cara menjalankan test

Dari root worktree (`.worktrees/pph21-dec-minspend`):

```
LEGEND_TEST_FILES="src/test/payroll-pph21-dec-gross-first.test.ts src/test/payroll-pph21-history-split-reference.test.ts src/test/payroll-pph21-unclamped-reference.test.ts src/test/payroll-pph21-overwithhold-reference.test.ts src/test/payroll-pph21-takehome-cap.test.ts" pnpm test
```

Test baru: `apps/api/src/test/payroll-pph21-dec-gross-first.test.ts` (H7,
tanpa gross-up, cap D, priorMix = 0). Catatan rilis:
`docs/release-notes-pph21-december.md`.
