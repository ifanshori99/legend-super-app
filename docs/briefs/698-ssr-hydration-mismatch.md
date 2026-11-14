# Brief: engineer (Codex) — peringatan SSR hydration mismatch (legend-sivp)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/ssr-hydration .worktrees/ssr-hydration milestone/m1`.

## Tujuan
Mock e2e shard 2 mencatat 5x "Hydration failed because the server rendered text didn't match the client" di sekitar spec legend-kaqr / legend-m4zn (dugaan: teks berbasis waktu, mis. timer sesi FAC-01 atau tanggal locale). Reproduksi dulu (catat komponen + spec), lalu render teks itu dari nilai server yang stabil atau client-only setelah mount. Cari pola serupa lain (Date.now(), new Date() tanpa argumen, toLocale* tanpa timeZone tetap) di komponen yang dirender SSR dan perbaiki yang terbukti mismatch.

Hanya `apps/web`. Tanpa perubahan API, tanpa migrasi.

## Bukti, sebelum melapor
Run mock e2e spec terkait lewat `heavy` tanpa peringatan hydration (log sebelum vs sesudah), test web terkait hijau, pra-gate AGENTS.md (prettier, eslint, typecheck web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/ssr-hydration` tanpa force. Jangan merge, jangan deploy.
