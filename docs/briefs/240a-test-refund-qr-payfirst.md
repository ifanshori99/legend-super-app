# Brief test-writer: refund vs QR pay-first sale (legend-xtzpb)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-qr-payfirst-guard (jangan pindah, jangan commit, jangan edit src non-test).
Buat `apps/api/src/test/payment-refund-qr-sale-guard.test.ts`. Salin pola seeding dan helper dari `apps/api/src/test/payment-refund-pos-tender-guard.test.ts` (paidIntent, asOwner, requestRefund, refundRows, refundablePayment, setup/cleanup, approver).

Perbaikan (sudah ada): `refundableBalance` di `apps/api/src/services/payment-admin.service.ts` mengurangi `qrSaleInUse` = sum(total_idr - deposit_applied_idr) dari `orders` channel='qr', payment_mode='pay_first', payment_intent_id=intent, fired_at IS NOT NULL, tanpa baris pos_orders. Request refund yang melewati cap tetapi masuk dalam cap+qrSaleInUse: 409 `REFUND_INTENT_IN_QR_SALE`. Approve: refund berakhir failed, failure_reason `cap_exceeded`, gateway tidak dipanggil.

Kasus (insert orders mentah: channel 'qr', payment_mode 'pay_first', status 'sent', fired_at now(), payment_intent_id = intent; lihat kolom wajib di seed `posOrder` pada file pola, tambah kolom qr bila NOT NULL):
- Q1 intent 100000, order QR fired total 100000: request refund 100000 -> 409 REFUND_INTENT_IN_QR_SALE, tidak ada baris payment_refunds. Test ini HARUS gagal di basis (tanpa perbaikan, refund diterima).
- Q2 order fired total 100000 deposit_applied 30000 (intent 70000): refund 70000 ditolak; GET refundable menunjukkan refundableAmountIdr 0.
- Q3 intent 100000, order fired total 60000: refund 40000 diterima, refund 40001 ditolak.
- Q4 order QR pay_first status 'voided', fired_at NULL, payment_intent_id = intent (bayar terlambat): refund 100000 TETAP diterima (tidak menahan).
- Q5 refund pending dibuat sebelum order fired, lalu order di-fire (UPDATE fired_at), approve -> failed cap_exceeded, gateway tidak dipanggil (pola R2 pada file pola).
- Q6 order QR 'open_bill' fired_at NULL: tidak menahan; order dengan baris pos_orders tidak dihitung QR (tetap lewat jalur POS).
Jalankan: bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/payment-refund-qr-sale-guard.test.ts" pnpm test'. Lapor jumlah lulus/gagal, dan nama test yang gagal di basis bila kamu bisa memeriksanya (git stash dilarang; cukup nyatakan Q1 bergantung pada perbaikan).
