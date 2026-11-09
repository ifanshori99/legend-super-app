# Sub-brief: DOIT getPayment (legend-6g29, tingkat K uang)

Worktree: `.worktrees/doit-get-payment`, cabang `ws/doit-get-payment`. Jangan push/merge. Jangan baca `.env*`.

## Fakta (sudah dipetakan)

- `PaymentProvider` (`packages/shared/src/adapters/providers.ts:234`) hanya diimplementasi `FakePaymentProvider`. DOIT hari ini hanya `PaymentGatewayPort` (`apps/api/src/services/payment-gateway.ts`), `getStatus` di `payment-doit.ts:602` memetakan `refunded` ke `pending` dan memotong `cancelled`.
- `PaymentResult` = `{reference, providerReference, status}`, status enum 6: pending, paid, expired, failed, cancelled, refunded.
- Status DOIT (docs publik https://doit.id/docs/en/): hanya 5: pending, paid, refunded, expired, failed. Skema `doitPaymentStatusSchema` di `payment-doit-wire.ts:102`. Nilai lain gagal parse -> `malformedProviderAnswer()` (SERVICE_UNAVAILABLE), jangan pernah jadi `paid`.
- DOIT `GET /v1/payments/{id}` memakai id DOIT (providerRef), bukan reference Legend. `payment.reference` = reference Legend.
- Verifier `verifyDoitSignature` (`payment-doit-wire.ts:550`) sudah cocok dengan docs: `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + raw body)>`, `timingSafeEqual`. JANGAN diubah. Dedupe event id: `services/payment-webhook.service.ts:1189` (`onConflictDoNothing`).

## Desain

1. `payment-doit-wire.ts`: tambah `doitPaymentToProviderStatus(status)` (switch lengkap 5 -> enum 6, `refunded` tetap `refunded`, tak dikenal throw `malformedProviderAnswer()`) dan `doitPaymentToProviderResult(payment): PaymentResult` (`reference: payment.reference`, `providerReference: payment.id`).
2. `payment-doit.ts`: tambah ke `DoitGateway` method `lookupPayment({context, outletId?, integrationId?, providerRef, reference}): Promise<PaymentResult>`: `GET /v1/payments/{providerRef}` lewat `requireCredentials` + `call`; tolak bila `payment.id !== providerRef` atau `payment.reference !== reference` (`malformedProviderAnswer()`). Di `call()` saat `schema.safeParse` gagal: `logger.warn({integrationId, paths}, "DOIT answer failed validation")`, `paths` = path issue saja, tanpa nilai/body.
3. File baru `apps/api/src/services/payment-doit-provider.ts`: `createDoitPaymentReader({gateway, resolve})` mengembalikan `Pick<PaymentProvider, "getPayment">`. `resolve(context, scopedRef)` -> `{providerRef, integrationId, outletId} | null` (injeksi, tidak menyentuh DB). `null` -> `CoreError("NOT_FOUND")`. Validasi input pakai `scopedReferenceSchema`; tenant context harus cocok `input.tenantId`. Galat jaringan/timeout/HTTP 5xx dilempar apa adanya (CoreError SERVICE_UNAVAILABLE), tidak mengubah status lokal (adapter ini tidak menulis apa pun).
4. Jangan sentuh refund, settlement, UI, `verifyDoitSignature`.

## Test (file baru `apps/api/src/test/payment-doit-get-payment.test.ts`, pakai pola server HTTP lokal di `payment-doit.test.ts:120-135`, helper `makeGateway`)

- tiap status DOIT -> status provider benar (pending, paid, expired, failed, refunded)
- status tak dikenal ("settled", "cancelled", "", angka, null) -> galat, tidak pernah `paid`, tercatat (spy logger)
- timeout/ECONNREFUSED/HTTP 500/502/429 -> galat SERVICE_UNAVAILABLE; resolve null -> NOT_FOUND
- id atau reference berbeda di jawaban DOIT -> ditolak
- tenant mismatch -> ditolak
- webhook (tambahan di file yang sama, bila belum ada di `payment-doit.test.ts:1504+`, cek dulu): tanda tangan salah, header kosong, tanda tangan dari body berbeda ditolak; event id ganda tidak diproses dua kali (lihat test dedupe yang ada di `payment-webhook*.test.ts`; bila sudah tercakup, cukup rujuk, jangan duplikat)
- Jalankan: `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/payment-doit-get-payment.test.ts" pnpm test'`
- Test harus gagal dulu (sebelum implementasi) lalu hijau.
