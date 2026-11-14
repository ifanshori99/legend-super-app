# Brief: engineer (Codex) — 5 e2e mock merah di base (legend-ncvcz)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/e2e-ijv8-qhh5 .worktrees/e2e-ijv8-qhh5 origin/milestone/m1`.

## Tujuan
Spec e2e mock `legend-ijv8` dan `legend-qhh5` punya 5 test merah di base `origin/milestone/m1`. Reproduksi di base (browser lewat `heavy --browser`, satu sekaligus), cari akar per test (selector/teks basi vs bug produk). Bug produk: perbaiki kode bila kecil dan jelas, selain itu laporkan tanpa memperbaiki. Jangan melonggarkan assertion. Jangan ubah `docs/PROGRESS.md`.

## Bukti, sebelum melapor
Merah dulu lalu hijau 3x berturut, pra-gate AGENTS.md (prettier, eslint, typecheck web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push cabang tanpa force. Jangan merge, jangan deploy.
