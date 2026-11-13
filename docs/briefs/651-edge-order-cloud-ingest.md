# Brief: engineer — cloud ingest order dan void dari edge (legend-771dl)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang (penjualan, void): "jangan sampai rugi".

## Konteks
`ws/edge-sync-appliers` (456b4dff1) memarkir event order edge (`order.paid`, void) di `edge_deferred_events` dan menghitung `cost_snapshot_idr`, tetapi cloud tidak punya `orders`/`order_items` untuk order dari kasir offline. Akibat: penjualan offline tidak masuk laporan cloud, dan `legend-zy43` (merge struk edge, `registerReceiptRunEdgeApplier`) tidak bisa di-wire karena merge menolak struk tanpa order cloud. Lihat laporan di bead `legend-pd9t`, `legend-zy43`, dan `docs/design/edge-cloud-failover.md`.

## Repo
Worktree dari `origin/ws/edge-sync-appliers`: `git worktree add .worktrees/edge-ingest-651 -b ws/edge-order-ingest origin/ws/edge-sync-appliers`, lalu `pnpm worktree:setup`. Migrasi rentang **0522-0525**.

## Kerja (urut)
1. Explore paralel: bentuk payload event order/void edge, tabel orders/order_items/payments cloud, merge struk (`pos-receipt.service.ts mergeDeviceReceiptRun`). Tulis catatan desain singkat di `docs/design/edge-order-ingest.md`: pemetaan event -> baris cloud, idempotensi (replay, urutan acak, batch terpisah), void, nomor dokumen, outlet snapshot.
2. Subagent `architect` effort xhigh mereview catatan desain sebelum kode. Keputusan bisnis yang muncul: tulis di laporan, jangan tebak.
3. Test gagal-dulu: order offline lunas muncul satu kali di cloud dengan total dan item sama; replay tidak menggandakan; void membalik tepat sekali; tenant/outlet lain tidak tersentuh; total penjualan cloud = total edge (tidak ada selisih uang).
4. Implementasi ingest. Lalu wire `registerReceiptRunEdgeApplier` (hapus `receipt_run` dari `posDeferredAggregates` agar tidak duplicate handler) bila aman; bila tidak, lapor alasannya.
5. `bd update legend-771dl --status review` (+ `legend-zy43` bila ikut selesai) dengan `bd comment`.

## Review
Tingkat K: satu subagent `architect` effort xhigh pada diff, maks 2 ronde (desain di langkah 2 tidak dihitung).

## Bukti selesai
Test terarah edge + pos lewat `heavy`, typecheck api sekali lewat `heavy`, prettier + eslint, `db:generate` kosong, `node --test` registry migrasi. Push tanpa force.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Kuota terbatas: maks 4 subagent bersamaan.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
