# 502 Lanjutan WS-D (G1jk7): keputusan M1/L1/L2 + temuan 501 no.1-3

Cabang: ws/hris-leave-guard (lanjut dari a9a04b67). Migrasi sementara: 0321-0323 (0320 sudah dipakai). Tingkat K (uang + akses + data pribadi): architect effort xhigh di akhir.

## Keputusan CTO (aturan "ragu = batasi pembayaran")
- L1: hari cuti bersama DIPOTONG bila clock-in hanya flagged/belum direview. Hanya clock-in `in` yang valid atau sudah diterima yang membatalkan potongan.
- M1: bila clock-in valid/diterima muncul belakangan (koreksi, sinkron offline, review flagged diterima), potongan hari itu DIKEMBALIKAN lewat baris ledger pembalik (bukan hapus). Idempoten: tidak boleh balik dua kali.
- Test wajib: saldo cuti tidak pernah lebih besar dari hak; settlement (`hris-settlement.service.ts`) tidak membayar hari yang belum diterima; balik ganda ditolak.
- L2: buat kartu bd P3 "guard cuti FOR SHARE pada run payroll yang tumpang tindih saat fitur kunci run ada". Jangan dikerjakan.

## Temuan 501 no.1-3 (detail: docs/briefs/501-findings-fixes.md)
1. P1 supervisor hanya melihat bawahannya (rantai supervisor) di antrean koreksi manual + selfie. Test supervisor A vs B di outlet sama.
2. P1 lookup cuti mengecualikan excluded_holiday_dates (lookup + penandaan). Test clock-in sebelum/sesudah persetujuan.
3. P2 urutan lock seragam: karyawan dulu, lalu baris pengajuan, di semua jalur. Test konkuren approve vs cancel.

## Cara kerja
- Spawn sekaligus: test-writer per butir (fail-first), implementer per butir (file terpisah), lalu reviewer + architect xhigh.
- Test HRIS dijalankan per berkas (run gabungan gagal palsu).
- Commit TANPA `core.hooksPath=/dev/null`; hook beads harus jalan. Jalankan ekspor/sinkron bd untuk commit a9a04b67 yang melewatinya.
- Kartu 0c5yg, qmte, j06v, 5nv1: jangan ditutup; ditutup setelah merge ke m1.
- Laporan: bukti gagal-dulu per butir, angka subagent, temuan architect.
