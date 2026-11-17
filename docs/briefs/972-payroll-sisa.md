# 972 Payroll sisa (brief engineer)

Cabang: ghostex/dd932307 (dari 955 c6ab51bbc). Migrasi baru nomor 0515-0519. Bahasa kode/komentar: ikuti file sekitar.

## Kartu
- **legend-bckn9**: `apps/api/src/services/payroll-loans.service.ts` (~baris 504) tolak pencairan pinjaman bila offboarding karyawan `completed` (409 kode jelas). Test balapan: simulate lawan complete offboarding, dua transaksi bersamaan; akhir: tidak ada potongan ganda, tidak ada tagihan kurang. Lihat 955 (commit 67d26efc7 guard offboarding, 15344ad49 skip di simulate).
- **legend-51h1**: jurnal payroll untuk refund PPh21 perusahaan saat withheld > T. Utang PPh21 = withheld + borne - refund karyawan - refund perusahaan (= pph21Idr). Aturan di `packages/shared/src/accounting/posting-rules.ts`. Jurnal seimbang, idempoten per run. Totals run (`payslips.ts` payrollRunTotalsSchema) belum punya kolom refund/borne.
- **legend-itph**: open item piutang PPh21 per karyawan (party `employee`, migrasi CHECK), ditautkan dari slip `tax.pph21ReceivableIdr` (akun 1204, penagihan baris pph21_receivable); sisa piutang karyawan keluar tampil untuk finance. Write-off TIDAK dikerjakan (legend-45lm).

## Bukti wajib (jangan sampai rugi)
1. Tidak ada uang pinjaman keluar ke karyawan yang offboarding-nya selesai.
2. Jurnal PPh21 seimbang; utang PPh21 tidak lebih kecil dari yang harus disetor.
3. Piutang karyawan tidak ganda saat run di-simulate ulang atau di-reverse.
4. Open item hanya terlihat di tenant sendiri (filter SQL + RLS).
Ragu: tolak pembayaran.

## Jangan sentuh
apps/web, payout gaji 947, refund/recon 967, services/ai-*, DOIT, Duitku.

## Aturan
- Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree. Satu token heavy per thread: hanya satu subagent menjalankan tsc/vitest.
- FK tabel baru inline di CREATE TABLE; tabel baru diakui di `data-import-registry.test.ts` dan tes cakupan tabel.
- Tipe brand: pakai helper bertipe.
- Jangan commit; engineer utama yang commit.
