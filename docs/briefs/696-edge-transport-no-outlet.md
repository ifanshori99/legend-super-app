# Brief: engineer (Codex) — event edge tanpa outlet membuat relay macet (legend-3owf)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/edge-transport-no-outlet .worktrees/edge-transport-no-outlet milestone/m1`.

## Tujuan
`apps/api/src/worker/transport.ts:76-77` melempar `Edge sync requires an outlet-scoped event` bila event outbox tidak punya `outletId` (mis. `approval.*`). Reproduksi dulu dengan test: apakah relay outbox di edge macet/retry selamanya pada baris itu, atau baris diparkir. Lalu perbaiki supaya event tanpa outlet tidak menghalangi baris lain: kirim lewat jalur tenant-scoped bila kontrak cloud mendukungnya, atau parkir/lewati dengan status jelas dan log. Pilih aturan yang tidak menghilangkan event diam-diam. Lihat juga `bd show legend-078n`.

Tanpa migrasi. Bila ternyata butuh migrasi atau menyentuh uang/akses, berhenti dan laporkan.

## Bukti, sebelum melapor
Test gagal-dulu (merah di base), test terarah hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/edge-transport-no-outlet` tanpa force. Jangan merge, jangan deploy.
