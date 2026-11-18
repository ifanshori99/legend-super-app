# 1127 Perbaikan architect delta 1095: pembayaran telat QR (tingkat K uang)
Peran: engineer. Cabang `ws/1095-void-refund-ganda-voucher` (head 4aea9e038), worktree `legend-05b932c9`. Langkah pertama: spawn subagent paralel (test-writer + implementer, file terpisah). Push tanpa `--force`. Tanpa migrasi.
## P1 (architect xhigh, commit 0bbfce9e0)
`order-given.ts:79-86` melewati refund pembayaran telat (`qr-late-payment-refund:`, `pos-late-payment-refund:`, `facility-breakfast-refund:late:`, `fb-refile:late:`) saat menghitung yang sudah keluar, tetapi intent yang dibayar telat tetap dihitung "dibayar" (`:189-203`). Skenario: pesanan QR 100.000 kedaluwarsa dan di-void; tamu bayar telat; `requestQrLatePaymentRefund` mengajukan refund 100.000; dibayar terbaca 100.000; `voucherRoomIdr` (`order-voucher-room.ts:39`) hanya cek `pos_order_voids`/void edge; issue dibuat tanpa cek status pesanan (`order-issues.service.ts:488`); voucher maaf 100.000 -> tamu terima 200.000 dari bayar 100.000.
## Keputusan CTO (membatasi)
1. Di filter intent non-POS (`:194-206`): intent yang punya baris kunci pembayaran-telat = 0 (cocokkan `i.id` persis, bukan prefix longgar).
2. `order-voucher-room.ts`: `orders.status = 'voided'` -> ruang 0.
3. Cek kelas yang sama: semua uang "parkir" (kelebihan bayar, bayar telat) tidak boleh dihitung dibayar DAN tidak boleh dikurangkan; pastikan simetris di satu tempat.
4. P3: `assertNothingBackThroughProvider` (`pos-order-corrections.ts:427`) tidak terjangkau; biarkan sebagai pertahanan dengan komentar, test 409 `CONFLICT` tetap assert uang 0.
## Bukti
Test: void QR + bayar telat -> voucher ditolak 422 `APOLOGY_VOUCHER_NOTHING_DUE`, refund kasir 0; merah di 4aea9e038, hijau di head. Tabel 6x6 ditambah baris bayar telat. Regresi 67 berkas terarah. Typecheck API sekali lewat heavy. Prettier/eslint. Architect xhigh delta sekali.
## Laporan
Commit, head SHA, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
