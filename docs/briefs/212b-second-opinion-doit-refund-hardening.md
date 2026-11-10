# Brief 212b: second-opinion (Codex) — pengerasan refund DOIT (legend-2ol8g, legend-3usn8, legend-kl46s)

Tingkat K (uang). Review read-only. Jangan mengubah berkas, jangan commit, jangan `git add`, jangan checkout.

## Di mana
- Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/doit-refund-hardening`, cabang `ws/doit-refund-hardening`.
- Rentang diff: `git diff 94d769c6..ws/doit-refund-hardening` (base = ujung `milestone/m1` saat cabang dibuat; commit 3eeb3fa0, 7b2cdfae, fda5b7a1). Pakai tip cabang saat review. Bila cabang sudah digabung dan dihapus, cari commit-nya di `milestone/m1` lewat `git log --grep legend-3usn8`.

## Berkas berisiko
- `apps/api/src/services/payment-doit-refund-webhook.ts`: `readDoitRefundFacts`, `doitRefundWebhookEventSchema` (bentuk event tersimpan).
- `apps/api/src/services/payment-webhook.service.ts`: `processRefundEvent`, `findSettledOutsideTarget`, helper audit baru.
- `apps/api/src/services/payment-refund.service.ts`: langkah sebelum POST di `runRefundPayout` (pengganti `stillHoldsSendLease`), `settleRefundManually`.
- Test baru: `apps/api/src/test/payment-doit-refund-facts-invalid.test.ts`, `payment-doit-refund-facts-parse.test.ts`, `payment-refund-send-fence.test.ts`, `payment-refund-settled-fund-conflict.test.ts`.
- `apps/api/src/services/payment-doit.ts`: `call` (cek `sendBy` dan `signal.throwIfAborted()` tepat sebelum `doFetch`), `refund` (meneruskan `sendBy`).
- `apps/api/src/services/payment-refund-gateway.ts`: `GatewayRefundRequest.sendBy`.
- Test baru juga: `apps/api/src/test/payment-doit-refund-send-by.test.ts`. Fixture lama yang diubah: `payment-doit-refund-webhook.test.ts`, `payment-refund-manual-settle-webhook.test.ts` (menambah `payment_id`/`amount` pada event yang dimaksud sah).

## Invariant yang harus dipegang
1. Webhook refund DOIT (bentuk apa pun yang cocok lewat idempotency key atau id refund provider) hanya boleh menyelesaikan refund bila nominal refund yang dibawa sah (bilangan bulat rupiah) dan sama dengan refund, dan `payment_id` yang dibawa sah serta sama dengan payment sumber dana. Field yang tidak sah atau tidak ada tidak pernah menyelesaikan refund; event diparkir dan teraudit, lalu lookup provider pada sweep payout yang mengonfirmasi.
2. Event yang disimpan dan diproses ulang dari payload tersimpan berperilaku sama dengan pengiriman pertama.
3. Satu refund tidak pernah dibayar dua kali: settle manual oleh finance dan POST refund oleh worker saling meniadakan, termasuk saat worker tertahan (GC, VM suspend) di titik mana pun sebelum request keluar, juga di dalam adapter (kredensial, DNS) sebelum `doFetch`.
4. Refund yang sudah di-settle manual lalu menerima `refund.succeeded` dari DOIT selalu tercatat sebagai konflik provider, juga bila dana berasal dari payment lain (dana tak teralokasi) daripada payment utama intent. Kandidat harus unik; tidak pernah menebak.
5. Tidak ada perubahan skema.

## Yang diminta
Cari jalur yang masih melanggar invariant di atas: race, retry dari payload tersimpan, clock skew antar host, worker crash, bentuk payload DOIT lain. Tulis temuan sebagai P1/P2/P3 dengan file:baris dan skenario konkret.
