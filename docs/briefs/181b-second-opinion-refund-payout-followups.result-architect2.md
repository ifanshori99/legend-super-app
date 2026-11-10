# 181b — hasil architect 2 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6. Kartu brief: legend-hxpd5, legend-r5brx, legend-3bsyh (plus lanjutan legend-060xt, legend-9z1vm).

Hasil: **Bersih** (tidak ada temuan P1/P2 baru).

## Pemeriksaan per invariant
- Uang intent tidak keluar dua kali: `refundableBalance` (apps/api/src/services/payment-admin.service.ts:66-108) mengeluarkan `posSaleInUse` dari `cap`; mode `held` (pos-intent-attribution.ts:59-80) menghitung tender `captured` intent dan tender `authorized` pesanan terbuka pada payment link yang sama (QR refresh, 060xt). Retur POS hanya mengurangi bagian yang bisa diatribusikan (baris ber-`tenderId` + intent sendiri, atau aturan legacy fail-closed). Intent POS dibuat tanpa `orderId` (payment.service.ts:742-760), jadi refund intent oleh admin memang jalur pembayaran bagian gateway retur POS, dan dibatasi `cap`.
- Capture QRIS: di bawah kunci intent (`lockIntentsForFact`, pos-order-payment.ts:704-709), refund approved/completed di atas `cap` membuat tender di-void dan sisa di-refund (:791-804). Refund `pending` tidak memblokir; approval-nya kemudian gagal `cap_exceeded` karena tender sudah captured. Tidak ada bayar lebih.
- Jurnal payout: `intentBackedAt` (accounting-auto-journal-guards.ts:668-808) memakai builder SQL yang sama dengan sisi refund (mode `ledger`), hanya retur POS yang jurnalnya terposting; yang masih bisa posting membuat cek menunggu (`AutoJournalReceiptPending`), yang tidak akan posting atau di-reverse tidak dikurangkan (fail closed).
- Urutan kunci: capture orders, pos_orders, tender, link, intent (pos-order-payment.ts:624-709); late refund mengunci intent saja sesudah tender. Tidak ditemukan siklus baru.
- Re-queue SALE_MISSING: `requeueSaleDependents` (accounting-auto-journal-consumer.ts:375-397) difilter tenant, kode galat, jenis event, dan `orderId` payload. Hanya baris pesanan itu.
- Isolasi tenant: semua query di berkas berisiko memfilter `tenant_id`.

## P3 (catatan, tanpa kartu)
- Pembayaran bagian gateway dari retur POS bergantung pada admin yang membuat refund intent secara manual; tidak ada pemicu otomatis dari `order.refunded`. Sudah terkait legend-2jyr/legend-27mt.
