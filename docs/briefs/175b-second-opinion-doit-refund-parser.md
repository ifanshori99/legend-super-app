# Brief Codex 175b: second opinion parser refund DOIT (legend-r7g2)

Peran: second-opinion (tingkat K: uang, refund gateway). Read-only. Cabang `ws/doit-refund-parser`, diff `5e227f59..3b053bb8` (dasar milestone/m1). Bug ini yang menahan `DOIT_REFUNDS_ENABLED`.

## Berkas berisiko

- `apps/api/src/services/payment-doit-wire.ts` (`parseDoitRefundAnswer`: jawaban 2xx `POST /v1/payments/{paymentProviderRef}/refunds`, header `Idempotency-Key: refund:<refundId>`)
- `apps/api/src/services/payment-doit.ts` (pemanggil parser, `refundPayment`)
- `apps/api/src/services/payment-doit-refund-webhook.ts` (`readDoitRefundFacts`: objek `refund` yang juga membawa `reference`)
- `apps/api/src/services/payment-webhook.service.ts` (jalur `payment_object`: `providerRef` refund)
- Penanganan `DoitRefundUnknownError` di `apps/api/src/services/payment-refund.service.ts` (lease, `lastPayoutError`, batas `PAYOUT_MAX_ATTEMPTS`, eskalasi)
- Test: `apps/api/src/test/payment-doit-refund.test.ts`, `payment-doit-refund-sandbox-shapes.test.ts`, `payment-doit-refund-webhook.test.ts`

## Invariant

1. Refund dianggap `succeeded`, `pending`, atau `failed` dari jawaban POST hanya bila jawaban itu menyebut payment yang diminta (`payment_id`, atau `id` untuk objek payment), nominal yang diminta, dan, bila ada, idempotency key dan `reference` intent yang diminta.
2. Jawaban lain berakhir `DoitRefundUnknownError`: refund tetap `approved`, tidak `completed`, tidak `failed` (uang tidak dilepas dua kali), dan percobaan ulang terbatas lalu dieskalasi ke operator.
3. Bentuk nyata sandbox tetap diterima: 201 `{id:"rf_…", payment_id, amount:number, status, reason}`; 200 replay menambah `idempotency_key`, `provider_ref`, `created_at`, dan `amount` berupa string bilangan bulat kanonik.
4. Webhook refund tidak pernah menyelesaikan atau menggagalkan refund yang salah, dan tidak menimpa `providerRef` refund yang sudah ada dengan ID payment.
5. `DOIT_REFUND_IDENTITY_MISMATCH` adalah flag lengket (`PAYOUT_IDENTITY_MISMATCH`): lookup unknown berikut dan batas percobaan tidak menggantinya, refund masuk himpunan eskalasi, dan audit `payment.refund_payout_identity_mismatch` ditulis sekali.
6. Event yang disimpan, bila diproses ulang dari payload tersimpan, menghasilkan fakta yang sama.

## Pertanyaan

- Cari bentuk jawaban (field hilang, tipe lain, string angka tidak kanonik, `object` lain, `id` sama dengan payment, `status` tak dikenal, replay dengan kunci lain) yang masih lolos sebagai sukses, pending, atau gagal tanpa bukti identitas.
- Apakah `failed` dari jawaban POST yang identitasnya cocok aman untuk melepas refund, atau perlu bukti tambahan?
- Cari jalur di mana `DOIT_REFUND_IDENTITY_MISMATCH` membuat refund berulang tanpa batas, atau hilang dari pandangan operator.
- Cari event webhook yang lewat perubahan (a) atau (b) lalu menyentuh refund yang salah.
- Laporkan P1/P2 dengan file:line, payload reproduksi, dan saran fix. Tulis hasil ke `docs/briefs/175b-second-opinion-doit-refund-parser.result.md`.
