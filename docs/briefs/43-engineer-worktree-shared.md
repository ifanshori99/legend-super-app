# Brief: engineer — build di worktree memakai packages/shared milik worktree (legend-meki)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (mis. Explore untuk resolusi modul, implementer untuk fix).

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/worktree-shared`, cabang `fix/worktree-shared` (dari `main`). Jangan pindah cabang. Jangan ubah worktree lain.

## Tujuan
Bug P1: build web (dan mungkin api/typecheck) di `.worktrees/*` me-resolve `@starter/shared` dari checkout utama, bukan dari worktree sendiri. Cabang yang mengubah `packages/shared` bisa lulus build tanpa perubahan shared-nya. Reproduksi dulu (bukti: ubah export di `packages/shared` worktree ini, build/typecheck harus melihat perubahan itu), cari akar masalah (symlink node_modules, tsconfig paths, vite alias, pnpm workspace), lalu fix. Detail: `bd show legend-meki`.

## Kartu
`legend-meki`. Di awal: `ghostex board associate legend-meki` dan `bd update legend-meki --status in_progress`. Saat melapor: `bd update legend-meki --status review` dan `bd comment legend-meki "<ringkasan>"`.

## Catatan
- Fix yang disukai: resolusi berbasis path relatif repo (tsconfig/vite) sehingga tiap worktree otomatis benar, atau script setup worktree resmi (mis. `scripts/worktree-setup.sh` yang menjalankan `pnpm install --offline` dan menyalin `.claude/settings.local.json`). Pilih satu, jelaskan alasannya.
- Bila butuh `pnpm install` di worktree: pakai `--offline`/`--prefer-offline`, perhatikan RAM. Build lewat `heavy`.
- Jangan baca `.env*`.

## Scope
- Boleh: config build (`apps/*/vite.config.*`, `tsconfig*.json`, `package.json` scripts), `scripts/`, `docs/` catatan singkat di HANDOFF/AGENTS bagian worktree.
- Jangan: kode produk di `apps/*/src`, `packages/shared/src` (kecuali perubahan sementara untuk reproduksi yang di-revert).

## Bukti selesai
- Bukti reproduksi sebelum dan sesudah fix (perintah dan output singkat).
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check` lulus di worktree ini. `git status` bersih.
- Subagent reviewer konteks segar cek diff.

## Sebelum melapor
Commit lokal di `fix/worktree-shared`, pesan merujuk `legend-meki`. Jangan push, jangan merge.

## Laporan
Akar masalah, fix, bukti, langkah yang harus dijalankan agent lain di worktree lama, risiko tersisa.
