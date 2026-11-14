# Brief: engineer (Codex) — AI lock NOWAIT dan test re-check mcp-oauth (legend-f5nxl)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show legend-f5nxl` dan `bd show legend-c8dmr` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/ai-lock-nowait .worktrees/ai-lock-nowait origin/fix/ai-lock-second-opinion` (cabang 31f4fedb9, belum masuk milestone).

## Tujuan
1. `org.service` mengunci `tenants` dengan `FOR UPDATE NOWAIT`; saat operasi AI memegang `FOR SHARE` pada baris tenant yang sama, operasi org gagal 409 `LOYALTY_ENTITY_BUSY` padahal hanya perlu menunggu sebentar. Reproduksi dengan test dulu, lalu pilih perbaikan paling kecil (mis. tunggu dengan `lock_timeout` pendek, atau urutan kunci) tanpa membuka race pencabutan yang ditutup legend-c8dmr. Jelaskan pilihan di laporan.
2. Tambah test re-check di dalam transaksi untuk alur mcp-oauth (pencabutan terjadi di tengah transaksi harus ditolak).

## Bukti, sebelum melapor
Test gagal-dulu lalu hijau (`LEGEND_TEST_FILES=... heavy pnpm test`), pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push cabang tanpa force. Jangan merge, jangan deploy.
