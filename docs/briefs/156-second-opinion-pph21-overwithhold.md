# Brief 156: second-opinion — PPh 21 lebih potong Jan–Nov milik perusahaan (legend-u1xq, tingkat K)

## Diff

- Repo `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pph21-overwithhold`, cabang `ws/pph21-overwithhold`.
- Rentang: `21edd29b..baf5ca9e` (satu commit).
- Non-test: 158 baris (`packages/shared/src/hris/payroll/pph21.ts` +116/−42 bersama `payslips.ts`). Satu run cukup.
- Test: `apps/api/src/test/payroll-pph21-overwithhold-reference.test.ts` (baru), `payroll-pph21-annual.test.ts` (R36, R49, R50, R51, R74 diubah), `payroll-pph21-history-split.test.ts` (property test invarian baru).
- Spesifikasi: `docs/briefs/sub-pph21-overwithhold.md` di worktree; latar: `docs/briefs/sub-pph21-history-split.md`.

## Berkas berisiko

1. `pph21.ts` `computePph21Period`, cabang `history < 0n`: pembagian kredit C (tiga cabang: basis skema + gross_first, basis skema + proportional, tanpa basis), titik tetap `covered = max(0, Dr(X) − Cr)` tanpa gate T > 0, netting sisi perusahaan.
2. `pph21.ts` cabang H ≥ 0: harus identik dengan sebelumnya (hanya restruktur + throw untuk T < 0 yang mustahil).
3. `payslips.ts` `payslipTotalsIssues`: cek `withheld ≤ max(0, T)` diganti kesetaraan `withheld + borne − refund − employerRefund = T`; cek yang sama di `payrollRunTotalsSchema` dihapus (totals tak punya kolom refund/borne).

## Invarian yang harus dicek

- Setoran DJP: withheld + borne − refund karyawan − refund perusahaan = T, per slip.
- Karyawan tidak pernah menanggung lebih dari bagiannya: W = max(0, De − Ce) ≤ De.
- Refund perusahaan ≤ Cr ≤ pajak perusahaan Jan–Nov; refund karyawan ≤ Ce ≤ pajak karyawan Jan–Nov.
- Satu pembayar tidak sekaligus dipotong dan di-refund.
- Tahun satu skema (murni gross, murni net, murni gross-up) sama dengan engine lama, termasuk T < 0.
- Kontinu di H = 0 dengan cabang H ≥ 0.
- X = baris + benefit + A + B tepat (covered = bagian bersih perusahaan).

## Perubahan perilaku yang disengaja (nilai, bukan hanya kode)

- Contoh bead (gross-up 15 jt Jan–Nov, Desember gross): W 1.443.498 → 2.250.000, refund perusahaan 0 → 806.502; T tetap 1.443.498.
- T < 0 campuran: −T tidak lagi dibagi murni riwayat; tiap pembayar = kreditnya − bagiannya atas D.
- `gross_first` tanpa basis skema: kredit dibagi riwayat pembayar, bukan "karyawan duluan" (R50, R51, R74). Jalur produksi (`buildPph21Prior`) selalu mengirim basis skema.

Uji silang secara independen; jangan bersandar pada kesimpulan review lain.

## Run 2 — legend-mmgd (saldo pembayar tanpa clamp)

- Rentang: `baf5ca9e..6e20273a` (satu commit). Non-test: `pph21.ts` +95/−182 (satu jalur untuk semua periode). Satu run.
- Spesifikasi: `docs/briefs/sub-pph21-unclamped.md` di worktree.
- Berisiko: perhitungan saldo `employerBalance` (tiga cabang + gate `lastTaxPeriod`), titik tetap `covered = max(0, Dr + bR)`, netting per pembayar.
- Invarian: setoran = T; kasus tanda sama, bulan TER, satu skema identik dengan `baf5ca9e`; tidak ada pembayar sekaligus dipotong dan di-refund; saldo 0 di luar periode terakhir.
- Nilai berubah: H3, H4, H7 (history-split-reference), O5, O6 (overwithhold-reference), P4 (prior-reference).
- Uji silang independen; jangan bersandar pada review lain.

## Run 3 — legend-4ndx (potongan karyawan dibatasi gaji tersedia)

- Rentang: `6e20273a..1535d4d8` (empat commit: cap `06dd7ddd`, clawback `9c4153fb`, settle final `86d3d417`, test `1535d4d8`). Non-test: `pph21.ts` (cap, titik tetap, `pph21CapExcessIdr` di hasil dan prior), `payslip-tax.ts` (cap opsional diteruskan; `buildPph21Prior` menjumlahkan excess), `payslips.ts` (field opsional `pph21CapExcessIdr` ≤ borne).
- Spesifikasi: `docs/briefs/sub-pph21-takehome-cap.md` di worktree, bagian "Keputusan architect".
- Bug: `proportional` dengan T < 0 memotong karyawan melebihi gaji (CTO S2: W 2.486.089 dari gaji 1 jt). Sekarang cap W = min(gross lines + U + N − JHT/JP karyawan, `employeeWithholdingCapIdr`); kelebihan masuk ke sisi perusahaan di dalam titik tetap covered (borne bila net perusahaan ≥ 0, selain itu mengurangi refund perusahaan).
- Clawback: excess yang ditanggung perusahaan di bulan TER (`pph21CapExcessIdr`, dijumlahkan ke prior) melunasi tagihan karyawan periode terakhir (saldo history + bagian bulan ini) di `netsAt`: `settled = min(priorCapExcess, max(0, charge))`. Tidak pernah ditarik balik ke karyawan dan tidak pernah dibayarkan sebagai refund karyawan; sisanya tetap kredit perusahaan. Bagian yang diambil alih (settled + excess) selalu borne, bukan allowance. Skenario K1–K4 di sub-brief.
- Berisiko: `netsAt` dan loop titik tetap (monoton, konvergen), pemisahan allowance vs excess (`ownCovered`, `ownNet`), validasi `employeeWithholdingCapIdr`, cap yang juga berlaku di bulan TER (bukan hanya Desember).
- Invarian: W ≤ cap; setoran = T; take-home ≥ 0; excess = 0 → identik dengan `6e20273a`; excess tidak pernah menjadi allowance; dibanding `6e20273a` W tidak naik, refund perusahaan tidak naik, borne tidak turun.
- Nilai berubah: R63 (annual, Desember tanpa gaji: B = T = 5.646.900), M1 (history-split-reference, bulan TER benefit saja: B = T = 121.827), O6 `proportional` dengan basis skema (W 2.000.000, refund perusahaan 3.700.000). Test baru: `payroll-pph21-takehome-cap.test.ts`.
- Catatan kebijakan (bukan bug untuk dicari): `proportional` membebani karyawan di bawah PTKP dengan tarif rata-rata gabungan; tidak diubah di run ini.
- Uji silang independen; jangan bersandar pada review lain.
