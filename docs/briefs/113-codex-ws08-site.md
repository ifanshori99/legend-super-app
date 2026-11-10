# Brief 113: Codex second-opinion WS-08 situs, delivery, CRM (tingkat K)

Peran: second-opinion. Baca `~/.agents/team/roles/second-opinion.md`.
Cabang: `ws/ws08-site` 0800ac71 (sudah merge `milestone/m1`). Hanya baca, jangan commit.
Diff: `git diff milestone/m1...ws/ws08-site -- <file>`. Abaikan test, fixture, dan `drizzle/meta`.
Tulis temuan P0-P3 dengan file:line dan skenario gagal ke `docs/reviews/codex-ws08-<run>.md`.

## Run A (uang): delivery ingest dan inject ke POS
`apps/api/src/services/delivery-ingest.service.ts`, `delivery-inject.ts`, `routes/delivery-webhook.routes.ts`, `packages/shared/src/adapters/delivery-webhook.ts`.
Cek: tanda tangan webhook, duplikat dan replay, pesanan masuk POS+dapur satu transaksi, cancel platform void POS, race dengan dapur.

## Run B (uang + akses data): order, rekonsiliasi, store index
`delivery-orders.service.ts`, `delivery-reconciliation.service.ts`, `delivery-store.ts`, `delivery-channels.service.ts`, `drizzle/0102_ws08_delivery.sql`, `0105_delivery_store_index_rls.sql`, `db/schema/delivery.custom.sql`.
Cek: `app.resolve_delivery_store` SECURITY DEFINER (search_path, hanya satu baris), komisi, panggilan platform di dalam transaksi (desync), RLS.

## Run C (akses data + uang kecil): situs publik, DP link, promo
`public-site.service.ts`, `routes/website-admin.routes.ts`, `drizzle/0099_brand_websites.sql`, `reservation-deposit-resend.ts`, `crm-promo-idempotency.ts`, `crm-promo-outlets.ts`.
Cek: kolom internal bocor ke publik, policy `tenant_wide_only`, link DP bisa dipakai ulang/ditebak, idempotensi promo dan allowlist outlet.

Laporan: jumlah temuan per tingkat, 3 teratas, path berkas review.
