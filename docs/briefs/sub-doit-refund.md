# sub-doit-refund (bd legend-0ogy, WS-05, tingkat K uang)

Worktree: `.worktrees/doit-refund`, cabang `ws/doit-refund`. Semua path di bawah relatif ke `apps/api/src/`.

## Tujuan

Refund yang sudah `approved` benar-benar dibayar lewat DOIT, hasil async DOIT (webhook `refund.*` dan poll) menutup refund, tanpa pernah membayar dua kali dan tanpa melanggar karantina (`PAYOUT_QUARANTINED`).

## Fakta kontrak DOIT (docs resmi https://doit.id/docs/en/#refund, dibaca 9 Nov 2026)

- `POST /v1/payments/{paymentId}/refunds`, header `Idempotency-Key` wajib, body `{ "amount": <int IDR, opsional, default penuh>, "reason": "<text>" }`.
- Kunci idempotensi yang sama: DOIT mengembalikan hasil asli (HTTP 200), tidak membuat transaksi baru. Masa simpan kunci TIDAK didokumentasikan.
- Hanya payment berstatus `paid` yang bisa direfund. Refund parsial boleh berulang sampai total = jumlah asli. Payment lifecycle: `paid -> refunded`.
- Error: `{ "error": { "code", "message", "doc_url" } }`. Kode relevan: `409 payment_not_refundable`, `400 invalid_refund_amount`, `502 provider_refund_failed` (penolakan definitif dari bank/provider), `404 payment_not_found`, `429 rate_limited`, `500 internal_error`, `503 service_unavailable` (sementara, ulangi dengan kunci sama).
- TIDAK didokumentasikan: bentuk objek respons refund, endpoint GET refund, isi `data` webhook `refund.succeeded` / `refund.failed` (event lain: `data` = objek payment utuh; `payment.proof_uploaded` = payment + field `proof`).

Karena itu adapter wajib fail-safe: tiap bentuk yang tidak dikenali = hasil TIDAK DIKETAHUI (throw), bukan sukses atau gagal.

## Invarian (wajib, semua potongan)

1. Tidak pernah dua kali bayar. `getRefundStatus` DOIT TIDAK PERNAH mengembalikan `not_found` (DOIT tak punya GET refund; masa simpan kunci tak diketahui). Akibatnya `refund()` hanya terpanggil pada percobaan pertama; hasil tak diketahui berakhir di rekonsiliasi manual oleh sweep yang sudah ada.
2. `failed` hanya untuk penolakan definitif pada kiriman pertama: HTTP 409 kode `payment_not_refundable`, 400 kode `invalid_refund_amount`, 502 kode `provider_refund_failed`. `paymentProviderRef` null (intent manual, tidak terkirim sama sekali) BUKAN penolakan: throw kode `DOIT_PAYMENT_REF_MISSING`. Status lain, kode lain, body tak terbaca, timeout, abort: throw (`CoreError` tanpa teks provider; 400/409/502 yang bukan penolakan memakai kode `DOIT_HTTP_<status>`).
3. Selalu kirim `amount` eksplisit (= `amountIdr`), jangan andalkan default penuh.
4. Kredensial: refund memakai integrasi yang mencetak payment intent aslinya (`integrationId` intent), sama seperti `getStatus`. Tanpa integrasi aktif: throw SERVICE_UNAVAILABLE.
5. Karantina tidak disentuh: logika `claim.send`/`keepQuarantine` di `payment-refund.service.ts` tetap. Webhook/poll yang melaporkan hasil untuk refund berkarantina tetap lewat `applyRefundProviderUpdate` (provider otoritatif; fungsi itu sudah menangani).
6. Webhook: hanya diproses setelah verifikasi tanda tangan yang sudah ada, dan integrasi yang memverifikasi HARUS integrasi yang mencetak payment intent milik refund itu (pola `signedByIntentIntegration`); beda = `ignored` + `REFERENCE_MISMATCH` + audit, tanpa menulis refund. Cek lintas integrasi `MISMATCH_AUDIT_FIELDS` tetap utuh.
7. Jangan log body, header, kunci, atau secret (PAY-06). Log hanya integrationId, status HTTP, kode error DOIT (string ≤ 64, pola `^[a-z_]+$`).
8. Tidak ada migrasi. `pnpm db:generate` harus kosong.

## Potongan dan pemilik berkas (tidak bertumpuk)

### A. Adapter + port (implementer A)

Berkas: `services/payment-refund-gateway.ts`, `services/payment-refund.service.ts` (hanya tempat memanggil port), `services/payment-doit.ts`, `services/payment-doit-wire.ts`.

1. Port: tambah ke `GatewayRefundRequest` field `integrationId: string | null` (integrasi pencetak intent) dan `outletId: string`. Tambah ke input `getRefundStatus`: `paymentIntentId`, `paymentProviderRef: string | null`, `integrationId: string | null`, `outletId: string`, `amountIdr: number`. Update komentar kontrak. `test/refund-fake-gateway.ts` harus tetap kompilasi tanpa diubah (field tambahan diabaikan).
2. Service: isi field baru dari data yang sudah dibaca saat claim (intent milik refund). Jangan ubah logika claim/lease/karantina.
3. `createDoitGateway` juga mengimplementasikan `PaymentRefundPort` (`provider: "doit"` sama), memakai `resolve`/`call` yang ada. Perluas `call` agar bisa mengembalikan kode error DOIT untuk status tertentu (baca body maks 4 KB, parse `{error:{code}}`, kode tak valid = null) tanpa mengubah perilaku pemanggil lama. Hormati `input.signal` (gabung dengan timeout internal via `AbortSignal.any`).
4. `refund()`: `POST /v1/payments/${encodeURIComponent(paymentProviderRef)}/refunds`, `Idempotency-Key: input.idempotencyKey`, body `{ amount: amountIdr, reason }` (reason dipotong 255 karakter). Respons 2xx diparse longgar (skema baru di wire):
   - Objek refund (punya `id` string ≠ paymentProviderRef, `status`): `succeeded|success|completed|refunded` -> succeeded; `pending|processing|requested` -> pending; `failed` -> failed (kode `DOIT_REFUND_FAILED`). Field `amount` ada dan ≠ amountIdr -> throw.
   - Objek payment (`id` = paymentProviderRef dan punya `reference`): status `refunded` dan `amount` = amountIdr -> succeeded, providerRef = payment id; lainnya -> throw (kode `DOIT_REFUND_UNRECOGNIZED`).
   - Bentuk lain -> throw (`DOIT_REFUND_UNRECOGNIZED`).
5. `getRefundStatus()`: providerRef refund ada dan bukan payment id -> tetap pakai GET payment (tak ada GET refund). `GET /v1/payments/{paymentProviderRef}`; id harus sama dan `reference` = paymentIntentId, kalau tidak throw. Status `refunded` dan `amount` = amountIdr -> `succeeded` (providerRef = providerRef refund bila ada, kalau tidak payment id). Selain itu throw (`DOIT_REFUND_STATUS_UNKNOWN`). paymentProviderRef null -> throw. Tidak pernah `not_found`.

### B. Webhook refund (implementer B)

Berkas: `services/payment-webhook.service.ts`, berkas baru `services/payment-doit-refund-webhook.ts` (parser + pencocokan murni bila perlu).

1. `refund.succeeded` / `refund.failed` lolos gerbang `isDoitPaymentEvent` (jalur lain tetap `ignored`). Simpan payload ter-validasi (terbatas, tanpa field tak dikenal) agar worker retry bisa memproses ulang.
2. Parser longgar `data`: `idempotency_key` (di `data` atau `data.refund`), refund id (`data.refund.id`, atau `data.id` bila `data.object === "refund"`), payment (`data` punya `reference` dan status payment, atau `data.payment`), `amount`, kode gagal (`data.failure_code` / `data.refund.failure_code`, opsional).
3. Pencocokan, berurutan, berhenti di yang pertama:
   a. `idempotency_key` cocok `refund:<uuid>` -> `applyRefundProviderUpdate({ idempotencyKey, providerRef: refundId?, status, code, amountIdr? })`.
   b. refund id ada -> `applyRefundProviderUpdate({ providerRef: refundId, status, ... })`.
   c. Hanya `refund.succeeded` dengan objek payment berstatus `refunded`: kandidat = refund `approved` milik intent dengan providerRef payment = `data.id`. Tepat satu kandidat, `amountIdr` kandidat = `data.amount`, dan tidak ada refund lain non-`failed` untuk intent itu -> apply dengan `idempotencyKey: "refund:<id>"`, `providerRef: data.id`. Selain itu tidak cocok.
   d. Tidak cocok: perlakukan seperti `UNKNOWN_REFERENCE` yang sudah ada (`failed` dalam 15 menit agar DOIT mengirim ulang, lalu `ignored` kode `REFUND_UNMATCHED`).
   `refund.failed` TIDAK PERNAH memakai jalur c.
4. Sebelum apply: integrasi yang memverifikasi harus integrasi pencetak intent refund itu (invarian 6).
5. Hasil: sukses -> `processed`; 409 dari apply -> `ignored` kode `REJECTED_CONFLICT`; 404 -> jalur d; error lain -> `failed` (retry yang ada).

### C. Wiring (engineer sendiri)

`server.ts` dan `worker-main.ts`: `const doit = createDoitGateway(); setPaymentGateway(doit); setPaymentRefundGateway(doit);`. Sweep `sweepApprovedRefundPayouts` yang sudah ada adalah poll job refund approved + provider pending (via `getRefundStatus`); tidak perlu job baru.

### D. Test (test-writer, dari brief ini, tidak menunggu kode)

- T1 `test/payment-doit-refund.test.ts`: unit adapter, `fetch` palsu (pola `test/payment-doit.test.ts`). Kasus: body+header+path benar; amount eksplisit; tiap mapping status 2xx; 409/400/502 dengan kode -> failed; 502 tanpa kode, 429, 500, 503, timeout, abort, body rusak -> throw; amount beda -> throw; ref null -> throw `DOIT_PAYMENT_REF_MISSING`; integrasi pencetak dipakai; `getRefundStatus` tidak pernah `not_found` (paid, refunded parsial, 404, ref null); tidak ada body/secret di log.
- T2 `test/payment-doit-refund-webhook.test.ts`: integrasi DB (pola `test/payment-webhook-api.test.ts` + seed refund dari `test/payment-refund-approval.test.ts`/`payment-refund-codex-fix.test.ts`). Kasus: webhook bertanda tangan `refund.succeeded` dengan idempotency key -> refund `completed`, event `processed`; replay -> `duplicate`; `refund.failed` -> refund `failed` alasan `provider_declined`; secret integrasi lain -> tidak ada perubahan refund, `ignored`; tak cocok -> `failed` lalu `ignored REFUND_UNMATCHED` setelah 15 menit; jalur c payment object penuh tepat satu kandidat -> completed, dua kandidat -> tidak berubah; `refund.failed` dengan payment object -> tidak berubah; refund berkarantina + `refund.succeeded` -> completed dan tidak ada panggilan `refund()`; sweep: refund approved + pending, DOIT GET payment `refunded` jumlah sama -> completed, status `paid` -> tetap approved dan `refund()` tidak dipanggil lagi.

## Bukti selesai

- `LEGEND_TEST_FILES="src/test/payment-doit-refund.test.ts src/test/payment-doit-refund-webhook.test.ts src/test/payment-doit.test.ts src/test/payment-webhook-api.test.ts src/test/payment-webhook-retry-integration.test.ts src/test/payment-refund-approval.test.ts src/test/payment-refund-codex-fix.test.ts src/test/payment-refund-review-fix.test.ts src/test/payment-admin-api.test.ts" pnpm test` dari root worktree: hijau.
- Typecheck `apps/api` dan eslint berkas berubah lewat `heavy`. `pnpm db:generate` kosong.
