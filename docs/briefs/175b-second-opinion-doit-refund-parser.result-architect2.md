# 175b — hasil architect 2 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6. Kartu brief: legend-r7g2.

Hasil: **Bersih** (tidak ada temuan P1/P2 baru di luar kartu terbuka).

## Pemeriksaan
- `parseDoitRefundAnswer` (apps/api/src/services/payment-doit-wire.ts:462-523): objek payment wajib `id` = payment kita dan `reference` = intent kita; sukses hanya `refunded` dengan nominal sama. Objek refund wajib `payment_id` kita, nominal ada dan sama, `idempotency_key`/`reference` bila ada harus milik kita, `id` tidak boleh sama dengan ID payment. String angka non-kanonik, tipe lain, `object` lain, dan status tak dikenal menjadi `DoitRefundUnknownError`. Invariant 1-3 terpenuhi.
- `failed` dari jawaban POST yang identitasnya cocok: dapat diterima sebagai jawaban definitif untuk refund itu. Contoh payload `refund.failed` asli belum ada: sudah ada kartu legend-oahzs.
- Flag lengket: `keepSticky` (payment-refund.service.ts:1526-1527) mempertahankan `DOIT_REFUND_IDENTITY_MISMATCH`; `exhausted` tidak menimpanya (:2354); masuk himpunan eskalasi `payout_stalled` (:2111-2117), atau `provider_pending` bila lookup kemudian menjawab pending. Audit ditulis sekali (:1952-1969). Tripwire xd2q mencegah POST ulang. Tidak ada jalur ulang tanpa batas.
- Webhook: `providerRef` dari objek payment hanya dipakai bila refund belum punya ref (payment-webhook.service.ts:945-948); `reference` objek refund dicek terhadap intent (:792). Payload tersimpan dinormalkan dan diparse ulang ke fakta yang sama (payment-doit-refund-webhook.ts:164-182).

## Sudah punya kartu (tidak dilaporkan ulang)
legend-2ol8g (webhook menerima amount tidak valid / payment_id null lewat refund_id), legend-3usn8 (POST sesudah lease habis), legend-kl46s (fallback manual-settle), legend-gqv7, legend-oahzs.
