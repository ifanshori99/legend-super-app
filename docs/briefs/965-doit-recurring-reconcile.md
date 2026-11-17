# 965 DOIT recurring: cegah tagih dobel + alat reconcile

Kartu: legend-ycb85, legend-yqne1, legend-lch2o, legend-145n0. Kode: `apps/api/src/services/payment-recurring.service.ts` (startSubscription ~460, unresolvedSubscription ~1137, changeSubscription ~1161, markStartNeedsReconcile ~388), schema `apps/api/src/db/schema/payment-recurring.ts`, route `apps/api/src/routes/payment-recurring.routes.ts`, client `payment-doit-recurring.ts` + `payment-doit-recurring-wire.ts`.

Aturan uang: tidak ada jalur yang menandai langganan `active` dari alat reconcile. `active` hanya dari webhook `invoice.paid` terverifikasi atau resume yang sudah ada. Ragu = status tetap `needs_reconcile`. Tidak ada log rahasia/body DOIT.

## Potongan (file terpisah)

### P1 (legend-145n0) hanya `payment-webhook.service.ts`
`loadWebhookSecrets` (~208): satu integrasi AKTIF dengan kredensial rusak jangan mematahkan yang lain. `loadActiveIntegrationCredentials` (platform-integration.service.ts ~879) memetakan SEMUA baris aktif lalu `openCredentials`, jadi satu baris rusak melempar untuk semua. JANGAN ubah fungsi itu (dipakai pembuatan pembayaran; fallback diam-diam ke baris tenant = salah rekening). Di `loadWebhookSecrets`: per baris aktif DOIT dari `listIntegrations`, muat lewat `loadIntegrationCredentialsById` di try/catch per baris; gagal = `logger.warn({tenantId, integrationId, errName}, ...)` (tanpa pesan error yang bisa memuat rahasia, tanpa kredensial), lewati. Pastikan `listIntegrations` sendiri tidak melempar (periksa). Tes: tenant dengan 2 integrasi (satu rusak): webhook yang ditandatangani integrasi sehat tetap diproses; tenant lain tidak terpengaruh; log tidak memuat rahasia.

### P2 (legend-ycb85 + unique index dari legend-yqne1) schema + migrasi + jalur start
- `unresolvedSubscription()`: hapus pengecualian PLAN_MISMATCH; semua baris `needs_reconcile` (ber-id atau tidak) dan `provisioning` memblok start baru DAN resume baris lain. Hapus `isNull(providerSubscriptionId)` di pra-cek `startSubscription` (~523) supaya konsisten (pakai `unresolvedSubscription()`). Baris PLAN_MISMATCH baru bebas lagi setelah dibatalkan (`cancelled`).
- Migrasi baru `apps/api/drizzle/0500_recurring_unresolved_start_key.sql` (+ journal idx 432, snapshot via `pnpm db:generate`, tag `0500_...`): unique partial index `payment_recurring_subscriptions_unresolved_customer_plan_key` ON (tenant_id, plan_id, customer_profile_id) WHERE status IN ('provisioning','needs_reconcile'). SEBELUM index: blok `DO $$` yang menghitung grup duplikat dan `RAISE EXCEPTION` dengan jumlah grup (tanpa menghapus/mengubah data uang) agar deploy berhenti dan tim memutuskan; ikuti pola preflight di `apps/api/src/test/preflight-0301.test.ts`/migrasi preflight lain. Di schema Drizzle tambahkan index yang sama.
- `startSubscription` insert (`.onConflictDoNothing()` ~658): bila `inserted` kosong dan `raced` tidak ada (konflik index baru, bukan kunci sama) lempar `CoreError("CONFLICT", "Pelanggan ini sudah memiliki langganan untuk paket ini atau sedang diproses.")`, bukan KEY_REUSED.
- Registry: `apps/api/src/test/data-import-registry.test.ts` / tes cakupan tabel hanya bila tabel baru (tidak ada); cek tes yang menghitung indeks/migrasi.

### P3 (client DOIT) hanya `payment-doit-recurring.ts` + `payment-doit-recurring-wire.ts`
Kontrak DOIT ASSUMED (tandai di komentar). Tambah GET ke client (tanpa Idempotency-Key, aturan SSRF/DNS/redirect/error sama dengan `post`; refaktor transport bersama bila perlu):
- `getSubscription(providerSubscriptionId)`: GET `/v1/recurring/subscriptions/{id}` -> `DoitRecurringSubscription`.
- `findSubscriptionByReference(reference)`: GET `/v1/recurring/subscriptions?reference={uuid}` -> `{ data: DoitRecurringSubscription[] }` (skema baru di wire); kembalikan array (kosong = DOIT tidak punya).
Tes unit di `payment-doit-recurring-wire.test.ts` atau file baru bergaya sama.

### P4 (legend-yqne1 + legend-lch2o) SETELAH P2 dan P3 (file service sama)
Service `reconcileSubscription(context, subscriptionId, input: {action: "sync" | "abandon"}, now, deps)`; tambah `getSubscription`/`findSubscriptionByReference` ke `RecurringDeps` client mock bila perlu.
Syarat baris: tenant + outlet scope (`assertOutletInScope`), filter tenant di SQL; status `needs_reconcile`, atau `provisioning` yang lebih tua dari `START_RETRY_WINDOW_MS`. Lainnya: CONFLICT "tidak perlu direkonsiliasi".
- Ber-id DOIT, `sync`: GET status. Jawaban harus `id` sama dan `plan_id` = plan lokal `providerPlanId`, jika tidak baris tetap, kembalikan hasil `unresolved`. Pemetaan: DOIT cancelled/canceled -> `cancelled` (+`cancelledAt`, revoke grace seperti cancel biasa); paused -> `paused`; active/pending/status live lain -> turunan seperti resume (never paid -> `pending_first_payment`; punya periode berjalan -> `active`; selain itu `past_due`), TIDAK PERNAH `active` untuk yang belum pernah dibayar; status tak dikenal -> tetap `needs_reconcile`. Baris PLAN_MISMATCH: hanya bisa jadi `cancelled` bila DOIT sudah cancelled; selain itu tetap (gunakan cancel). Tolak bila start baru sudah memegang slot live (23505 -> CONFLICT).
- Tanpa id (`sync`, lch2o): `findSubscriptionByReference(row.id)`. 1 hasil sesuai plan -> simpan `providerSubscriptionId` (jika belum dimiliki baris lain), status `pending_first_payment` (atau `cancelled` bila DOIT cancelled), `reconcileReason` null, jangan pernah `active`; plan beda -> simpan id + `needs_reconcile` PLAN_MISMATCH; >1 hasil atau error -> tetap. 
- `abandon` (hanya tanpa id): hanya bila `findSubscriptionByReference` BERHASIL dan kosong -> `cancelled` lokal (tanpa panggilan cancel). Error/ada hasil -> ditolak. Baris ber-id: `abandon` ditolak (pakai cancel).
- Transisi lokal di satu transaksi dengan `FOR UPDATE`, ulangi syarat status/id di dalamnya.
- Route `POST /payments/recurring/subscriptions/:id/reconcile` meniru route pause/cancel (permission `payment.recurring.manage`, `requireTrustedOrigin`, body strict zod di `packages/shared/src/validators/` dengan subpath export bila file baru, DTO bila perlu). Tanpa izin baru, jadi tidak ada perubahan katalog izin.
- Tes: hasil gagal-dulu dari test-writer (`apps/api/src/test/payment-recurring-965-*.test.ts`); sesuaikan nama.

## Keputusan setelah P1-P3 (CTO engineer, ikut ini, menggantikan P4 di atas bila beda)

- Dua fungsi service terpisah, sesuai tes test-writer: `resolveNeedsReconcileSubscription(context, subscriptionId, now?, deps?)` (baris needs_reconcile BER-id, route `POST /payments/recurring/subscriptions/:id/resolve`) dan `reconcileExpiredStartIntent(context, subscriptionId, now?, deps?)` (INTENT_EXPIRED TANPA id, route `POST .../:id/reconcile-intent`). Aturan di P4 tetap (jangan pernah menulis `active`; id/plan beda = tetap needs_reconcile PLAN_MISMATCH; error DOIT = tolak, baris tidak berubah; filter tenant di SQL; CONFLICT tanpa panggilan DOIT bila status/id tidak sesuai; tanpa panggilan mutasi DOIT).
- Client nyata (P3, sudah ada): `getSubscription(id)` dan `findSubscriptionByReference(ref)` yang mengembalikan ARRAY (kosong = DOIT tidak punya, >1 = ambigu -> tolak, baris tetap). Service memetakan array ke satu/null; tes memakai mock `null`/objek: test-writer menyesuaikan mock ke array, implementer mengikuti client nyata.
- Index unik P2 satu set (provisioning + needs_reconcile) per tenant+plan+customer; tes lama yang menanam dua baris belum-selesai untuk pasangan sama diperbarui test-writer.
- Pastikan permission `payment.recurring.manage`, `requireTrustedOrigin`, body strict (kosong) dan tanpa log rahasia.
