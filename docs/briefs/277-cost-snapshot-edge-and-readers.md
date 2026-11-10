# Brief lanjutan G8www: HPP pesanan edge dan pembaca NULL

Lanjutan di thread yang sama. Aturan sama dengan brief 273.

## Repo
Cabang baru `ws/cost-snapshot-edge` dari `ws/cost-snapshot-at-sale` (ec37dc36; antre merge train), worktree `.worktrees/cost-snapshot-edge`, `worktree:setup`. Jangan push, jangan merge. Migrasi hanya bila benar perlu: nomor dipesan `0185`, `when` 1794264000000.

## Tujuan
1. `legend-g8sen` (P2, K uang). Keputusan CTO: payload edge tidak diubah. Cloud mengisi `cost_snapshot_idr` saat baris pesanan dari edge diterima atau disinkronkan, memakai `computeLineCostSnapshots` dan `stock_balances.avg_cost_idr` di lokasi jual. Isi hanya bila NULL, jangan pernah menimpa nilai yang ada; gagal hitung tetap NULL + log `warn`. Langkah pertama lewat `Explore`: di mana cloud menerima baris pesanan dari edge (ingest, outbox, replikasi). Bila tidak ada titik ingest di kode cloud (mis. replikasi murni tingkat DB), berhenti dan lapor dengan buktinya.
2. `legend-n8r5m` (P3), bagian `pos-order-support.ts` (sekitar :1048) saja: NULL dibaca sebagai "tidak diketahui", bukan 0, dan margin untuk baris tanpa HPP tidak dihitung seolah biayanya nol. Bagian `ai-metrics/sales.ts` jangan disentuh: berkas itu sudah diubah `ws/ws11-sales` dan milik alur WS-11. Tulis `bd comment legend-n8r5m` bahwa bagian itu menunggu WS-11.

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Bukti selesai
- Test gagal-dulu: baris edge NULL terisi di cloud; nilai yang sudah ada tidak ditimpa; sinkron ulang idempoten; gagal hitung tetap NULL; isolasi tenant; pembaca POS tidak menghitung NULL sebagai 0.
- Tes terarah, sebut jumlah file dan tes. Typecheck api lewat `heavy` sekali; eslint + prettier.
- Review (Q48, tingkat K): satu `architect`.
- Tulis brief Codex `docs/briefs/273b-second-opinion-cost-snapshot.md` untuk area HPP (ec37dc36 + cabang ini), jangan dijalankan.

## Laporan
Sekali di akhir: titik ingest yang dipakai, SHA, migrasi (ada/tidak), bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
