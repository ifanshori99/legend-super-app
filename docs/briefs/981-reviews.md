# 981 / legend-vqicf + legend-39d.5: tabel ulasan + AI-11 ringkasan

Catatan: tabel `feedback` (WS-08, migrasi 0209, `db/schema/crm-feedback.ts`) sudah ada untuk rating/keluhan yang DITANGANI staf (open/in_review/resolved/closed). Kartu ini membangun tabel ULASAN pelanggan terpisah (sumber + moderasi). Jangan ubah `feedback`.

## Kontrak (nama tetap, dipakai test-writer dan implementer)

Tabel `customer_reviews` di `apps/api/src/db/schema/customer-reviews.ts` (+ `.custom.sql`), export `customerReviews`, const `CUSTOMER_REVIEW_SOURCES`, `CUSTOMER_REVIEW_MODERATION_STATUSES`.

- `id` uuid default random; `tenant_id`, `outlet_id` NOT NULL (tenantIdColumn/outletIdColumn); PK (tenant_id, id).
- `order_id` ulidInUuid NULL (FK orders), `reservation_id` NULL (FK ke tabel reservasi, tenant composite), `customer_profile_id` uuid NULL (FK customer_profiles).
- `rating` int NOT NULL check 1..5; `body` varchar(2000) NULL (PII: tidak boleh dilog, tidak ke dashboard queue, tidak ke output AI).
- `source` varchar(16) check IN ('qr','app','web','google','manual').
- `moderation_status` varchar(12) check IN ('pending','published','hidden') default 'pending'; `moderated_by` text NULL; `moderated_at` timestamptz NULL; `moderation_note` varchar(500) NULL.
- `created_at` timestamptz default now.
- Index (tenant_id, outlet_id, moderation_status, created_at).
- Migrasi nomor 0545 (nama `0545_customer_reviews`), hand SQL: `app.enforce_tenant_rls` + `app.enforce_outlet_rls`, `REVOKE DELETE, TRUNCATE ... FROM legend_app`. FK inline di CREATE TABLE (bukan ALTER TABLE ADD CONSTRAINT). Kembalikan jurnal `_journal.json` idx berurutan dari 496 (cek bagaimana migrasi sebelumnya menomori; pakai tag 0545).
- Daftarkan di tes cakupan tabel dan `apps/api/src/test/data-import-registry.test.ts` / `config/data-import.ts` bila perlu.

Contract zod di `packages/shared/src/crm/customer-reviews.ts` (export subpath lewat `@starter/shared/crm` seperti feedback): `createCustomerReviewInput` (strict: outletId, rating, body?, source, orderId?, reservationId?), `listCustomerReviewsQuery` (limit, cursor/offset pola feedback, outletId?, moderationStatus?), `moderateCustomerReviewInput` (strict: status published|hidden|pending, note?), DTO `CustomerReviewDto` (tanggal ISO).

Service `apps/api/src/services/customer-review.service.ts`: `createCustomerReview`, `listCustomerReviews`, `moderateCustomerReview`; tenant filter di SQL + RLS; outlet scope dari ScopedTenantContext; body tidak dilog.
Route `apps/api/src/routes/customer-review.routes.ts` mount `/api/reviews` (pola `feedback.routes.ts`: requireTenantContext, requireAuth, requireTrustedOrigin, jsonBody):

- GET `/` izin `review.respond` (peran dan outlet sesuai RLS).
- POST `/` (entri manual, source tetap 'manual' dari staf) dan PATCH `/:id/moderation`: izin `crm.feedback.manage` (KEPUTUSAN PRODUK pembatas: moderasi hanya peran yang memegang crm.feedback.manage; perlu dilaporkan).
  Antrean dasbor `reviews` di `services/dashboard-run.service.ts` (~baris 827): baca dari tabel (pending dulu), tanpa `body`; perbarui `dashboards-api.test.ts` bila perlu.

## AI-11 (legend-39d.5)

Tool baru TL-21 `get_review_summary` (read-only), pola `read-b/tl-11-anomalies.ts`, katalog `packages/shared/src/ai/tools.ts`, ids `ids.ts`, schema `tool-io.ts`. Feature code `AI-11`. Peran minimum = yang punya `review.respond` (scope assigned_outlets), requiredPermissions `review.respond`, hanya outlet dalam `resolveOutletScope`. Hanya agregat: jumlah per outlet, rata-rata rating, sebaran 1..5, hitung tema dari leksikon tetap (makanan, pelayanan, harga, kebersihan, waktu tunggu) pada ulasan moderation_status != 'hidden'. TANPA teks mentah, nama, telepon, id pelanggan di output. Tool non-shared jika memuat data per outlet pribadi; pastikan scan PII `lib/ai/pii.ts` tetap berlaku. Perbarui hitungan katalog: `ai-eval-dataset.test.ts:171`, `ai-governance-api.test.ts:520` (20 -> 21), dataset eval, fixtures `packages/shared/src/ai/fixtures.ts`, label web minimal hanya bila test shared mewajibkan (catat sebagai sentuhan `apps/web`/kontrak). Tes root `tests/ai-contract.test.mjs` dan `text-contract` diperiksa.

## Batas

Jangan sentuh: refund/recon, payroll, POS kas/harga, edge, payment QR/Duitku, `apps/web` kecuali kontrak bersama wajib (catat). Jangan ubah `e2e/acceptance`. Jangan menjalankan tsc/vitest (token heavy dipegang agent utama).

## Kontrak final (setelah review architect)

- `source` pada POST dipaksa literal `"manual"` (qr/app/web/google dibuka lewat jalur anggota/impor nanti, bukan staf).
- PATCH `/:id/moderation` wajib `expectedStatus` (status saat ini yang dilihat staf). Nilai basi: 409 `REVIEW_STATUS_CONFLICT`, tidak menimpa moderasi staf lain.
- GET `/` butuh `review.respond`; POST dan PATCH butuh `crm.feedback.manage`.
- POST memeriksa outlet milik tenant (404 bila bukan).
- Kursor daftar memakai `date_trunc('milliseconds', created_at)` + `id`.
- `customer_profile_id` belum dijaga `app.enforce_member_rls`: tambahkan sebelum ada rute anggota/QR yang membacanya.
