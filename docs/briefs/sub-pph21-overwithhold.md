# Sub-brief: PPh 21 kelebihan potong Jan–Nov milik perusahaan (bd legend-u1xq, tingkat K)

Engine: `packages/shared/src/hris/payroll/pph21.ts` `computePph21Period`. Notasi seperti `docs/briefs/sub-pph21-history-split.md` (H, priorTax, pET, pEeT = priorTax − pET, E/Gs, G*, X, T, W, A, B).

## Bug

H < 0 (TER Jan–Nov kelebihan potong) dan T ≥ 0: kode sekarang W = floor(T × G*/X), jadi kredit −H milik perusahaan mengurangi pajak karyawan.
Contoh bead: TK/0 NPWP, gross-up 15 jt Jan–Nov, Desember gross 15 jt. H = −806.502, T = 1.443.498: karyawan bayar 1.443.498, seharusnya 2.250.000 (pajak tambahan Desember atas gajinya), perusahaan terima refund 806.502.

## Usulan desain engineer (divalidasi architect)

Untuk H < 0 saja (H ≥ 0 dan bulan TER tidak berubah):

1. D = T − H = annual(prior + X) − annual(prior) ≥ 0: pajak tambahan bulan ini.
2. D dibagi campuran skema bulan ini: `proportional` De = floor(D × G*/X); `gross_first` De = min(D, annual(prior + G*) − annual(prior)). Dr = D − De.
3. Kredit C = −H dibagi riwayat pembayar, aturan sama dengan lebih potong sekarang: `proportional` Cr = floor(C × pET/priorTax), `gross_first` Ce = min(C, pEeT). Ce = C − Cr.
4. Karyawan: De − Ce ≥ 0 → W = De − Ce; < 0 → W = 0, refund karyawan = Ce − De.
5. Perusahaan: Dr − Cr ≥ 0 → covered S = Dr − Cr (titik tetap seperti biasa, dibagi A/B); < 0 → S = 0, refund perusahaan = Cr − Dr.
   Netting di sisi perusahaan perlu supaya benefit (borne/allowance di X) setahun tidak menghitung C dua kali: C sudah masuk X Jan–Nov.
6. Berlaku untuk T ≥ 0 dan T < 0 (satu rumus, kontinu). Akibatnya T < 0 campuran berubah dari pembagian −T murni riwayat.

Invarian baru: W + A + B − refundKaryawan − refundPerusahaan = T; take-home = G+U+N − W + refundKaryawan; W ≤ De (karyawan tidak menanggung lebih dari bagiannya atas D); refund perusahaan ≤ Cr; refund karyawan ≤ Ce.
Invarian lama yang dilepas: W ≤ T dan A + B + W = T (hanya untuk H < 0).
Satu skema (murni gross, murni net, murni gross-up): hasil sama dengan kode lama.

## Pertanyaan untuk architect

- Q1 Aturan 6 (T < 0 ikut rumus baru) vs pertahankan pembagian −T lama untuk T < 0.
- Q2 Pembagian C di `gross_first`: karyawan duluan min(C, pEeT) (aturan refund lama) vs simetri aturan B: Ce = clamp(pEeT − annual(Gs), 0, C) saat basis skema dikirim; `proportional` dengan basis skema: Cr = clamp(pET − floor(annual(prior) × E/mix), 0, C)?
- Q3 Netting sisi perusahaan (5) vs S = Dr penuh + refund Cr.
- Q4 Monotonisitas titik tetap S = max(0, Dr(X(S)) − Cr).

## Test

- Referensi hitung tangan: `apps/api/src/test/payroll-pph21-overwithhold-reference.test.ts` (test-writer). Langkah hitung di komentar.
- Kasus: contoh bead (kedua kebijakan); H < 0, T ≥ 0 campuran (kedua kebijakan); H < 0, T < 0; satu skema (gross, net, gross-up) sama dengan lama; invarian dicek di tiap kasus.
- Regresi: semua `apps/api/src/test/payroll-pph21-*` dan `payroll-run-pph21-db.test.ts`.
- Jalankan: `LEGEND_TEST_FILES="src/test/<file> ..." pnpm test` dari root worktree.

## Keputusan architect (final, sudah diimplementasi di pph21.ts)

- Q1: aturan 6 (T < 0 ikut rumus baru). Q3: netting. Q4: monoton, loop tanpa gate T > 0.
- Q2: simetri aturan B. Mix ada + `gross_first`: Ce = clampC(pEeT − annual(Gs)), Cr = C − Ce. Mix ada + `proportional`: Cr = clampC(pET − floor(annual(prior) × E/mix)), Ce = C − Cr. Tanpa mix (kedua kebijakan): Cr = floor(C × pET/priorTax), Ce = C − Cr. annual(prior) = priorTax + H.
- Model Python architect: /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/d40e2095-9e42-418b-b8b4-2171af7d1f96/scratchpad/model.py (cek silang).

## Tugas test-writer putaran 2

1. Perbarui ekspektasi `apps/api/src/test/payroll-pph21-annual.test.ts` R36, R49, R50, R51, R74 ke aturan baru: hitung tangan di komentar, sebut "bead legend-u1xq" dan alasan berubah (kredit tiap pembayar dikurangi bagiannya atas D; garis net bulan ini milik perusahaan jadi borne masuk X). Tambah cek invarian baru. Jangan ubah judul makna kecuali perlu.
2. Tambah kasus di `payroll-pph21-overwithhold-reference.test.ts`: H < 0, T ≥ 0 campuran (kedua kebijakan, dengan dan tanpa basis skema); H < 0, T < 0 campuran (kedua kebijakan); cek invarian di tiap kasus.
