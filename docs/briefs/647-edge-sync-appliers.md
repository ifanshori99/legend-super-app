# Brief: engineer — applier transaksi edge -> cloud (offline POS)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Sinkron offline + stok/uang: tingkat K. Kartu file berbeda: satu `implementer` per kartu setelah `Explore` per area.

## Repo
Worktree baru dari `origin/fix/edge-order-reemit` (c93ffaca9; pagar re-emit + lewati potong resep untuk order edge, ikut batch58): `git worktree add .worktrees/edge-647 -b ws/edge-sync-appliers origin/fix/edge-order-reemit`, `pnpm worktree:setup`. Rentang migrasi: **0510-0513**.

## Kartu (detail dan sisa kerja: `bd show <id>` + komentar terakhir)
1. `legend-pd9t` — applier transaksi edge link + konsumer outbox->antrean edge (`setEdgeEventApplier` edge_to_cloud di cloud). Pakai baris parkir `edge_deferred_events` yang sudah ada; isi `cost_snapshot_idr`. Pagar dari `apps/api/src/edge/apply-scope.ts` wajib dipakai (applier tidak memancarkan ulang `order.*`).
2. `legend-zy43` — pasang `mergeDeviceReceiptRun` di applier edge->cloud.
3. `legend-7h5s` — edge tidak boleh menghasilkan event sinkron cloud selebar tenant.
Kaitan: `legend-kai` (status review, up-sync ULID idempoten). Jangan ubah kontraknya tanpa lapor CTO.

## Invariant (test gagal-dulu tiap butir)
Satu event edge -> tepat satu efek di cloud (idempoten saat retry/replay/urutan acak per agregat); stok resep terpotong tepat sekali; tidak ada data lintas tenant/outlet; tidak ada event hilang saat cloud mati lalu pulih.

## Review
Satu subagent `architect` effort high atas diff gabungan; maks 2 ronde, cek ulang fix dengan reviewer sonnet.

## Bukti selesai
Test terarah lewat `heavy` (test edge sync berbasis timer 3x), typecheck api lewat `heavy` sekali sebelum lapor, prettier + eslint, `db:generate` kosong, `node --test` tes root registry bila ada migrasi. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, atau `pnpm test` penuh. Hemat token.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
