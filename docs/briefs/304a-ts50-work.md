# 304a: kerja bersama legend-ts50 (Customer 360, RFM, feedback)

Sumber: `docs/briefs/290d-ts50-customer360-segments-feedback.md`, `docs/briefs/290-aturan-bersama.md`, `docs/design/ws08-member-loyalty.md`. Worktree ini: `.worktrees/ts50-customer360`, cabang `ws/ts50-customer360`. Perubahan dari 290d: migrasi `0209`, `when` 1794288000000 (setelah 0208 `when` 1794287000000, idx 209), nama berkas test seperti 290d. Jangan commit, jangan push (agent induk yang commit). Hanya edit berkas milik potonganmu.

## Fakta yang sudah dicek
- Kontrak sudah ada: `packages/shared/src/crm/crm.ts` (segment 45-104, feedback 312-445, customer360Schema 488, segmentPreviewSchema 533) dan `endpoints.ts` (submitFeedback 322, listCustomers 339, getCustomer360 344, segments 649-676, listFeedback 738, updateFeedback 749). Izin `crm.customer.view`, `crm.customer.pii.read`, `crm.segment.manage`, `crm.feedback.manage` sudah ada di `access/permissions.ts` dan `roles.ts`. Kode error feedback/segmen belum ada di `errors.ts`.
- `feedbackSchema` belum punya `handledNote`. Tambah aditif (nullable) bila perlu.
- Pola: skema `db/schema/crm-member.ts`, `crm-ledger.ts`; `db/member-scope.ts` `withMemberScope`; `middleware/member.ts` `requireMember({allow})`; rantai rute member di `routes/member.routes.ts:40-42`; `requireTenantPermission` (`middleware/permissions.ts:126`); `recordAudit` (`services/core-audit.ts`, contoh `services/loyalty-program.service.ts:209`); `sealSecret`/`openSecret` `lib/secrets.ts`; `userIdentities.valueEncrypted` `db/schema/identity.ts:59`; lookup nomor `services/pos-order-customer.service.ts`; job harian contoh `worker/loyalty-balance-check.job.ts` dan `worker-main.ts:497`; `orders` `db/schema/qr-order.ts:185`; `sessionParticipants` `db/schema/floor.ts`.
- Migrasi: `enforce_member_rls` didefinisikan `drizzle/0203_member_loyalty_ledger.sql:268`; contoh pemakaian `0207_loyalty_rewards_missions.sql:180-184`. SQL custom ditulis di `db/schema/<tabel>.custom.sql` lalu disalin manual ke migrasi bernomor (pola `0181_sales_targets.sql`).
- Test helper: `src/test/member-loyalty-helpers.ts` (`createWorld`, `seedProgram`, `seedProfile`, `seedConsent`, `seedMember`, `asTenant`, `contextOf`), `member-rewards-helpers.ts`, `helpers.ts`; contoh isolasi `member-isolation.test.ts:149-185`. Outlet baru wajib `opening_hours` valid. Data milik sendiri saja.

## Aturan data pribadi
- Nomor WhatsApp di Customer 360: termasking default. Nomor penuh hanya bila pemanggil punya `crm.customer.pii.read`, dibaca dari `user_identities.value_encrypted` (`openSecret`), dan tiap pembukaan menulis audit. Jangan pernah ada di respons/log tanpa izin itu.
- Error order milik orang lain: 404 `NOT_FOUND` umum (bukan `CUSTOMER_NOT_FOUND`).
- Layanan member tidak pernah membaca profil dari path/query/body; rute member tidak mengimpor `withTenant`.

## Potongan
1. Skema + migrasi 0209: `db/schema/crm-feedback.ts`, `crm-segments.ts`, `crm-*.custom.sql`, `db/schema/index.ts`, `drizzle/0209_*.sql`, `drizzle/meta/*`. Tabel `feedback` (T+O, `handled_note`, PK `(tenant_id,id)`, FK komposit ke `customer_profiles` dan `orders`, unique `(tenant_id,order_id,customer_profile_id,kind)`, `outlet_id NOT NULL`, tenant+outlet+member RLS), `segments` (T), `segment_members` (T). Grant legend_app SELECT/INSERT/UPDATE.
2. Kontrak kecil: `packages/shared/src/crm/errors.ts` (kode baru bila perlu, mis. `FEEDBACK_DUPLICATE`), `crm.ts` (`handledNote`).
3. Feedback: `services/feedback.service.ts`, `routes/member-feedback.routes.ts`, `routes/feedback.routes.ts`.
4. Customer 360 + favorit: `services/customer360.service.ts`, `services/member-favorites.service.ts`, `routes/customers.routes.ts`.
5. Segmen: `services/segments.service.ts`, `routes/segments.routes.ts`, `worker/segment-materialize.job.ts`.
6. Registri: `routes/index.ts`, `worker-main.ts`, `db/schema/index.ts` (pemegang: potongan 1 untuk schema index; agent induk untuk dua lainnya).
