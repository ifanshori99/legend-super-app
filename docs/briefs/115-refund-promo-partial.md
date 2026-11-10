# Brief 115: refund parsial pada pesanan berpromo (legend-q1e0, legend-9be7)

Peran: engineer (baca `~/.agents/team/roles/engineer.md`). Tingkat K (uang): review K wajib (reviewer Opus + architect).

## Setup
- Base: `milestone/m1` (batch 1 merge train sudah masuk, termasuk refund + quarantine-ops).
- Buat worktree sendiri: `git worktree add .worktrees/refund-promo -b ws/refund-promo milestone/m1`. Jangan pakai `--worktree` Ghostex.

## Keputusan founder (9 Nov 2026, final)
1. Promo masih sah setelah refund: refund = harga item dikurangi bagian diskonnya secara pro-rata menurut harga.
2. Syarat promo tidak lagi terpenuhi: promo batal, item yang disimpan dihitung harga normal, refund = dibayar - harga normal item yang disimpan (min 0).

## Tugas
- Baca catatan di `bd show legend-q1e0` dan `bd show legend-9be7` (usulan desain: `items[{itemId,quantity}]` opsional di body refundPosOrder; harga kept lines dari order_items dikurangi refund sebelumnya; payout = min(amountIdr, refundDueIdr)).
- Modul refund memanggil `orderPromoPartialRefundPort` (order-promo-refund.ts) di dalam transaksi refund; tolak refund parsial bila port tidak bisa jalan.
- `refunded_paid_idr` mencatat payout sebenarnya; idempotensi per refund (kirim ulang tidak menggandakan).
- Contoh uji wajib: subtotal 100k, diskon 20k, dibayar 80k; refund item 50k saat promo masih sah, dan saat promo batal.
- Refund tidak membalik stok (keputusan CTO; hanya void).

## Gate
Lint dan typecheck paket yang berubah (lewat `heavy`), test terarah (`LEGEND_TEST_FILES`), `db:generate` kosong atau migrasi baru tercatat. Commit lokal di cabang, jangan push.

## Laporan
SHA akhir, migrasi (nomor), hasil gate, temuan review K, bead baru.
