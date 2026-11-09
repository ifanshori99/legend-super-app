# Brief 290c: engineer K (Opus) — legend-m4p5 rewards, penukaran, misi, voucher

Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §2 M4, M5, §3 (0195), §4 (baris m4p5), §7 (Redemption), §9. Kartu bd: `legend-m4p5` (WS-08 BE). Kontrak (`packages/shared/src/crm/*`) menang untuk bentuk field, enum, dan kode error.

## Peran

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Tingkat K (uang: poin dan voucher). Model: Opus.

## Repo dan cabang

- Worktree: `.worktrees/m4p5-rewards` dari `milestone/m1`, cabang `ws/m4p5-rewards`.
- `pnpm worktree:setup` sekali.
- Commit lokal saja. Jangan push, jangan merge.

## Tujuan

1. Katalog hadiah (`rewards`) dan penukaran atomik (§M5, §3 0195): tidak ada redeem ganda walau paralel.
2. Penukaran idempoten: kunci `(tenant_id, customer_profile_id, idempotency_key)`. Replay mengembalikan penukaran pertama.
3. Batalkan dan kedaluwarsa penukaran: poin kembali lewat baris `adjust` (`source_type='adjustment'`), stok kembali (§3 0195).
4. Misi (`missions`, `mission_progress`) dengan `period_key`. Selesai menerbitkan bonus sekali (`source_type='mission'`).
5. Voucher: tidak ada tabel baru. `GET /api/member/vouchers` membaca `vouchers` per profil.
6. Pemenuhan di kasir: staff memasukkan kode, item atau voucher diterapkan ke order (§3 0195).

## Bergantung pada

- `290a` (legend-111j): tabel `customer_profiles`, `point_ledger`, `customer_visits`, `vouchers` RLS, `withProfileLock`, `withMemberScope`, `app.enforce_member_rls`, konsumen `loyalty-earn` (`apps/api/src/services/loyalty-earn-consumer.ts`). Mulai setelah 290a merge ke cabang gabungan, atau rebase.

## Paralel dengan

- `290d` (ts50 feedback, Customer 360, RFM), `290e` (3zd1 tier, expiry), `290f` (jurnal loyalti).
- Konflik yang harus dicatat: `loyalty-earn-consumer.ts` ditulis 290a, 290c menambah langkah misi setelah baris visit. Sentuh berkas itu hanya setelah 290a merge. Kalau 290e juga menyentuh berkas itu, merge train yang mengurutkan.

## Migrasi

Migrasi `0195`, `when` = `1794274000000` (merge train boleh mengganti nomor dan `when`).

- `rewards` (T, katalog, bukan milik member): kolom kontrak, plus `per_customer_limit` int null, `redemption_valid_days` int default 30, `created_by`, `updated_at`. PK `(tenant_id, id)`. CHECK tipe: voucher punya `value` dan tanpa item; item punya item dan tanpa value. `stock` null = tak terbatas, CHECK `stock >= 0`.
- `reward_redemptions` (T, member policy): kolom kontrak, plus `ledger_entry_id`, `voucher_id` null, `expires_at`, `fulfilled_outlet_id` null, `fulfilled_by` null, `restore_entry_id` null. Unique `(tenant_id, customer_profile_id, idempotency_key)`, unique `(tenant_id, redemption_code)`. Trigger menolak transisi status di luar kontrak.
- `missions` (T): kolom kontrak. Tanpa member policy.
- `mission_progress` (T, member policy): kolom kontrak plus `period_key` (`2026-11`, `2026-W46`, atau rentang). Unique `(tenant_id, mission_id, customer_profile_id, period_key)`.
- FK komposit mengikuti pola 1 di `docs/plan/contracts.md:123-159` (FK di dalam `CREATE TABLE` tabel baru). Contoh: `(tenant_id, customer_profile_id)` ke `customer_profiles`.
- Outlet: katalog tanpa `outlet_id`. Pemenuhan memakai `fulfilled_outlet_id`, jadi tidak perlu `enforce_outlet_rls` kecuali TBD-verify kontrak meminta.
- RLS: `SELECT app.enforce_tenant_rls('public.<t>'::regclass);` untuk semua. `app.enforce_member_rls` untuk `reward_redemptions` dan `mission_progress`. Pola ada di `apps/api/src/db/schema/sales-targets.custom.sql`. Grant: `legend_app` SELECT, INSERT, UPDATE sesuai kolom status.
- Bila kontrak memakai nama kolom berbeda dari di atas, ikuti kontrak dan tulis catatan di laporan.

## Potongan untuk subagent

Tidak bertumpuk. Diduga, verifikasi di repo (TBD-verify):

1. Skema dan migrasi: `apps/api/src/db/schema/rewards.ts`, `apps/api/src/db/schema/missions.ts`, `apps/api/drizzle/0195_*.sql`, `apps/api/drizzle/meta/*`.
2. Layanan redeem dan batal: `apps/api/src/services/member-rewards.service.ts` (kunci profil, `SELECT ... FOR UPDATE` pada `rewards`, cek `rewardRedemptionCheck`, stok, ledger `redeem`, voucher).
3. Misi: `apps/api/src/services/member-missions.service.ts` dan langkah baru di `apps/api/src/services/loyalty-earn-consumer.ts` (sesudah baris kunjungan). Pola konsumen: `apps/api/src/services/accounting-auto-journal-consumer.ts`; konsumen terdaftar di `apps/api/src/worker-main.ts`.
4. Rute member: `apps/api/src/routes/member-rewards.routes.ts` (rewards, redemptions, cancel, missions, vouchers). Pasang `requireMember`, `withMemberScope`.
5. Rute staff: `apps/api/src/routes/crm-rewards.routes.ts` (CRUD hadiah dan misi, fulfil). Pakai `requireTenantPermission`.
6. Kontrak aditif (lihat bagian Kontrak): `packages/shared/src/crm/endpoints.ts`, `packages/shared/src/crm/errors.ts`.

Invarian untuk semua potongan: layanan menerima `MemberScope` sebagai satu-satunya identitas. Tidak ada `withTenant` langsung di modul rute member.

## Tes gagal-dulu

Tulis dan lihat merah sebelum kode. Berkas: `apps/api/src/test/` (nama mengikuti pola berkas tes yang ada, TBD-verify).

- Konkurensi: 20 redeem paralel dengan `stock = 1` menghasilkan tepat satu sukses, sisanya `REWARD_OUT_OF_STOCK`.
- Replay: idempotency key sama mengembalikan penukaran pertama, tanpa baris ledger kedua.
- Poin kurang: `POINTS_INSUFFICIENT`, tanpa baris ledger, stok tidak turun.
- Batal: poin kembali lewat `adjust` dengan `reason='redemption_cancelled'`, stok kembali, dan batal dua kali tidak menambah poin.
- Kedaluwarsa penukaran: `reason='redemption_expired'`.
- Batas per pelanggan: `REDEMPTION_LIMIT_REACHED`.
- Hadiah kedaluwarsa: `REWARD_EXPIRED`.
- Voucher: penukaran voucher membuat baris `vouchers` dengan `customer_profile_id`, `source='loyalty_reward'`.
- Misi: selesai menerbitkan bonus sekali; dua kali konsumsi event yang sama tetap satu bonus (`source_id` = id progres).
- Isolasi: member A tidak bisa baca atau batalkan penukaran, progres, atau voucher B lewat rute mana pun. Dengan GUC diset, select mentah atas baris B kosong.
- Rute: member tanpa profil dapat 404 `CUSTOMER_NOT_FOUND`. Sesi member di rute staff dapat 403 `PERMISSION_DENIED`.
- Tenant: data tenant lain tidak terlihat (tes lintas tenant untuk tabel baru).

Perintah: dari root worktree, `LEGEND_TEST_FILES="src/test/<berkas>.test.ts ..." pnpm test`. Path relatif ke `apps/api`, dipisah spasi. Contoh: `LEGEND_TEST_FILES="src/test/member-ledger.test.ts src/test/member-earn.test.ts" pnpm test`.

## Kontrak

Tambahan aditif di `packages/shared/src/crm/endpoints.ts` dan `errors.ts`, hanya bila belum ada:

- Rute staff yang sudah ada di kontrak (`endpoints.ts:287-339`): `GET`/`POST /api/loyalty/rewards`, `/api/loyalty/rewards/:rewardId`, `GET`/`POST /api/loyalty/missions`, `/api/loyalty/missions/:missionId`. Pakai bentuk di kontrak, jangan ubah.
- Rute baru (aditif):
  - `POST /api/loyalty/redemptions/fulfil` (staf memasukkan kode).
  - `POST /api/member/redemptions/:redemptionId/cancel`.
- Kode error sudah ada di `packages/shared/src/crm/errors.ts`: `POINTS_INSUFFICIENT`, `REWARD_OUT_OF_STOCK`, `REWARD_EXPIRED`, `REDEMPTION_LIMIT_REACHED`, `VOUCHER_INVALID`, `MARKETING_CONSENT_REQUIRED`, `MEMBERSHIP_NOT_ACTIVE`, `CUSTOMER_NOT_FOUND`. Jangan ganti nama. Tambah kode baru hanya bila benar-benar tidak ada.

## Gate cabang

- Lint dan typecheck paket yang berubah lewat `heavy`: `heavy pnpm --filter @starter/api typecheck`, dan `heavy pnpm --filter @starter/shared typecheck` bila `packages/shared` berubah. `pnpm exec eslint <berkas berubah>`.
- `LEGEND_TEST_FILES="..." pnpm test` untuk semua tes baru dan tes 290a yang terdampak.
- `pnpm db:generate` harus kosong (tidak ada perubahan skema tak ter-migrasi).
- `pnpm exec prettier --check <berkas berubah>`.
- Jangan jalankan `pnpm check` penuh di sini. Itu gate akhir.
- Review: tingkat K, satu subagent `architect` untuk diff cabang. Temuan nyata diperbaiki sebelum lanjut.

## Bukti selesai

- Semua tes di bagian Tes gagal-dulu hijau, dan terbukti merah sebelum kode (sebut SHA merah dan hijau).
- Gate di atas lolos.
- Migrasi `0195` ter-generate bersih dan `drizzle/meta` ikut di-commit.

## Laporan

SHA commit, kartu bd `legend-m4p5` selesai atau belum, jumlah subagent yang di-spawn dan puncak bersamaan, hasil gate, temuan review dan perbaikannya, bagian yang belum teruji, dan catatan TBD-verify yang masih terbuka.
