# Brief: engineer (Claude Sonnet) — dua perbaikan test K (legend-0lyzf bagian AUTH-01, legend-wdqco)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. `bd show legend-0lyzf`, `bd show legend-wdqco`. Satu subagent per kartu, paralel.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/test-auth01-refund .worktrees/test-auth01-refund origin/milestone/m1`.

## Tujuan
1. legend-0lyzf, HANYA bagian `member-signin` AUTH-01 (bagian menu-print sudah selesai): reproduksi, cari akar. Bug auth nyata: perbaiki kode dengan test; flake test: isolasi tanpa melonggarkan assertion.
2. legend-wdqco: `order-recovery-refund` T3/T4 dan `order-recovery-rereport` RR-2 merah. Pastikan dulu apakah perilaku produk yang benar (audit refile 1, bukan 2) memang tidak membayar lebih. Bila ya: perbarui ekspektasi test. Bila perilaku produk yang salah: perbaiki kode dengan test bahwa tidak ada refund ganda. Jelaskan di laporan.

## Bukti, sebelum melapor
Gagal-dulu lalu hijau (flake: 20x), `LEGEND_TEST_FILES=... heavy pnpm test`, satu `reviewer`, pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
