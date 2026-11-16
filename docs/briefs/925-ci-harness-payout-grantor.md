# 925 Harness CI: grantor payout di Lighthouse + flake 915-withdraw (kartu S)
Peran: engineer Codex (baca ~/.agents/team/roles/engineer.md). Effort medium. Tanpa ubah logika uang/akses dan tanpa migrasi.
Cabang: worktree-mu dari `milestone/m1` (7b7cc52df); commit dan push tanpa force. Tidak merge, tidak deploy.
Kartu:
- legend-kj50i (P2): Lighthouse CI harness belum menyediakan login grantor payout terisolasi (`PAYOUT_GRANTOR_DATABASE_URL`, role `legend_payout_grantor`); samakan dengan cara harness test/e2e (lihat commit merge train batch77 3ef964f63 dan sekitarnya). Jangan cetak nilai rahasia.
- legend-61umg (P3): flake setup fixture `payroll-payout-915-withdraw*`: 409 PAYOUT_BATCH_STATE sesekali. Reproduksi dulu (ulang file 10x lewat heavy), cari akar (urutan/tunggu fixture, bukan longgarkan assertion), perbaiki di test.
Paralel: satu subagent per kartu, test-runner untuk ulang, satu reviewer atas diff.
Bukti: harness Lighthouse jalan sampai grantor terbaca (atau langkah setara yang bisa dijalankan lokal lewat heavy --browser); file flake hijau 10/10; prettier, eslint pada file berubah.
Laporan: cabang, SHA, bukti, angka subagent. Komentari kedua kartu. Lapor sekali saat selesai.
