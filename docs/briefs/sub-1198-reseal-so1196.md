# Brief 1198: fix SO 1196 reseal kolom beku (kartu legend-qwm9r)

Base 782c4b938, cabang ws/1198-reseal-so1196. Tingkat K. Temuan: `git show ux/customer-order-benchmark:docs/qa/second-opinion-sealed-reseal-1196.md`.
Migrasi: ubah `apps/api/drizzle/0720_sealed_reseal_frozen.sql` (belum landing) DAN `apps/api/src/db/schema/sealed-reseal-frozen.custom.sql` / `apologyvouchers.custom.sql` / `pos-order.custom.sql` agar tetap sama. Tanpa 0721. `pnpm db:generate` harus kosong.
Semua perintah test lewat `heavy` (hanya SATU subagent per giliran yang menjalankan vitest/tsc).

## Keputusan (tetap, jangan dibuka ulang)

### P1 tenant lintas batas
- `app.reseal_frozen_sealed(p_table,p_column,p_tenant,p_id,p_expected,p_new)` tetap bersignatur sama. Hapus pemeriksaan GUC `app.tenant_id`. Ganti: baca `tenant_id` dari baris target (`WHERE id = p_id`) di dalam fungsi; bila baris tidak ada return 0; bila `tenant_id <> p_tenant` RAISE 42501. UPDATE tetap `WHERE tenant_id = p_tenant AND id = p_id AND kolom = p_expected`.
- `legend_app` TIDAK lagi anggota `legend_sealed_reseal` (migrasi: hapus GRANT, tambah REVOKE idempoten bila ada keanggotaan). Tidak ada login app/worker/maint/grantor yang boleh anggota atau bisa SET ROLE ke grup.
- Login baru khusus: `legend_reseal_<16 hex>` (export `RESEAL_LOGIN = /^legend_reseal_[a-f0-9]{16}$/` dari `provision-roles.ts`), anggota grup WITH INHERIT TRUE, SET FALSE, tanpa ADMIN; tidak punya hak tabel lain. Env `RESEAL_DATABASE_URL` (opsional; nama key saja di `.env.example`; runbook `docs/deployment.md`; validasi di `apps/api/src/config/env.ts`). Provision mengikuti pola login grantor (`PAYOUT_GRANTOR_DATABASE_URL`): opsi `resealUrl`.
- Job: opsi baru `resealDatabase?: NodePgDatabase` pada job (pool login reseal). Pembacaan baris tetap lewat `database` (withTenant). Pemanggilan fungsi `SELECT app.reseal_frozen_sealed(...)` lewat `resealDatabase`, tanpa SET ROLE. `resealDatabase` kosong: pass beku dilewati, tidak gagal, `remaining` tetap menghitung baris beku (jujur, pensiun tertahan), log warn sekali. Wiring worker membuat pool dari `RESEAL_DATABASE_URL`.
- Bukti: login app nyata (pool `appPool`) setel GUC tenant B lalu `SET ROLE legend_sealed_reseal` atau EXECUTE fungsi ditolak; login reseal sukses mereseal B tanpa mengubah plaintext/kolom lain; tenant param tidak cocok baris => 42501.

### P2 audit privilese (`assertSealedResealRoleReachedOnly`, provision-roles.ts ~1074-1153)
- Audit hak efektif grup langsung: SELECT/dll pada katalog sistem sensitif (`pg_authid`, `pg_shadow`, memakai daftar `SENSITIVE_TABLES`) tidak lagi dikecualikan oleh filter `pg_catalog`; EXECUTE builtin non-PUBLIC di luar baseline `pg_init_privs`; MAINTAIN pada PG17+ (pakai helper :507); sequence; DDL (CREATE di schema). Audit juga menolak keanggotaan grup selain login reseal (cek `pg_auth_members`, termasuk SET option).
- Test terpisah: grant SELECT pg_authid, EXECUTE builtin, MAINTAIN masing-masing menolak lalu lolos setelah REVOKE.

### P2 row lock
- Di fungsi: sebelum UPDATE, `SELECT ... FROM <tabel> WHERE id = p_id FOR NO KEY UPDATE SKIP LOCKED`; tidak dapat kunci => return -1 (sibuk). 0 = CAS kalah/baris hilang, >0 = berhasil. Job menganggap <=0 bukan gagal, tidak menambah `failed`, `remaining` dihitung ulang dan tetap menyertakan baris itu; job memproses baris lain. Pass berikut (rerun) mengambil baris itu setelah lock lepas.
- Test: kunci satu baris lewat koneksi kedua (`SELECT ... FOR UPDATE`), jalankan job, baris bebas pindah, baris terkunci `remaining` 1, tidak menggantung; lepas lock, rerun, remaining 0.

### P2 fixture
- `apps/api/src/test/apology-voucher.test.ts` ~:224: tanpa melonggarkan guard. Pakai INSERT dengan `issued_at` lampau atau `ALTER TABLE apology_vouchers DISABLE TRIGGER apology_vouchers_guard_trg` / `ENABLE` di setup test (owner), pastikan ENABLE kembali di finally.

## Pembagian berkas (tidak bertumpuk)
- Fase 1 (test-writer): `src/test/sealed-secret-reseal-frozen.test.ts`, `src/test/sealed-secret-reseal-job.test.ts`, `src/db/provision-roles-audit.test.ts`, `src/test/apology-voucher.test.ts`. Gagal-dulu di 782c4b938 per temuan.
- Fase 2 (implementer):
  - A: `drizzle/0720_sealed_reseal_frozen.sql` + 3 berkas `src/db/schema/*.custom.sql` terkait.
  - B: `src/db/provision-roles.ts`, `.env.example`, `docs/deployment.md`, `src/config/env.ts`, skrip provisioning terkait (`provision-roles.sh` bila ada).
  - C: `src/worker/sealed-secret-reseal.job.ts` + wiring worker (cari pemanggil job).
