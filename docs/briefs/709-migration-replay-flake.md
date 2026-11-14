# Brief: engineer (Codex) — flake test replay migrasi saat run penuh (legend-odyct)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/migration-replay-flake .worktrees/migration-replay-flake origin/milestone/m1`.

## Tujuan
Baca `bd show legend-odyct`. Di run penuh, `accounting-coa-backfill-1204`, `purchase-price-variance-migration` gagal FK `chart_of_accounts_tenant_id_tenants_id_fk` saat replay backfill (INSERT..SELECT memindai semua tenant sementara file lain menghapus tenant), lalu `migration-force-rls-guard` gagal karena FORCE RLS tetap terangkat setelah replay batal. Perbaiki di test: replay dibatasi ke tenant milik test itu atau diisolasi/serial, dan FORCE RLS dipulihkan di `finally`. Jangan ubah file migrasi yang sudah diterapkan, jangan longgarkan assertion. Buktikan race dengan reproduksi kecil (mis. dua file bersamaan lewat `LEGEND_TEST_FILES`, atau test yang menghapus tenant di tengah replay). Jangan jalankan suite penuh.

## Bukti, sebelum melapor
Reproduksi merah di base, ketiga file hijau 3x berturut lewat `heavy` termasuk saat dijalankan bersama file teardown tenant, pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/migration-replay-flake` tanpa force. Jangan merge, jangan deploy.
