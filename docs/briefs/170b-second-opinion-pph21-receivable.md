# Brief 170b: second opinion PPh 21 piutang karyawan (Codex, tingkat K)

## Peran

Second-opinion. Baca saja, jangan ubah file repo. Tulis hasil ke `docs/briefs/170b-second-opinion-pph21-receivable.result.md` di folder utama.

## Lokasi dan diff

- Worktree: `.worktrees/pph21-overwithhold`, cabang `ws/pph21-overwithhold`.
- Diff yang diperiksa HANYA: `git diff 1535d4d8..7b486d73` (2 commit: 4fa8159d, 7b486d73). Perubahan sebelum 1535d4d8 sudah diperiksa di brief 156.

## Keputusan founder B8 (spesifikasi, mengikat)

Kekurangan potongan PPh 21 karyawan dicatat sebagai PIUTANG KARYAWAN, bukan beban perusahaan. Setoran ke negara tetap = T. Tidak ada gross-up atas kekurangan ini. Berlaku untuk kelebihan di atas batas gaji tersedia (bulan TER dan Desember) dan karyawan keluar/Desember tanpa gaji. Penagihan: dipotong dari gaji berikutnya sampai batas gaji tersedia; sisa saat karyawan keluar tetap piutang terbuka untuk finance. Default alokasi riwayat campuran (`proportional` vs `gross_first`) TIDAK diubah.

Batas gaji tersedia (cap) = tunai tanpa tunjangan PPh - semua BPJS karyawan - potongan pra-net non-pinjaman (legend-xzid).

## Yang diubah (ringkas)

- `packages/shared/src/hris/payroll/pph21.ts`: field `prior.pph21ReceivableIdr` dan hasil `pph21ReceivableIdr`; potongan karyawan dibatasi cap, sisanya piutang.
- `payslip-tax.ts` (`buildPph21Prior`, `payslipWithholdingCap`), `payslips.ts` (skema tax, identitas slip, totals run), `pph21-receivable.ts` (saldo dan rencana penagihan), `fixtures.ts` (`calculate()`), `components.ts`.
- Akuntansi: `coa.ts` (role `employee_receivable`, akun 1204), `posting-rules.ts` (`payroll_run.completed`), `accounting/fixtures.ts`.
- Test: `apps/api/src/test/payroll-pph21-*.test.ts`, `accounting-payroll-receivable.test.ts`.

## Pertanyaan

1. Apakah setoran selalu = T, potongan karyawan selalu 0 sampai cap, take-home tidak pernah negatif, dan piutang = bagian karyawan di atas cap tanpa gross-up? Cari contoh balik dengan angka Rupiah.
2. Rekalkulasi Desember: apakah piutang bulan sebelumnya dihitung benar sebagai pajak yang sudah dibayar karyawan (tidak dipungut dua kali, tidak hilang)? Termasuk karyawan keluar dan Desember tanpa gaji.
3. Laporan 156 run 3 (legend-6ajk, `156-second-opinion-pph21-overwithhold.result3.md`): apakah masalah ambang PKP masih bisa terjadi? Apakah ada jalur lain yang menaikkan W atau X karena piutang?
4. Penagihan: urutan BPJS karyawan, PPh 21, LATE, penagihan piutang, pinjaman; piutang baru tidak ditagih di slip yang sama; refund PPh 21 menetting piutang terbuka. Ada kasus yang salah?
5. Jurnal: apakah baris piutang di `payroll_run.completed` seimbang dan benar arahnya? Apakah totals run memetakan kunci yang sama?
6. Apakah ada data atau API lama yang rusak karena field `pph21CapExcessIdr` diganti?

## Cara cek

- `LEGEND_TEST_FILES="src/test/payroll-pph21-receivable.test.ts src/test/payroll-pph21-takehome-cap.test.ts" pnpm test` dari root worktree.
- Model independen boleh ditulis di folder sementara; jalankan dengan `apps/api/node_modules/.bin/tsx`.

## Format hasil

Per temuan: file:baris, tingkat (blocker/major/minor), skenario Rupiah konkret, saran perbaikan. Tanpa temuan: tulis "tidak ada temuan" plus apa yang dicek.
