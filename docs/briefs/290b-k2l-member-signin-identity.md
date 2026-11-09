# Brief 290b: engineer K — legend-k2l magic link, Google, graf identitas, merge

Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §1, §2 (M2, M3), §3 (tabel 0194), §4 (baris k2l), §7 (identitas). Desain tidak boleh diubah. Jika ada yang kurang jelas, tulis `TBD-verify: ...` di laporan.

## Peran

- Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`.
- Tingkat K (akses dan identitas, migrasi). Model: Opus 5.5, effort high.
- Review tingkat K: satu subagent `architect`.

## Repo dan cabang

- Worktree: `.worktrees/ws01-k2l` dari `milestone/m1`, cabang `ws/ws01-k2l`.
- Jalankan `pnpm worktree:setup` sekali setelah membuat worktree.
- Commit lokal saja. Jangan push, jangan merge ke `milestone/m1`.
- Kartu bd `legend-k2l` tetap milik CTO. Jangan ubah status kartu dari sini.

## Tujuan

1. Magic link lewat Better Auth `magicLink` plugin, `expiresIn: 600`, sender di balik port `EmailSender`. Produksi tanpa kunci provider menjawab 503 `EMAIL_NOT_CONFIGURED`. Alamat berakhiran `.invalid` ditolak (§M2).
2. Google lewat `socialProviders.google`, aktif hanya bila `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` ada. `accountLinking` dengan `trustedProviders: ["google"]`. Tidak pernah menaut ke placeholder `@wa.invalid` (§M2).
3. Tolak akun staf pada metode member: hook `before` untuk `/sign-in/magic-link`, `/magic-link/verify`, `/callback/:id`, dan login WhatsApp yang sudah ada. Jawaban generik, tanpa enumerasi. Akun staf = punya role assignment aktif atau baris `platform_admins` (§M2).
4. Graf identitas: baris `user_identities` untuk `email` (digest alamat ternormalisasi), `google` (`provider_subject` = `sub`), dan `whatsapp` yang sudah ada. Satu WhatsApp per user (§M3).
5. Merge saat user yang sudah login membuktikan nomor WhatsApp milik user lain (jalur tautan reverse OTP, `identity-login.service.ts`). Syarat dan langkah ada di §M3 poin 1 sampai 3. Akun V yang punya identitas selain WhatsApp, role, atau `platform_admins` ditolak 409 `IDENTITY_MERGE_NEEDS_SUPPORT` dan dicatat audit.
6. Merge memindahkan profil per tenant sesuai §M3 poin 4. Ketentuan ini bergantung pada tabel `customer_profiles` dari 290a.

## Bergantung pada

- Slice sign-in (magic link, Google, tolak staf, identitas) tidak bergantung pada 290a dan boleh mulai sekarang.
- Slice merge (poin 5 dan 6) rebase di atas 290a setelah 290a selesai. Migrasi 0194 bergantung pada tabel profil dari 0193.
- `legend-v0o` (WhatsApp reverse OTP) sudah selesai di m1.

## Paralel dengan

- 290a (`legend-111j`). Jangan sentuh berkas skema `crm*` di sini.

## Migrasi

Satu migrasi `0194`, `when` = `1794273000000`. Nomor ikut urutan merge; merge train boleh mengganti nama.

Isi (§3):

- `identity_merges` (global, tanpa `tenant_id` dan tanpa RLS, seperti `user_identities`): `id`, `survivor_user_id`, `absorbed_user_id` (unik), `trigger` (`whatsapp_link`, `support`), `identity_ids` uuid[], `profile_moves` jsonb (`[{tenantId, profileId, action}]`), `created_at`, `created_by`. Trigger append-only, `legend_app` hanya SELECT dan INSERT.
- Indeks unik parsial `user_identities_one_whatsapp_per_user ON (user_id) WHERE type='whatsapp'`.
- Sebelum indeks dibuat, migrasi memeriksa duplikat dan gagal dengan pesan jelas. Migrasi tidak boleh gagal diam-diam pada indeks.
- `user_identities` tetap global, tanpa RLS, unik `(type, value_hash)` seperti sekarang. `identity_merges` juga tanpa RLS. Grant `legend_app` SELECT dan INSERT saja; trigger append-only.

Setelah edit skema: `pnpm db:generate` harus menghasilkan migrasi ini saja. Periksa SQL-nya.

## Potongan untuk subagent

Berkas diduga (verifikasi dulu, TBD-verify):

1. Better Auth: `apps/api/src/lib/auth.ts` (plugin `magicLink`, `socialProviders.google`, `accountLinking`, hook `before`), `apps/api/src/config/env.ts` (variabel baru: kunci email dan Google, validasi).
2. Port email: `apps/api/src/lib/email*.ts` (interface `EmailSender`, implementasi nonproduksi, penolakan 503 di produksi).
3. Penolakan staf dan identitas: `apps/api/src/services/identity-login.service.ts`, `identity-wa-inbound.service.ts`, `apps/api/src/lib/identity-session.ts`, `apps/api/src/db/schema/identity.ts`.
4. Merge: `apps/api/src/services/identity-merge*.ts` (advisory lock dua user, urutan id terurut), dan skema `identity_merges` di `apps/api/src/db/schema/identity-merge*.ts`.
5. Kontrak aditif: `packages/shared/src/crm/errors.ts` dan `packages/shared/src/crm/endpoints.ts` (kode `EMAIL_NOT_CONFIGURED`, `IDENTITY_MERGE_NEEDS_SUPPORT`; endpoint sign-in member di §4).

Potongan tidak boleh tumpang tindih. `lib/auth.ts` hanya dipegang satu subagent.

## Tes gagal-dulu

Tulis tes dulu, jalankan, catat merah. Berkas tes di `apps/api/src/test/`:

- `member-signin.test.ts`:
  - Email staf ditolak di magic link dengan jawaban generik yang sama dengan email tidak dikenal.
  - Google dengan email terverifikasi menggabung ke user magic link dengan email sama.
  - Google dan magic link tidak pernah menaut ke `@wa.invalid`.
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
  - Dua merge paralel untuk pasangan user yang sama menghasilkan satu hasil (advisory lock).

Perintah: `LEGEND_TEST_FILES="src/test/member-signin.test.ts src/test/identity-merge.test.ts" pnpm test` dari root worktree.

## Kontrak

- Endpoint Better Auth (bukan rute baru): `/api/auth/sign-in/magic-link`, `/api/auth/magic-link/verify`, `/api/auth/sign-in/social` (google).
- Kode error baru di `packages/shared/src/crm/errors.ts`: `EMAIL_NOT_CONFIGURED` (503), `IDENTITY_MERGE_NEEDS_SUPPORT` (409).
- Rute baca dukungan merge (staf) hanya bila diperlukan oleh desain §4; tidak wajib untuk 290b kecuali CTO meminta.

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
