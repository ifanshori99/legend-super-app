# 938 Laporan loyalty: metrik active_members + points_redeemed (legend-eqdcd, kartu S)
Peran: engineer Codex (baca ~/.agents/team/roles/engineer.md). Effort medium. TANPA migrasi; tanpa ubah nilai poin atau aturan tukar.
Cabang: worktree-mu dari `milestone/m1` (c17c60df7); commit dan push tanpa force. Tidak merge, tidak deploy.
Kartu: `bd show legend-eqdcd`. `apps/api/src/services/metric-sources/loyalty-crm.ts:239-240` masih `unavailable(...)`. Isi `active_members`, dan `points_redeemed` sejauh bisa dihitung dari data yang ada tanpa migrasi; bila outlet/tanggal tukar tidak ada di baris, biarkan dimensi itu `unavailable` dengan alasan jelas dan buat kartu lanjutan (jangan migrasi). Patuhi guard `metric-single-path` (jangan baca journal_lines di luar allowlist) dan filter tenant di SQL.
Paralel: Explore sumber data loyalty, test-writer gagal-dulu, implementer, test-runner, satu reviewer. Batas 1 tsc bila free < 60%.
Bukti: `ms-loyalty-crm.test.ts` + test kontrak pemindai (`*-single-path*`, `*registry*`) lewat heavy setelah commit terakhir, prettier, eslint, typecheck api sekali.
Laporan: cabang, SHA, test, temuan reviewer, angka subagent. Komentari kartu. Lapor sekali saat selesai.
