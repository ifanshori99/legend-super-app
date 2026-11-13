# Brief: engineer — edge POS-order applier jangan memancarkan ulang order.* (potong resep dobel)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Dampak stok/HPP: test bukti stok tidak terpotong dua kali.

## Repo
Worktree baru dari `milestone/m1` (a2234853d): `git worktree add .worktrees/edge-645 -b fix/edge-order-reemit milestone/m1`, `pnpm worktree:setup`. Rentang migrasi bila perlu: **0508-0509**.

## Kartu
`legend-078n` (P1) — `bd show legend-078n`. Applier order POS di edge tidak boleh memancarkan ulang `order.*` ke outbox cloud (akibat: resep terpotong dua kali). Giliran pertama: `Explore` (alur applier + outbox) dan `test-writer` (gagal-dulu: satu order dari edge -> satu potong resep di cloud, juga saat retry/replay).

## Review
Tingkat K (sinkron offline + stok): satu subagent `architect` effort high; maks 2 ronde.

## Bukti selesai
Test gagal-dulu, test terarah lewat `heavy` (termasuk test edge sync terkait, 3x untuk yang berbasis timer), typecheck api lewat `heavy` sekali, prettier + eslint, `db:generate` kosong. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, atau `pnpm test` penuh. Hemat token.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
