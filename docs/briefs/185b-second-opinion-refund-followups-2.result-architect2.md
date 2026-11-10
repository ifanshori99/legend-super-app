# 185b — hasil architect 2 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6. Kartu brief: legend-x1i1h, legend-j0ag5, legend-leqj6, legend-8v2yl, legend-45bs9.

Hasil: **Bersih** (tidak ada temuan P1/P2 baru).

## Pemeriksaan per invariant
- Refund late payment vs refund pending (legend-leqj6): jumlah late = `cap - (reserved - pending)` (pos-order-late-payment.ts:108-115, qr-order-late-payment.ts:98-103). Approval late tidak menghitung pending lain; approval lain menghitung semuanya (payment-refund.service.ts:352-363). Contoh intent Rp100.000, refund approved A Rp30.000, pending P Rp40.000: late L = Rp70.000. Approve L dulu: 140-40 = 100, L lolos, P gagal `cap_exceeded`. Approve P dulu: 140 > 100, P gagal, L lolos. Kedua urutan: tamu menerima Rp100.000. Tidak melebihi yang diterima.
- Pending gagal tidak menghilangkan sisa: karena L tidak dikurangi pending, L sudah mencakup uang P. Bila L sendiri gagal di gateway, refund ulang lewat admin (intent POS tanpa dokumen sumber). Ini jalur umum refund gagal (kartu legend-17ml).
- Jurnal payout: retur POS dan void yang jurnalnya di-reverse finance dibaca "none" (accounting-auto-journal-guards.ts:288-301); parkir SALE_MISSING dihitung pending hanya bila jurnal penjualannya tidak di-reverse (:266-285). Payout tidak mengeluarkan lebih dari penerimaan + kredit balik yang benar-benar terposting.
- Void QRIS (legend-x1i1h): `voidFactOf` (accounting-auto-journal-void.ts:111-180) membalik jurnal penjualan apa adanya; metode tanpa intent, EDC, poin, atau penerimaan intent yang belum terposting parkir `AUTO_JOURNAL_VOID_UNSUPPORTED`. Sejak legend-ioyg, void penjualan non-tunai ditolak di POS (pos-order-corrections.ts:266-277), jadi jalur ini hanya untuk void lama.
- Isolasi tenant: semua query memfilter `tenant_id`.

## P3 (catatan, tanpa kartu)
- accounting-auto-journal-void.ts:169-179 membaca status penerimaan intent pada saat void diproses, bukan pada saat penjualan diposting. Penjualan yang diposting ke `gateway_clearing` (penerimaan belum terposting waktu itu) lalu penerimaannya terposting kemudian akan lolos cek ini; pembalikan tetap mengikuti jurnal asli, jadi kreditnya ke `gateway_clearing`, bukan `customer_deposit`. Dampak hanya pada void non-tunai lama (sebelum legend-ioyg).
