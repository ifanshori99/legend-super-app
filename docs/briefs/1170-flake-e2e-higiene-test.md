# 1170 Flake e2e + higiene test API (engineer Codex, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md` (Codex: subagent bawaan maks 6, spawn paralel di giliran pertama). Codex tidak menjalankan `bd`: tulis bukti per kartu di laporan, CTO memindah kartu.
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `milestone/m1`. Cabang kerja: `ws/1170-flake-higiene`. Tingkat S (reviewer sonnet di sisi CTO). Tanpa migrasi.

## Kartu (baca tiap kartu: `bd show <id>` boleh dibaca lewat CTO; deskripsi ringkas di bawah)
1. `legend-3g69v` flake e2e kmndq: `finish()` pada animasi tak hingga menggantung. Cari helper animasi e2e (grep `getAnimations`, `finish(`, teks "Ya, masuk" di `e2e/`). Fix: lewati animasi `iterations: Infinity` atau batasi tunggu.
2. `legend-bz3hj` flake e2e OPS-04/05 dan kmndq di bawah beban: berurutan SESUDAH 3g69v (helper sama). Ganti tunggu waktu tetap dengan tunggu keadaan.
3. `legend-oqs0y` sisa `DROP ... WITH (FORCE)` di `tests/db-role-provisioning*.mjs` dan `apps/api/src/test/provision-roles-audit.test.ts:119`: samakan dengan pola drop aman yang sudah dipakai test lain (cari `WITH (FORCE)` dan pola penggantinya di m1).
4. `legend-h2wvx` cabut batas 1 worker vitest (`apps/api/vitest.config.ts:11`, `fileParallelism:false`): prasyarat 44d6876d2 dan cc68d2c35 sudah di m1. Kerjakan TERAKHIR. Bukti: satu run penuh API dengan 2 worker lewat `heavy` hijau. Bila merah: kembalikan batas, catat file yang bertabrakan di laporan.

## Batas
- Hanya file test/e2e/config test. Jangan ubah kode produk di `apps/api/src/services`, `apps/web/src/routes`.
- Run penuh hanya sekali (kartu 4). Lainnya test terarah atau e2e terarah lewat `heavy`.

## Bukti selesai
Per kartu: bukti gagal-dulu atau reproduksi (flake: jumlah run sebelum/sesudah), prettier + eslint file berubah. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, yang belum teruji.
