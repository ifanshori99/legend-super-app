# Sub-brief 175: parser refund DOIT (legend-r7g2)

Worktree `.worktrees/doit-refund-parser`, cabang `ws/doit-refund-parser` dari m1 5e227f59. Jangan edit service (engineer yang mengedit). Jalankan test: `LEGEND_TEST_FILES="src/test/<file>" pnpm test` dari root worktree.

## Bug P1 (Codex 117 Run A)
`parseDoitRefundAnswer` (`apps/api/src/services/payment-doit-wire.ts:423`): jawaban 2xx `POST /v1/payments/{paymentProviderRef}/refunds` (header `Idempotency-Key: refund:<refundId>`). Bila `id !== paymentProviderRef` jawaban dianggap objek refund dan diterima tanpa bukti identitas. Contoh: refund Rp50.000 untuk `pay_EXPECTED`/`intent_EXPECTED` menerima `{id:"pay_OTHER",status:"refunded",amount:50000,reference:"intent_OTHER"}` sebagai sukses.

## Aturan baru (yang diuji)
- Objek refund (`id !== paymentProviderRef`, atau `object === "refund"`) sukses/pending/failed hanya bila:
  - `payment_id` ADA dan sama dengan `paymentProviderRef`;
  - `amount` ADA dan sama dengan nominal permintaan (angka, atau string bilangan bulat kanonik pada replay);
  - `idempotency_key`, bila ada, sama dengan kunci permintaan (`refund:<refundId>`);
  - `reference`, bila ada, sama dengan `paymentIntentId`.
- `object`, bila ada, harus `"refund"` atau `"payment"` dan cocok dengan cabangnya.
- Selain itu: lempar `DoitRefundUnknownError`; mismatch identitas memakai kode `DOIT_REFUND_IDENTITY_MISMATCH`, bentuk tak dikenal tetap `DOIT_REFUND_UNRECOGNIZED`.
- `parseDoitRefundAnswer(payload, { paymentProviderRef, paymentIntentId, amountIdr, idempotencyKey })` (parameter baru `idempotencyKey`).
- Bentuk sandbox nyata (`payment-doit-refund-sandbox-shapes.test.ts`): 201 `{id:"rf_…", payment_id, amount:number, status, reason}`; 200 replay menambah `idempotency_key`, `provider_ref`, `created_at`, `amount` string. Keduanya tetap diterima.

## Webhook P2 (Codex 117 Run B), dikerjakan
- (a) `payment-doit-refund-webhook.ts:~115`: objek `object:"refund"` yang juga membawa `reference` tidak boleh dibaca sebagai objek payment. Skenario: R approved (sumber `pay_actual`), webhook `refund.failed` `{object:"refund", id:"rf_actual", idempotency_key:"refund:<R>", reference:"<intentId>", status:"failed", amount:100000}` → R `failed` (sekarang: event `ignored/REFERENCE_MISMATCH`, R tetap approved).
- (b) `payment-webhook.service.ts:~974`: jalur `payment_object` tidak boleh menimpa `providerRef` refund yang sudah ada dengan ID payment. Skenario: R approved, `providerRef="rf_actual"`, intent `pay_actual`; webhook `{id:"pay_actual", reference:"<intentId>", status:"refunded", amount:100000}` → R `completed` dengan providerRef tetap `rf_actual` (sekarang: `ignored/REJECTED_CONFLICT`). Test lama `payment-doit-refund-webhook.test.ts:~880-990` men-seed providerRef = ID payment, sehingga celah tak terlihat.

## Test yang ditulis
T1 (parser, `apps/api/src/test/payment-doit-refund.test.ts` dekat test parser :237/:264): (1) contoh Codex di atas → unknown `DOIT_REFUND_IDENTITY_MISMATCH`; (2) objek refund tanpa `payment_id` → unknown; (3) objek refund tanpa `amount` → unknown; (4) `idempotency_key` beda → unknown; (5) `reference` intent lain → unknown; (6) `object:"payment"` dengan id lain → unknown; (7) bentuk 201 dan 200 sandbox tetap succeeded/pending; jalur end-to-end bila ada (refund berstatus tetap `approved` dengan `lastPayoutError` kode di atas, bukan `completed`). Fixture lama `refundObject` (tanpa `payment_id`) diperbarui mengikuti bentuk sandbox.
T2 (webhook, `apps/api/src/test/payment-doit-refund-webhook.test.ts`): skenario (a) dan (b).
Semua test baru harus GAGAL di kode lama; laporkan baris kegagalannya.
