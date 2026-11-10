# Brief: engineer (Sonnet) — dua kartu kecil berurutan

Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Aturan bersama (basis, test, bukti, review, kartu, laporan): bagian "Bersama" di `docs/briefs/304-wave2-loyalty.md`. Basis `milestone/m1` 7d388b02. Satu worktree `.worktrees/small-305`; cabang pertama `ws/ia54l-claim-after-close`, sesudah selesai dan commit, cabang kedua `ws/arj6-auto-clearance` dari m1 di worktree yang sama (`git switch -c`).

## 1. `legend-ia54l` (tingkat S)
Founder Q75: kode klaim poin split bill tampil di struk dan bisa dibuka dari HP tamu selama 24 jam walau meja sudah ditutup. Sekarang `GET /api/table-sessions/:sessionId/splits/:splitId/claim` hanya saat sesi meja terbuka. Tambah baca terbatas berbasis token bagian itu (tanpa data tamu lain, tanpa data order lain), berlaku sampai `claimableUntil`, rate limit seperti route tamu lain. Tanpa migrasi bila bisa. Test: bisa dibaca sesudah meja ditutup dalam 24 jam; ditolak sesudah 24 jam, sesudah dipakai, sesudah order di-void, dan untuk bagian orang lain.

## 2. `legend-arj.6` (tingkat K: akses)
Exit clearance otomatis sesudah hari kerja terakhir. Job worker harian memanggil service clearance yang sudah ada (`legend-ovxw`, di m1) untuk offboarding yang tanggal keluarnya sudah lewat dan aksesnya belum dicabut. Idempoten, satu transaksi per karyawan, error satu karyawan tidak menghentikan yang lain, tercatat di audit sebagai sistem. Pola job: lihat job harian lain di `apps/api/src/worker/`. Migrasi bila perlu `0213`, `when` 1794292000000. Test gagal-dulu: karyawan lewat tanggal keluar dicabut sekali walau job jalan dua kali; karyawan belum lewat tidak tersentuh; isolasi tenant.
