# Brief 290g: engineer — legend-u57q member API sisa + web wiring

Level: K (data pribadi, akses member). Model: Sonnet 5.5 (naik Opus bila gagal 1x). Effort: high.
Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §2 M1, M4, M7, §4 (u57q), §7. Sumber aturan bersama: `docs/briefs/290-aturan-bersama.md` (B16, B19). Desain menang; aturan bersama merinci. Bila beda, tulis TBD-verify di laporan.
Kontrak: `packages/shared/src/crm/endpoints.ts` (`memberEndpoints`), `errors.ts`. Kontrak menang atas desain.

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Kamu memimpin subagent sendiri.

## Repo dan cabang
- Worktree: `.worktrees/member-pwa-api` dari `milestone/m1`, cabang `ws/member-pwa-api`. Cabang itu sudah dibuat kosong dari m1 tanpa commit (komentar u57q). Pakai cabang itu.
- Jalankan `pnpm worktree:setup` sekali.
- Commit lokal saja. Jangan push, jangan merge.
- Kartu bd: legend-u57q (status BLOCKED). Jangan mulai sebelum semua dependensi merge ke cabang induk (lihat "Bergantung pada").

## Bergantung pada
- 290a (legend-111j): `customer_profiles`, `point_ledger`, `customer_visits`, `withMemberScope`, `requireMember`, `POST /api/member/consents`, `GET /api/member/consent-policies`, `GET /api/member/profile`, `GET /api/member/points`, `services/member-profile.service.ts`.
- 290b (legend-k2l): sign-in member dan identity graph.
- 290c (legend-m4p5): `GET /api/member/rewards`, redeem, missions, vouchers.
- 290d (legend-ts50): `POST /api/member/feedback`, dan `services/member-favorites.service.ts` (`memberFavorites(tx, profileId)`). 290g hanya MEMAKAI fungsi itu, tidak membuat ulang.
- 290e (legend-3zd1): tier fields di profil.
- Jika salah satu belum merge, berhenti dan lapor ke CTO. Jangan menebak kontrak.

## Paralel dengan
Tidak ada. Kartu ini memegang rute member dan web member.

## Tujuan
1. Route yang belum ada (§4 u57q): `GET /api/member/overview`, `GET /api/member/visits`, `GET /api/member/favorites`, `PATCH /api/member/profile`. Semua lewat chain M4: `tenantContext` → `requireAuth` → `requireTrustedOrigin` (mutasi) → `jsonBody` (PATCH) → `requireMember({ allow })`.
2. Overview memuat versi kebijakan aktif per tujuan (`loyalty`, `marketing`, `ai`) dari `consent_policy_versions`. Ini menggantikan fallback `FALLBACK_POLICY_VERSION` (2026-01) di web.
3. Visits membaca `customer_visits` milik profil sendiri, dengan paginasi yang divalidasi zod strict.
4. Favorit (B19): `GET /api/member/favorites` memanggil `memberFavorites(tx, profileId)` dari 290d. Customer 360 (290d) memakai fungsi yang sama. Tanpa tabel.
5. PATCH profile: hanya field yang diizinkan kontrak (nama, tanggal lahir, dan field lain yang kontrak sebut). Tidak boleh menerima `id`, `tenant_id`, `user_id`, `customer_profile_id`, `whatsapp_hash`, `points_balance`, atau `membership_status`. Zod strict menolak field lain.
6. Member service hanya menerima `MemberScope`. Tidak ada `profileId` dari path, query, atau body.
7. Status `pending_verification` (B16): yang boleh hanya `GET /api/member/overview` (tanpa saldo, tampilkan status saja). Visits, favorites, dan PATCH profile ditolak 403 `MEMBERSHIP_NOT_ACTIVE`.
8. Web: `apps/web/src/features/ws08-member` pindah dari mock ke API (`api.ts` → `queries.ts` → `hooks.ts`). Mock dihapus dari jalur yang sudah diganti. Loader route memanggil `ensureQueryData`. 290g (bagian ui-engineer) memegang layar login member (minta link email, halaman verify, tombol Google), dan layar konfirmasi tautkan WhatsApp yang menyebut akun yang sedang login (email termasking). 290b hanya API.
9. E2E: alur member (daftar, lihat poin, tukar hadiah, visit, ubah profil) lewat Playwright (`pnpm test:e2e`, wajib lewat `heavy`).

## Migrasi
Tidak ada. Desain §8 tidak mencantumkan migrasi untuk u57q. `pnpm db:generate` harus kosong.

## Potongan untuk subagent
Nama berkas dari tabel D. Cek dengan Explore hanya untuk berkas yang belum ada di tabel D (validator, DTO), dan lapor namanya ke CTO sebelum menulis.
1. `apps/api/src/routes/member-overview.routes.ts` (overview, visits, favorites). Implementer sonnet. Route file ini dipegang satu subagent.
2. `apps/api/src/services/member-overview.service.ts`, `apps/api/src/services/member-visits.service.ts` (nama dicek Explore; dicatat di laporan). PATCH profile di `apps/api/src/services/member-profile.service.ts` (sesudah 290a merge). Implementer sonnet.
3. Berkas registri (A.2), tiap berkas dipegang SATU subagent:
   - `apps/api/src/routes/index.ts` (daftar `member-overview.routes.ts`, hanya tambah blok dengan komentar `legend-u57q`).
   - `packages/shared/src/crm/endpoints.ts` (`memberEndpoints`: overview, visits, favorites, PATCH profile, aditif).
4. Validator dan DTO member: `packages/shared/src/validators/` dan `packages/shared/src/types/api.ts`. Tambah subpath di `packages/shared/package.json` bila perlu. Implementer sonnet.
5. Web: `apps/web/src/features/ws08-member/*` (api, queries, hooks, dan komponen terkait). Route di `apps/web/src/routes/_customer/` (cek `docs/frontend.md` "Where to put a new screen"). Dikerjakan kamu sendiri atau subagent terpisah bila berkas tidak bertumpuk. Layar login dan konfirmasi tautkan WhatsApp (tujuan 8) dikerjakan agent `ui-engineer` (Opus 5.5; Sonnet 5.5 bila tugas kecil).
6. test-writer sonnet: `apps/api/src/test/member-api.test.ts` (isolasi dan validasi), `apps/api/src/test/member-scope-import.test.ts` (rute member hanya impor `withMemberScope`, bukan `withTenant`).
7. E2E: `e2e/acceptance/` untuk alur member. Test di sana tidak boleh dilemahkan.

Subagent: implementer sonnet untuk 1-4, test-writer sonnet untuk 6. Maks 8 yang mengedit sekaligus.

Batas: `e2e/visual/` baseline tidak boleh diubah. Bila tampilan perlu berubah, lapor ke CTO.

## Tes gagal-dulu
- Isolasi: member A tidak bisa membaca overview, visits, favorites milik B lewat route manapun.
- Isolasi: dengan GUC `app.customer_profile_id` diset ke A, select langsung baris B kosong.
- Staff tanpa profil: `GET /api/member/overview` → 404 `CUSTOMER_NOT_FOUND`.
- Member session di rute staff: 403 `PERMISSION_DENIED`.
- Profil `pending_verification`: `GET /api/member/overview` 200 tanpa saldo. Visits, favorites, dan PATCH profile 403 `MEMBERSHIP_NOT_ACTIVE`.
- Profil `closed` atau `suspended`: `MEMBERSHIP_NOT_ACTIVE` 403 untuk rute yang tidak mengizinkan.
- PATCH dengan field terlarang (`id`, `user_id`, `points_balance`, `whatsapp_hash`) → 400 (zod strict).
- PATCH tidak mengubah `points_balance` dan tidak membuat ledger row.
- Favorit: hasil `GET /api/member/favorites` sama dengan `memberFavorites` untuk profil yang sama.
- Overview memuat versi kebijakan aktif dari DB, bukan fallback. Ganti versi aktif di tes, respon ikut berubah.
- Test arsitektur: rute member hanya impor `withMemberScope`.
- E2E: daftar member, lihat poin, ubah nama, lihat visit.

Perintah: `LEGEND_TEST_FILES="src/test/member-api.test.ts src/test/member-scope-import.test.ts" pnpm test` dari root worktree. E2E lewat `heavy pnpm test:e2e`. Output panjang lewat `test-runner` (haiku).

## Kontrak
- Kode error sudah ada di `packages/shared/src/crm/errors.ts`. Jangan ganti nama.
- `packages/shared/src/crm/endpoints.ts`: `memberEndpoints` harus memuat overview, visits, favorites, PATCH profile. Tambah aditif saja.
- `errors.ts`: tidak ada kode baru yang diduga.
- Data pribadi: jangan kirim `whatsapp_hash` atau nomor penuh ke web. Tampilkan hanya bentuk yang kontrak izinkan. Tes respon overview memastikan tidak ada field itu.

## Gate cabang
- `heavy pnpm --filter @starter/api typecheck`, `heavy pnpm --filter @starter/shared typecheck` (bila shared berubah), `pnpm exec eslint <berkas berubah>`, `heavy pnpm typecheck` untuk `apps/web`.
- `LEGEND_TEST_FILES="..." pnpm test` untuk tes di atas.
- `heavy pnpm build` untuk `apps/web` (route TanStack Start baru).
- `heavy pnpm test:e2e` untuk alur member.
- `pnpm db:generate` kosong (tidak ada migrasi).
- `pnpm exec prettier --check <berkas berubah>`.
- Review tingkat K: satu subagent `architect` (Opus, xhigh) untuk diff data pribadi dan akses.
- Tidak menjalankan `pnpm check` penuh. Itu gate akhir CTO.

## Bukti selesai
- Semua tes hijau setelah merah.
- E2E alur member hijau.
- Web tidak lagi membaca mock untuk rute yang sudah diganti. Sebut berkas mock yang tersisa.
- Commit lokal di `ws/member-pwa-api`. Pesan commit merujuk `legend-u57q` dan kriteria LOY-02, AUTH-07.
- `docs/PROGRESS.md` diperbarui.

## Laporan
SHA, kartu bd (`legend-u57q`), jumlah subagent dan puncak bersamaan, hasil gate (lint, typecheck, build, e2e), temuan `architect` dan perbaikannya, pemakaian `memberFavorites` dari 290d, nama berkas validator dan DTO yang dipakai, mock yang tersisa, dan yang belum teruji.
