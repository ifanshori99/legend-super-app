# 915 Payout grant: lanjutan sebelum rilis (legend-786te, legend-xatux, legend-7gghu)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Uang + akses: architect xhigh. Spawn subagent paralel dalam satu giliran (Explore, test-writer gagal-dulu, satu implementer per kartu, test-runner, architect).
Cabang: worktree-mu dari `ghostex/911-payout-905-perbaikan-p1-p2` (3cfecb901); commit dan push tanpa force. Migrasi sementara mulai 0658. Tidak merge, tidak deploy.
Keputusan CTO:
- legend-786te: `PAYOUT_GRANTOR_DATABASE_URL` WAJIB di semua profil deploy production (validasi env gagal start bila kosong; doctor/deploy doc diperbarui). Dev/test tetap boleh SET LOCAL ROLE.
- legend-xatux: rute batal proposal koreksi/overpaid yang masih terbuka (API + tombol di UI yang sudah ada), lewat fungsi tepercaya + grant step-up; batal tidak melepas hold closure. Teks UI baru masuk katalog text-contract.
- legend-7gghu (pemalsuan baris sesi oleh `legend_app`): diterima sebagai sisa untuk rilis (butuh kompromi peran DB aplikasi), DENGAN deteksi: tiap grant yang dipakai untuk persetujuan payout dicatat append-only di tabel milik `legend_payout`, dan penyetuju asli mendapat notifikasi di luar sesi itu (notifikasi in-app + email/WA lewat outbox yang ada) "Anda menyetujui <batch/nominal>". Penyetuju bisa menandai "bukan saya" yang membekukan batch. Desain detail dari architect; bila terlalu besar, kerjakan pencatatan + notifikasi, catat pembekuan sebagai kartu.
Bukti: test gagal-dulu lalu hijau per kartu, test payout lewat heavy setelah commit terakhir, migrator non-superuser, pra-gate AGENTS.md (prettier, eslint, text-contract, typecheck api+web), architect xhigh tanpa P1.
Laporan: SHA, rentang migrasi, hasil test, temuan architect, angka subagent. Komentari kartu.
