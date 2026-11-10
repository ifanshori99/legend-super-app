# 175b hasil architect 1 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6. Kartu: legend-r7g2 (review).

Hasil: **Bersih** (tidak ada P1/P2 baru).

## Yang diperiksa
- `payment-doit-wire.ts:462-523` `parseDoitRefundAnswer`: objek payment wajib `id` = payment kita, `reference` = intent, `status=refunded`, `amount` = nominal; objek refund wajib `payment_id` = payment kita, `amount` ada dan sama, `id` != payment id, `idempotency_key`/`reference` bila ada harus milik kita. Angka string hanya kanonik (`parseDoitIntegerString`). `object` lain, `id` kosong, status tak dikenal: UNRECOGNIZED. Invariant 1-3 terpenuhi.
- `payment-doit.ts:599-645`: hanya 400/409/502 dengan kode DOIT yang cocok menjadi `failed`; status lain unknown.
- `payment-refund.service.ts:1867-1891`: tripwire, POST hanya pada percobaan pertama; berikutnya lookup saja.
- `payment-refund.service.ts:1924-1975, 1526-1527`: IDENTITY_MISMATCH lengket (`keepSticky`), audit sekali (cek before != mismatch). Lookup partial selalu unknown, jadi attempts naik sampai 8 lalu berhenti (`sweepApprovedRefundPayouts` 2330); flag tidak ditimpa MANUAL_RECONCILIATION (2354) dan masuk eskalasi `payout_stalled` (2111-2117). Tidak ada loop tanpa batas, tidak hilang dari operator.
- Webhook: `payment-doit-refund-webhook.ts:111-146` objek refund dengan `reference` tetap refund; `payment-webhook.service.ts:945-948` payment_object tidak menimpa providerRef refund; `paymentMatchesRefund` 782-802 mengecek `reference` dan payment id. Data tersimpan dinormalisasi lalu dibaca ulang dengan parser yang sama (invariant 6).

## Catatan P3 (tidak dibuat kartu)
1. `payment-doit-wire.ts:516-521`: jawaban 201 tanpa `idempotency_key` diterima hanya dengan `payment_id` + `amount`. Bila DOIT mengembalikan objek refund lain dengan nominal sama (dua refund parsial sama besar), parser menerimanya. Tertahan oleh unique index `payment_refunds_provider_ref_idx` (tenant, provider_ref): `completeRefund` gagal 23505, refund tetap approved, lalu lookup unknown sampai MANUAL_RECONCILIATION. Fail-closed, tetapi kodenya generik (bukan IDENTITY_MISMATCH). Saran: tangkap 23505 di jalur selesai dan set flag IDENTITY_MISMATCH.
2. `payment-doit-wire.ts:520-521` dan `payment-refund.service.ts:2030-2040`: `failed` dari POST dengan identitas cocok langsung `failRefund` (dana refundable dilepas). Bila DOIT kemudian mengirim `refund.succeeded` untuk refund itu, hanya tercatat sebagai provider conflict; refund baru yang sudah dibuat staf bisa membayar dua kali. Bergantung pada kontrak DOIT (kartu legend-oahzs sudah meminta contoh payload refund.failed). Saran: sebelum DOIT_REFUNDS_ENABLED, pastikan `failed` final di DOIT, atau tahan pelepasan dana sampai webhook.
3. `payment-doit.ts:679-684`: lookup menyelesaikan refund penuh dari status payment `refunded` tanpa menyebut refund mana; juga untuk refund berflag IDENTITY_MISMATCH. Aman selama hanya satu refund live per nominal penuh (refundable menahan sisanya).
