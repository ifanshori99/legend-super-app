# Brief 290d: engineer K (Opus) — legend-ts50 Customer 360, segmentasi RFM, feedback member dan antrean staff

Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §2 M4, §3 (0196), §4 (baris ts50), §7, §9. Kartu bd: `legend-ts50` (WS-08 BE, berjudul "Customer 360 queries, RFM segmentation, feedback/complaints"). Ruang lingkup kartu ini: Customer 360, segmentasi RFM, dan feedback. Kontrak (`packages/shared/src/crm/*`) menang untuk bentuk field dan enum.

## Peran

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Tingkat K (data pribadi, akses lintas profil, migrasi). Model: Opus.

## Repo dan cabang

- Worktree: `.worktrees/ts50-feedback` dari `milestone/m1`, cabang `ws/ts50-feedback`.
- `pnpm worktree:setup` sekali.
- Commit lokal saja. Jangan push, jangan merge.

## Tujuan

1. Customer 360: staff membaca daftar dan detail pelanggan (`GET /api/customers`, `GET /api/customers/:customerProfileId`, kontrak `customer360Schema`, `endpoints.ts:200-207`). Nomor WhatsApp hanya tampil termasking. Nomor penuh butuh izin baru `crm.customer.pii.read`, dan tiap pembukaan dicatat di audit. Nomor asli dibaca dari `user_identities.value_encrypted` lewat `sealSecret`.
2. Segmentasi RFM: tabel `segments` dan `segment_members` (materialisasi). Rute `GET`/`POST /api/segments`, `POST /api/segments/preview` (`endpoints.ts:494-517`). Aturan mengikuti `segmentRuleSchema` dan `segmentDefinitionSchema` (`packages/shared/src/crm/crm.ts:44-104`). Materialisasi lewat job worker harian dan saat segmen disimpan.
3. Member mengirim feedback atau keluhan untuk order miliknya atau sesi meja yang ia ikuti (`POST /api/member/feedback`).
4. Tabel `feedback` (T+O) dengan `handled_note`.
5. Antrean feedback untuk staff dengan izin `crm.feedback.*` dan transisi status lewat `transitionFeedback` dari kontrak (`GET /api/feedback`, `PATCH /api/feedback/:feedbackId`, `endpoints.ts:581-592`).
6. Tiap feedback punya pemilik yang jelas: member hanya melihat feedback miliknya. Baris dari tamu QR (profil null) tidak terlihat member.
7. Satu feedback per kombinasi order dan jenis oleh satu member (anti duplikat).

## Bergantung pada

- `290a` (legend-111j): `customer_profiles`, `withMemberScope`, `app.enforce_member_rls`, `requireMember`. Mulai setelah 290a merge ke cabang gabungan, atau rebase.

## Paralel dengan

- `290c` (m4p5), `290e` (3zd1), `290f` (jurnal). Tidak ada berkas bersama yang diketahui. Bila ada tabrakan di `packages/shared/src/crm/endpoints.ts` atau `errors.ts`, rebase dan gabungkan aditif.

## Migrasi

Migrasi `0196`, `when` = `1794275000000` (merge train boleh mengganti nomor dan `when`).

- `feedback` (T+O): kolom kontrak, plus `handled_note`. PK `(tenant_id, id)`. FK komposit `(tenant_id, customer_profile_id)` ke `customer_profiles` dan `(tenant_id, order_id)` ke `orders (tenant_id, id)`, pola 1 di `docs/plan/contracts.md:123-159`. `orders` adalah tabel order tunggal semua kanal (`apps/api/src/db/schema/qr-order.ts:184`). `pos_orders` hanya perpanjangan POS, jadi tidak dipakai sebagai target FK.
- `segments` (T): kolom kontrak. PK `(tenant_id, id)`.
- `segment_members` (T, materialisasi): kolom kontrak. PK atau unique `(tenant_id, segment_id, customer_profile_id)`, FK komposit ke `segments` dan `customer_profiles`.
- Unique `feedback (tenant_id, order_id, customer_profile_id, kind)`.
- `outlet_id NOT NULL` pada `feedback`: `SELECT app.enforce_outlet_rls(...)`, contoh `apps/api/src/db/schema/sales-targets.custom.sql`.
- `SELECT app.enforce_tenant_rls('public.<t>'::regclass);` untuk `feedback`, `segments`, dan `segment_members`.
- `app.enforce_member_rls(...)` pada `feedback.customer_profile_id`. Baris dengan profil null hanya terlihat staff, tidak terlihat member.
- Grant: `legend_app` SELECT, INSERT, UPDATE. Status diubah lewat layanan, tidak lewat DELETE.
- Tidak ada perubahan pada `session_participants` (hanya dibaca).

## Potongan untuk subagent

Tidak bertumpuk. Diduga, verifikasi di repo (TBD-verify):

1. Skema dan migrasi: `apps/api/src/db/schema/feedback.ts`, `apps/api/src/db/schema/segments.ts`, `apps/api/src/db/schema/index.ts` (ekspor), `apps/api/drizzle/0196_*.sql`, `apps/api/drizzle/meta/*`.
2. Customer 360 dan segmen: `apps/api/src/services/crm-customer360.service.ts`, `apps/api/src/services/crm-segments.service.ts`, job materialisasi di worker (`apps/api/src/worker-main.ts`). Rute staff: `apps/api/src/routes/crm-customers.routes.ts`, `apps/api/src/routes/crm-segments.routes.ts`. Pakai `requireTenantPermission`. Pembukaan nomor penuh lewat izin `crm.customer.pii.read` dengan penulisan audit.
3. Layanan member feedback: `apps/api/src/services/member-feedback.service.ts`. Cek kepemilikan order (`customer_profile_id` cocok) atau sesi meja (`session_participants.user_id` = user sesi). Terima `MemberScope` saja.
4. Rute member: `apps/api/src/routes/member-feedback.routes.ts`, `POST /api/member/feedback`. Pasang `requireAuth`, `requireTrustedOrigin`, `jsonBody`, `requireMember`, dan validasi zod strict dari `packages/shared`.
5. Antrean staff: `apps/api/src/services/crm-feedback.service.ts` (daftar, detail, `transitionFeedback`), `apps/api/src/routes/crm-feedback.routes.ts`. Pakai `requireTenantPermission` dengan `crm.feedback.*`, dan `requireOutletPermission` bila antrean dibatasi outlet (TBD-verify).
6. Kontrak aditif: `packages/shared/src/crm/endpoints.ts`, `packages/shared/src/crm/errors.ts`, dan `packages/shared/package.json` bila subpath baru.

Invarian: layanan member tidak pernah membaca profil dari path, query, atau body. Modul rute member tidak mengimpor `withTenant` langsung. Layanan Customer 360 tidak pernah mengembalikan nomor penuh kecuali pemanggil punya `crm.customer.pii.read`.

## Tes gagal-dulu

Tulis dan lihat merah sebelum kode. Berkas: `apps/api/src/test/member-feedback.test.ts`, `apps/api/src/test/crm-feedback.test.ts`, `apps/api/src/test/crm-customer360.test.ts`, `apps/api/src/test/crm-segments.test.ts` (nama mengikuti pola yang ada, TBD-verify).

Feedback:

- Member A mengirim feedback untuk order miliknya: 201, baris tersimpan dengan profil A.
- Member A untuk order milik B: 404 `NOT_FOUND` umum. Jangan pakai `CUSTOMER_NOT_FOUND`, agar keberadaan order tidak bocor.
- Sesi meja: member yang tergabung di `session_participants` boleh mengirim feedback untuk sesi itu. Yang tidak tergabung ditolak.
- Dua kali feedback jenis sama untuk order sama dari member sama: kedua tolak dengan konflik, hanya satu baris.
- Isolasi: member A tidak melihat feedback B lewat rute apa pun. Dengan GUC diset, select mentah atas baris B kosong. Baris tamu QR (profil null) tidak terlihat member.
- Staff tanpa `crm.feedback.*` mendapat 403 `PERMISSION_DENIED`.
- Sesi member di rute staff mendapat 403 `PERMISSION_DENIED`.
- Member tanpa profil dapat 404 `CUSTOMER_NOT_FOUND`. Member dengan status tidak aktif: `POST /api/member/feedback` memakai `allow: "pending"`, jadi profil apa pun kecuali `closed` boleh mengirim (TBD-verify kode error untuk `closed`).
- `transitionFeedback`: transisi di luar kontrak ditolak. Catatan `handled_note` tersimpan.

Customer 360 dan segmen:

- Daftar dan detail pelanggan: nomor WhatsApp termasking pada respons default.
- Staff tanpa `crm.customer.pii.read` tidak mendapat nomor penuh. Staff dengan izin mendapat nomor penuh, dan tiap pembukaan menulis baris audit.
- Segmen RFM: preview mengembalikan anggota sesuai aturan. Materialisasi menghasilkan baris `segment_members` yang sama dengan preview.
- Isolasi dan tenant: data tenant lain tidak terlihat. Dengan GUC diset, select mentah atas baris tenant lain kosong.

Perintah: dari root worktree, `LEGEND_TEST_FILES="src/test/member-feedback.test.ts src/test/crm-feedback.test.ts src/test/crm-customer360.test.ts src/test/crm-segments.test.ts" pnpm test`. Path relatif ke `apps/api`, dipisah spasi (sesuai `CLAUDE.md`).

## Kontrak

- `POST /api/member/feedback` (baru, aditif di `endpoints.ts`).
- `GET /api/customers`, `GET /api/customers/:customerProfileId`: pakai `customer360Schema` yang ada.
- `GET`/`POST /api/segments`, `POST /api/segments/preview`: pakai yang ada di `endpoints.ts:494-517`.
- `GET /api/feedback`, `PATCH /api/feedback/:feedbackId`, dan `transitionFeedback`: pakai yang ada di `endpoints.ts:581-592`. Tambah hanya bila belum ada (TBD-verify).
- Izin baru `crm.customer.pii.read`: tambah di `packages/shared` bila belum ada.
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
