# Hasil Codex 127: refund promo (G0918, 9 Nov 16:40)

`ws/refund-promo` 0f7e4ff6..e3d5f56e (sudah di m1). Skenario direproduksi dengan evaluator/schema produksi. Belum: transaksi DB/API, suite test.

- **P1, `apps/api/src/services/crm-promo-refund.ts:649`**: batas diskon historis membuat total refund bergantung pembagian retur. Promo beli 2 kopi Rp30.000 gratis 1 pastry termurah; pesanan 4 kopi + 2 pastry Rp20.000 + 1 pastry Rp40.000, dibayar Rp160.000: retur 1 kopi lalu 2 pastry murah membayar Rp50.000, sekaligus Rp56.000. Fix: hitung diskon dari snapshot awal, rekonsiliasi perubahan redemption/budget atomik, termasuk saat diskon naik.
- **P1, `apps/api/src/services/pos-order-corrections.ts:555`**: payout di bawah kewajiban tetap menghabiskan seluruh kuantitas retur. Pesanan 2 x Rp50.000, promo Rp20.000, dibayar Rp80.000: refund pertama Rp40.000, item terakhir diminta Rp30.000, total Rp70.000; sisa Rp10.000 terkunci karena kuantitas habis dan refund tanpa `items` ditolak. Fix: tolak pembayaran kurang sebelum menyimpan retur, atau sediakan jalur pelunasan refund tanpa mengembalikan item lagi.
