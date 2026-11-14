# Brief: engineer (Codex) — codec payroll_settings + flake render PDF menu (legend-p5vke, legend-0lyzf)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show <id>` read-only. Dua kartu, file terpisah: satu subagent per kartu, paralel.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ws/codec-print-flake .worktrees/codec-print-flake origin/milestone/m1`.

## Tujuan
1. legend-p5vke: codec config `payroll_settings` mengikuti pola legend-tct8 (`packages/shared/src/<domain>/config-codec.ts`, `platform/config-codecs.ts`, `tests/platform-config-codecs.test.mjs`). Jangan ubah logika gaji atau nominal.
2. legend-0lyzf, HANYA bagian `menu-print-db` "concurrent renders leave exactly one PDF object": reproduksi dulu (jalankan berulang), cari akar race, perbaiki di kode bila race nyata (bukan melonggarkan test). Lewati bagian `member-signin` AUTH-01.

## Bukti, sebelum melapor
Test gagal-dulu lalu hijau (`LEGEND_TEST_FILES=... heavy pnpm test`; flake: hijau 20x berturut), pra-gate AGENTS.md (prettier, eslint, typecheck api dan web bila shared berubah, lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push cabang tanpa force. Jangan merge, jangan deploy.
