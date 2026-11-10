# Brief 290a: engineer K — legend-111j profil, consent, buku poin

Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §2 (M1, M4, M5, M6, M7), §3 (tabel 0193), §6 (risiko 5), §7, §8. Aturan bersama: `docs/briefs/290-aturan-bersama.md`. Desain menang; aturan bersama merinci. Bila beda, tulis TBD-verify di laporan. Jika kontrak `packages/shared/src/crm/*` berbeda dengan desain, kontrak yang menang.

## Peran

- Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`.
- Tingkat K (uang, akses, migrasi). Model: Opus 5.5, effort high.
- Review tingkat K: satu subagent `architect` (bukan reviewer biasa).

## Repo dan cabang

- Worktree: `.worktrees/ws08-111j` dari `milestone/m1`, cabang `ws/ws08-111j`.
- Jalankan `pnpm worktree:setup` sekali setelah membuat worktree.
- Commit lokal saja. Jangan push, jangan merge ke `milestone/m1`.
- Tanpa rahasia di commit. Jika butuh kunci, pakai `ghostex secret request`.

## Aturan bersama

- Migrasi: `pnpm db:generate`, ganti nama berkas ke `0193`, `when` = `1794272000000`. `idx` ikut urutan jurnal cabang, `prevId` = snapshot terakhir di m1 (pola 0174/0176/0178 di `docs/PROGRESS.md`). Migrasi ini mengubah data (seed, backfill): daftar di `MIGRATION_DATA_STATEMENTS` (pola 0186). Merge train menomori ulang bila urutan merge berubah.
- Berkas registri bersama (hanya tambah, tiap tambahan di blok sendiri dengan komentar `legend-111j`): `packages/shared/src/crm/endpoints.ts`, `packages/shared/src/crm/errors.ts`, `packages/shared/src/crm/events.ts`, `packages/shared/src/crm/loyalty.ts`, `packages/shared/src/access/permissions.ts`, `packages/shared/src/access/roles.ts`, `apps/api/src/db/schema/index.ts`, `apps/api/src/routes/index.ts`, `apps/api/src/worker-main.ts`, `apps/api/src/db/backfill-tenant-defaults.ts`. Tiap berkas dipegang SATU subagent.
- Izin baru (`permissions.ts` + `roles.ts`): `crm.loyalty.manage` (program, tier, reward, misi: owner, manager), `crm.loyalty.review` (anomali saja), `crm.loyalty.fulfil` (kasir memasukkan kode penukaran), `crm.customer.pii.read` (buka nomor penuh), `crm.feedback.manage` (antrean feedback). Izin yang sudah ada: `crm.customer.view`, `crm.consent.record`, `crm.segment.manage`.

## Tujuan

1. Profil member: `customer_profiles` (T), satu baris per `(tenant_id, user_id)`, dengan `points_balance >= 0` dan status enum. Profil dibuat saat consent loyalty diberikan: `active` bila WhatsApp terverifikasi, selain itu `pending_verification`. Sinkron `marketing_opt_in`. Counter: `visits_count`, `lifetime_spend_idr`, `first_visit_at`, `last_visit_at`.
   - Guard member (`requireMember`) punya tiga nilai `allow`:
     - `"signup"`: profil boleh belum ada. Hanya `POST /api/member/consents` (yang membuat profil).
     - `"pending"`: status `pending_verification` atau `suspended`. Dipakai `GET /api/member/profile` dan `GET /api/member/overview`.
     - Default: hanya `active`.
   - `GET /api/member/consent-policies` tidak memakai `requireMember`. Cukup `tenantContext` + `requireAuth`.
   - Profil `closed`: 404 `CUSTOMER_NOT_FOUND`.
2. Consent versi kebijakan: tabel `consent_policy_versions`, seed `2026-01` untuk `loyalty`, `marketing`, `ai` lewat backfill dan provisioning tenant. `recordMemberConsent` di `consent.service.ts` dengan source `member_pwa` (§M7). Grant versi lama gagal 409 `CONSENT_POLICY_OUTDATED`. Withdraw loyalty menjadi `suspended`. Consent loyalty yang diberikan lagi pada profil `suspended` mengembalikan status: `active` bila WhatsApp terverifikasi, selain itu `pending_verification`.
   - `onWhatsAppVerified(tx, userId, whatsappHash)` di `services/member-profile.service.ts`: untuk tiap profil user, isi `whatsapp_hash` dan `whatsapp_verified_at`. Profil `pending_verification` menjadi `active` bila consent loyalty aktif. Dipanggil 290b (lihat brief 290b).
3. Buku poin append-only `point_ledger` dengan trigger, saldo dijaga database, dan `withProfileLock` (§M5, LOY-01..02).
   - Nilai poin: trigger `BEFORE INSERT` di `point_ledger` membaca program (`FOR SHARE` bila sudah terkunci; `FOR UPDATE` lalu isi `point_value_locked_at` bila belum), menyalin `point_value_idr`, dan menghitung `liability_idr`. Trigger di `loyalty_programs` menolak ubah `point_value_idr` bila terkunci.
4. Earn dan reverse dari `order.paid`, `order.refunded`, dan `order.voided` lewat consumer `loyalty-earn` (§M6). Pendapatan kotor dihitung tanpa servis dan PBJT.
   - Void: `order.voided` dengan `voidedFinalOrder: true` (`pos-order-corrections.ts:328-342`) membalik semua poin sisa: baris `reverse`, `source_type='void'`, `source_id` = `voidId`. Tambah `'void'` ke source reverse di `packages/shared/src/crm/loyalty.ts:321-325` dan `crm/events.ts:83` (kontrak aditif).
   - Refund: `refundEligible = max(0, grossSalesIdr − discountIdr − refundPointsIdr)` dari payload `order.refunded`. Reverse yang hasilnya 0 tidak ditulis (CHECK tanda).
   - Order QR lunas: belum ada jalur void atau refund. Refund sistem QR memancarkan `payment.refunded` tanpa `orderId`. Tes gagal-dulu "order QR lunas lalu refund sistem: poin tidak tertinggal", atau TBD-verify yang menjelaskan kenapa tidak mungkin terjadi.
5. Lampirkan member ke order: `PUT /api/pos/orders/:orderId/customer` (staf) dan token QR HMAC 120 detik (§M6). Kolom `customer_profile_id` dan atribusi hanya di `orders` (`apps/api/src/db/schema/qr-order.ts:184`, tabel order tunggal semua kanal). Tidak ada kolom baru di `pos_orders`.
   - Order dengan sesi member aktif (`pwa_session`) di-attach otomatis.
   - `customer_attached_by` = NULL untuk `pwa_session` dan `receipt_claim`. Kalau tidak, larangan swalayan memblok semua order QR member.
6. Anti-fraud: batas harian per `businessDate` lintas outlet, larangan swalayan (staf tidak dapat poin dari transaksinya sendiri), tabel `loyalty_anomalies` (T saja, `outlet_id` nullable untuk `balance_mismatch`), dan job malam `balance_mismatch` (`worker/loyalty-balance-check.job.ts`).
   - Cari nomor HP di kasir: batas per kasir per hari `loyalty_programs.phone_lookup_daily_cap_per_cashier` (default 20). Lewat batas: tolak dengan pesan "Pakai QR member" dan catat anomali `phone_lookup_cap_hit`.
7. RLS member: `app.member_profile_id()`, `app.enforce_member_rls(regclass, column name default 'customer_profile_id')`, `withMemberScope`. Di 290a dipasang di `customer_profiles` (kolom `id`), `point_ledger`, `customer_visits`, dan `consents` (kolom `subject_id`). Tabel 290c dan 290d (`reward_redemptions`, `mission_progress`, `vouchers`, `feedback`) dipasang oleh kartunya masing-masing. `referrals` punya kebijakan khusus di 290e.
8. Konsumen earn: `services/loyalty-earn-consumer.ts` plus tiga berkas langkah kosong. 290a membuat ketiganya: `services/loyalty-earn-mission-step.ts` (milik 290c), `services/loyalty-earn-tier-step.ts` dan `services/loyalty-earn-referral-step.ts` (milik 290e). 290c dan 290e hanya mengisi berkas langkahnya, tidak mengedit konsumen.
   - Antarmuka langkah (290a menulis tipe dan stub; 290c dan 290e mengisi):
     - `EarnStepContext = { tx, tenantId, profile (baris terkunci), program, order: { id, outletId, channel, businessDate, paidAt, eligibleSpendIdr }, record }`.
     - `loyalty-earn-tier-step.ts`: `tierMultiplierBp(ctx): Promise<number>`. Stub mengembalikan 10000. Dipanggil sebelum `pointsForSpend`.
     - `loyalty-earn-mission-step.ts`: `afterVisit(ctx): Promise<void>`. Stub kosong.
     - `loyalty-earn-referral-step.ts`: `afterVisit(ctx): Promise<void>`. Stub kosong. Mengunci profil referrer SESUDAH profil referee. Deadlock diulang oleh konsumen (savepoint per event).
     - Langkah berjalan di transaksi konsumsi, di bawah kunci profil, dan menulis ledger hanya lewat `point-ledger.service.ts`. Replay tidak memanggil langkah (berhenti di langkah 2).
9. Kolom `loyalty_programs.referral` dibuat di 290a (0193). 290e hanya membaca dan menulisnya.
10. Status `pending_verification`: dari rute 290a hanya `GET /api/member/profile`, `POST /api/member/consents`, dan `GET /api/member/consent-policies` yang boleh. Rute lain 403 `MEMBERSHIP_NOT_ACTIVE`.
11. CHECK `adjust` (tabel `point_ledger`): restore (`reverses_entry_id` terisi) wajib `expires_at` NULL. Adjust manual positif (`reverses_entry_id` NULL) wajib `expires_at`. Semua adjust wajib `reason`.

## Bergantung pada

- `legend-zk25` (kontrak CRM, sudah selesai di m1).
- Tidak bergantung pada 290b. Sign-in tidak diperlukan untuk migrasi 0193.

## Paralel dengan

- 290b (k2l) jalan paralel. Slice merge di 290b rebase setelah 290a selesai.
- Jangan sentuh berkas identity (`apps/api/src/lib/auth.ts`, `identity-*.service.ts`) di sini.

## Migrasi

Isi (§3):

- `loyalty_programs` (T): unik `(tenant_id)`. `is_active` default **false**. `point_value_locked_at` dikunci trigger setelah baris ledger pertama. Kolom `referral` dan `phone_lookup_daily_cap_per_cashier`.
- `customer_profiles` (T): unik `(tenant_id, user_id) WHERE user_id IS NOT NULL`; unik `(tenant_id, whatsapp_hash) WHERE whatsapp_hash IS NOT NULL AND membership_status <> 'closed'`; unik `(tenant_id, referral_code)`. Kolom `merged_into_profile_id`, `home_outlet_id`, `updated_at`, dan counter. Policy `member_self` pada `id`.
- `consent_policy_versions` (T): unik `(tenant_id, purpose, version)`. Seed `2026-01`.
- `point_ledger` (T): ULID `id` char(26), `posting_seq` bigint identity, CHECK tanda per tipe, `source_type` per tipe, `expires_at` wajib pada earn/bonus dan null pada redeem, `reason` wajib pada adjust, `liability_idr = points * point_value_idr`. Unik `(tenant_id, type, source_type, source_id) WHERE source_id IS NOT NULL`. Indeks `(tenant_id, customer_profile_id, posting_seq)`.
- `point_earn_records` (T+O): unik `(tenant_id, order_id)`. Tabel mutable, hanya ditulis di bawah lock profil.
- `customer_visits` (T+O): unik `(tenant_id, order_id)`. Member policy.
- `loyalty_anomalies` (T): kolom `kind` sesuai §3, termasuk `balance_mismatch` dan `phone_lookup_cap_hit`. `outlet_id` nullable, jadi hanya tenant RLS (`contracts.md:41`).
- `orders` (tabel existing): kolom `customer_attached_by`, `customer_attached_via`, `customer_attached_at`, nullable tanpa default. `orders.customer_profile_id` sudah ada. FK `(tenant_id, customer_profile_id)` → `customer_profiles` ditambah `NOT VALID` (kolom selalu NULL hari ini). Tidak melepas FORCE di `orders`.
- FK order lain = `(tenant_id, order_id)` → `orders (tenant_id, id)`, pola 1 (FK di dalam `CREATE TABLE`).
- Trigger: append-only `point_ledger` (pesan `point_ledger is append-only (LOY-01)`, pola `app.reject_stock_ledger_mutation()` di `apps/api/drizzle/0017_inventory_rls.sql:31-39`), saldo `AFTER INSERT` SECURITY DEFINER dengan `SET search_path = pg_catalog, public` dan filter `id` DAN `tenant_id`, nilai poin `BEFORE INSERT` (lihat Tujuan 3), `orders_customer_lock` (hanya di `orders`), kunci `point_value_idr` di `loyalty_programs`.
- Grant: cabut INSERT dan UPDATE tingkat tabel di `customer_profiles` dari `legend_app`, lalu grant per kolom TANPA `points_balance`. `point_ledger`: `legend_app` SELECT dan INSERT (pola `drizzle/0017_inventory_rls.sql`), tanpa UPDATE/DELETE.
- RLS: `SELECT app.enforce_tenant_rls('public.<t>'::regclass);` untuk semua tabel baru. Tabel ber-`outlet_id NOT NULL` (`point_earn_records`, `customer_visits`) juga `SELECT app.enforce_outlet_rls(...)` (contoh `apps/api/src/db/schema/sales-targets.custom.sql`). Empat tabel member (Tujuan 7) juga `app.enforce_member_rls`.
- Tidak ada perubahan skema consent (`member_pwa` sudah diizinkan).

Setelah edit skema: `pnpm db:generate` harus menghasilkan migrasi ini saja. Periksa SQL-nya.

## Potongan untuk subagent

Berkas (nama persis, TBD-verify bila ragu):

1. Skema: `db/schema/crm-member.ts` (profil, program, versi kebijakan), `db/schema/crm-ledger.ts` (ledger, earn records, visits, anomali), `apps/api/drizzle/0193_*.sql`.
2. Ledger dan lock: `db/member-scope.ts` (`withMemberScope`, `withProfileLock`), `services/point-ledger.service.ts`.
3. Earn dan anti-fraud: `services/loyalty-earn-consumer.ts` + tiga stub langkah, `services/loyalty-anomaly.service.ts`, `worker/loyalty-balance-check.job.ts`.
4. Member dan staf API: `middleware/member.ts` (`requireMember`), `routes/member.routes.ts` (profile, points, consents, consent-policies, qr-token), `services/member-profile.service.ts`, `routes/loyalty-program.routes.ts`, `routes/pos-order-customer.routes.ts`, dan `services/consent.service.ts` (fungsi `recordMemberConsent`).
5. Kontrak aditif: lihat "Aturan bersama" (registri).

Potongan tidak boleh tumpang tindih. Berkas yang bersentuhan dikerjakan berurutan atau pakai `isolation: worktree`.

## Tes gagal-dulu

Tulis tes dulu, jalankan, catat merah. Berkas tes di `apps/api/src/test/`:

- `member-ledger.test.ts`: UPDATE dan DELETE pada `point_ledger` ditolak untuk `legend_app`; saldo sama dengan jumlah ledger setelah urutan acak; insert yang membuat saldo negatif gagal; dua refund parsial membalik tepat `booked_points`; refund penuh setelah tukar poin di-clamp dan shortfall tercatat; INSERT dengan `points_balance` ditolak grant; ubah `point_value_idr` sesudah baris pertama ditolak.
- `member-earn.test.ts`: `order.paid` kembar hanya membukukan sekali; pendapatan kotor tanpa servis dan PBJT (§6 risiko 5, uji ini wajib lebih dulu; jalur POS `orderRevenueSplit` di `apps/api/src/services/pos-order.service.ts:1248` dan QR `apps/api/src/services/qr-order-paid.ts` harus terkunci); poin tender dikurangi; void order lunas membalik semua poin; refund parsial dikurangi `refundPointsIdr`; order QR `pwa_session` tidak diblok swalayan; order QR lunas lalu refund sistem: poin tidak tertinggal; batas harian lintas dua outlet pada satu hari bisnis; self-serve staf diblokir dan tercatat anomali; batas cari nomor per kasir.
- `member-isolation.test.ts`: member A tidak bisa membaca profil, poin, kunjungan, atau data B lewat rute mana pun; dengan GUC diset, select mentah B kosong; sesi member mendapat 403 di rute staf; user staf tanpa profil mendapat 404 di rute member; modul rute member mengimpor `withMemberScope` dan tidak `withTenant` langsung; RLS member aktif pada `customer_profiles`, `point_ledger`, `customer_visits`, `consents`.
- `member-consent.test.ts`: grant versi lama 409 `CONSENT_POLICY_OUTDATED`; withdraw loyalty menjadi `suspended`; consent loyalty ulang pada profil `suspended` kembali `active` bila WhatsApp terverifikasi, selain itu `pending_verification`; jalur staf tetap menolak `member_pwa`; status `pending_verification` hanya boleh rute yang disebut Tujuan 10, selain itu 403 `MEMBERSHIP_NOT_ACTIVE`; user tanpa profil bisa signup lewat `POST /api/member/consents`; `GET /api/member/consent-policies` terbaca tanpa profil; profil `closed` 404 `CUSTOMER_NOT_FOUND`.
- Isolasi tenant untuk tabel baru (cross-tenant), sesuai AC kartu.

Perintah: `LEGEND_TEST_FILES="src/test/member-ledger.test.ts src/test/member-earn.test.ts src/test/member-isolation.test.ts src/test/member-consent.test.ts" pnpm test` dari root worktree.

## Kontrak

Endpoint baru (aditif) di `packages/shared/src/crm/endpoints.ts`:

- `GET /api/member/profile`, `GET /api/member/points`, `POST /api/member/consents`, `GET /api/member/consent-policies`, `POST /api/member/qr-token`.
- `PUT /api/pos/orders/:orderId/customer` (staf).
- Rute staf dari kontrak yang dipakai (sudah ada, `endpoints.ts`): `GET /api/customers/:customerProfileId/points` (214), `GET` dan `PUT /api/loyalty/program` (224, 248).
- Daftar anomali (staf, permission `crm.loyalty.review`): rute baru.

Kode error baru di `packages/shared/src/crm/errors.ts`:

- `CONSENT_POLICY_OUTDATED` (409).
- `MEMBERSHIP_NOT_ACTIVE` (403).

Kontrak lain sudah ada dan dipakai apa adanya: `pointLedgerDedupeKey`, `pointsForSpend`, `referralRulesSchema`, `evaluateTier` (dipakai nanti oleh 290e), dan payload event `points.*` di `events.ts`.

## Gate cabang

1. `heavy pnpm --filter @starter/api typecheck`, `heavy pnpm --filter @starter/shared typecheck` (bila shared berubah), `pnpm exec eslint <berkas berubah>`.
2. Tes terarah: `LEGEND_TEST_FILES="..." pnpm test` (lihat daftar di atas).
3. `pnpm db:generate` harus kosong setelah migrasi dibuat.
4. `pnpm exec prettier --check <berkas berubah>`.
5. Tidak menjalankan `pnpm check` penuh. Gate penuh hanya di akhir gelombang, oleh satu test-runner.

Review: satu subagent `architect` (K) untuk diff, fokus ledger, RLS, dan lock. Temuan nyata diperbaiki sebelum lanjut.

## Bukti selesai

- Seluruh tes di daftar di atas hijau, dengan catatan merah sebelum implementasi.
- `pnpm db:generate` kosong.
- Lint, typecheck, dan prettier lulus.
- Review `architect` selesai dan temuan nyata sudah diperbaiki.
- Commit lokal di `ws/ws08-111j`.
- `docs/PROGRESS.md` diperbarui.

## Laporan

- SHA, kartu `legend-111j` (selesai atau belum).
- Jumlah subagent yang di-spawn dan puncak bersamaan.
- Hasil gate.
- Temuan review dan perbaikannya.
- Yang belum teruji: pengecekan nightly `balance_mismatch`, klaim resi (receipt_claim, default off), dan semua yang diberi TBD-verify.
