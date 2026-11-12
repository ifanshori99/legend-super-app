# 538 Gelombang backend 12 Nov: aturan umum (semua grup G1-G5)

- Peran: engineer (~/.agents/team/roles/engineer.md). Detail tiap kartu: `bd show legend-<id>`. Cek dulu `git log --all --oneline -i --grep=<id>`: kartu yang sudah dikerjakan di cabang lain -> lapor, jangan ulang.
- Worktree sendiri: `git worktree add .worktrees/<cabang-pendek> -b ws/<cabang> origin/milestone/m1` (jangan --worktree ghostex). Commit lokal per kartu, push ke cabang kerja boleh, jangan merge ke m1/main.
- Jangan sentuh berkas yang sedang digabung/diperbaiki: payment-refund*, pos-order-corrections*, edge/catalog*, edge/promo*, edge-catalog-*, ai-gateway test, preflight 0301.
- Migrasi hanya di rentang grupmu; `when` > semua migrasi m1 dan 0340-0341.
- Paralel: Explore per kartu, test-writer test gagal-dulu, satu implementer per kartu (berkas terpisah; kartu yang berbagi berkas berurutan), test-runner. Test terarah `LEGEND_TEST_FILES=... heavy pnpm test`; tsc paket lewat heavy, satu per giliran; eslint+prettier berkas berubah. Jangan pnpm check penuh. Postgres test OOM: `STARTER_TEST_PG_MEM=1536m`.
- Uang/pajak/gaji (tingkat K): aturan founder, buktikan dengan test tidak ada pihak dibayar lebih dan outlet tidak rugi; ragu -> pilih aturan yang membatasi pembayaran dan tanyakan CTO. Review: satu reviewer per cabang (CTO menambah architect untuk K).
- Laporan: commit per kartu, test (gagal-dulu lalu lulus), angka subagent (total, puncak), yang belum. `bd update <id> --status review` untuk yang selesai.
