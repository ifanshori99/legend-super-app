# 963 Infra test: PostgreSQL test putus karena memori VM Colima (kartu S)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Codex gpt-6.1-sol effort high. Codex tidak menjalankan bd: CTO yang memindah kartu.
Cabang: worktree-mu dari `origin/milestone/m1` (0c31ff40e). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Tanpa migrasi, tanpa kode produk.
Kartu legend-3id81. Temuan CTO (lihat `bd show legend-3id81` komentar): VM Colima 2898 MB tanpa swap; dua container pg-test (limit 1,5 GiB) untuk 2 jalur test ringan melebihi VM; container dev DB worktree yang sudah dihapus tetap jalan berhari-hari.
Kerjakan di repo: (1) turunkan limit memori dan setelan Postgres container test (shared_buffers, work_mem, max_connections) supaya dua jalur bersamaan muat di bawah ~2,4 GB total, tanpa memperlambat suite secara nyata; (2) skrip penghapus worktree di repo (cari `worktree:` di package.json dan scripts/) ikut menjalankan `docker compose down` (tanpa `-v`) untuk project compose worktree itu; (3) catat di `docs/local-development.md`.
Jangan menghapus volume Docker, jangan restart Colima, jangan stop container milik worktree yang masih ada.
Bukti: dua run terarah API bersamaan lewat `heavy` (dua berkas test DB berbeda) hijau tanpa "Connection terminated"; catat `docker stats --no-stream` puncak tiap container pg-test; test kontrak root yang menyentuh skrip hijau; prettier dan eslint pada berkas berubah.
Laporan: SHA, berkas, angka memori sebelum/sesudah, hasil run, angka subagent. Lapor sekali di akhir.
