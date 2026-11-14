# Brief: engineer (Codex) — flake migrasi 0360 balapan teardown tenant (legend-zdfsm)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show legend-zdfsm` dan `bd show legend-odyct` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/flake-zdfsm .worktrees/flake-zdfsm origin/milestone/m1`, lalu `git merge --no-ff origin/fix/migration-replay-flake` (fc8e69215, perbaikan keluarga yang sama untuk legend-odyct; pakai polanya).

## Tujuan
`cash-movement-mapping-backfill-migration` (migrasi 0360) membaca semua tenant lalu gagal FK saat tenant test lain dihapus paralel; FORCE RLS tertinggal lepas dan `rls.test` ikut merah. Terapkan pola isolasi yang sama dengan legend-odyct (batasi ke tenant test sendiri / kunci teardown). Hanya test dan helper test; jangan ubah SQL migrasi yang sudah ada di m1. Pastikan FORCE RLS selalu dipulihkan di finally.

## Bukti, sebelum melapor
Reproduksi berpasangan (berkas migrasi + berkas yang menghapus tenant) merah dulu, lalu hijau 20x, plus `rls.test` hijau. `LEGEND_TEST_FILES=... heavy pnpm test`. Pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
