# Second opinion payout 934+947

Tanggal: 17 November 2026. Brief: `docs/briefs/950-second-opinion-payout-934-947.md`.

Rentang yang diperiksa: `c17c60df7ca80f4dc4af8de06faae4e43d40ac80..aca164ca5f0c7edaf9ae8dfbe0061a8039625376` (`origin/ghostex/947-payout-934-followups`, termasuk 934). Semua nomor baris di bawah merujuk tip tersebut, bukan isi cabang checkout utama.

## Temuan

P0: 0; P1: 0; P2: 1; P3: 0. Temuan berdasarkan penelusuran statis, belum direproduksi di PostgreSQL.

- **P2 — `apps/api/drizzle/0433_payout_934_followups.sql:855` — Grant persetujuan yang kedaluwarsa selama menunggu lock tetap diterima pada jalur SQL langsung.** Fungsi baru `app.payout_batch_approve_attest` memakai consumer yang menangkap waktu sebelum lock, lalu memeriksa expiry terhadap waktu lama tersebut. Skenario: koneksi A menahan lock run; koneksi B sebagai `legend_app`, dengan tenant, sesi penyetuju lain dan secret grant `batch_approve` yang sah, memanggil attest sesaat sebelum expiry; A melepas lock setelah expiry. B tetap mengonsumsi grant, menulis log dan dapat mengubah batch menjadi approved dalam transaksi yang sama. Perbaikan: lewat migrasi baru, ambil waktu validasi setelah memperoleh lock run/batch dan grant, tepat sebelum consume; jangan mengubah migrasi yang sudah diterapkan. Usul test: dua koneksi, tahan lock melewati expiry, lalu wajib `PAYOUT-70`, grant tetap unspent, batch tetap pending, tanpa log persetujuan, item approved atau dana keluar. Tindak lanjut: `legend-628t9`.

### Bukti dan batas dampak

- `apps/api/drizzle/0428_payout_batch_freeze_guards.sql:210` mengambil `v_now := clock_timestamp()` sebelum pemanggilan `payout_batch_assert_open` pada baris 223. Fungsi itu mengambil lock run melalui `apps/api/drizzle/0429_payout_freeze_run_lock.sql:67`; lock `FOR UPDATE` ada pada baris 50, kemudian lock batch pada baris 71.
- Sesudah menunggu, consumer memakai `g.expires_at > v_now` pada `apps/api/drizzle/0428_payout_batch_freeze_guards.sql:231` dan menyimpan `consumed_at = v_now` pada baris 226. Waktu konsumsi ikut tercatat sebelum penantian. Guard persetujuan baru memeriksa grant yang dikonsumsi dalam transaksi yang sama (`apps/api/drizzle/0432_payout_batch_approve_grant.sql:284` dan `apps/api/drizzle/0433_payout_934_followups.sql:1065`), sehingga tidak membatalkan kelolosan expiry ini.
- Jalur service biasa mengambil lock run sebelum attest (`apps/api/src/services/payroll-payout.service.ts:1625`, pemanggilan attest pada baris 1695). Skenario temuan memakai batas SQL yang memang dilindungi trigger dalam diff; ini bukan bukti bahwa endpoint approval biasa menerima grant kedaluwarsa.
- Secret grant yang sah dan sesi penyetuju yang tetap berizin masih diperlukan. Temuan tidak membuktikan self-approval, kebocoran tenant atau pembayaran ganda; yang dilanggar adalah batas waktu step-up dua menit pada persetujuan utama baru.

## Pemeriksaan lainnya

- Tidak menemukan skenario gagal konkret tambahan pada pemisahan pemohon/penyetuju, larangan semua penyangkal menyetujui ulang, binding grant ke tenant/batch, replay grant, perubahan kolom persetujuan pada status halted, ownership/ACL fungsi, atau pelemahan RLS/FORCE oleh kedua migrasi.
- Cash sebagian: `apps/api/drizzle/0433_payout_934_followups.sql:1024` mempertahankan item yang sudah dibayar, menghentikan item approved menjadi not_sent dan menutup batch partially_failed. Pemilihan retry mengecualikan slip yang masih memiliki item succeeded (`apps/api/src/services/payroll-payout.service.ts:1228`). Tidak menemukan jalur bayar ganda konkret pada alur ini.
- Test pelengkap yang disarankan untuk fokus cash baru: lanjutkan kasus `apps/api/src/test/payroll-payout-947-unfreeze-reapprove.test.ts:598` sampai membuat dan membayar batch retry. Pastikan hanya slip not_sent yang terpilih, tiap slip mempunyai tepat satu pembayaran berhasil, total pembayaran sama dengan hak gaji, dan jurnal kas/bank tidak berlebih. Ini tambahan bukti, bukan temuan bug.
- Snapshot 0432 berantai ke 0431 dan hanya mengubah tiga CHECK kind; snapshot 0433 berantai ke 0432 tanpa perubahan skema tabel. Registry journal memuat kedua nomor dan timestamp berurutan. Kedua migrasi tidak mematikan RLS/FORCE.

## Verifikasi dan hasil kerja

- Pemeriksaan memakai `git diff`, `git show` pada ref yang dibekukan, penelusuran service/trigger/test terkait, serta pembandingan JSON snapshot dan journal. Tiga subagent native Codex, puncak tiga bersamaan; hasil digabung dan lokasi utama diperiksa ulang.
- Prettier 3.9.6 melalui binary paket lokal, pemeriksaan whitespace laporan, dan validasi 10 rujukan berkas/baris pada tip yang dibekukan lulus. Shim `pnpm exec prettier` tidak menemukan modul; binary versi yang sama di `node_modules/.pnpm` tersedia dan dipakai tanpa mengubah dependensi.
- Hanya laporan ini yang ditulis. Tidak checkout, membuat worktree, mengubah implementasi, commit, push, merge atau deploy. Kartu review: `legend-2k7np`; kartu perbaikan P2 tetap terbuka.
- Tidak menjalankan test, reproduksi database, migrasi, typecheck, build, atau layanan development. Klaim cash dan guard lainnya sebatas review statis; bukan pengganti gate uang dan test anti bayar ganda.
- Helper `session-usage.py` tidak menemukan transkrip sesi native Codex; `parallel-report` hanya memuat sesi Claude. Biaya/token dan rata-rata paralel native tidak tersedia; tidak diperkirakan.
