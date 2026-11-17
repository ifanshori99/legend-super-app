# 972 Payroll sisa: pencairan pinjaman karyawan keluar, jurnal refund PPh21, open item piutang PPh21
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang, migrasi).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/1a1b16fe` (c6ab51bbc, 955; belum di m1). Langkah pertama `heavy pnpm worktree:setup` (antrean heavy bisa padat: selama antre, baca kode dan tulis test). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0515-0519 (nomor kerja).

Kartu (`bd show <id>`; claim dulu):
- legend-bckn9: `payroll-loans.service.ts:504` menolak pencairan pinjaman bila offboarding karyawan `completed` (409 kode jelas). Tambah test balapan simulate lawan complete offboarding (dua transaksi bersamaan: hasil akhirnya tidak ada potongan ganda dan tidak ada tagihan kurang).
- legend-51h1: jurnal payroll untuk refund PPh21 perusahaan saat withheld > T (lebih potong Jan-Nov). Utang PPh21 = withheld + borne - refund karyawan - refund perusahaan (= pph21Idr). Aturan di `packages/shared/src/accounting/posting-rules.ts`. Jurnal seimbang, idempoten per run.
- legend-itph: open item piutang PPh21 per karyawan (party `employee`, migrasi CHECK), ditautkan dari slip `tax.pph21ReceivableIdr`; sisa piutang karyawan keluar tampil untuk finance. Penghapusan/write-off TIDAK dikerjakan (legend-45lm menunggu konsultan pajak).

Jangan sampai rugi: test bukti (1) tidak ada uang pinjaman keluar ke karyawan yang offboarding-nya selesai, (2) jurnal PPh21 seimbang dan utang PPh21 tidak lebih kecil dari yang harus disetor, (3) piutang karyawan tidak tercatat ganda saat run di-simulate ulang atau di-reverse, (4) open item hanya terlihat di tenant sendiri (filter SQL + RLS). Bila ragu: tolak pembayaran.

Jangan sentuh: `apps/web` (kartu UI legend-10tqi terpisah), payout/pencairan gaji 947 (founder Q22: aturan tetap), refund/recon (967), `services/ai-*` (964), DOIT (965), Duitku (969).

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect xhigh bersamaan. Gate (TEAM #9, bukan pnpm check penuh): lint, typecheck API (+web bila shared berubah), test terarah grup payroll/hris/accounting/open-items, `db:generate` kosong, prettier. Satu token heavy per thread (#14).

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
