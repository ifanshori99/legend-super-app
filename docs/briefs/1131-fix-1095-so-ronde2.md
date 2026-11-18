# 1131 Perbaikan SO refund kasir ronde 2 (1095): satu anggaran uang keluar per pesanan (tingkat K uang)
Peran: engineer. Cabang `ws/1095-void-refund-ganda-voucher` (head 0b8b9d017), worktree `legend-05b932c9`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer + implementer per jalur, berkas terpisah). Push tanpa `--force`. Tanpa migrasi.
Temuan lengkap: `docs/qa/second-opinion-refund-kasir-1095-1129.md` (folder utama).

## P1-1 voucher lalu ORD-09 (Rp200.000 keluar dari bayar Rp100.000)
`order-recovery-refund.ts:345-365` hanya menjumlah payment_refunds; ORD-09 tidak mengurangi voucher maaf yang sudah terbit. `payment-admin.service.ts:263` (sale-in-use, batas refund finance manual) juga tidak menghitung voucher.
## P1-2 voucher lalu refund charge swap (Rp140.000 dari bayar Rp120.000)
`order-recovery-charge-manual-refund.ts:195,349` membatasi hanya terhadap charge; tidak cek voucher/anggaran pesanan, baik saat request maupun approval. Cek juga jalur refund charge online.
## P2 tabel bayar telat
`refund-1116-paid-basis.test.ts:1062`: refund Rp25.000 bayar telat tidak masuk `totalOut`.

## Keputusan CTO (membatasi)
1. Satu anggaran per pesanan di `services/order-given.ts`: sisa = dibayar (aturan yang ada) - semua uang keluar hidup (refund kasir, ORD-09 semua status hidup, refund charge, refund penyedia, refund finance manual) - voucher maaf terbit yang belum di-void (nilai nominal, terpakai atau belum).
2. Semua jalur uang keluar memanggil anggaran itu di bawah lock pesanan (urutan lock yang ada: issue -> orders -> charge) dan menolak bila nominal > sisa: ORD-09 (request, approval `order-recovery.service.ts:1575`, settlement manual_refund `:964`), refund finance manual (`payment-admin.service.ts:263` / `payment-refund.service.ts:530`), refund charge swap manual (request dan approval) dan online, refund kasir, voucher maaf. Staf di atas sisa: 422 `REFUND_OVER_ORDER_ROOM` (jangan dipotong diam-diam).
3. Jangan menambah anggaran kedua; pakai satu fungsi supaya simetris.

## Bukti
Test gagal-dulu kedua arah (voucher dulu lalu ORD-09/charge; ORD-09/charge dulu lalu voucher): merah di 0b8b9d017, hijau di head. Tabel properti: semua permutasi jalur, invarian total keluar + voucher <= dibayar. P2 dibetulkan. Regresi terarah berkas refund/voucher/recovery (67+ berkas) lewat `heavy`. Typecheck API sekali lewat `heavy`. Prettier/eslint. Architect xhigh delta sekali.
## Laporan
Commit, head SHA, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
