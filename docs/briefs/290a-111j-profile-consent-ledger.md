# Brief 290a: engineer K — legend-111j profil, consent, buku poin

Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §2 (M1, M4, M5, M6, M7), §3 (tabel 0193), §6 (risiko 5), §7, §8. Jika kontrak `packages/shared/src/crm/*` berbeda dengan desain, kontrak yang menang; desain hanya menambah storage, otorisasi, dan konkurensi.

## Peran

- Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`.
- Tingkat K (uang, akses, migrasi). Model: Opus 5.5, effort high.
- Review tingkat K: satu subagent `architect` (bukan reviewer biasa).

## Repo dan cabang

- Worktree: `.worktrees/ws08-111j` dari `milestone/m1`, cabang `ws/ws08-111j`.
- Jalankan `pnpm worktree:setup` sekali setelah membuat worktree.
- Commit lokal saja. Jangan push, jangan merge ke `milestone/m1`.
- Tanpa rahasia di commit. Jika butuh kunci, pakai `ghostex secret request`.

## Tujuan

1. Profil member: tabel `customer_profiles` (T), satu baris per `(tenant_id, user_id)`, dengan `points_balance >= 0`, status enum, dan `active` hanya bila WhatsApp terverifikasi (§3).
2. Consent versi kebijakan: tabel `consent_policy_versions`, seed `2026-01` untuk `loyalty`, `marketing`, `ai` (§M7). `recordMemberConsent` di `consent.service.ts` dengan source `member_pwa` (§M7). Grant versi lama gagal 409 `CONSENT_POLICY_OUTDATED`. Withdraw loyalty menjadi `suspended`.
3. Buku poin append-only `point_ledger` dengan trigger, saldo dijaga database, dan `withProfileLock` (§M5, LOY-01..02).
4. Earn dan reverse dari `order.paid` dan `order.refunded` lewat consumer `loyalty-earn` (§M6). Pendapatan kotor dihitung tanpa servis dan PBJT.
5. Lampirkan member ke order: kolom `customer_profile_id` dan atribusi di `pos_orders` dan `orders`, endpoint `PUT /api/pos/orders/:orderId/customer`, dan token QR HMAC 120 detik (§M6).
6. Anti-fraud: batas harian per `businessDate` lintas outlet, larangan self-serve staf, dan tabel `loyalty_anomalies` (§3).
7. RLS member: `app.member_profile_id()`, `app.enforce_member_rls()`, `withMemberScope` (§M4).

## Bergantung pada

- `legend-zk25` (kontrak CRM, sudah selesai di m1).
- Tidak bergantung pada 290b. Sign-in tidak diperlukan untuk migrasi 0193.

## Paralel dengan

- 290b (k2l) jalan paralel. Slice merge di 290b rebase setelah 290a selesai.
- Jangan sentuh berkas identity (`apps/api/src/lib/auth.ts`, `identity-*.service.ts`) di sini.

## Migrasi

Satu migrasi `0193`, `when` = `1794272000000`. Nomor ikut urutan merge; merge train boleh mengganti nama.

Isi (§3):

- `loyalty_programs` (T): unik `(tenant_id)`. `is_active` default **false**. `point_value_locked_at` dikunci trigger setelah baris ledger pertama.
- `customer_profiles` (T): unik `(tenant_id, user_id) WHERE user_id IS NOT NULL`; unik `(tenant_id, whatsapp_hash) WHERE whatsapp_hash IS NOT NULL AND membership_status <> 'closed'`; unik `(tenant_id, referral_code)`. Kolom `merged_into_profile_id`, `home_outlet_id`, `updated_at`. Policy `member_self` pada `id`.
- `consent_policy_versions` (T): unik `(tenant_id, purpose, version)`.
- `point_ledger` (T): ULID `id` char(26), `posting_seq` bigint identity, CHECK tanda per tipe, `source_type` per tipe, `expires_at` wajib pada earn/bonus dan null pada redeem, `reason` wajib pada adjust, `liability_idr = points * point_value_idr`. Unik `(tenant_id, type, source_type, source_id) WHERE source_id IS NOT NULL`. Indeks `(tenant_id, customer_profile_id, posting_seq)`.
- `point_earn_records` (T+O): unik `(tenant_id, order_id)`. Tabel mutable, hanya ditulis di bawah lock profil.
- `customer_visits` (T+O): unik `(tenant_id, order_id)`. Member policy.
- `loyalty_anomalies` (T+O): kolom `kind` sesuai §3.
- Kolom order hanya di `orders` (`apps/api/src/db/schema/qr-order.ts:184`, tabel order tunggal semua kanal): `customer_attached_by`, `customer_attached_via`, `customer_attached_at`. `orders.customer_profile_id` sudah ada. Tidak ada kolom baru di `pos_orders`. FK order = `(tenant_id, order_id)` → `orders (tenant_id, id)`.
- Pola FK (`docs/plan/contracts.md:123-159`): pola 1 (FK di dalam `CREATE TABLE`) untuk tabel baru. Bila FK ke `customer_profiles` ditambah pada `orders` (tabel existing), pakai pola 2: `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` di kedua sisi, lalu pulihkan FORCE sebelum akhir berkas.
- Trigger: append-only `point_ledger` (pesan `point_ledger is append-only (LOY-01)`, pola `app.reject_stock_ledger_mutation()` di `apps/api/drizzle/0017_inventory_rls.sql:31-39`), saldo `AFTER INSERT` SECURITY DEFINER, larangan UPDATE kolom `points_balance` untuk `legend_app`, `orders_customer_lock` (hanya di `orders`; tidak ada trigger kunci di `pos_orders`), kunci `point_value_idr` setelah ledger pertama.
- Grant: `legend_app` SELECT dan INSERT pada `point_ledger` (pola `drizzle/0017_inventory_rls.sql`). Tanpa UPDATE/DELETE.
- RLS: `SELECT app.enforce_tenant_rls('public.<t>'::regclass);`; tabel ber-`outlet_id NOT NULL` juga `SELECT app.enforce_outlet_rls(...)` (contoh `apps/api/src/db/schema/sales-targets.custom.sql`); tabel member juga `app.enforce_member_rls`.
- Tidak ada perubahan skema consent (`member_pwa` sudah diizinkan).

Setelah edit skema: `pnpm db:generate` harus menghasilkan migrasi ini saja. Periksa SQL-nya.

## Potongan untuk subagent

Berkas diduga (verifikasi dulu, TBD-verify):

1. Skema dan migrasi: `apps/api/src/db/schema/crm*.ts` (profil, consent policy, program), `apps/api/drizzle/0193_*.sql`.
2. Ledger dan lock: `apps/api/src/services/crm-ledger*.ts` (insert ledger, `withProfileLock`, `withMemberScope`).
3. Earn, reverse, anti-fraud: `apps/api/src/services/crm-earn*.ts`, consumer `apps/api/src/services/loyalty-earn-consumer.ts` (pola `accounting-auto-journal-consumer.ts`, didaftarkan di `apps/api/src/worker-main.ts`).
4. Consent dan member API: `apps/api/src/services/consent.service.ts` (fungsi baru `recordMemberConsent`), `apps/api/src/routes/member*.routes.ts`, `apps/api/src/routes/pos*.routes.ts` (endpoint customer).
5. Kontrak aditif: `packages/shared/src/crm/endpoints.ts`, `packages/shared/src/crm/errors.ts`.

Potongan tidak boleh tumpang tindih. Berkas yang bersentuhan dikerjakan berurutan atau pakai `isolation: worktree`.

## Tes gagal-dulu

Tulis tes dulu, jalankan, catat merah. Berkas tes di `apps/api/src/test/`:

- `member-ledger.test.ts`: UPDATE dan DELETE pada `point_ledger` ditolak untuk `legend_app`; saldo sama dengan jumlah ledger setelah urutan acak; insert yang membuat saldo negatif gagal; dua refund parsial membalik tepat `booked_points`; refund penuh setelah tukar poin di-clamp dan shortfall tercatat.
- `member-earn.test.ts`: `order.paid` kembar hanya membukukan sekali; pendapatan kotor tanpa servis dan PBJT (§6 risiko 5, uji ini wajib lebih dulu; jalur POS `orderRevenueSplit` di `apps/api/src/services/pos-order.service.ts:1248` dan QR `apps/api/src/services/qr-order-paid.ts` harus terkunci); poin tender dikurangi; batas harian lintas dua outlet pada satu hari bisnis; self-serve staf diblokir dan tercatat anomali.
- `member-isolation.test.ts`: member A tidak bisa membaca profil, poin, kunjungan, atau data B lewat rute mana pun; dengan GUC diset, select mentah B kosong; sesi member mendapat 403 di rute staf; user staf tanpa profil mendapat 404 di rute member; modul rute member mengimpor `withMemberScope` dan tidak `withTenant` langsung.
- `member-consent.test.ts`: grant versi lama 409 `CONSENT_POLICY_OUTDATED`; withdraw loyalty menjadi `suspended`; jalur staf tetap menolak `member_pwa`.
- Isolasi tenant untuk tabel baru (cross-tenant), sesuai AC kartu.

Perintah: `LEGEND_TEST_FILES="src/test/member-ledger.test.ts src/test/member-earn.test.ts" pnpm test` dari root worktree. Path relatif terhadap `apps/api`, sesuaikan dengan `LEGEND_TEST_FILES` yang dipakai repo.

## Kontrak

Endpoint baru (aditif) di `packages/shared/src/crm/endpoints.ts`:

- `GET /api/member/profile`, `GET /api/member/points`, `POST /api/member/consents`, `GET /api/member/consent-policies`, `POST /api/member/qr-token`.
- `PUT /api/pos/orders/:orderId/customer` (staf).
- Rute staf dari kontrak yang dipakai (sudah ada, `endpoints.ts`): `GET /api/customers/:customerProfileId/points` (214), `GET` dan `PUT /api/loyalty/program` (224, 248).
- Daftar anomali (staf, permission `crm.loyalty.review`): rute baru.

Kode error baru di `packages/shared/src/crm/errors.ts`:

- `CONSENT_POLICY_OUTDATED` (409).

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
