# Brief 290e: engineer — legend-3zd1 tier, kedaluwarsa poin, ulang tahun, referral

Level: K (uang, migrasi). Model: Opus 5.5 (desain uang dan migrasi baru). Effort: high.
Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §2 M5, M6, M8, §3, §4 (3zd1), §7, §8. Sumber aturan bersama: `docs/briefs/290-aturan-bersama.md` (B13, B14, B15, B17). Desain menang; aturan bersama merinci. Bila beda, tulis TBD-verify di laporan.
Kontrak: `packages/shared/src/crm/*` (tier, `evaluateTier`, `pointsForSpend`, event `tier.changed`, `points.expired`). Kontrak menang atas desain untuk bentuk field dan enum.

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Kamu memimpin subagent sendiri. Kamu dipanggil sebagai agent, bukan subagent.

## Repo dan cabang
- Worktree: `.worktrees/tiers-expiry` dari `milestone/m1`, cabang `ws/tiers-expiry`.
- Jalankan `pnpm worktree:setup` sekali setelah membuat worktree.
- Commit lokal saja. Jangan push, jangan merge.
- Kartu bd: legend-3zd1. Tandai `bd update legend-3zd1 --claim` bila belum.

## Bergantung pada
- 290a (legend-111j) harus sudah merge ke `ws/` induk atau m1: `customer_profiles`, `point_ledger`, `customer_visits`, `loyalty_programs` (termasuk kolom `referral` dan `phone_lookup_daily_cap_per_cashier`, migrasi 0193), `withProfileLock`, `app.member_profiles_of_user`, trigger saldo, `points.*` outbox, `services/loyalty-earn-consumer.ts` dan tiga berkas stub langkah.
- Tanpa 290a, berhenti dan lapor ke CTO.

## Paralel dengan
290c (m4p5), 290d (ts50), 290f (journal). File tidak boleh bertumpuk dengan mereka. Migrasi 0197 hanya milik kartu ini.

## Tujuan
1. Tabel tier (§3 0197): `loyalty_tiers` (unik `(tenant_id, rank)`), `customer_profiles.tier_id` FK pola 2 dan `tier_evaluated_at`, `customer_tier_history` append-only.
2. Job evaluasi tier MALAM (nightly, B17), bukan bulanan. Pakai `customer_visits` untuk jendela rolling 12 bulan dan `evaluateTier` dari kontrak. Emit `tier.changed`. Riwayat ditulis dalam transaksi yang sama.
3. Pengali tier diisi di `services/loyalty-earn-tier-step.ts`: `tierMultiplierBp(ctx): Promise<number>` (stub 290a mengembalikan 10000), dipanggil sebelum `pointsForSpend`. Konteks `EarnStepContext` dari 290a: `{ tx, tenantId, profile (baris terkunci), program, order, record }`. 290e hanya mengisi berkas langkah, tidak mengedit konsumen `loyalty-earn-consumer.ts`. Sebelum tier ada, pengali 10 000 bp (§M6 langkah 5).
4. Kedaluwarsa (B13), tanpa tabel baru. Per profil, di bawah lock:
   - `terpakai = Σ|redeem| − Σ restore + Σ|adjust negatif manual|`. Pakai besaran (nilai mutlak, karena poin ledger bertanda). Restore = `adjust` dengan `reverses_entry_id` ke baris `redeem`.
   - `grant = earn + bonus + adjust positif manual`. Adjust positif manual WAJIB punya `expires_at`.
   - FIFO: grant tertua habis dulu. Saldo tidak pernah negatif.
   - Satu baris `expire` per grant per run. `source_id` = UUIDv5 dari `<grantId>:<n>`, `n` = jumlah expire sebelumnya untuk grant itu + 1. Restore sesudah kedaluwarsa ikut kedaluwarsa di run berikut.
   - Tiap expire dibatasi saldo. Emit `points.expired`. Dijalankan ulang tanpa data baru tidak menulis baris kedua.
5. Pengingat 30 hari = dihitung saat baca. `GET /api/member/points` menambah `expiringSoon` (aditif bila kontrak belum punya). Tanpa tabel, tanpa kirim pesan di m1.
6. Ulang tahun (B14): `type='bonus'`, `source_type='birthday'` (kontrak `crm/events.ts:60`), `source_id` = UUIDv5 dari `<profileId>:<tahun>`. Job keluarga kedaluwarsa, idempoten.
7. Referral: tabel `referrals` di 0197 sesuai kontrak `referralSchema`. Kolom `loyalty_programs.referral` dibuat 290a (0193); 290e hanya membaca dan menulisnya. Lengkap:
   - Kualifikasi di earn pertama ≥ `minFirstOrderIdr`, langkah di `services/loyalty-earn-referral-step.ts` dengan `afterVisit(ctx): Promise<void>` (stub kosong dari 290a). Langkah mengunci profil referrer SESUDAH profil referee. Deadlock diulang oleh konsumen (savepoint per event).
   - Cap bulanan referrer di bawah kunci profil referrer.
   - Tolak referral diri sendiri. Referee unik. Tolak referee yang hash WhatsApp-nya pernah punya profil.
   - Kode referral saat signup.
   - Kebijakan RLS khusus `referrals` (B7).
8. Izin tier CRUD staff = `crm.loyalty.manage` (A.4). Tidak ada izin baru di kartu ini.

## Migrasi
- Nomor `0197`, `when` 1794276000000. Ikuti A.1: `pnpm db:generate`, ganti nama ke 0197, set `when` di `drizzle/meta/_journal.json`, `idx` ikut urutan jurnal cabang, `prevId` = snapshot terakhir di m1 (pola 0174/0176/0178 di `docs/PROGRESS.md`). Merge train boleh menomori ulang.
- 0197 tidak mengubah data dan tidak melepas FORCE, jadi tidak masuk `MIGRATION_DATA_STATEMENTS`.
- Tabel: `loyalty_tiers`, `customer_tier_history`, `referrals`. Kolom: `customer_profiles.tier_id`, `customer_profiles.tier_evaluated_at`.
- Kunci unik: `loyalty_tiers (tenant_id, rank)`, `loyalty_tiers (tenant_id, id)`. FK komposit `(tenant_id, tier_id)`.
- RLS: `SELECT app.enforce_tenant_rls('public.loyalty_tiers'::regclass);`, `customer_tier_history`, dan `referrals`. `customer_tier_history` tidak dibaca rute member, jadi tanpa `app.enforce_member_rls`. `referrals` TIDAK memakai `enforce_member_rls` default: kebijakan khusus `referrer_profile_id = app.member_profile_id() OR referee_profile_id = app.member_profile_id()`.
- `customer_tier_history` append-only: trigger `BEFORE UPDATE OR DELETE` raise error (pola `app.reject_stock_ledger_mutation()` di `apps/api/drizzle/0017_inventory_rls.sql:31-39`), `legend_app` hanya SELECT dan INSERT.
- `customer_profiles`: kolom baru tidak boleh membuka kolom `points_balance` untuk UPDATE. Grant per kolom sesuai B5.
- Grant: `legend_app` SELECT, INSERT pada tabel baru. UPDATE pada `loyalty_tiers` sesuai kebutuhan CRUD staff.
- `pnpm db:generate` harus menghasilkan SQL yang sama dengan berkas migrasi. Inspeksi SQL sebelum commit.

## Potongan untuk subagent
Nama berkas dari tabel D. Tidak bertumpuk.
1. `apps/api/src/db/schema/crm-tiers.ts` (skema `loyalty_tiers`, `customer_tier_history`, `referrals`). Milik migrasi 0197. Implementer sonnet.
2. `apps/api/src/services/loyalty-tier.service.ts` (evaluasi tier, tulis riwayat, emit `tier.changed`) + `apps/api/src/routes/loyalty-tiers.routes.ts` (CRUD staff, `crm.loyalty.manage`) + `apps/api/src/worker/loyalty-tier.job.ts`. Implementer sonnet.
3. `apps/api/src/services/loyalty-expiry.service.ts` (expire, ulang tahun, `expiringSoon`) + `apps/api/src/worker/loyalty-expiry.job.ts`. Implementer sonnet.
4. `apps/api/src/services/referral.service.ts` (kode referral, cap bulanan, tolak diri sendiri). Implementer sonnet.
5. `apps/api/src/services/loyalty-earn-tier-step.ts` dan `apps/api/src/services/loyalty-earn-referral-step.ts` (isi langkah saja). Dikerjakan kamu sendiri.
6. Berkas registri (A.2), tiap berkas dipegang SATU subagent, hanya tambah blok dengan komentar `legend-3zd1`:
   - `apps/api/src/db/schema/index.ts` (export `crm-tiers.ts`).
   - `apps/api/src/routes/index.ts` (daftar `loyalty-tiers.routes.ts`).
   - `apps/api/src/worker-main.ts` (daftar dua job).
   - `packages/shared/src/crm/endpoints.ts` (endpoint staff tier CRUD dan status job, aditif).
7. test-writer sonnet: `apps/api/src/test/crm-tiers.test.ts` (tier dan referral), `apps/api/src/test/crm-expiry.test.ts` (kedaluwarsa dan ulang tahun).
8. Berkas 290a (berurutan, sesudah 290a merge; tidak ada kartu paralel lain yang menyentuhnya): `apps/api/src/routes/member.routes.ts` (`expiringSoon` di `GET /api/member/points`), `apps/api/src/services/member-profile.service.ts` (field tier di profil, kode referral saat signup). DTO di `packages/shared/src/crm/*` (registri bersama). 290g menyentuh `member-profile.service.ts` sesudah 290e.

Maks 8 yang mengedit sekaligus. Tidak ada subagent pada dua berkas registri yang sama.

## Tes gagal-dulu
Tulis tes dulu, jalankan terhadap kode lama, catat merah.
- Expire: dua kali job tanpa data baru menghasilkan satu baris `expire` per grant (idempoten).
- Expire: grant dengan reversal sebagian hanya kehilangan sisa yang benar. Rumus B13.
- Expire: FIFO, grant tertua habis dulu. Saldo tidak pernah negatif.
- Expire: redeem setelah grant berjalan tetap dihitung (`− Σ redeem`). Restore sesudah kedaluwarsa ikut kedaluwarsa di run berikut (`source_id` dengan `n` berikutnya).
- Expire: adjust positif manual tanpa `expires_at` ditolak.
- Tier: pengali tier masuk ke earn. Earn dengan pengali 10 000 bp sama dengan sebelumnya (regresi).
- Tier: evaluasi dua kali pada periode sama tidak menulis riwayat kedua.
- Tier: `tier.changed` dan riwayat ditulis dalam transaksi yang sama. Gagal salah satu, tidak ada yang tertulis.
- Ulang tahun: `<profileId>:<year>` hanya sekali per tahun. Jalankan dua kali, satu bonus.
- Pengingat: `GET /api/member/points` mengembalikan `expiringSoon` dihitung saat baca.
- Referral: kualifikasi sekali (earn pertama ≥ `minFirstOrderIdr`). Cap bulanan referrer. Referral diri ditolak. Referee unik.
- Isolasi: member A tidak bisa membaca `referrals` milik B. Dengan GUC `app.customer_profile_id` diset ke A, select baris B kosong.
- Tier history: UPDATE dan DELETE ditolak untuk `legend_app`.
- Staff tanpa `crm.loyalty.manage` tidak bisa CRUD tier.

Perintah: `LEGEND_TEST_FILES="src/test/crm-tiers.test.ts src/test/crm-expiry.test.ts" pnpm test` dari root worktree. Bungkus long output lewat subagent `test-runner` (haiku).

## Kontrak
- Kode error sudah ada di `packages/shared/src/crm/errors.ts`. Jangan ganti nama. Tidak ada kode baru di kartu ini.
- `packages/shared/src/crm/endpoints.ts`: endpoint staff tier CRUD dan status job, bila belum ada. Aditif saja.
- `packages/shared/src/crm/events.ts`: `tier.changed`, `points.expired`, dan `birthday` (source) sudah ada. Jangan ubah bentuk payload.

## Gate cabang
- `heavy pnpm --filter @starter/api typecheck`, `heavy pnpm --filter @starter/shared typecheck` (bila shared berubah), `pnpm exec eslint <berkas berubah>`.
- `LEGEND_TEST_FILES="..." pnpm test` untuk tes di atas, plus tes ledger dari 290a yang menyentuh earn.
- `pnpm db:generate` harus kosong (tidak ada diff setelah generate).
- `pnpm exec prettier --check <berkas berubah>`.
- Tidak menjalankan `pnpm check` penuh. Itu gate akhir CTO.
- Review tingkat K: satu subagent `architect` (Opus, xhigh) untuk diff. Temuan nyata diperbaiki sebelum lanjut.

## Bukti selesai
- Semua tes di atas hijau. Catat merah sebelum hijau per tes.
- `pnpm db:generate` kosong.
- Lint dan typecheck lolos lewat `heavy`.
- Commit lokal di `ws/tiers-expiry`. Pesan commit merujuk `legend-3zd1` dan kriteria LOY-02.
- `docs/PROGRESS.md` diperbarui.

## Laporan
SHA, kartu bd (`legend-3zd1`), jumlah subagent dan puncak bersamaan, hasil gate, temuan `architect` dan perbaikannya, bagian referral yang TBD-verify, dan yang belum teruji.
