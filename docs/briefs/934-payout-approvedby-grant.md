# 934 Payout: persetujuan utama batch lewat grant + log (legend-xp8mc)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Uang + akses: architect xhigh. Spawn paralel dalam satu giliran (Explore, test-writer gagal-dulu, implementer, test-runner, architect). Lapor sekali; tunggu job latar dengan Monitor. Typecheck penuh sekali sebelum lapor.
Cabang: worktree-mu dari `milestone/m1` (c17c60df7); commit dan push tanpa force. Migrasi sementara mulai 0432. Tidak merge, tidak deploy.
Kartu: `bd show legend-xp8mc`. Pola yang sudah ada (911-923): grant sekali pakai via `legend_payout_grantor` (sha256, 2 menit, terikat operasi), log append-only `payroll_payout_approval_log`, notifikasi ke penyetuju asli, "Bukan saya" membekukan batch.
Arah CTO: persetujuan utama batch (approvedBy) wajib grant step-up sekali pakai dan menulis baris log persetujuan yang sama, sehingga notifikasi + "Bukan saya" berlaku juga untuk persetujuan utama. Aturan dua orang tetap. Tanpa grant ditolak. Jangan ubah aturan uang lain.
Bukti: test gagal-dulu lalu hijau (tanpa grant ditolak, grant dipakai ulang ditolak, log tertulis, bukan-saya pada persetujuan utama membekukan), test payout lewat heavy setelah commit terakhir, migrator non-superuser, pra-gate AGENTS.md, architect xhigh tanpa P1.
Laporan: SHA, migrasi, test, temuan architect, angka subagent. Komentari kartu.
