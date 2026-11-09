# Brief 290g: engineer — legend-u57q member API sisa + web wiring

Level: K (data pribadi, akses member). Model: Sonnet 5.5 (naik Opus bila gagal 1x). Effort: high.
Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §2 M1, M4, M7, §4 (u57q), §7.
Kontrak: `packages/shared/src/crm/endpoints.ts` (`memberEndpoints`), `errors.ts`. Kontrak menang atas desain.

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Kamu memimpin subagent sendiri.

## Repo dan cabang
- Worktree: `.worktrees/member-pwa-api` dari `milestone/m1`, cabang `ws/member-pwa-api`. Cabang itu sudah dibuat kosong dari m1 tanpa commit (komentar u57q). Pakai cabang itu.
- Jalankan `pnpm worktree:setup` sekali.
- Commit lokal saja. Jangan push, jangan merge.
- Kartu bd: legend-u57q (status BLOCKED). Jangan mulai sebelum semua dependensi merge ke cabang induk (lihat "Bergantung pada").

## Bergantung pada
- 290a (legend-111j): `customer_profiles`, `point_ledger`, `customer_visits`, `withMemberScope`, `requireMember`, `POST /api/member/consents`, `GET /api/member/consent-policies`, `GET /api/member/profile`, `GET /api/member/points`.
- 290b (legend-k2l): sign-in member dan identity graph.
- 290c (legend-m4p5): `GET /api/member/rewards`, redeem, missions, vouchers.
- 290d (legend-ts50): `POST /api/member/feedback`.
- 290e (legend-3zd1): tier fields di profil.
- Jika salah satu belum merge, berhenti dan lapor ke CTO. Jangan menebak kontrak.

## Paralel dengan
Tidak ada. Kartu ini memegang rute member dan web member.

## Tujuan
1. Route yang belum ada (§4 u57q): `GET /api/member/overview`, `GET /api/member/visits`, `GET /api/member/favorites`, `PATCH /api/member/profile`. Semua lewat chain M4: `tenantContext` → `requireAuth` → `requireTrustedOrigin` (mutasi) → `jsonBody` (PATCH) → `requireMember({ allow })`.
2. Overview memuat versi kebijakan aktif per tujuan (`loyalty`, `marketing`, `ai`) dari `consent_policy_versions`. Ini menggantikan fallback `FALLBACK_POLICY_VERSION` (2026-01) di web.
3. Visits membaca `customer_visits` milik profil sendiri, dengan paginasi yang divalidasi zod strict.
4. PATCH profile: hanya field yang diizinkan kontrak (nama, tanggal lahir, dan field lain yang kontrak sebut). Tidak boleh menerima `id`, `tenant_id`, `user_id`, `customer_profile_id`, `whatsapp_hash`, `points_balance`, atau `membership_status`. Zod strict menolak field lain.
5. Member service hanya menerima `MemberScope`. Tidak ada `profileId` dari path, query, atau body.
6. Web: `apps/web/src/features/ws08-member` pindah dari mock ke API (`api.ts` → `queries.ts` → `hooks.ts`). Mock dihapus dari jalur yang sudah diganti. Loader route memanggil `ensureQueryData`.
7. E2E: alur member (daftar, lihat poin, tukar hadiah, visit, ubah profil) lewat Playwright (`pnpm test:e2e`, wajib lewat `heavy`).

## Migrasi
Tidak ada. Desain §8 tidak mencantumkan migrasi untuk u57q.
Favorit: tanpa tabel. Kueri dari `order_items` order lunas milik member (`orders.customer_profile_id` sebagai scope), dikelompokkan per menu item, diurutkan menurut jumlah lalu terakhir dipesan.

## Potongan untuk subagent
Berkas diduga. Cek dengan Explore dulu, satu per area.
1. `apps/api/src/services/member-overview.service.ts`, `member-visits.service.ts`, `member-profile.service.ts` (PATCH), `member-favorites.service.ts`.
2. `apps/api/src/routes/member*.routes.ts` (tambah rute, daftar di `routes/index.ts`). Jangan mengubah rute 290a-290d.
3. `packages/shared/src/validators/member*.ts` dan `packages/shared/src/types/api.ts` (DTO). Tambah subpath di `packages/shared/package.json` bila perlu.
4. `apps/web/src/features/ws08-member/{api,queries,hooks}.ts` dan komponen terkait. Route di `apps/web/src/routes/_customer/` (cek `docs/frontend.md` "Where to put a new screen").
5. test-writer: `apps/api/src/test/member-api.test.ts` (isolasi dan validasi), `apps/api/src/test/member-scope-import.test.ts` (rute member hanya impor `withMemberScope`, bukan `withTenant`).
6. E2E: `e2e/acceptance/` untuk alur member. Test di sana tidak boleh dilemahkan.

Subagent: implementer sonnet untuk 1-4, test-writer sonnet untuk 5. Potongan 6 dikerjakan kamu sendiri atau subagent terpisah bila berkas tidak bertumpuk. Maks 8 yang mengedit sekaligus.

Batas: `e2e/visual/` baseline tidak boleh diubah. Bila tampilan perlu berubah, lapor ke CTO.

## Tes gagal-dulu
- Isolasi: member A tidak bisa membaca overview, visits, favorites milik B lewat route manapun.
- Isolasi: dengan GUC `app.customer_profile_id` diset ke A, select langsung baris B kosong.
- Staff tanpa profil: `GET /api/member/overview` → 404 `CUSTOMER_NOT_FOUND`.
- Member session di rute staff: 403 `PERMISSION_DENIED`.
- Profil `pending_verification`: overview boleh (`allow: "pending"`), visits dan rute mutasi tertentu ditolak sesuai allow.
- Profil `closed` atau `suspended`: `MEMBERSHIP_NOT_ACTIVE` 403 untuk rute yang tidak mengizinkan.
- PATCH dengan field terlarang (`id`, `user_id`, `points_balance`, `whatsapp_hash`) → 400 (zod strict).
- PATCH tidak mengubah `points_balance` dan tidak membuat ledger row.
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
SHA, kartu bd (`legend-u57q`), jumlah subagent dan puncak bersamaan, hasil gate (lint, typecheck, build, e2e), temuan `architect` dan perbaikannya, kueri favorit dari `order_items`, mock yang tersisa, dan yang belum teruji.
