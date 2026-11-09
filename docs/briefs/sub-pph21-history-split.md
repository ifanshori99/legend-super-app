# Sub-brief: PPh 21 history split (bd legend-6q7o + legend-6p71, tingkat K)

Engine: packages/shared/src/hris/payroll/pph21.ts `computePph21Period`.
Notasi: H = history shortfall = annual tax on prior income alone − priorTax (last period only; 0 in TER months).
priorTax = prior withheld + prior borne. E / Gs = prior employer / gross scheme base, mix = E + Gs.
pET = prior employer tax, G* = this period's employee (gross-scheme) part of G+U+N (`employeeG`), X = taxable gross.

## Bug yang harus direproduksi (angka referensi dihitung tangan, TK/0 NPWP, kedua kebijakan bila relevan)

1. (6q7o a) `proportional`: kekurangan Jan–Nov mengikuti campuran skema Desember. Gross-up 8 jt Jan–Nov (TER), Desember gross 8 jt: karyawan bayar Rp583.553 (salah), gross_first Rp380.000.
2. (6q7o b) Periode terakhir tanpa pembayaran (semua baris 0, X awal 0): karyawan murni gross-up menanggung seluruh kekurangan (Rp203.553) di kedua kebijakan.
3. (6q7o c) Riwayat net TER 0% lalu bulan gross berpajak: basis skema diabaikan begitu ada pajak dibayar → pajak bulan net dibebankan ke karyawan.
4. (6p71, Codex) Jan net 20 jt (X 21.978.022, borne 1.978.022), Feb gross 10 jt (withheld 200.000), keluar Mar gross 1 jt, monthsWorked 3, `taxAllowanceIdr` tidak dikirim tapi basis skema dikirim: refund karyawan/perusahaan 681.100/1.496.922. Setelah fix: tanpa allowance → RangeError (aturan A); dengan `taxAllowanceIdr: 0` → 200.000/1.978.022.

## Aturan baru

A. pET = priorBorne + (priorAllowance ?? 0), eksak. Rasio basis TIDAK lagi dipakai untuk pET.
mix > 0 dan mix ≠ prior.taxableGrossIdr → RangeError (hanya satu basis dikirim).
`prior.taxAllowanceIdr` wajib (RangeError bila tidak ada) saat priorWithheld > 0 dan E > 0 (withheld bisa berisi tunjangan gross-up yang tak bisa dibedakan).
B. Pembagi H (H > 0), bagian perusahaan employerHistory:

- mix > 0, `gross_first`: employeeHistory = clamp(annual(Gs) − pEeT, 0, H), pEeT = priorTax − pET; annual(Gs) = pajak Pasal 17 atas Gs saja (biaya jabatan, cap, pengurang, PTKP, faktor sama). Saran architect: rasio basis di gross_first membuat kasus gross 5 jt + gross-up 5 jt lebih buruk (W 237.500 → 350.781).
- mix > 0, `proportional`: clamp(floor((H + priorTax) × E / mix) − pET, 0, H) (pajak tahunan atas penghasilan lalu dibagi per basis skema, dikurangi yang sudah dibayar perusahaan)
- selain itu priorTax > 0: floor(H × pET / priorTax)
- selain itu basis bulan ini > 0: floor(H × (G+U+N − G*) / (G+U+N))
  employeeHistory = H − employerHistory.
  C. `proportional`, H > 0: W = employeeHistory + floor((T − H) × G* / X). H ≤ 0: tetap floor(T × G* / X).
  D. X = 0 (tak ada pembayaran periode ini), H > 0: W = min(employeeHistory, T) di kedua kebijakan (perusahaan menanggung bagiannya sebagai borne; borne masuk X lalu iterasi titik tetap seperti biasa).
  E. `gross_first`: rumus tetap (pajak tambahan G* di atas penghasilan lalu + employeeHistory), memakai employeeHistory baru.
  F. Di luar scope (architect: bead terpisah, tingkat K): H < 0 (kelebihan bayar Jan–Nov) dengan T ≥ 0 — kredit milik perusahaan saat ini mengurangi pajak karyawan.

## Invarian

- Riwayat murni gross-up/net: karyawan tidak pernah menanggung H; riwayat murni gross: perusahaan tidak menanggung H.
- W ≤ T, A + B + W = T, take-home = G+U+N − W.
- Kasus lama tanpa basis skema dan tanpa allowance (suite annual/ter) tidak berubah kecuali yang memang terkena aturan C.

## File

- Engine: pph21.ts (engineer).
- Test reproduksi engineer: apps/api/src/test/payroll-pph21-history-split.test.ts.
- Test referensi hitung tangan (test-writer): apps/api/src/test/payroll-pph21-history-split-reference.test.ts.
- legend-wtpf (pembulatan biaya jabatan): hanya bila sumber DJP pasti.

## Test terarah

`LEGEND_TEST_FILES="src/test/payroll-pph21-history-split.test.ts src/test/payroll-pph21-history-split-reference.test.ts src/test/payroll-pph21-annual.test.ts src/test/payroll-pph21-ter.test.ts src/test/payroll-pph21-prior.test.ts src/test/payroll-pph21-prior-reference.test.ts src/test/payroll-run-pph21-db.test.ts src/test/payroll-pph21-guards.test.ts" pnpm test`

## legend-m9gx (keputusan CTO 2026-11-09)

Bulan tanpa baris gaji kena pajak tetapi ada BPJS perusahaan (`employerBenefitIdr` > 0) mengikuti skema perjanjian kerja yang berlaku di bulan itu (skema pajak = atribut perjanjian kerja).

- Input baru `contractTaxScheme` di `Pph21PeriodInput` dan `PayslipTaxInput`. Wajib (RangeError) bila benefit > 0 dan jumlah baris kena pajak 0 (tidak ada baris, atau semua bernilai 0); diabaikan bila ada baris bernilai.
- `gross`: seperti sebelumnya. G* = benefit, karyawan menanggung pajaknya.
- `gross_up`: G* = 0, pajak perusahaan menjadi tunjangan (allowance).
- `net`: G* = 0, pajak perusahaan menjadi borne.
- Basis tersimpan mengikuti G*: `grossSchemeBaseIdr` = G*, `employerSchemeBaseIdr` = X − G*.
- Repro reviewer: TK/0 tanpa NPWP, `noTaxIdSurcharge: "annual_only"`, proportional. Jan tanpa baris, benefit 3.000.000 (kontrak gross_up). Feb–Nov gross_up 20.000.000. Des gross_up 20.000.000, alur `computePayslipTax` → `buildPph21Prior`. Sebelum: T 7.154.260, W 297.609. Sesudah: W 0 (bagian karyawan atas H = 0).
- Belum ada kolom skema pajak di `employment_contracts`. Sumber data untuk run service (legend-07eg) dilaporkan ke CTO.
