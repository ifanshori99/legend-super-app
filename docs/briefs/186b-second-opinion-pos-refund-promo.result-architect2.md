# 186b — hasil architect 2 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6. Kartu brief: legend-s7rx, legend-wkl3, legend-15by, legend-8v2yl, legend-45bs9 (lanjutan legend-9z1vm).

Hasil: **Bersih** (tidak ada temuan P1/P2 baru).

## Jawaban pertanyaan
- Bayar lebih dari yang dibayar tamu / item gratis menghasilkan uang: tidak ditemukan. `dueBill` kumulatif (apps/api/src/services/pos-order-corrections.ts:713-721) dibatasi sisa tender (`owedIdr`, :731) dan `assertRefundWithinPaid` (:765). Item gratis yang dikembalikan: re-check stack memberi r_i = 0 (crm-promo-refund.ts:633-640), `keptPayable` = subtotal yang disimpan, jatuh tempo Rp0, jadi baris Rp0 tanpa event (pos-order-corrections.ts:725, :871).
- Pelunasan tanpa item: hanya bila sudah ada refund (:641) dan selalu memakai hitungan kumulatif yang sama, jadi pelunasan kedua menghasilkan `REFUND_NOTHING_DUE`. Edit promo tidak bisa menaikkan diskon yang disimpan: k_i = min(share, original, recheck) (crm-promo-refund.ts:654), snapshot aturan dipakai (:375-388). Promo gugur saat pelunasan ditolak (:678-687). Catatan: kode menjawab 422 `REFUND_SETTLEMENT_NEEDS_ADMIN`, bukan 409 seperti di brief; bukan masalah uang.
- FIFO per tender: total per metode tetap dari `refundAllocation(stillRefundableByMethod(...))` (:520-523); tender hanya diambil sampai sisa > 0 (:528-529); sisa tanpa tender hanya muncul bila baris lama tidak konsisten, dan ditulis tanpa tenderId/intent (:544-545). Tidak ada atribusi ke tender yang sudah habis.
- Pembaca `pos_order_refunds.lines` dengan beberapa baris per metode: rekap harian menjumlah per metode dan mengecek total baris = nilai refund (pos-day.service.ts:532-542); shift (pos-shift-support.ts:275-295, 382-394, 581-592) menjumlah; atribusi intent membaca `tenderId`/`paymentIntentId` per baris (pos-intent-attribution.ts:98-123). Event tetap satu baris per metode (pos-order-corrections.ts:858-866). Tidak ada pembaca yang rusak.
- DP: `depositGoodsReturn` hanya saat tender sudah habis (`paid - refunded <= 0`, :735-743). Selama tender masih ada, tender dipakai lebih dulu. DP tidak menyembunyikan uang tunai yang masih bisa dibayar.

## P3 (catatan, tanpa kartu)
- Bila baris `promotions` sebuah redemption tidak ada lagi, re-check jatuh ke "keep" (crm-promo-refund.ts:502-504): item gratis yang dikembalikan mendapat bagian pro-rata. Contoh: 2 kopi Rp30.000 + croissant gratis Rp20.000, bayar Rp60.000; retur croissant membayar Rp15.000. Hanya terjadi bila baris promo dihapus permanen (FK redemption biasanya mencegahnya).
- Jalur promo min-spend yang gugur di langkah kedua (bergantung urutan) sudah ada di kartu keputusan legend-ob9o.
