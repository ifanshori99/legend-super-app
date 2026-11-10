# 172b — hasil architect 2 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6. Kartu brief: legend-a0i7, legend-ioyg.

Hasil: **Bersih** (tidak ada temuan P1/P2 baru).

## Invariant
1. Path-independence: `refundPosOrder` (apps/api/src/services/pos-order-corrections.ts:705-750) menghitung `dueBill` kumulatif dari barang yang disimpan (`keptPayableIdr`, yang menurut crm-promo-refund.ts:607-671 hanya bergantung pada barang yang disimpan dan bon asal), dan menolak jumlah di bawah yang jatuh tempo (`REFUND_AMOUNT_BELOW_DUE`, :744). Satu-satunya jalur yang masih bergantung urutan adalah promo min-spend yang gugur di langkah berikut (pembayaran langkah 1 tidak bisa ditarik kembali): sudah tercatat sebagai kartu keputusan legend-ob9o. Contoh: A 90.000 + B 15.000 + C 5.000, min-spend 100.000 diskon 50.000, bayar 60.000. Retur C lalu B = 2.727; retur B+C sekaligus = 0.
2. Retur semua item: semua promo ditarik, `keptPayableBill` = 0, `owedIdr` = sisa tender (pos-order-corrections.ts:731). Tidak ada sisa tender yang terkunci; DP tetap di luar refund POS (sesuai keputusan).
3. `spent_idr`: penurunan memakai `GREATEST(...,0)` (order-promo-refund.ts:226); kenaikan dibatasi ruang anggaran (:201-206); penarikan mengurangi `line.discountIdr` yang memang dihitung di `spent_idr` (crm-promo-refund.ts:530). Tidak ada jalur negatif atau melewati CHECK.
4. Jumlah `discount_idr` baris applied = `total_discount_idr` kecuali kenaikan dipotong anggaran; selisihnya diaudit sebagai `budgetShortIdr` (order-promo-refund.ts:279-309).
5. Void: semua tender non-tunai berstatus `captured` atau `authorized` ditolak (pos-order-corrections.ts:266-277); DP ditolak (:228). Tidak ada metode atau status yang lolos.
6. Penolakan terjadi di dalam satu transaksi `withTenant` + `posIdempotent`; throw membatalkan baris refund, ledger promo, anggaran, dan persetujuan.

## P3 (catatan, tanpa kartu)
- Kenaikan diskon yang terpotong anggaran tetap dihitung penuh untuk tamu (`keptPayableIdr` tidak dibatasi anggaran): anggaran promo kurang menghitung diskon itu. Hanya tercatat di audit `promo_application.clamped`.
