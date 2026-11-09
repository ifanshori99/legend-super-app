# Brief 290e: engineer — legend-3zd1 tier, kedaluwarsa poin, ulang tahun, referral

Level: K (uang, migrasi). Model: Opus 5.5 (desain uang dan migrasi baru). Effort: high.
Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §2 M5, M6, M8 (0197), §3 (0197), §4 (3zd1), §7, §8.
Kontrak: `packages/shared/src/crm/*` (tier, `evaluateTier`, `pointsForSpend`, event `tier.changed`, `points.expired`). Kontrak menang atas desain untuk bentuk field dan enum.

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Kamu memimpin subagent sendiri. Kamu dipanggil sebagai agent, bukan subagent.

## Repo dan cabang
- Worktree: `.worktrees/tiers-expiry` dari `milestone/m1`, cabang `ws/tiers-expiry`.
- Jalankan `pnpm worktree:setup` sekali setelah membuat worktree.
- Commit lokal saja. Jangan push, jangan merge.
- Kartu bd: legend-3zd1. Tandai `bd update legend-3zd1 --claim` bila belum.

## Bergantung pada
- 290a (legend-111j) harus sudah merge ke `ws/` induk atau m1: `customer_profiles`, `point_ledger`, `customer_visits`, `loyalty_programs`, `withProfileLock`, trigger saldo, `points.*` outbox.
- Tanpa 290a, berhenti dan lapor ke CTO.

## Paralel dengan
290c (m4p5), 290d (ts50), 290f (journal). File tidak boleh bertumpuk dengan mereka. Migrasi 0197 hanya milik kartu ini.

## Tujuan
1. Tabel tier (§3 0197): `loyalty_tiers` (unik `(tenant_id, rank)`), `customer_profiles.tier_id` FK pola 2 dan `tier_evaluated_at`, `customer_tier_history` append-only.
2. Job evaluasi tier bulanan (§3, §4): pakai `customer_visits` untuk jendela rolling 12 bulan dan `evaluateTier` dari kontrak. Emit `tier.changed`. Riwayat ditulis dalam transaksi yang sama.
3. Consumer `loyalty-earn` (290a) mulai membaca pengali tier. Sebelum tier ada, pengali 10 000 bp (§M6 langkah 5). Tes: pengali tier masuk ke `pointsForSpend`.
4. Job kedaluwarsa (§3 bagian Expiry, tanpa tabel baru): per profil, di bawah lock, `expirable` dihitung sesuai rumus desain, konsumsi FIFO grant tertua, satu baris `expire` per grant (`source_id` = id grant). Emit `points.expired`. Bisa dijalankan ulang tanpa dobel.
5. Daftar pengingat 30 hari dibuat sebagai data. Pengiriman notifikasi bukan kartu ini.
6. Bonus ulang tahun (tier benefit): job keluarga yang sama, idempoten pada `<profileId>:<year>`, `source_type='bonus'` sesuai kontrak. `source_id` = UUIDv5 deterministik dari `<profileId>:<year>` (kontrak mewajibkan uuid/ULID).
7. Referral (judul kartu: "+ birthday rewards + referral"): tabel `referrals` di 0197 sesuai kontrak `referralSchema`. Alur mengikuti desain §3 0197 (sudah diperbarui). Kolom `loyalty_programs.referral` (jsonb, default off, kontrak `referralRulesSchema`) ikut kartu ini.

## Migrasi
- Nomor `0197`, `when` 1794276000000. Nomor mengikuti urutan merge. Merge train boleh mengganti nama.
- Tabel: `loyalty_tiers`, `customer_tier_history`, `referrals`. Kolom: `customer_profiles.tier_id`, `customer_profiles.tier_evaluated_at`.
- Kunci unik: `loyalty_tiers (tenant_id, rank)`, `loyalty_tiers (tenant_id, id)`. FK komposit `(tenant_id, tier_id)`.
- RLS: `SELECT app.enforce_tenant_rls('public.loyalty_tiers'::regclass);` dan `customer_tier_history`. `customer_tier_history` juga `app.enforce_member_rls` (baca member). `customer_tier_history` append-only: trigger `BEFORE UPDATE OR DELETE` raise error (pola `app.reject_stock_ledger_mutation()` di `apps/api/drizzle/0017_inventory_rls.sql:31-39`), `legend_app` hanya SELECT dan INSERT.
- `customer_profiles`: kolom baru tidak boleh membuka kolom `points_balance` untuk UPDATE.
- Grant: `legend_app` SELECT, INSERT pada tabel baru. UPDATE pada `loyalty_tiers` sesuai kebutuhan CRUD staff.
- `pnpm db:generate` harus menghasilkan SQL yang sama dengan berkas migrasi. Inspeksi SQL sebelum commit.

## Potongan untuk subagent
Berkas diduga, tidak bertumpuk. Nama berkas final boleh berbeda; cek dengan Explore dulu.
1. `apps/api/src/db/schema/crm-tiers.ts` (skema tier, riwayat, dan `referrals`) + export di `db/schema/index.ts`. Milik migrasi 0197.
2. `apps/api/src/services/crm-tiers.service.ts` (evaluasi tier, tulis riwayat, emit `tier.changed`) + `routes` staff CRUD tier bila kontrak memintanya (`routes/crm-tiers.routes.ts`).
3. `apps/api/src/services/crm-expiry.service.ts` (job kedaluwarsa, bonus ulang tahun, daftar pengingat).
4. Sentuhan kecil di `apps/api/src/services/loyalty-earn-consumer.ts` (pembacaan pengali tier; 290a membuat berkas ini, 290c dan 290e menambah langkah). Kerjakan setelah 290a merge, bukan paralel.
5. test-writer: `apps/api/src/test/crm-tiers.test.ts`, `apps/api/src/test/crm-expiry.test.ts`.

Subagent: implementer sonnet untuk 1-3; test-writer sonnet. Potongan 4 dikerjakan kamu sendiri. Maks 8 yang mengedit sekaligus.

## Tes gagal-dulu
Tulis tes dulu, jalankan terhadap kode lama, catat merah.
- Expire: job dijalankan dua kali menghasilkan satu baris `expire` per grant (idempoten).
- Expire: grant dengan reversal sebagian hanya kehilangan sisa yang benar. Rumus dari desain §3.
- Expire: FIFO, grant tertua habis dulu. Saldo tidak pernah negatif.
- Expire: redeem setelah grant berjalan tetap dihitung sesuai rumus (`− Σ redeem`).
- Tier: pengali tier masuk ke earn. Earn dengan pengali 10 000 bp sama dengan sebelumnya (regresi).
- Tier: evaluasi dua kali pada periode sama tidak menulis riwayat kedua.
- Tier: `tier.changed` dan riwayat ditulis dalam transaksi yang sama. Gagal salah satu, tidak ada yang tertulis.
- Ulang tahun: `<profileId>:<year>` hanya sekali per tahun. Jalankan dua kali, satu bonus.
- Isolasi: member A tidak bisa membaca `customer_tier_history` milik B. Dengan GUC `app.customer_profile_id` diset ke A, select baris B kosong.
- Tier history: UPDATE dan DELETE ditolak untuk `legend_app`.
- Staff tanpa `crm.loyalty.review`/permission tier tidak bisa CRUD tier.

Perintah: `LEGEND_TEST_FILES="src/test/crm-tiers.test.ts src/test/crm-expiry.test.ts" pnpm test` dari root worktree. Bungkus long output lewat subagent `test-runner` (haiku).

## Kontrak
- Kode error sudah ada di `packages/shared/src/crm/errors.ts`. Jangan ganti nama.
- `packages/shared/src/crm/endpoints.ts`: endpoint staff tier CRUD dan status job, bila belum ada. Aditif saja.
- `packages/shared/src/crm/errors.ts`: kode error baru hanya bila kontrak belum punya. Tidak ada kode baru yang diduga di kartu ini.
- `packages/shared/src/crm/events.ts`: `tier.changed` dan `points.expired` sudah ada. Jangan ubah bentuk payload.

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
