# Second opinion Codex: keuangan dan HPP (15 Nov 2026)

Rentang: origin/milestone/m1...ghostex/845-finance-view-access (43e9824fa) dan ...ws/hpp-stock-followups (f6315f99f). Thread G47fm, read-only. Hasil: 2 P2, tanpa P1; guard laporan tidak melemah, tidak ada jalur bayar lebih.

1. P2 apps/api/src/services/purchase-return.service.ts:1090: pembulatan tiap retur menyisakan persediaan semu dan melebihkan laba. Terima 3 unit @1.000,3333 dibukukan 3.001; tiga retur 1 unit mengkredit total 3.000. Stok habis, GL persediaan sisa Rp1 dan 5106 terkredit Rp1. Perbaikan: pengurangan = round(qtyBefore x avg) - round(qtyAfter x avg) per saldo; uji retur bertahap sampai habis (GL persediaan kembali 0).
2. P2 apps/api/src/services/accounting-finance-exceptions.service.ts:371: resolusi intent mengabaikan pos_order_tenders. Pembayaran POS dengan resi tertunda > 24 jam tampil intentId null dan outboxState missing padahal intent dan outbox pending ada (orders.payment_intent_id memang null di POS). Perbaikan: ambil intent dari tender/deposit, dukung beberapa intent per order.

Keputusan CTO: keduanya diperbaiki (brief 853).
