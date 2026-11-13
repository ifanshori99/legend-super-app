# Brief: engineer — lanjutan kontrak event edge (legend-cqehx, legend-yu8z0, legend-zy43)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang/loyalty: "jangan sampai rugi".

## Konteks
`ws/edge-sales-gl` (51d67b182) memasukkan penjualan edge ke GL, PBJT, dan poin. Sisa celah (lihat komentar CTO di tiap bead):
- `legend-cqehx`: ingest tidak mengisi `orders.customerAttachedBy`, jadi guard staf-memberi-poin-ke-diri-sendiri hanya melihat kasir.
- `legend-yu8z0`: tender gateway (`card`, `va`, `ewallet`, `qris`) ditolak ingest karena provider tidak ada di event; event `order.paid` lama tanpa kontrak baru; order QR dibayar di edge. Keputusan CTO: tambah field provider ke kontrak `order.paid`, diisi dari konfigurasi pembayaran outlet.
- `legend-zy43`: belum ada producer `receipt_run.reported` di edge; wire `registerReceiptRunEdgeApplier` (hapus `receipt_run` dari `posDeferredAggregates` agar tidak duplicate handler).

## Repo
Worktree dari `origin/ws/edge-sales-gl`: `git worktree add .worktrees/edge-contract-657 -b ws/edge-contract-followups origin/ws/edge-sales-gl`, `pnpm worktree:setup`. Migrasi rentang **0530-0533** bila perlu.

## Kerja (satu implementer per kartu bila file terpisah)
1. cqehx: bawa id staf yang menempel customer di payload edge (opsional, kompatibel mundur), isi `customerAttachedBy`, guard self-grant berlaku. Test: staf menempel dirinya sendiri sebagai customer tidak dapat poin.
2. yu8z0: field provider di kontrak; ingest menerima tender gateway dengan provider valid; event lama tanpa kontrak baru tetap ditolak dan dicatat (backfill hanya bila aman dan idempoten, kalau tidak: lapor). Order QR yang sudah ada di cloud dan dibayar di edge: jangan buat order ganda; lapor desainnya bila butuh keputusan.
3. zy43: producer `receipt_run.reported` di edge + wire applier di cloud. Test: struk edge digabung tepat sekali, replay aman, cloud boot tanpa duplicate handler.

Urutan rilis tetap cloud dulu baru edge; key kontrak baru opsional.

## Review
Tingkat K: satu subagent `architect` effort xhigh, maks 2 ronde.

## Bukti selesai
Test gagal-dulu, test terarah edge/pos/loyalty lewat `heavy`, typecheck api (+ web bila tersentuh) lewat `heavy`, prettier + eslint, `db:generate` kosong, registry migrasi bila ada. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Maks 4 subagent bersamaan.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
