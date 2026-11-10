# 255a test-writer: jurnal penjualan QR split bill (legend-gzu54)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/qr-split-sale-journal` (cabang `ws/qr-split-sale-journal`). Jangan ubah `apps/api/src/services/*`. Jangan commit. Jangan suite penuh, jangan `pkill`, jangan `pnpm check`. Hanya `LEGEND_TEST_FILES="src/test/<file>" pnpm test` dari root worktree. Maks 30 giliran.

## Bug
`qrSaleGatewayOf` (apps/api/src/services/accounting-auto-journal-amounts.ts ~543-650) mengurus `order.paid` penjualan QR pay-first. Ia mensyaratkan intent payer (`orders.payment_intent_id`) `amount_idr >= total - DP` dan mendebit seluruh total-DP dari receipt payer saja. Pada split bill (satu order, satu payment link, beberapa intent masing-masing bayar sebagian: payer 60k + non-payer 50k, due 110k) `order.paid` parkir `AUTO_JOURNAL_PAYLOAD_INVALID` non-retryable ("Pinned payment intent of the QR sale took less than total - DP"): penjualan tidak terjurnal.

## Perilaku yang benar (engineer memasang; kamu hanya menulis test)
Kontributor = intent paid/partially_refunded/refunded di link order dengan alokasi > 0 (alokasi = jumlah `payment_evidence` intent - jumlah `payment_unallocated_funds` intent). Bagian tiap kontributor = `min(total-DP, alokasi)`; payer tunggal (tidak ada intent lain beralokasi > 0) menahan total-DP penuh dan tetap diperiksa `amount_idr >= total-DP` seperti sebelumnya.
- Semua receipt kontributor posted: jurnal sale posted; customer_deposit didebit total-DP; setelah receipt tiap kontributor + sale, saldo `customer_deposit` = 0.
- Ada kontributor dengan receipt masih di outbox (pending): sale parkir `AUTO_JOURNAL_RECEIPT_PENDING` retryable; setelah receipt itu posted dan sweep jalan, sale posted dan saldo customer_deposit 0.
- Receipt "none" (intent pra-cutover, tidak akan posting): bagiannya didebit ke `gateway_clearing`, bukan customer_deposit (seperti AJ-QR-04 untuk payer tunggal).
- Jumlah bagian kontributor < total-DP (mis. 60k + 30k untuk due 110k): sale parkir `AUTO_JOURNAL_PAYLOAD_INVALID` non-retryable, tidak ada jurnal sale.
- Refund kontributor yang sudah final sebelum sale sehingga receipt - bagian tidak cukup: `POSTING_AMOUNTS_MISMATCH` (assertSaleWithinReceipt per kontributor).
- Non-split tidak berubah: AJ-QR-01..AJ-QR-16 di `accounting-auto-journal.test.ts` tetap hijau (jalankan file itu sekali di akhir).

## Test yang diminta
File baru `apps/api/src/test/accounting-auto-journal-split-qr-sale.test.ts`. Pakai gaya dan helper dari `apps/api/src/test/accounting-auto-journal-split-qr-guard.test.ts` (seed split bill: dua intent satu link, evidence, fund, order fired pinned payer) dan `accounting-auto-journal.test.ts` bagian "F19 slice 3 QR sale" (~4303-4960: `makeWorld`, `bookedIntent`, `seedQrOrder`, `qrOrderPaid`, `paymentPaid`, `deliver`, sweep). Salin helper; jangan ubah file lama.
- SALE-1 dua kode 60k + 50k (due 110k), kedua receipt posted lebih dulu, lalu kirim order.paid: sale posted; jurnal: debit customer_deposit 110k, kredit pendapatan sesuai AJ-QR-01; saldo customer_deposit 0. Gagal di base.
- SALE-2 tiga kode 50k + 40k + 20k (due 110k) semua posted: sale posted, customer_deposit 0. Gagal di base.
- SALE-3 satu receipt pending (payment.paid kode non-payer belum dikirim): sale parkir RECEIPT_PENDING retryable, tidak ada jurnal sale; kirim receipt itu lalu jalankan sweep (lihat AJ-QR-05): sale posted, customer_deposit 0. Di base: parkir non-retryable (gagal).
- SALE-4 bagian < total-DP (60k + 30k, due 110k): sale non-retryable invalid, tidak ada jurnal sale. Boleh lulus di base; tetap harus lulus sesudah fix.
- SALE-5 receipt "none" untuk satu kontributor (tidak ada payment.paid dan tidak akan: ikuti cara AJ-QR-04 membuat intent pra-cutover) dan satu posted: bagian none didebit gateway_clearing; pastikan jumlah debit customer_deposit = bagian yang posted dan gateway_clearing = bagian none.
- SALE-6 refund kontributor N final (completed) SEBELUM sale fired, sehingga receipt N - bagian N tidak cukup: sale `POSTING_AMOUNTS_MISMATCH`.
- SALE-7 payer dengan fund unallocated (P evidence 110k, fund 50k, N 50k; alokasi P 60k) seperti SPLIT-S2: sale posted dan customer_deposit 0.

Bukti gagal-dulu: jalankan file baru di base (tanpa perubahan service), laporkan test yang gagal beserta pesan gagal; gagal harus karena perilaku, bukan salah seed. Test yang lulus di base (SALE-4 mungkin) disebut. Jangan pasang fix. Laporan: nama file, daftar test, hasil di base, jumlah baris.
