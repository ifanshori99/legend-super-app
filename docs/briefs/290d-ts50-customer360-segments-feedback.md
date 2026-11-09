# Brief 290d: engineer K (Opus) — legend-ts50 Customer 360, segmentasi RFM, feedback member dan antrean staf

Sumber kebenaran: `docs/briefs/290-aturan-bersama.md` dan `docs/design/ws08-member-loyalty.md` §2 M4, §3 (0196), §4 (baris ts50), §7, §9. Desain menang; aturan bersama merinci. Bila beda, tulis TBD-verify di laporan. Kartu bd: `legend-ts50` (WS-08 BE, berjudul "Customer 360 queries, RFM segmentation, feedback/complaints"). Ruang lingkup kartu ini: Customer 360, segmentasi RFM, dan feedback. Kontrak (`packages/shared/src/crm/*`) menang untuk bentuk field dan enum.

## Peran

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Tingkat K (data pribadi, akses lintas profil, migrasi). Model: Opus.

## Repo dan cabang

- Worktree: `.worktrees/ts50-feedback` dari `milestone/m1`, cabang `ws/ts50-feedback`.
- `pnpm worktree:setup` sekali.
- Commit lokal saja. Jangan push, jangan merge.

## Tujuan

1. Customer 360: staf membaca daftar dan detail pelanggan (`GET /api/customers`, `GET /api/customers/:customerProfileId`, kontrak `customer360Schema`, `endpoints.ts:200-207`). Nomor WhatsApp hanya tampil termasking. Nomor penuh butuh izin `crm.customer.pii.read`, dan tiap pembukaan dicatat di audit. Nomor asli dibaca dari `user_identities.value_encrypted` lewat `sealSecret`.
2. Customer 360 juga menampilkan favorit dan voucher (B19). Favorit memakai `memberFavorites(tx, profileId)` dari `services/member-favorites.service.ts` (order lunas, `order_items`). Fungsi yang sama dipakai `GET /api/member/favorites` di 290g.
3. Segmentasi RFM: tabel `segments` dan `segment_members` (materialisasi). Rute `GET`/`POST /api/segments`, `POST /api/segments/preview` (`endpoints.ts:494-517`). Aturan mengikuti `segmentRuleSchema` dan `segmentDefinitionSchema` (`packages/shared/src/crm/crm.ts:44-104`). Materialisasi lewat job worker harian dan saat segmen disimpan. Izin `crm.segment.manage` (sudah ada).
4. Member mengirim feedback atau keluhan untuk order miliknya atau sesi meja yang ia ikuti (`POST /api/member/feedback`). Hanya profil `active` (B16). Status lain: 403 `MEMBERSHIP_NOT_ACTIVE`.
5. Tabel `feedback` (T+O) dengan `handled_note`.
6. Antrean feedback untuk staf dengan izin `crm.feedback.manage` dan transisi status lewat `transitionFeedback` dari kontrak (`GET /api/feedback`, `PATCH /api/feedback/:feedbackId`, `endpoints.ts:581-592`).
7. Tiap feedback punya pemilik yang jelas: member hanya melihat feedback miliknya. Baris dari tamu QR (profil null) tidak terlihat member.
8. Satu feedback per kombinasi order dan jenis oleh satu member (anti duplikat).
9. Izin baru (A.4): `crm.customer.pii.read`, `crm.feedback.manage`. Izin yang dipakai, sudah ada: `crm.customer.view`, `crm.segment.manage`.

## Bergantung pada

- `290a` (legend-111j): `customer_profiles`, `withMemberScope`, `app.enforce_member_rls`, `requireMember`. Mulai setelah 290a merge ke cabang gabungan, atau rebase.

## Paralel dengan

- `290c` (m4p5), `290e` (3zd1), `290f` (jurnal). Tidak ada berkas bersama yang diketahui, kecuali registri bersama (lihat Potongan nomor 7). Bila ada tabrakan, rebase dan gabungkan aditif.

## Migrasi

Migrasi `0196`, `when` = `1794275000000` (nomor cadangan kartu; merge train boleh menomori ulang bila urutan merge berubah).

- Jalankan `pnpm db:generate`, ganti nama berkas ke `0196_*`, set `when` di `drizzle/meta/_journal.json`. `idx` ikut urutan jurnal cabang. `prevId` = snapshot terakhir di m1 (pola 0174/0176/0178 di `docs/PROGRESS.md`).
- Migrasi 0196 tidak mengubah data dan tidak melepas FORCE. Tidak masuk `MIGRATION_DATA_STATEMENTS`.
- `feedback` (T+O): kolom kontrak, plus `handled_note`. PK `(tenant_id, id)`. FK komposit `(tenant_id, customer_profile_id)` ke `customer_profiles` dan `(tenant_id, order_id)` ke `orders (tenant_id, id)`, pola 1 di `docs/plan/contracts.md:123-159`. `orders` adalah tabel order tunggal semua kanal (`apps/api/src/db/schema/qr-order.ts:184`). `pos_orders` hanya perpanjangan POS, jadi tidak dipakai sebagai target FK. Unique `(tenant_id, order_id, customer_profile_id, kind)`. `outlet_id NOT NULL`.
- `segments` (T): kolom kontrak. PK `(tenant_id, id)`.
- `segment_members` (T, materialisasi): kolom kontrak. PK atau unique `(tenant_id, segment_id, customer_profile_id)`, FK komposit ke `segments` dan `customer_profiles`.
- RLS: `SELECT app.enforce_tenant_rls('public.<t>'::regclass);` untuk `feedback`, `segments`, dan `segment_members`. `SELECT app.enforce_outlet_rls(...)` untuk `feedback` (pola `apps/api/src/db/schema/sales-targets.custom.sql`).
- `app.enforce_member_rls('public.feedback'::regclass)` dengan kolom default `customer_profile_id` (B7). Baris dengan profil null hanya terlihat staf, tidak terlihat member.
- Grant: `legend_app` SELECT, INSERT, UPDATE. Status diubah lewat layanan, tidak lewat DELETE.
- Tidak ada perubahan pada `session_participants` (hanya dibaca).

## Potongan untuk subagent

Tidak bertumpuk. Nama berkas per kartu (D):

1. Skema dan migrasi: `apps/api/src/db/schema/crm-feedback.ts`, `apps/api/src/db/schema/crm-segments.ts`, `apps/api/drizzle/0196_*.sql`, `apps/api/drizzle/meta/*`.
2. Customer 360: `apps/api/src/services/customer360.service.ts` (daftar, detail, favorit, voucher). Rute staf: `apps/api/src/routes/customers.routes.ts`. Pakai `requireTenantPermission` dengan `crm.customer.view`. Pembukaan nomor penuh lewat `crm.customer.pii.read` dengan penulisan audit.
3. Favorit: `apps/api/src/services/member-favorites.service.ts` (`memberFavorites(tx, profileId)`).
4. Segmen: rute `apps/api/src/routes/segments.routes.ts`, job `apps/api/src/worker/segment-materialize.job.ts`. Layanan: `apps/api/src/services/segments.service.ts`. Pakai `requireTenantPermission` dengan `crm.segment.manage`.
5. Feedback member: rute `apps/api/src/routes/member-feedback.routes.ts` (`POST /api/member/feedback`). Pasang `requireAuth`, `requireTrustedOrigin`, `jsonBody`, `requireMember`, dan validasi zod strict dari `packages/shared`. Cek kepemilikan order (`customer_profile_id` cocok) atau sesi meja (`session_participants.user_id` = user sesi). Layanan: `apps/api/src/services/feedback.service.ts` (fungsi member dan staf di satu berkas; potongan 5 dan 6 berurutan, satu subagent).
6. Antrean staf: rute `apps/api/src/routes/feedback.routes.ts` (`GET /api/feedback`, `PATCH /api/feedback/:feedbackId`). Pakai `requireTenantPermission` dengan `crm.feedback.manage`, dan `requireOutletPermission` bila antrean dibatasi outlet (TBD-verify). Layanan: `apps/api/src/services/feedback.service.ts`, subagent yang sama dengan nomor 5.
7. Berkas registri bersama (A.2): `packages/shared/src/crm/endpoints.ts`, `packages/shared/src/crm/errors.ts`, `packages/shared/src/access/permissions.ts`, `packages/shared/src/access/roles.ts`, `apps/api/src/db/schema/index.ts`, `apps/api/src/routes/index.ts`, `apps/api/src/worker-main.ts` (daftar job materialisasi), dan `packages/shared/package.json` bila subpath baru. Dipegang SATU subagent. Tambahan tiap blok diberi komentar id kartu `legend-ts50`. Merge train menyelesaikan konflik teks.

Invarian: layanan member tidak pernah membaca profil dari path, query, atau body. Modul rute member tidak mengimpor `withTenant` langsung. Layanan Customer 360 tidak pernah mengembalikan nomor penuh kecuali pemanggil punya `crm.customer.pii.read`.

## Tes gagal-dulu

Tulis dan lihat merah sebelum kode. Berkas: `apps/api/src/test/member-feedback.test.ts`, `apps/api/src/test/crm-feedback.test.ts`, `apps/api/src/test/crm-customer360.test.ts`, `apps/api/src/test/crm-segments.test.ts` (nama mengikuti pola yang ada, TBD-verify).

Feedback:

- Member A mengirim feedback untuk order miliknya: 201, baris tersimpan dengan profil A.
- Member A untuk order milik B: 404 `NOT_FOUND` umum. Jangan pakai `CUSTOMER_NOT_FOUND`, agar keberadaan order tidak bocor.
- Sesi meja: member yang tergabung di `session_participants` boleh mengirim feedback untuk sesi itu. Yang tidak tergabung ditolak.
- Dua kali feedback jenis sama untuk order sama dari member sama: kedua tolak dengan konflik, hanya satu baris.
- Member dengan status tidak aktif (`pending_verification`, `closed`): `POST /api/member/feedback` 403 `MEMBERSHIP_NOT_ACTIVE` (B16).
- Member tanpa profil dapat 404 `CUSTOMER_NOT_FOUND`.
- Isolasi: member A tidak melihat feedback B lewat rute apa pun. Dengan GUC diset, select mentah atas baris B kosong. Baris tamu QR (profil null) tidak terlihat member.
- Staf tanpa `crm.feedback.manage` mendapat 403 `PERMISSION_DENIED`.
- Sesi member di rute staf mendapat 403 `PERMISSION_DENIED`.
- `transitionFeedback`: transisi di luar kontrak ditolak. Catatan `handled_note` tersimpan.

Customer 360 dan segmen:

- Daftar dan detail pelanggan: nomor WhatsApp termasking pada respons default.
- Staf tanpa `crm.customer.pii.read` tidak mendapat nomor penuh. Staf dengan izin mendapat nomor penuh, dan tiap pembukaan menulis baris audit.
- Customer 360 menampilkan favorit dan voucher (B19). Favorit sama dengan hasil `memberFavorites`.
- Segmen RFM: preview mengembalikan anggota sesuai aturan. Materialisasi menghasilkan baris `segment_members` yang sama dengan preview.
- Isolasi dan tenant: data tenant lain tidak terlihat. Dengan GUC diset, select mentah atas baris tenant lain kosong.

Perintah: dari root worktree, `LEGEND_TEST_FILES="src/test/member-feedback.test.ts src/test/crm-feedback.test.ts src/test/crm-customer360.test.ts src/test/crm-segments.test.ts" pnpm test`. Path relatif ke `apps/api`, dipisah spasi (sesuai `CLAUDE.md`).

## Kontrak

- `POST /api/member/feedback` (baru, aditif di `endpoints.ts`).
- `GET /api/customers`, `GET /api/customers/:customerProfileId`: pakai `customer360Schema` yang ada.
- `GET`/`POST /api/segments`, `POST /api/segments/preview`: pakai yang ada di `endpoints.ts:494-517`.
- `GET /api/feedback`, `PATCH /api/feedback/:feedbackId`, dan `transitionFeedback`: pakai yang ada di `endpoints.ts:581-592`. Tambah hanya bila belum ada (TBD-verify).
- Izin baru (A.4): `crm.customer.pii.read`, `crm.feedback.manage`. Tambah di `packages/shared/src/access/permissions.ts` dan peran di `roles.ts` bila belum ada.
- Kode error: pakai yang ada di `packages/shared/src/crm/errors.ts`. Bila perlu kode baru (misal konflik duplikat), tambah aditif di `errors.ts` dan tulis di laporan.

## Gate cabang

- Lint dan typecheck paket yang berubah lewat `heavy`: `heavy pnpm --filter @starter/api typecheck`, dan `heavy pnpm --filter @starter/shared typecheck` bila `packages/shared` berubah. `pnpm exec eslint <berkas berubah>`.
- `LEGEND_TEST_FILES="..." pnpm test` untuk tes baru.
- `pnpm db:generate` harus kosong.
- `pnpm exec prettier --check <berkas berubah>`.
- Jangan jalankan `pnpm check` penuh. Itu gate akhir.
- Review: tingkat K, satu subagent `architect` untuk diff cabang. Temuan nyata diperbaiki sebelum lanjut.

## Bukti selesai

- Semua tes di Tes gagal-dulu hijau, dan terbukti merah sebelum kode (sebut SHA merah dan hijau).
- Gate di atas lolos.
- Migrasi `0196` ter-generate bersih, `drizzle/meta` ikut di-commit.

## Laporan

SHA commit, kartu bd `legend-ts50` selesai atau belum, jumlah subagent yang di-spawn dan puncak bersamaan, hasil gate, temuan review dan perbaikannya, bagian yang belum teruji, dan catatan TBD-verify yang masih terbuka.
