# 784 Edge: applier + classifier down-sync master data (legend-3x9l)
Peran: engineer (Codex, kartu S, backend tanpa uang). Effort high. Basis: worktree dari origin/milestone/m1 (sudah berisi batch 64d).
Langkah 0 (Explore paralel): `bd show legend-3x9l` dan legend-97p; apakah setEdgeEventApplier cloud_to_edge dan setEdgeEventClassifier master_data sudah terpasang di m1 atau di origin/ws/edge-kds-stations (Grep apps/api/src). Sudah ada: lapor dan berhenti.
Isi: pasang applier cloud_to_edge dan classifier master_data; event master data membawa state penuh (boleh loncat ke versi terbaru). Jangan ubah protokol catalog (v3 dari ws/edge-kds-stations) kecuali perlu; bila perlu, kompatibel mundur.
Migrasi hanya bila perlu: nomor 0373.
Bukti: test gagal-dulu (event master data diterapkan di edge, skip-ahead aman, event outlet lain ditolak), test terarah lewat `LEGEND_TEST_FILES=... heavy pnpm test`, typecheck api sekali lewat heavy, prettier/eslint, satu reviewer subagent.
Commit+push ke cabang kerja, jangan merge. Lapor: berkas, test, angka subagent.
