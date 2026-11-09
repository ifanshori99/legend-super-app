# Sub-brief: potongan PPh 21 karyawan tidak boleh melebihi gaji tersedia (bd legend-4ndx, P1, tingkat K)

Engine: `packages/shared/src/hris/payroll/pph21.ts` `computePph21Period`, HEAD 6e20273a (legend-mmgd, saldo pembayar tanpa clamp). Notasi: header pph21.ts dan `docs/briefs/sub-pph21-unclamped.md` (H, priorTax, pET, pEeT, E, Gs, mix, G*, X, T, D, De, Dr, W, A, B, employeeBalance, employerBalance).

## Bug (repro CTO, sudah direproduksi engineer)

TK/0 NPWP. Net 30 jt Jan–Jun, gross 5,4 jt Jul–Nov (TER 0%), Desember gross 1 jt, `proportional` (default).

| Engine          | X         | T          | W         | refund perusahaan | take-home  |
| --------------- | --------- | ---------- | --------- | ----------------- | ---------- |
| lama (21edd29b) | 1.000.000 | −8.707.026 | 150.000   | 8.857.026         | 850.000    |
| 6e20273a        | 1.000.000 | −8.707.026 | 2.486.089 | 11.193.115        | −1.486.089 |

`gross_first` tidak terdampak (W 150.000). Fuzz CTO: 394/12000 take-home negatif, engine lama 0. `netIdr` nonNegativeIdr (`payslips.ts:135`), jadi run Desember gagal.
Repro: `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/d40e2095-9e42-418b-b8b4-2171af7d1f96/scratchpad/r/sim.ts` (arg `s`) dan `fuzz.ts` di folder yang sama; jalankan dengan `<worktree>/apps/api/node_modules/.bin/tsx` dari folder itu. Engine "new" = worktree.

Akar: `proportional` dengan mix: employeeBalance = floor(annual(prior) × Gs/mix) − pEeT (rata-rata tarif setahun × basis gross karyawan). Di sini pEeT = 0 (TER 0%), jadi saldo karyawan ≈ +2,3 jt, jauh di atas gaji Desember 1 jt.

## Keputusan CTO (wajib)

Karyawan tidak pernah dipotong melebihi gaji tersedia. Kelebihan ditanggung perusahaan (mengurangi refund perusahaan). Setoran tetap T.

## Pertanyaan untuk architect

- Q1 Definisi "gaji tersedia" (cap W). Engine tahu: grossLines, u, n, allowance A, benefit (non-tunai), employeeDeductible (JHT+JP karyawan). Engine TIDAK tahu: BPJS Kesehatan karyawan, pinjaman, potongan lain. Usulan engineer: cap default = max(0, grossLines + u + n − employeeDeductible) (A saling hapus: masuk earnings dan withheld). Plus input opsional baru `employeeWithholdingCapIdr` (caller hitung, mis. kurangi BPJS Kesehatan) dipakai bila ada, min dengan default? Atau cukup default? Catatan: belum ada builder produksi `PayrollRunTaxEmployee` di luar test; `payslip-tax.ts` boleh diubah.
- Q2 Di mana cap masuk: kelebihan E = max(0, employeeNet − cap) pindah ke sisi perusahaan SEBELUM titik tetap covered (employerNet' = Dr + employerBalance + E, covered = max(0, ·)), supaya bila employerNet' ≥ 0 kelebihan jadi borne (masuk X, gross-up) dan bila < 0 hanya mengurangi refund perusahaan. Apakah borne yang masuk X mengubah T dan De (loop)? Usulan: cap dihitung terhadap employeeNet di titik tetap, monoton?
- Q3 Karyawan di bawah PTKP dipotong: diagnosis engineer: bukan akar legend-y2lf (y2lf soal skala annual(Gs) di `gross_first`). Ini sifat `proportional` = tarif rata-rata gabungan × basis karyawan, terlepas dari gross karyawan sendiri di bawah PTKP; `gross_first` sudah memberi 0 (annual(Gs) = 0). Konfirmasi atau bantah. Bila perlu perubahan aturan `proportional` (mis. saldo karyawan dibatasi annual(Gs + porsi Desember) − pEeT, atau dibatasi annual(prior) − annual(prior − Gs)), beri rumus dan dampaknya ke test lama; ini keputusan kebijakan, tandai bila butuh founder/konsultan (legend-8463 jangan diubah).
- Q4 Invarian baru: W ≤ cap; W + A + B − refundKaryawan − refundPerusahaan = T; refundPerusahaan ≥ 0; tidak ada pembayar yang dipotong dan direfund sekaligus. Apa lagi?
- Q5 Komentar pph21.ts:~488 ("BigInt division truncates toward 0: the employee keeps the rupiah") hanya benar untuk H < 0; usulkan teks.

Jawab dengan rumus final yang bisa langsung diimplementasi + 2 hitungan tangan (contoh CTO S2 kedua kebijakan, dan satu kasus T ≥ 0 di mana cap memaksa borne).

## Test (test-writer)

- Fuzz invarian baru: `apps/api/src/test/payroll-pph21-takehome-cap.test.ts`, setahun bulan demi bulan seperti sim.ts, kedua kebijakan, seed tetap: W ≤ cap; setoran = T; take-home ≥ 0; refund ≥ 0.
- Referensi hitung tangan menyusul setelah rumus architect final.
- Jalankan: `LEGEND_TEST_FILES="src/test/<file> ..." pnpm test` dari root worktree.

## Keputusan architect (final, sudah diimplementasi di pph21.ts + payslip-tax.ts)

- Q1: cap = min(max(0, grossLines + u + n − deductible), `employeeWithholdingCapIdr` bila diisi). Input caller hanya bisa menurunkan cap; isinya tunai tanpa tunjangan PPh dikurangi semua BPJS karyawan. Pinjaman tidak ikut (dipotong setelah PPh). `PayslipTaxInput` meneruskan field opsional.
- Q2: excess = max(0, De + bE − cap) masuk peta titik tetap: employerNet(X) = Dr + bR + excess. Monoton, kemiringan < 1. Excess selalu borne (A dihitung dari covered − excess, dibatasi ownNet = employerNet − excess). employerNet akhir < 0: excess hanya mengurangi refund perusahaan.
- Q3: bukan akar y2lf. `proportional` = tarif rata-rata gabungan × Gs, tanpa PTKP per skema. Aturan tidak diubah di bead ini; default kebijakan riwayat campuran = keputusan founder/konsultan, bead terpisah.
- Q4: W ≤ cap; excess > 0 → W = cap, refund karyawan 0; excess = 0 → identik dengan 6e20273a; dibanding 6e20273a: W tidak naik, refund perusahaan tidak naik, borne tidak turun, T tidak turun.
- Q5: komentar diganti.

Hitung tangan architect:

- S2 `proportional`: prior X 236.302.326, priorTax = pET = 29.302.326, Gs 27.000.000, E 209.302.326; aP 20.445.300, H −8.857.026, D 150.000, T −8.707.026; bR = floor(aP × E/mix) − pET = 18.109.211 − 29.302.326 = −11.193.115; bE 2.336.089; employee own 2.486.089, cap 1.000.000, excess 1.486.089; W 1.000.000; employerNet −9.707.026 → refund perusahaan 9.707.026, B 0, X 1.000.000; take-home 0.
- S2 `gross_first`: sama dengan HEAD (W 150.000, refund perusahaan 8.857.026).
- C2 (kedua kebijakan): TK/0, gross 10 jt Jan–Nov (TER 2%, priorTax 2.200.000), Desember gross 200.000. annual(110 jt) = 2.525.000, H = bE = 325.000, bR 0. Iterasi covered 0, 134.500, 140.850, 141.150, 141.200. X 341.200, annual 2.541.200, D 16.200, T 341.200, W 200.000, B 141.200, take-home 0. HEAD: W 334.500.

## Tugas test-writer putaran 2

1. Perbarui ekspektasi dengan hitung tangan di komentar, sebut "bead legend-4ndx" (W dibatasi gaji tersedia, kelebihan ditanggung perusahaan): `payroll-pph21-annual.test.ts` R63 (X = T = B = 5.646.900, W 0); `payroll-pph21-history-split-reference.test.ts` M1 (X 8.121.827, T = B = 121.827, W 0); `payroll-pph21-overwithhold-reference.test.ts` O6 `proportional` dengan basis skema (W 2.000.000, refund perusahaan 3.700.000, T −1.700.000). Verifikasi angka sendiri; perbaiki judul bila menyatakan aturan lama.
2. `payroll-pph21-takehome-cap.test.ts`: tambah angka tepat S2 (kedua kebijakan), C2, satu kasus `employeeWithholdingCapIdr` lebih kecil dari cap default (excess jadi borne, X naik), dan satu kasus caller cap lebih besar (diabaikan). Fuzz: tambah cek monoton vs tanpa cap tidak perlu; cek `employeeWithholdingCapIdr` acak ≤ default.
3. Jalankan semua `apps/api/src/test/payroll-pph21-*` (bukan db) dan laporkan.

## Review putaran 1: clawback bulan TER (reviewer Opus + architect, sudah diimplementasi)

Temuan: excess yang jadi borne di bulan TER ditarik balik ke karyawan di Desember, karena `grossSchemeBaseIdr` tetap menghitung basis itu sebagai skema karyawan dan borne masuk `priorEmployerTax`. Skenario K1: TK/0 NPWP, Januari hanya benefit 8 jt kontrak `gross` (cap 0: B 121.827, X 8.121.827), Februari–Desember gross 10 jt. Desember sebelum perbaikan: `proportional` W 908.006, refund perusahaan 119.083; `gross_first` W 905.000, refund perusahaan 116.077.

Perbaikan (varian C architect): hasil periode punya `pph21CapExcessIdr` = min(excess, borne) bila employerNet ≥ 0, selain itu 0. Prior punya `pph21CapExcessIdr` (opsional, default 0, ≤ prior borne). `priorEmployerTax = priorBorne − priorCapExcess + priorAllowance`: excess dihitung sebagai pajak karyawan yang sudah dibayar. `payslipTaxSchema` field opsional (≤ borne), `computePayslipTax` memetakannya, `buildPph21Prior` menjumlahkannya.

Angka K1 setelah perbaikan (architect): `proportional` Desember X 10.000.962, T 788.973, W 788.011, B 962, refund perusahaan 0; `gross_first` Desember X 10.004.123, T 789.123, W 785.000, B 4.123, refund 0.

## Tugas test-writer putaran 3

1. `payroll-pph21-takehome-cap.test.ts`: tambah K1 kedua kebijakan (Januari dan Desember, angka tepat, verifikasi sendiri; Januari: excess = `pph21CapExcessIdr`). Fuzz: akumulasi `pph21CapExcessIdr` ke prior; tambah bulan Jan–Nov dengan benefit > 0 dan sebagian bulan tanpa gaji (cap di bulan TER); cek invarian di tiap bulan (bukan hanya Desember) dan `pph21CapExcessIdr ≤ borne`. Perbaiki komentar header file yang menyebut cap hanya di periode terakhir.
2. Test `buildPph21Prior` (file test payslip-tax/prior yang ada): menjumlahkan `pph21CapExcessIdr`, absen = 0, menolak bila > borne. `payslipTaxSchema` menolak cap excess > borne.
3. Jalankan semua `apps/api/src/test/payroll-pph21-*` dan file yang kamu ubah.
