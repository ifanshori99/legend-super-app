# 181b hasil architect 1 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6 (termasuk lanjutan legend-9z1vm/45bs9/8v2yl yang digabung di 94d769c6). Kartu: legend-riqu, legend-r5brx, legend-hxpd5, legend-3bsyh, legend-060xt (review).

Hasil: **Bersih** (tidak ada P1/P2 baru).

## Yang diperiksa
- Guard refund intent: `payment-admin.service.ts:66-109, 133-143` `cap = paid - (DP dipakai + DP hangus + posSaleInUse)`; `pos-intent-attribution.ts:51-137` mode `held` menghitung tender captured milik intent dan tender `authorized` pesanan terbuka di payment link yang sama (060xt), dikurangi retur POS yang teratribusi; sale yang di-void tidak memegang. Contoh: intent 100.000, retur POS 50.000 metode qris: posSaleInUse 50.000, cap 50.000; refund intent 100.000 ditolak `cap_exceeded`.
- Capture QRIS: `pos-order-payment.ts:604-853` mengunci orders -> pos_orders -> tender -> link -> intent (`lockIntentsForFact`, urut id); refund approved/completed di atas cap (`reserved - pending > cap`, 793) membuat tender di-void dan sisanya di-refund, bukan capture. Refund pending kalah dan gagal `cap_exceeded` saat disetujui (`payment-refund.service.ts:346-374`, di bawah kunci intent yang sama).
- Jurnal payout: `accounting-auto-journal-guards.ts:668-808` `intentBackedAt` memakai SQL atribusi yang sama (mode `ledger`), hanya retur POS yang jurnalnya terposting dan tidak di-reverse; yang masih bisa terposting membuat `AutoJournalReceiptPending` (retryable), sisanya fail-closed.
- Parkir SALE_MISSING: `accounting-auto-journal-consumer.ts:375-397` membuka ulang hanya baris tenant itu, `order.voided`/`order.refunded`, `payload.orderId` sama, setelah `order.paid` terposting.
- Retur POS metode gateway tidak membayar uang sendiri; uang keluar lewat refund intent yang dibatasi cap. Intent QRIS POS tidak membawa `orderId` (`pos-order-payment.ts:347-375`), jadi refund intent buatan staf tidak terhalang `source_document`.
- Isolasi tenant: setiap query di berkas di atas memfilter `tenant_id`.

## Catatan P3
- `refundPosOrder` tidak mengambil kunci intent; ia hanya menambah retur (menurunkan posSaleInUse), jadi pembaca yang memegang kunci intent melihat nilai lama yang lebih ketat (aman).
