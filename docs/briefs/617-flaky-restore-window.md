# Brief: engineer — test flaky platform-restore-window

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti.

## Repo
Worktree baru dari `milestone/m1`. Push ke `origin` sebagai `fix/flaky-restore-window`.

## Kartu `legend-2187v`
`apps/api/src/test/platform-restore-window.test.ts` sesekali gagal 403 (harap 409). Terlihat 2x di cabang `ws/platform-tenant-wizard` saat file test lain jalan bersamaan. Reproduksi (jalankan berulang bersama test platform lain), temukan akar masalah (data bersama, urutan setup, sesi/MFA kedaluwarsa, role), perbaiki test atau kode. Bila akar masalah di kode produksi (bug akses), lapor dulu sebelum mengubah.

`bd update legend-2187v --status in_progress` di awal; lapor `--status review` + `bd comment`.

## Bukti
Run berulang (mis. 5x) hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test`; prettier + eslint.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
