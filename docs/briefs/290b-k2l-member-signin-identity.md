# Brief 290b: engineer K — legend-k2l login email, Google, graf identitas, merge

Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §1, §2 (M2, M3), §3 (tabel 0194), §4 (baris k2l), §7 (identitas). Aturan bersama: `docs/briefs/290-aturan-bersama.md`. Desain menang; aturan bersama merinci. Bila beda, tulis TBD-verify di laporan. Jika ada yang kurang jelas, tulis `TBD-verify: ...` di laporan.

## Peran

- Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`.
- Tingkat K (akses dan identitas, migrasi). Model: Opus 5.5, effort high.
- Review tingkat K: satu subagent `architect`.

## Repo dan cabang

- Worktree: `.worktrees/ws01-k2l` dari `milestone/m1`, cabang `ws/ws01-k2l`.
- Jalankan `pnpm worktree:setup` sekali setelah membuat worktree.
- Commit lokal saja. Jangan push, jangan merge ke `milestone/m1`.
- Kartu bd `legend-k2l` tetap milik CTO. Jangan ubah status kartu dari sini.

## Aturan bersama

- Migrasi: `pnpm db:generate`, ganti nama berkas ke `0194`, `when` = `1794273000000`. `idx` ikut urutan jurnal cabang, `prevId` = snapshot terakhir di m1 (pola 0174/0176/0178 di `docs/PROGRESS.md`). Migrasi ini mengubah data (backfill sesi): daftar di `MIGRATION_DATA_STATEMENTS` (pola 0186). Merge train menomori ulang bila urutan merge berubah.
- Berkas registri bersama (hanya tambah, tiap tambahan di blok sendiri dengan komentar `legend-k2l`): `packages/shared/src/crm/errors.ts`, `packages/shared/src/crm/endpoints.ts`, `apps/api/src/db/schema/index.ts`, `apps/api/src/routes/index.ts`. Tiap berkas dipegang SATU subagent.
- Izin baru dan `permissions.ts`/`roles.ts`: dipegang 290a. 290b tidak menyentuh.

## Tujuan

1. Login email lewat `login_challenges` yang sudah ada (channel `email_magic_link` sudah ada di CHECK, kontrak AUTH-01 `docs/plan/contracts.md:295`). BUKAN plugin Better Auth `magicLink`.
   - Link berlaku 15 menit, sekali pakai, token disimpan sebagai digest berkunci, tenant dari domain.
   - Rute baru: `POST /api/auth/login-challenges/email` (minta link) dan `POST /api/auth/login-challenges/email/verify` (token). Sesi dibuat lewat `createCustomerSession`, yang diperluas agar menulis `auth_method`.
   - Sender di balik port `EmailSender`. Produksi tanpa kunci provider menjawab 503 `EMAIL_NOT_CONFIGURED`. Alamat berakhiran `.invalid` ditolak.
2. Ikatan browser: saat minta link, set cookie ikatan. Digest disimpan di `login_challenges.browser_binding_hash`.
   - Verify di browser yang sama = sesi biasa.
   - Verify di browser lain (kontrak: link boleh dibuka di browser mana pun) = sesi `auth_cross_device = true`. Sesi ini boleh semua fitur member KECUALI tautkan WhatsApp dan merge: 403 `IDENTITY_LINK_REAUTH_REQUIRED`.
   - Ini menutup serangan: penyerang mengirim link miliknya, korban login sebagai penyerang, lalu korban memverifikasi WhatsApp dan merge menyerahkan akun korban.
   - Kolom `login_challenges.browser_binding_hash` sudah ada (`NOT NULL varchar(64)`, `drizzle/0015_daily_star_brand.sql:7`). Kode challenge email wajib mengisinya. Tidak ada migrasi untuk kolom ini.
3. Kolom sesi baru (migrasi 0194): `session.auth_method` varchar (`password`, `whatsapp`, `email_magic_link`, `google`, `legacy`) dan `session.auth_cross_device` boolean default false.
   - Diisi di `databaseHooks.session.create.before` (`lib/auth.ts:146`) dari `ctx.path` untuk sesi Better Auth, dan oleh `createCustomerSession` untuk WhatsApp dan login email.
   - Backfill: sesi `kind='management'` = `password`, sisanya `legacy`.
   - Gerbang identitas (`middleware/identity.ts:57-63`) menaikkan sesi ke `management` HANYA bila `auth_method='password'`. Sesi WhatsApp, login email, Google, dan `legacy` tidak pernah naik.
4. Staf boleh memakai aplikasi member dengan akun yang sama. Sesinya hanya customer. Tidak ada penolakan akun staf di metode member. Larangan swalayan (290a) mencegah staf dapat poin dari transaksinya sendiri.
5. Google: `socialProviders.google` (state OAuth mengikat browser), aktif hanya bila `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` ada. `accountLinking` dengan `trustedProviders: ["google"]`. Tidak pernah menaut ke placeholder `@wa.invalid`.
6. Graf identitas: baris `user_identities` untuk `email` (digest alamat ternormalisasi), `google` (`provider_subject` = `sub`), dan `whatsapp` yang sudah ada. Satu WhatsApp per user (§M3).
7. Merge saat user yang sudah login membuktikan nomor WhatsApp milik user lain (jalur tautan reverse OTP, `identity-login.service.ts`). Syarat dan langkah di §M3 poin 1 sampai 3. Akun V yang punya identitas selain WhatsApp, role, atau `platform_admins` ditolak 409 `IDENTITY_MERGE_NEEDS_SUPPORT` dan dicatat audit. Tambahan:
   - (a) Sebelum tautkan, PWA menampilkan konfirmasi yang menyebut akun yang sedang login (email termasking).
   - (b) Sesudah merge, balasan WhatsApp ke nomor itu menyebut akun tujuan termasking.
   - (c) Profil U yang ditutup diberi `user_id = NULL` (unik `(tenant_id, user_id)`).
   - (d) Cari profil lintas tenant lewat fungsi `SECURITY DEFINER` `app.member_profiles_of_user(text)` (dibuat 290a di 0193; pola `app.resolve_delivery_store` di `drizzle/0126_*`), lalu `withTenant` per tenant.
   - (e) Syarat "profil U kosong": tanpa baris di `point_ledger`, `reward_redemptions`, `vouchers`, `orders`, `customer_visits`, `feedback`, `referrals`, `mission_progress`. Merge ditolak bila profil U punya voucher atau order. Consent U dicatat ulang ke profil V lewat `recordMemberConsent` (290a).
   - (f) WhatsApp terverifikasi belakangan: jalur tautan WhatsApp sukses dan sesudah merge memanggil `onWhatsAppVerified(tx, userId, whatsappHash)` dari `services/member-profile.service.ts` (290a). Fungsi itu mengisi `whatsapp_hash` dan `whatsapp_verified_at` tiap profil user, dan mengubah `pending_verification` jadi `active` bila consent loyalty aktif.
   - (g) Konfirmasi (a) dan layar tautkan WhatsApp milik 290g (ui-engineer). 290b hanya menyediakan API. Balasan WhatsApp (b) ditulis di `services/identity-wa-inbound.service.ts`.
8. Merge memindahkan profil per tenant sesuai §M3 poin 4. Slice merge (poin 7) bergantung pada tabel `customer_profiles` dari 290a dan rebase di atas 290a setelah 290a selesai. Slice sign-in (poin 1 sampai 5) tidak bergantung pada 290a dan boleh mulai sekarang.
9. Urutan: `identity-login.service.ts` disentuh slice "sesi dan auth_method" dulu, lalu slice merge. Berurutan, bukan paralel.
10. Rute baca dukungan merge TIDAK ada di m1. Dukungan memakai baris `identity_merges` dan audit.

## Bergantung pada

- Migrasi 0194 TIDAK bergantung pada 0193 (tidak ada FK ke profil). Yang menunggu 290a hanya slice kode merge.
- `legend-v0o` (WhatsApp reverse OTP) sudah selesai di m1.

## Paralel dengan

- 290a (`legend-111j`). Jangan sentuh berkas skema `crm*` di sini.

## Migrasi

Isi (§3):

- `identity_merges` (global, tanpa `tenant_id` dan tanpa RLS, seperti `user_identities`): `id`, `survivor_user_id`, `absorbed_user_id` (unik), `trigger` (`whatsapp_link`, `support`), `identity_ids` uuid[], `profile_moves` jsonb (`[{tenantId, profileId, action}]`), `created_at`, `created_by`. Trigger append-only, `legend_app` hanya SELECT dan INSERT.
- Indeks unik parsial `user_identities_one_whatsapp_per_user ON (user_id) WHERE type='whatsapp'`. Sebelum indeks dibuat, migrasi memeriksa duplikat dan gagal dengan pesan jelas. Migrasi tidak boleh gagal diam-diam pada indeks.
- `user_identities` tetap global, tanpa RLS, unik `(type, value_hash)` seperti sekarang.
- `session.auth_method` dan `session.auth_cross_device` (Tujuan 3), beserta backfill-nya.
- `login_challenges.browser_binding_hash`: TIDAK ada di migrasi ini. Kolom sudah ada di `drizzle/0015_daily_star_brand.sql:7`.
- Tidak ada FORCE yang dilepas. Tidak ada FK ke tabel profil.

Setelah edit skema: `pnpm db:generate` harus menghasilkan migrasi ini saja. Periksa SQL-nya.

## Potongan untuk subagent

Berkas (nama persis, TBD-verify bila ragu):

1. Better Auth dan konfigurasi: `lib/auth.ts` (`socialProviders.google`, `accountLinking`, hook `databaseHooks.session.create.before`), `config/env.ts` (variabel baru: kunci email dan Google, validasi).
2. Port email: `lib/email-sender.ts` (interface `EmailSender`, implementasi nonproduksi, penolakan 503 di produksi).
3. Login email dan sesi: `services/identity-email-login.service.ts` (login_challenges, cookie ikatan, verify), `lib/identity-session.ts` (`auth_method`, `auth_cross_device`), `middleware/identity.ts` (gerbang `management`), `db/schema/session.ts`.
4. Merge: `services/identity-merge.service.ts` (advisory lock dua user, urutan id terurut), `services/identity-login.service.ts` (jalur tautan reverse OTP), skema `db/schema/identity-merge.ts`, `services/identity-wa-inbound.service.ts` (balasan WhatsApp sesudah merge, menyebut akun tujuan termasking).
5. Kontrak aditif: lihat "Aturan bersama" (registri).

Potongan tidak boleh tumpang tindih. `lib/auth.ts` hanya dipegang satu subagent.

## Tes gagal-dulu

Tulis tes dulu, jalankan, catat merah. Berkas tes di `apps/api/src/test/`:

- `member-signin.test.ts`:
  - Login email: link kedaluwarsa setelah 15 menit dan link sekali pakai.
  - Verify di browser lain menghasilkan `auth_cross_device = true`; tautkan WhatsApp dari sesi itu ditolak 403 `IDENTITY_LINK_REAUTH_REQUIRED`.
  - Sesi login email, Google, dan WhatsApp milik staf tidak pernah jadi `management` (403 di rute staf).
  - Google dengan email terverifikasi menggabung ke user login email dengan email sama.
  - Google dan login email tidak pernah menaut ke `@wa.invalid`.
  - Produksi tanpa kunci email menjawab 503 `EMAIL_NOT_CONFIGURED`.
  - Google tidak aktif bila env Google kosong.
  - Alamat `.invalid` ditolak.
  - Sesi member pada rute staf tetap 403 `PERMISSION_DENIED` (tes ini sudah diminta di k2l §M1, jaga tetap hijau).
- `identity-merge.test.ts`:
  - Merge akun WhatsApp-only memindahkan profil dan identitas, membanned akun V (`banned=true`, `banReason='merged'`), dan menulis `identity_merges`.
  - Merge ditolak 409 bila akun V punya identitas email.
  - Merge ditolak bila akun V punya role assignment atau `platform_admins`.
  - User U yang sudah punya WhatsApp lain ditolak oleh indeks unik, dengan pesan jelas.
  - Profil dua sisi: U hanya `pending_verification` tanpa ledger dan tanpa hash WhatsApp, ditutup dengan `merged_into_profile_id`; selain itu refuse.
  - Merge mengosongkan `user_id` profil U yang ditutup.
  - Merge ditolak bila profil U punya voucher atau order.
  - Consent U dicatat ulang ke profil V.
  - Dua merge paralel untuk pasangan user yang sama menghasilkan satu hasil (advisory lock).
- WhatsApp terverifikasi belakangan: tautan WhatsApp sukses dan merge memanggil `onWhatsAppVerified`; profil `pending_verification` menjadi `active` bila consent loyalty aktif.

Perintah: `LEGEND_TEST_FILES="src/test/member-signin.test.ts src/test/identity-merge.test.ts" pnpm test` dari root worktree.

## Kontrak

- Endpoint baru (aditif): `POST /api/auth/login-challenges/email`, `POST /api/auth/login-challenges/email/verify`.
- Endpoint Better Auth (bukan rute baru): `/api/auth/sign-in/social` (google).
- Kode error baru di `packages/shared/src/crm/errors.ts`: `EMAIL_NOT_CONFIGURED` (503), `IDENTITY_MERGE_NEEDS_SUPPORT` (409), `IDENTITY_LINK_REAUTH_REQUIRED` (403).

## Gate cabang

1. `heavy pnpm --filter @starter/api typecheck`, `heavy pnpm --filter @starter/shared typecheck` (bila shared berubah), `pnpm exec eslint <berkas berubah>`.
2. Tes terarah: `LEGEND_TEST_FILES="..." pnpm test` (daftar di atas).
3. `pnpm db:generate` kosong setelah migrasi dibuat.
4. `pnpm exec prettier --check <berkas berubah>`.
5. Tidak menjalankan `pnpm check` penuh. Gate penuh hanya di akhir gelombang, oleh satu test-runner.
6. Auth/sesi berubah: `heavy pnpm test:e2e` sekali di akhir cabang (AGENTS.md mewajibkan untuk perubahan auth/sesi).

Review: satu subagent `architect` (K) untuk diff identitas dan merge. Temuan nyata diperbaiki sebelum lanjut.

Rahasia: kunci provider email (desain menyebut Brevo, belum diputuskan di `docs/plan/providers.md`) dan kunci Google tidak masuk ke repo atau brief. Minta lewat `ghostex secret request`. Jangan cetak nilainya.

## Bukti selesai

- Tes di daftar di atas hijau, dengan catatan merah sebelum implementasi.
- `pnpm db:generate` kosong.
- Lint, typecheck, dan prettier lulus.
- Review `architect` selesai dan temuan nyata sudah diperbaiki.
- Commit lokal di `ws/ws01-k2l`.
- `docs/PROGRESS.md` diperbarui.

## Laporan

- SHA, kartu `legend-k2l` (selesai atau belum), dan bagian mana yang menunggu 290a (slice merge).
- Jumlah subagent yang di-spawn dan puncak bersamaan.
- Hasil gate.
- Temuan review dan perbaikannya.
- Yang belum teruji: pengiriman email nyata (belum ada kunci), login Google nyata (belum ada client), dan semua yang diberi TBD-verify.
